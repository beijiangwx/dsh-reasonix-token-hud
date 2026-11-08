// reasonix-token-hud-dshgo — native dsh-go HUD for the current session's token
// usage, context occupancy, estimated CNY cost and account balance.
//
// The dsh-go app draws the manifest surfaces; this file only folds the live
// session's event log and emits strip / panel data. It reuses the same
// replacement + retry semantics as dsh-token-meter's `tokenUsage` projection,
// but keeps per-sample timestamps and models so the peak / off-peak split is
// exact instead of "price everything at now".
export const name = 'reasonix-token-hud-dshgo'

const TICK_MS = 3000
const BALANCE_TTL_MS = 5 * 60 * 1000
const RATES = { input: 2, cacheRead: 0.04, output: 8 } // CNY / 1M peak tokens
const HALF = 0.5

function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key, false) : undefined
  } catch {
    return undefined
  }
}

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const totalOf = (b) => b.uncachedInput + b.cacheRead + b.cacheWrite + b.output

/** Beijing peak: weekdays 09:00–12:00 and 14:00–18:00; everything else is half price. */
function tierAt(time) {
  const t = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
  const d = new Date(t + 8 * 60 * 60 * 1000)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return 'off'
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  const peak = (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
  return peak ? 'peak' : 'off'
}

function streamUsage(stream) {
  if (!Array.isArray(stream)) return null
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage) return record.chunk.usage
  }
  return null
}

function usageOf(event) {
  if (event === null || typeof event !== 'object') return null
  const data = event.data ?? {}
  if (event.type === 'assistant/chunk') {
    const chunk = data.chunk
    if (!chunk || chunk.type !== 'usage' || !chunk.usage) return null
    return { turn: data.turn, step: data.step, time: event.time, usage: chunk.usage }
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
  const usage = data.usage ?? streamUsage(data.stream)
  if (!usage) return null
  return { turn: data.turn, step: data.step, time: event.time, usage }
}

const bucketsOf = (usage) => ({
  uncachedInput: num(usage.inputTokens ?? usage.uncachedInputTokens),
  cacheRead: num(usage.cacheReadTokens),
  cacheWrite: num(usage.cacheWriteTokens),
  output: num(usage.outputTokens)
})

function addTotals(totals, b, sign) {
  totals.uncachedInput = Math.max(0, totals.uncachedInput + sign * b.uncachedInput)
  totals.cacheRead = Math.max(0, totals.cacheRead + sign * b.cacheRead)
  totals.cacheWrite = Math.max(0, totals.cacheWrite + sign * b.cacheWrite)
  totals.output = Math.max(0, totals.output + sign * b.output)
  totals.requests = Math.max(0, totals.requests + sign)
}

const bucketKey = (rec) => `${rec.provider ?? ''}\u0000${rec.model ?? ''}\u0000${rec.tier}`

function addBucket(map, rec, sign) {
  const key = bucketKey(rec)
  const previous = map.get(key)
  const next = {
    provider: rec.provider ?? null,
    model: rec.model ?? null,
    tier: rec.tier,
    uncachedInput: Math.max(0, (previous?.uncachedInput ?? 0) + sign * rec.uncachedInput),
    cacheRead: Math.max(0, (previous?.cacheRead ?? 0) + sign * rec.cacheRead),
    cacheWrite: Math.max(0, (previous?.cacheWrite ?? 0) + sign * rec.cacheWrite),
    output: Math.max(0, (previous?.output ?? 0) + sign * rec.output)
  }
  if (totalOf(next) === 0) map.delete(key)
  else map.set(key, next)
}

function costOfBucket(b) {
  const factor = b.tier === 'off' ? HALF : 1
  const input = (b.uncachedInput + b.cacheWrite) * RATES.input
  const cacheRead = b.cacheRead * RATES.cacheRead
  const output = b.output * RATES.output
  return ((input + cacheRead + output) / 1e6) * factor
}

function savedOfBucket(b) {
  const factor = b.tier === 'off' ? HALF : 1
  return Math.max(0, b.cacheRead * (RATES.input - RATES.cacheRead)) / 1e6 * factor
}

function emptyUsage() {
  return {
    tokens: 0,
    cost: 0,
    saved: 0,
    cacheHit: null,
    contextPct: null,
    contextWindow: null,
    lastPrompt: null,
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    requests: 0,
    peakTokens: 0,
    offTokens: 0,
    models: []
  }
}

/**
 * Fold the complete live session log into one usage summary.
 * @param {object | undefined} session - live Session object.
 * @returns usage summary.
 */
function foldSession(session) {
  const summary = emptyUsage()
  if (!session || typeof session.snapshotEvents !== 'function') return summary

  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return summary
  }
  if (!Array.isArray(events)) return summary

  const totals = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }
  const buckets = new Map()
  let last = null
  let origin = null
  let contextWindow = null
  let lastPrompt = null

  for (const event of events) {
    try {
      if (event.type === 'request/header') {
        const config = event.data?.header?.config
        if (config && typeof config.model === 'string' && config.model !== '') {
          origin = { provider: config.provider ?? null, model: config.model }
        }
        continue
      }
      if (event.type === 'request/context') {
        const data = event.data ?? {}
        if (typeof data.contextWindow === 'number' && data.contextWindow > 0) contextWindow = data.contextWindow
        if (typeof data.model === 'string' && data.model !== '') {
          origin = { provider: data.provider ?? null, model: data.model }
        }
        continue
      }
      if (event.type === 'llm/retry-started') {
        if (last && last.turn === event.data?.turn && last.step === event.data?.step) last = null
        continue
      }
      const sample = usageOf(event)
      if (!sample) continue
      if (!Number.isInteger(sample.turn) || !Number.isInteger(sample.step)) continue
      const b = bucketsOf(sample.usage)
      if (totalOf(b) === 0) continue
      const rec = {
        turn: sample.turn,
        step: sample.step,
        time: typeof sample.time === 'number' ? sample.time : null,
        provider: origin?.provider ?? null,
        model: origin?.model ?? null,
        tier: tierAt(typeof sample.time === 'number' ? sample.time : Date.now()),
        ...b
      }
      if (last && last.turn === rec.turn && last.step === rec.step) {
        addTotals(totals, last, -1)
        addBucket(buckets, last, -1)
      }
      addTotals(totals, rec, 1)
      addBucket(buckets, rec, 1)
      last = rec
      lastPrompt = b.uncachedInput + b.cacheRead + b.cacheWrite
    } catch {
      // A malformed event must never break the HUD.
    }
  }

  summary.uncachedInput = totals.uncachedInput
  summary.cacheRead = totals.cacheRead
  summary.cacheWrite = totals.cacheWrite
  summary.output = totals.output
  summary.requests = totals.requests
  summary.tokens = totalOf(totals)
  summary.contextWindow = contextWindow
  summary.lastPrompt = lastPrompt
  summary.contextPct =
    lastPrompt !== null && contextWindow !== null ? Math.min(100, (lastPrompt / contextWindow) * 100) : null

  const inputBase = totals.uncachedInput + totals.cacheRead + totals.cacheWrite
  summary.cacheHit = inputBase > 0 ? (totals.cacheRead / inputBase) * 100 : null

  const models = new Map()
  for (const bucket of buckets.values()) {
    summary.cost += costOfBucket(bucket)
    summary.saved += savedOfBucket(bucket)
    if (bucket.tier === 'off') summary.offTokens += totalOf(bucket)
    else summary.peakTokens += totalOf(bucket)
    const name = bucket.model ?? '未知模型'
    const model = models.get(name) ?? { name, tokens: 0, cost: 0 }
    model.tokens += totalOf(bucket)
    model.cost += costOfBucket(bucket)
    models.set(name, model)
  }
  summary.models = [...models.values()].sort((a, b) => b.cost - a.cost)
  return summary
}

// ── formatting ───────────────────────────────────────────────────────────────
function fmtMoney(value) {
  const n = Number(value) || 0
  if (n === 0) return '¥0.00'
  if (n < 0.01) return '¥' + n.toFixed(4)
  if (n < 1) return '¥' + n.toFixed(3)
  return '¥' + n.toFixed(2)
}

function fmtCostShort(value) {
  const n = Number(value) || 0
  if (n === 0) return '¥0'
  if (n < 0.01) return '¥' + n.toFixed(3)
  return '¥' + n.toFixed(2)
}

function fmtTokens(value) {
  const n = Number(value) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K'
  return String(Math.round(n))
}

function fmtExact(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US')
}

function fmtPct(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value) || 0
  return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + '%'
}

function fmtBalance(amount, currency) {
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' || !currency ? '¥' : currency + ' '
  const n = Math.abs(Number(amount) || 0)
  const text = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (Number(amount) < 0 ? '-' : '') + symbol + text
}

function fmtBalanceShort(amount, currency) {
  const symbol = currency === 'USD' ? '$' : '¥'
  const n = Math.abs(Number(amount) || 0)
  if (n >= 10) return symbol + n.toFixed(0)
  if (n >= 1) return symbol + n.toFixed(1)
  return symbol + n.toFixed(2)
}

// ── account balance (optional service) ───────────────────────────────────────
const balanceState = { at: 0, text: '—', amount: null, currency: 'CNY', tone: undefined }
let balanceInflight = null

function normalizeBalance(value) {
  if (!value || value.status !== 'ready' || !Array.isArray(value.value)) return null
  const wallets = value.value
    .map((wallet) => ({ currency: wallet?.currency, amount: Number(wallet?.balance) }))
    .filter((wallet) => Number.isFinite(wallet.amount))
  if (wallets.length === 0) return null
  const chosen = wallets.find((wallet) => wallet.currency === 'CNY') ?? wallets[0]
  const gift = (Array.isArray(value.bonusWallets) ? value.bonusWallets : [])
    .filter((wallet) => wallet?.currency === chosen.currency)
    .reduce((sum, wallet) => sum + (Number(wallet?.balance) || 0), 0)
  return { amount: chosen.amount + gift, currency: chosen.currency }
}

function refreshBalance(ctx, caps) {
  const account = service(ctx, 'deepseekAccount')
  if (!account || typeof account.getBalance !== 'function') return Promise.resolve()
  if (Date.now() - balanceState.at < BALANCE_TTL_MS) return Promise.resolve()
  if (balanceInflight) return balanceInflight
  const client = {
    version: '0.2.1',
    locale: caps?.locale || 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
  }
  balanceInflight = Promise.resolve(account.getBalance(client))
    .then((value) => {
      const picked = normalizeBalance(value)
      if (picked === null) {
        balanceState.at = Date.now()
        return
      }
      balanceState.at = Date.now()
      balanceState.amount = picked.amount
      balanceState.currency = picked.currency
      balanceState.text = fmtBalance(picked.amount, picked.currency)
      balanceState.tone = picked.amount < 1 ? 'bad' : picked.amount < 5 ? 'warn' : undefined
    })
    .catch(() => {
      balanceState.at = Date.now()
    })
    .finally(() => {
      balanceInflight = null
    })
  return balanceInflight
}

// ── session lookup + short cache ─────────────────────────────────────────────
let usageCache = { sessionId: null, at: 0, value: null }

function computeUsage(ctx, sessionId) {
  if (!sessionId) return emptyUsage()
  const now = Date.now()
  if (usageCache.sessionId === sessionId && now - usageCache.at < 1000) return usageCache.value
  const sessions = service(ctx, 'sessions')
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  const value = foldSession(session)
  usageCache = { sessionId, at: now, value }
  return value
}

// ── dsh-go surfaces ──────────────────────────────────────────────────────────
function stripText(usage) {
  if (!usage || usage.tokens === 0) return '暂无用量'
  const base = `${fmtCostShort(usage.cost)} · ${fmtTokens(usage.tokens)}`
  if (balanceState.amount !== null) {
    const withBalance = `${base} · 余${fmtBalanceShort(balanceState.amount, balanceState.currency)}`
    if (withBalance.length <= 24) return withBalance
  }
  return base.length <= 24 ? `${base} tok` : base.slice(0, 24)
}

function panelData(usage) {
  const pct = usage.contextPct
  return {
    cost: fmtMoney(usage.cost),
    tokens: fmtTokens(usage.tokens),
    cacheHit: fmtPct(usage.cacheHit),
    balance: balanceState.text,
    contextPct: pct === null ? 0 : Math.round(pct),
    contextText:
      usage.lastPrompt !== null && usage.contextWindow !== null
        ? `${fmtTokens(usage.lastPrompt)} / ${fmtTokens(usage.contextWindow)}`
        : '等待请求',
    contextTone: pct === null ? 'info' : pct >= 85 ? 'bad' : pct >= 60 ? 'warn' : 'good',
    breakdown: [
      ['未缓存输入', fmtExact(usage.uncachedInput)],
      ['缓存读取', fmtExact(usage.cacheRead)],
      ['缓存写入', fmtExact(usage.cacheWrite)],
      ['输出', fmtExact(usage.output)]
    ],
    modelRows:
      usage.models.length === 0
        ? [['暂无模型', '—', '—']]
        : usage.models.slice(0, 8).map((model) => [model.name, fmtTokens(model.tokens), fmtMoney(model.cost)]),
    tiers: [
      ['高峰 tokens', fmtTokens(usage.peakTokens)],
      ['空闲 tokens', fmtTokens(usage.offTokens)],
      ['计费请求', `${usage.requests} 次`],
      ['缓存节省', fmtMoney(usage.saved)]
    ]
  }
}

const VIEW = {
  type: 'stack',
  title: '用量与费用',
  children: [
    {
      type: 'metric',
      label: '本会话估算',
      value: { $: 'data.cost' },
      caption: 'CNY · 以官方账单为准'
    },
    {
      type: 'row',
      children: [
        { type: 'metric', label: '总 tokens', value: { $: 'data.tokens' } },
        { type: 'metric', label: '缓存命中', value: { $: 'data.cacheHit' } },
        { type: 'metric', label: '账户余额', value: { $: 'data.balance' } }
      ]
    },
    {
      type: 'progress',
      label: '上下文占用',
      value: { $: 'data.contextPct' },
      max: 100,
      caption: { $: 'data.contextText' },
      tone: { $: 'data.contextTone' }
    },
    { type: 'keyValue', items: { $: 'data.breakdown' } },
    {
      type: 'table',
      columns: ['模型', 'tokens', '费用'],
      rows: { $: 'data.modelRows' }
    },
    { type: 'keyValue', items: { $: 'data.tiers' } },
    {
      type: 'callout',
      text: '估算值，以官方账单为准；空闲时段按高峰价 50% 计。',
      tone: 'info'
    }
  ]
}

function summaryText(usage) {
  if (!usage || usage.tokens === 0) return '当前会话还没有用量。'
  return [
    '用量与费用（本会话估算）',
    `费用：${fmtMoney(usage.cost)} CNY`,
    `tokens：${fmtExact(usage.tokens)}（输入 ${fmtExact(usage.uncachedInput)} / 缓存 ${fmtExact(usage.cacheRead)} / 输出 ${fmtExact(usage.output)}）`,
    `缓存命中：${fmtPct(usage.cacheHit)}`,
    `计费请求：${usage.requests} 次`,
    `账户余额：${balanceState.text}`,
    '估算值，以官方账单为准。'
  ].join('\n')
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.on('copy', (scope) => {
      const usage = computeUsage(ctx, scope.sessionId)
      if (usage.tokens === 0) return { toast: '当前会话还没有用量' }
      return { copy: summaryText(usage), toast: '已复制' }
    })

    ctx.dshGo.strip('strip', (scope, emit, caps) => {
      let stopped = false
      const render = () => {
        if (stopped) return
        const usage = computeUsage(ctx, scope.sessionId)
        const effect = { text: stripText(usage), icon: 'coin' }
        if (balanceState.tone) effect.tone = balanceState.tone
        emit(effect)
      }
      const tick = () => {
        render()
        void refreshBalance(ctx, caps).then(render)
      }
      tick()
      const timer = setInterval(tick, TICK_MS)
      return () => {
        stopped = true
        clearInterval(timer)
      }
    })

    ctx.dshGo.panel('hud', {
      view: () => VIEW,
      data: (scope, emit, caps) => {
        let stopped = false
        const push = () => {
          if (stopped) return
          emit(panelData(computeUsage(ctx, scope.sessionId)))
        }
        const tick = () => {
          push()
          void refreshBalance(ctx, caps).then(push)
        }
        tick()
        const timer = setInterval(tick, TICK_MS)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }
    })
  })
}
