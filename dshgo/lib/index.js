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
/** How many reply ids the per-message lookup remembers (oldest dropped first). */
const MESSAGE_TURNS_MAX = 5000
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

// Official pricing (api-docs.deepseek.com › Models & Pricing): peak is 01:00–04:00 and
// 06:00–10:00 UTC, Monday–Friday; off-peak is half price; Chinese public holidays are
// off-peak all day. The holiday calendar changes every year, so this plugin ships none:
// set PEAK_HOLIDAYS to a JSON array of Beijing-time `YYYY-MM-DD` days and they count as
// off-peak. Unset means weekends + the daily time windows only.
function holidaySet() {
  const env = process.env.PEAK_HOLIDAYS
  if (typeof env !== 'string' || env.trim() === '') return new Set()
  try {
    const list = JSON.parse(env)
    if (!Array.isArray(list)) return new Set()
    return new Set(list.filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)))
  } catch {
    // A broken override must not break the HUD.
    return new Set()
  }
}

const HOLIDAYS = holidaySet()

/** Beijing calendar day (`YYYY-MM-DD`) of an epoch millisecond. */
function beijingDay(time) {
  const d = new Date(time + 8 * 60 * 60 * 1000)
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${month}-${day}`
}

// Peak windows in Beijing wall-clock minutes since midnight.
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60]
]

/** Beijing peak: workdays 09:00–12:00 and 14:00–18:00; weekends and holidays are half price. */
function tierAt(time) {
  const t = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
  const d = new Date(t + 8 * 60 * 60 * 1000)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return 'off'
  if (HOLIDAYS.has(beijingDay(t))) return 'off'
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to) ? 'peak' : 'off'
}

/** '1h12m' / '48m' / '2d14h' — the same span, squeezed for the 24-character strip. */
function fmtSpanShort(ms) {
  const total = Math.max(0, Math.round(ms / 60000))
  if (total >= 24 * 60) {
    const days = Math.floor(total / (24 * 60))
    const hours = Math.floor((total % (24 * 60)) / 60)
    return hours === 0 ? `${days}d` : `${days}d${hours}h`
  }
  if (total >= 60) {
    const hours = Math.floor(total / 60)
    const minutes = total % 60
    return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`
  }
  return `${total}m`
}

/** '1小时12分' / '48分' / '3分' — how long until the next tier switch. */
function fmtSpan(ms) {
  const total = Math.max(0, Math.round(ms / 60000))
  if (total >= 60) {
    const hours = Math.floor(total / 60)
    const minutes = total % 60
    return minutes === 0 ? `${hours}小时` : `${hours}小时${minutes}分`
  }
  return `${total}分`
}

/**
 * When the price tier next changes: { at, tier } (epoch ms and the tier it changes to),
 * or null within a year. Walks minute-aligned candidate boundaries in Beijing time, so it
 * follows weekend / holiday edges as well as the two daily windows.
 */
function nextTierSwitch(time) {
  const t = typeof time === 'number' && Number.isFinite(time) ? time : Date.now()
  const current = tierAt(t)
  // Boundaries can only fall on a window edge or a Beijing midnight; step to the next one.
  const step = 60 * 1000
  const limit = t + 370 * 24 * 60 * 60 * 1000
  // Start at the next whole minute to keep the scan cheap and the answer exact enough.
  let probe = Math.floor(t / step) * step + step
  while (probe <= limit) {
    const tier = tierAt(probe)
    if (tier !== current) return { at: probe, tier }
    const d = new Date(probe + 8 * 60 * 60 * 1000)
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
    // Jump straight to the next candidate instead of walking every minute.
    const edges = [...PEAK_WINDOWS.flat(), 24 * 60]
    const upcoming = edges.filter((edge) => edge > minutes)
    if (upcoming.length === 0) {
      // Past the last edge of the day: next Beijing midnight.
      probe += (24 * 60 - minutes) * 60 * 1000
    } else {
      probe += (Math.min(...upcoming) - minutes) * 60 * 1000
    }
  }
  return null
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
    peakCost: 0,
    offCost: 0,
    models: [],
    turns: [],
    messageTurns: new Map()
  }
}

/** One turn's running total while the log is folded. */
function turnEntry(turn) {
  return {
    turn,
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    cost: 0,
    peakTokens: 0,
    offTokens: 0
  }
}

/** Add (sign = 1) or remove (sign = -1) one sample from a turn's total. */
function addTurn(map, rec, sign) {
  const entry = map.get(rec.turn) ?? turnEntry(rec.turn)
  entry.uncachedInput = Math.max(0, entry.uncachedInput + sign * rec.uncachedInput)
  entry.cacheRead = Math.max(0, entry.cacheRead + sign * rec.cacheRead)
  entry.cacheWrite = Math.max(0, entry.cacheWrite + sign * rec.cacheWrite)
  entry.output = Math.max(0, entry.output + sign * rec.output)
  entry.cost = Math.max(0, entry.cost + sign * costOfBucket(rec))
  const tokens = totalOf(rec)
  if (rec.tier === 'off') entry.offTokens = Math.max(0, entry.offTokens + sign * tokens)
  else entry.peakTokens = Math.max(0, entry.peakTokens + sign * tokens)
  if (totalOf(entry) === 0 && entry.cost < 1e-9) map.delete(rec.turn)
  else map.set(rec.turn, entry)
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
  const turns = new Map()
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
      // Every reply gets an id→turn entry, whether or not it carried usage: the app sends
      // that id when the person long-presses the reply, and the turn may have settled earlier.
      if (event.type === 'assistant/message') {
        const id = event.data?.message?.id
        const turn = event.data?.turn
        if (typeof id === 'string' && id !== '' && Number.isInteger(turn)) {
          summary.messageTurns.set(id, turn)
          if (summary.messageTurns.size > MESSAGE_TURNS_MAX) {
            summary.messageTurns.delete(summary.messageTurns.keys().next().value)
          }
        }
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
        addTurn(turns, last, -1)
      }
      addTotals(totals, rec, 1)
      addBucket(buckets, rec, 1)
      addTurn(turns, rec, 1)
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
    const bucketCost = costOfBucket(bucket)
    summary.cost += bucketCost
    summary.saved += savedOfBucket(bucket)
    if (bucket.tier === 'off') {
      summary.offTokens += totalOf(bucket)
      summary.offCost += bucketCost
    } else {
      summary.peakTokens += totalOf(bucket)
      summary.peakCost += bucketCost
    }
    const name = bucket.model ?? '未知模型'
    const model = models.get(name) ?? { name, tokens: 0, cost: 0 }
    model.tokens += totalOf(bucket)
    model.cost += costOfBucket(bucket)
    models.set(name, model)
  }
  summary.models = [...models.values()].sort((a, b) => b.cost - a.cost)
  summary.turns = [...turns.values()].sort((a, b) => a.turn - b.turn)
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

/** A turn's cost: 2–4 decimals by magnitude, trailing zeros trimmed; a tiny charge stays visible. */
function fmtTurnMoney(value) {
  const n = Number(value) || 0
  if (n <= 0) return '¥0'
  if (n < 0.0001) return '<¥0.0001'
  if (n >= 1) return '¥' + n.toFixed(2)
  // 3 decimals from ¥0.01 up, 4 below it; never trimmed, so the shown value is the billed one.
  return '¥' + n.toFixed(n >= 0.01 ? 3 : 4)
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
const tierShort = (tier) => (tier === 'off' ? '谷时' : '峰时')

/** `谷时 · 1小时12分后进入峰时（09:00）`. Empty when the next switch is unknown. */
function tierSwitchText(now) {
  const next = nextTierSwitch(now)
  if (next === null) return ''
  // Shift to Beijing and read UTC fields: toTimeString would apply the host zone twice.
  const d = new Date(next.at + 8 * 60 * 60 * 1000)
  const clock = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  return `${tierShort(tierAt(now))} · ${fmtSpan(next.at - now)}后进入${tierShort(next.tier)}（${clock}）`
}

/** The tier one turn was billed at; a turn that crossed a boundary shows both. */
function turnTierLabel(turn) {
  if (turn.peakTokens > 0 && turn.offTokens > 0) return '峰+谷'
  return turn.offTokens > 0 ? '谷时' : '峰时'
}

/**
 * The strip is the reliable place for the numbers: 24 characters, and it always shows
 * when a turn ends. Order of sacrifice when it does not fit: account balance, tokens,
 * then the peak / off-peak hint; the current turn's cost is never dropped.
 */
function stripText(usage) {
  const now = Date.now()
  const nowTier = tierShort(tierAt(now))
  const next = nextTierSwitch(now)
  // "1h4m后峰" replaces the plain tier: it names the coming window and implies the current
  // one, so the strip carries the countdown without getting longer.
  const until =
    next === null ? nowTier : `${fmtSpanShort(next.at - now)}后${next.tier === 'off' ? '谷' : '峰'}`
  if (!usage || usage.tokens === 0) return `暂无用量 · ${until}`
  const total = `总${fmtCostShort(usage.cost)}`
  const last = usage.turns.at(-1)
  const turn = last ? `本轮${fmtTurnMoney(last.cost)}` : null
  const tokens = fmtTokens(usage.tokens)
  const balance =
    balanceState.amount !== null ? `余${fmtBalanceShort(balanceState.amount, balanceState.currency)}` : null
  // Priority: session total, this turn, the price countdown, then the account balance.
  // Each shape tries the roomy separator first, so a lower-priority number never crowds out
  // a higher-priority one just because it happens to fit on a shorter line.
  const shapes = [
    [total, turn, until, balance],
    [total, turn, until],
    [total, turn],
    [total, until],
    [total, nowTier],
    [total]
  ]
  for (const shape of shapes) {
    const parts = shape.filter((part) => part !== null && part !== undefined)
    for (const sep of [' · ', '·']) {
      const line = parts.join(sep)
      if (line.length <= 24) return line
    }
  }
  return [...total].slice(0, 24).join('')
}

function panelData(usage) {
  const pct = usage.contextPct
  const nowTier = tierAt(Date.now())
  const latest = usage.turns.at(-1)
  return {
    cost: fmtMoney(usage.cost),
    lastTurn: latest ? fmtTurnMoney(latest.cost) : '—',
    lastTurnLabel: latest ? `第 ${latest.turn} 轮（${turnTierLabel(latest)}）` : '还没有完成的回合',
    tierCaption: `CNY · 现在${tierShort(nowTier)}${nowTier === 'off' ? '（半价）' : '（全价）'}`,
    // "谷时 · 1小时12分后进入峰时" — the same countdown the desktop cost meter shows.
    tierSwitch: nextTierSwitch(Date.now()) === null ? '' : tierSwitchText(Date.now()),
    tierHint:
      nowTier === 'off'
        ? '现在是谷时，按峰时价 50% 计；峰时为工作日 09:00–12:00、14:00–18:00（不含法定节假日）。'
        : '现在是峰时，按全价计；工作日 12:00–14:00、18:00 之后、周末和法定节假日为谷时（半价）。',
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
    turnRows:
      usage.turns.length === 0
        ? [['暂无回合', '—', '—', '—']]
        : usage.turns.slice(-50).map((turn) => [
            `第 ${turn.turn} 轮`,
            fmtTokens(totalOf(turn)),
            fmtTurnMoney(turn.cost),
            turnTierLabel(turn)
          ]),
    tiers: [
      ['峰时费用', `${fmtMoney(usage.peakCost)} · ${fmtTokens(usage.peakTokens)} tok`],
      ['谷时费用', `${fmtMoney(usage.offCost)} · ${fmtTokens(usage.offTokens)} tok`],
      ['本次会话跨越', usage.peakTokens > 0 && usage.offTokens > 0 ? '峰时与谷时' : '单一时段'],
      ['计费请求', `${usage.requests} 次`],
      ['缓存节省', fmtMoney(usage.saved)]
    ]
  }
}

/** Turn note data: `{ <turn number>: { text, tone } }`, 16 characters per segment. */
function turnNoteData(usage) {
  const out = {}
  // The bridge keeps the newest 64 turns anyway; sending more would only grow the payload.
  for (const turn of usage.turns.slice(-64)) {
    if (!(turn.cost > 0)) continue
    const label = turn.peakTokens > 0 && turn.offTokens > 0 ? '峰谷' : turn.offTokens > 0 ? '谷' : '峰'
    const tone = label === '谷' ? 'good' : label === '峰' ? 'warn' : 'info'
    out[String(turn.turn)] = { text: `${fmtTurnMoney(turn.cost)}·${label}`, tone }
  }
  return out
}

const VIEW = {
  type: 'stack',
  title: '用量与费用',
  children: [
    {
      type: 'row',
      children: [
        {
          type: 'metric',
          label: '本会话估算',
          value: { $: 'data.cost' },
          caption: { $: 'data.tierCaption' }
        },
        { type: 'metric', label: '本轮', value: { $: 'data.lastTurn' }, caption: { $: 'data.lastTurnLabel' } }
      ]
    },
    { type: 'callout', text: { $: 'data.tierSwitch' }, tone: 'info' },
    { type: 'callout', text: { $: 'data.tierHint' }, tone: 'info' },
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
    { type: 'keyValue', items: { $: 'data.tiers' } },
    {
      type: 'table',
      columns: ['回合', 'tokens', '费用', '时段'],
      rows: { $: 'data.turnRows' }
    },
    {
      type: 'table',
      columns: ['模型', 'tokens', '费用'],
      rows: { $: 'data.modelRows' }
    },
    {
      type: 'callout',
      text: '估算值，以官方账单为准；谷时（空闲时段）按峰时价 50% 计。',
      tone: 'info'
    }
  ]
}

function summaryText(usage) {
  if (!usage || usage.tokens === 0) return '当前会话还没有用量。'
  const latest = usage.turns.at(-1)
  return [
    '用量与费用（本会话估算）',
    `费用：${fmtMoney(usage.cost)} CNY`,
    `tokens：${fmtExact(usage.tokens)}（输入 ${fmtExact(usage.uncachedInput)} / 缓存 ${fmtExact(usage.cacheRead)} / 输出 ${fmtExact(usage.output)}）`,
    `缓存命中：${fmtPct(usage.cacheHit)}`,
    `计费请求：${usage.requests} 次`,
    `峰时 ${fmtMoney(usage.peakCost)} / 谷时 ${fmtMoney(usage.offCost)}`,
    latest ? `最近一轮：第 ${latest.turn} 轮 ${fmtMoney(latest.cost)}（${turnTierLabel(latest)}）` : '最近一轮：—',
    `账户余额：${balanceState.text}`,
    '估算值，以官方账单为准。'
  ].join('\n')
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    // Long-press a reply → this message's own turn cost. The app sends messageId with the
    // tap; the fold remembers which turn each settled message belongs to.
    ctx.dshGo.on('turn-cost', (scope) => {
      const usage = computeUsage(ctx, scope.sessionId)
      const byMessage = scope.messageId ? usage.messageTurns.get(scope.messageId) : undefined
      // A given id that does not resolve must not borrow the newest turn's number — unless this
      // log carries no reply ids at all, where the newest settled turn is the best we have.
      if (scope.messageId && byMessage === undefined && usage.messageTurns.size > 0) {
        return { toast: '这条回复还没结算，稍后再看' }
      }
      const turn =
        (byMessage === undefined ? undefined : usage.turns.find((t) => t.turn === byMessage)) ?? usage.turns.at(-1)
      if (!turn) return { toast: '这一轮还没有费用记录' }
      const text = `第 ${turn.turn} 轮 ${fmtTurnMoney(turn.cost)}（${turnTierLabel(turn)}）`
      return { copy: `第 ${turn.turn} 轮费用：${fmtMoney(turn.cost)} ${turnTierLabel(turn)}`, toast: text }
    })

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

    // Per-turn cost on each turn's footnote: `¥0.021·峰`. Older bridges have no
    // turnNote and would make later registrations unreachable, so probe first.
    if (typeof ctx.dshGo.turnNote === 'function') {
      ctx.dshGo.turnNote('turncost', (scope, emit) => {
        let stopped = false
        const push = () => {
          if (stopped) return
          emit(turnNoteData(computeUsage(ctx, scope.sessionId)))
        }
        push()
        const timer = setInterval(push, TICK_MS)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      })
    }
  })
}
