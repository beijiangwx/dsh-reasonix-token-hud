/**
 * Pure fold behind the `usageMeter` session projection.
 *
 * It mirrors the replacement semantics of token-meter's `tokenUsage` unit —
 * the last usage sample of one attempt replaces the earlier one, and
 * `llm/retry-started` closes that slot — while additionally attributing every
 * committed sample to its provider/model and to the DeepSeek peak/off-peak
 * tier of the moment it happened. The client prices those buckets, so a
 * session that crosses the peak boundary is billed correctly instead of being
 * priced entirely at "now".
 *
 * Every exported function is synchronous and side-effect free; `applyEvent`
 * returns the same state reference for events the unit does not consume, which
 * is what the projection registry relies on to skip downstream work.
 */

const ZERO_TOTALS = () => ({
  uncachedInput: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  requests: 0,
});

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * DeepSeek's published peak windows, in Beijing time (UTC+8), Monday–Friday:
 * 09:00–12:00 and 14:00–18:00. Everything else — including the whole weekend —
 * is the off-peak tier, billed at half the peak rates. Chinese statutory
 * holidays are not modelled; those days are counted as peak, which can only
 * overstate the estimate.
 * @param time - epoch milliseconds of the billing sample.
 * @returns the tier name.
 */
export function tierAt(time) {
  const t = typeof time === "number" && Number.isFinite(time) ? time : Date.now();
  const d = new Date(t + 8 * 60 * 60 * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return "off";
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const peak = (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
  return peak ? "peak" : "off";
}

/** The last raw usage chunk of a durable Assistant settlement stream. */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return null;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === "chunk" && record.chunk?.type === "usage" && record.chunk.usage) return record.chunk.usage;
  }
  return null;
}

/**
 * One committed usage sample, or null when the event carries none. Covers both
 * the durable-chunk form (`assistant/chunk`) and the settlement form whose
 * sample can hide inside `data.stream`.
 * @param event - committed session event.
 * @returns { turn, step, time, usage } or null.
 */
export function usageOfEvent(event) {
  if (event === null || typeof event !== "object") return null;
  const data = event.data ?? {};
  if (event.type === "assistant/chunk") {
    const chunk = data.chunk;
    if (!chunk || chunk.type !== "usage" || !chunk.usage) return null;
    return { turn: data.turn, step: data.step, time: event.time, usage: chunk.usage };
  }
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return null;
  const usage = data.usage ?? streamUsage(data.stream);
  if (!usage) return null;
  return { turn: data.turn, step: data.step, time: event.time, usage };
}

/** The provider/model one request event names, or null. */
function originOf(event) {
  if (event.type === "request/header") {
    const config = event.data?.header?.config;
    if (typeof config?.model !== "string" || config.model === "") return null;
    return {
      provider: typeof config.provider === "string" && config.provider !== "" ? config.provider : null,
      model: config.model,
    };
  }
  if (event.type === "request/context") {
    const model = event.data?.model;
    if (typeof model !== "string" || model === "") return null;
    const provider = event.data?.provider;
    return { provider: typeof provider === "string" && provider !== "" ? provider : null, model };
  }
  return null;
}

const bucketsOf = (usage) => ({
  uncachedInput: num(usage.inputTokens ?? usage.uncachedInputTokens),
  cacheRead: num(usage.cacheReadTokens),
  cacheWrite: num(usage.cacheWriteTokens),
  output: num(usage.outputTokens),
});

const totalOf = (b) =>
  (Number(b?.uncachedInput) || 0) +
  (Number(b?.cacheRead) || 0) +
  (Number(b?.cacheWrite) || 0) +
  (Number(b?.output) || 0);

const sameOrigin = (left, right) =>
  left !== null && left !== undefined && left.provider === right.provider && left.model === right.model;

const sameSample = (left, right) =>
  left !== null &&
  left !== undefined &&
  left.turn === right.turn &&
  left.step === right.step &&
  left.provider === right.provider &&
  left.model === right.model &&
  left.tier === right.tier &&
  left.uncachedInput === right.uncachedInput &&
  left.cacheRead === right.cacheRead &&
  left.cacheWrite === right.cacheWrite &&
  left.output === right.output;

const bucketKey = (sample) => `${sample.provider ?? ""}\u0000${sample.model ?? ""}\u0000${sample.tier}`;

/** Add (sign = 1) or subtract (sign = -1) one sample to the per-model/tier buckets. */
function adjustBuckets(buckets, sample, sign) {
  const key = bucketKey(sample);
  const previous = buckets[key];
  const next = {
    provider: sample.provider ?? null,
    model: sample.model ?? null,
    tier: sample.tier,
    uncachedInput: Math.max(0, (previous?.uncachedInput ?? 0) + sign * sample.uncachedInput),
    cacheRead: Math.max(0, (previous?.cacheRead ?? 0) + sign * sample.cacheRead),
    cacheWrite: Math.max(0, (previous?.cacheWrite ?? 0) + sign * sample.cacheWrite),
    output: Math.max(0, (previous?.output ?? 0) + sign * sample.output),
  };
  const out = { ...buckets };
  if (totalOf(next) <= 0) delete out[key];
  else out[key] = next;
  return out;
}

function adjustTotals(totals, sample, sign) {
  return {
    uncachedInput: Math.max(0, totals.uncachedInput + sign * sample.uncachedInput),
    cacheRead: Math.max(0, totals.cacheRead + sign * sample.cacheRead),
    cacheWrite: Math.max(0, totals.cacheWrite + sign * sample.cacheWrite),
    output: Math.max(0, totals.output + sign * sample.output),
    requests: Math.max(0, totals.requests + (sign > 0 ? 1 : -1)),
  };
}

/** Initial fold state for one Session header. */
export function initialState(header) {
  const createdAt = header && typeof header.createdAt === "number" ? header.createdAt : null;
  return {
    totals: ZERO_TOTALS(),
    buckets: {},
    last: null,
    origin: null,
    firstAt: createdAt,
    lastAt: null,
  };
}

/**
 * Fold one committed session event.
 * @param state - previous state (never mutated).
 * @param event - committed session event.
 * @returns the next state, or the same reference when the event is not ours.
 */
export function applyEvent(state, event) {
  if (state === null || typeof state !== "object" || event === null || typeof event !== "object") return state;
  try {
    const named = originOf(event);
    if (named !== null) {
      if (sameOrigin(state.origin, named)) return state;
      return { ...state, origin: named };
    }

    if (event.type === "llm/retry-started") {
      const turn = event.data?.turn;
      const step = event.data?.step;
      if (state.last !== null && state.last.turn === turn && state.last.step === step) {
        return { ...state, last: null };
      }
      return state;
    }

    const sample = usageOfEvent(event);
    if (sample === null) return state;
    if (!Number.isInteger(sample.turn) || !Number.isInteger(sample.step)) return state;

    const origin = state.origin ?? { provider: null, model: null };
    const buckets = bucketsOf(sample.usage);
    const record = {
      turn: sample.turn,
      step: sample.step,
      time: typeof sample.time === "number" ? sample.time : null,
      provider: origin.provider,
      model: origin.model,
      tier: tierAt(typeof sample.time === "number" ? sample.time : Date.now()),
      ...buckets,
    };
    if (totalOf(record) <= 0) return state;

    const replacing =
      state.last !== null && state.last.turn === record.turn && state.last.step === record.step;
    if (replacing && sameSample(state.last, record)) return state;

    let totals = state.totals;
    let bucketMap = state.buckets;
    if (replacing) {
      totals = adjustTotals(totals, state.last, -1);
      bucketMap = adjustBuckets(bucketMap, state.last, -1);
    }
    totals = adjustTotals(totals, record, 1);
    bucketMap = adjustBuckets(bucketMap, record, 1);

    const lastAt =
      record.time !== null && (state.lastAt === null || record.time > state.lastAt) ? record.time : state.lastAt;

    return { ...state, totals, buckets: bucketMap, last: record, lastAt };
  } catch {
    // A malformed event must never poison the projection drive.
    return state;
  }
}

/**
 * Build the client-visible view. Results are memoized by state identity so an
 * untouched fold publishes nothing (the registry compares raw views with
 * `Object.is`).
 * @returns the wire `view(state)` function.
 */
export function createView() {
  const cache = new WeakMap();
  return function view(state) {
    const cached = cache.get(state);
    if (cached !== undefined) return cached;
    const buckets = Object.values(state?.buckets ?? {})
      .filter((bucket) => totalOf(bucket) > 0)
      .map((bucket) => ({
        provider: bucket.provider ?? null,
        model: bucket.model ?? null,
        tier: bucket.tier === "off" ? "off" : "peak",
        uncachedInput: Number(bucket.uncachedInput) || 0,
        cacheRead: Number(bucket.cacheRead) || 0,
        cacheWrite: Number(bucket.cacheWrite) || 0,
        output: Number(bucket.output) || 0,
      }))
      .sort(
        (a, b) =>
          (a.model ?? "").localeCompare(b.model ?? "") ||
          (a.provider ?? "").localeCompare(b.provider ?? "") ||
          a.tier.localeCompare(b.tier),
      );
    const value = {
      v: 1,
      totals: {
        uncachedInput: Number(state?.totals?.uncachedInput) || 0,
        cacheRead: Number(state?.totals?.cacheRead) || 0,
        cacheWrite: Number(state?.totals?.cacheWrite) || 0,
        output: Number(state?.totals?.output) || 0,
        requests: Number(state?.totals?.requests) || 0,
      },
      buckets,
      firstAt: typeof state?.firstAt === "number" ? state.firstAt : null,
      lastAt: typeof state?.lastAt === "number" ? state.lastAt : null,
    };
    cache.set(state, value);
    return value;
  };
}
