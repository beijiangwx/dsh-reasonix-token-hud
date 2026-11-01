import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, createView, initialState, tierAt, usageOfEvent } from "../lib/fold.js";

const at = (iso) => Date.parse(iso);
const header = { createdAt: at("2026-11-02T00:00:00Z") };

const request = (model, provider = "deepseek-account") => ({
  type: "request/header",
  time: at("2026-11-02T01:00:00Z"),
  data: { header: { config: { provider, model } } }
});

const message = (turn, step, usage, iso = "2026-11-02T02:00:00Z") => ({
  type: "assistant/message",
  time: at(iso),
  data: { turn, step, usage }
});

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite
});

function fold(events) {
  let state = initialState(header);
  for (const event of events) state = applyEvent(state, event);
  return state;
}

test("tierAt follows the Beijing weekday peak windows", () => {
  // Monday 2026-11-02, 10:00 Beijing = 02:00Z.
  assert.equal(tierAt(at("2026-11-02T02:00:00Z")), "peak");
  assert.equal(tierAt(at("2026-11-02T01:00:00Z")), "peak"); // 09:00
  assert.equal(tierAt(at("2026-11-02T04:00:00Z")), "off"); // 12:00
  assert.equal(tierAt(at("2026-11-02T06:30:00Z")), "peak"); // 14:30
  assert.equal(tierAt(at("2026-11-02T10:00:00Z")), "off"); // 18:00
  // Saturday 10:00 Beijing.
  assert.equal(tierAt(at("2026-11-07T02:00:00Z")), "off");
  // Monday 23:30 Beijing.
  assert.equal(tierAt(at("2026-11-02T15:30:00Z")), "off");
});

test("usageOfEvent reads both the settlement and the durable-chunk form", () => {
  assert.deepEqual(
    usageOfEvent({
      type: "assistant/message",
      time: 5,
      data: { turn: 1, step: 2, usage: usage(10, 20) }
    }),
    { turn: 1, step: 2, time: 5, usage: usage(10, 20) }
  );
  const stream = [
    { type: "chunk", chunk: { type: "text", text: "hi" } },
    { type: "chunk", chunk: { type: "usage", usage: usage(7, 9) } }
  ];
  assert.deepEqual(usageOfEvent({ type: "assistant/attempt", time: 6, data: { turn: 1, step: 2, stream } }), {
    turn: 1,
    step: 2,
    time: 6,
    usage: usage(7, 9)
  });
  assert.equal(usageOfEvent({ type: "turn/start", time: 1, data: {} }), null);
});

test("one sample lands in totals and in the peak bucket", () => {
  const state = fold([request("deepseek-flash"), message(1, 1, usage(100, 50, 400, 0))]);
  assert.deepEqual(state.totals, {
    uncachedInput: 100,
    cacheRead: 400,
    cacheWrite: 0,
    output: 50,
    requests: 1
  });
  assert.equal(state.buckets["deepseek-account\u0000deepseek-flash\u0000peak"].cacheRead, 400);
  assert.equal(Object.keys(state.buckets).length, 1);
});

test("a later sample for the same attempt replaces the earlier one", () => {
  const state = fold([
    request("deepseek-flash"),
    message(1, 1, usage(100, 10)),
    message(1, 1, usage(120, 30))
  ]);
  assert.deepEqual(state.totals, {
    uncachedInput: 120,
    cacheRead: 0,
    cacheWrite: 0,
    output: 30,
    requests: 1
  });
});

test("a retry opens a new billed attempt and adds instead of replacing", () => {
  const state = fold([
    request("deepseek-flash"),
    message(1, 1, usage(100, 10)),
    { type: "llm/retry-started", time: at("2026-11-02T02:01:00Z"), data: { turn: 1, step: 1 } },
    message(1, 1, usage(80, 20))
  ]);
  assert.deepEqual(state.totals, {
    uncachedInput: 180,
    cacheRead: 0,
    cacheWrite: 0,
    output: 30,
    requests: 2
  });
  assert.equal(Object.keys(state.buckets).length, 1);
});

test("off-peak samples are separated from peak samples", () => {
  const state = fold([
    request("deepseek-flash"),
    message(1, 1, usage(100, 10), "2026-11-02T02:00:00Z"),
    message(2, 1, usage(200, 20), "2026-11-02T12:00:00Z")
  ]);
  assert.equal(state.buckets["deepseek-account\u0000deepseek-flash\u0000peak"].uncachedInput, 100);
  assert.equal(state.buckets["deepseek-account\u0000deepseek-flash\u0000off"].uncachedInput, 200);
  assert.equal(state.totals.requests, 2);
});

test("a model change attributes later samples to the new model", () => {
  const state = fold([
    request("deepseek-flash"),
    message(1, 1, usage(100, 10)),
    request("deepseek-pro"),
    message(2, 1, usage(200, 20))
  ]);
  assert.equal(state.buckets["deepseek-account\u0000deepseek-flash\u0000peak"].uncachedInput, 100);
  assert.equal(state.buckets["deepseek-account\u0000deepseek-pro\u0000peak"].uncachedInput, 200);
  assert.equal(state.totals.requests, 2);
});

test("unrelated events keep the state reference", () => {
  const state = fold([request("deepseek-flash"), message(1, 1, usage(100, 10))]);
  assert.equal(applyEvent(state, { type: "session/title", time: 1, data: { title: "x" } }), state);
  assert.equal(applyEvent(state, { type: "llm/retry-started", time: 1, data: { turn: 9, step: 9 } }), state);
  assert.equal(applyEvent(state, { type: "assistant/message", time: 1, data: { turn: 1, step: 1, usage: usage(0, 0) } }), state);
});

test("malformed events never throw and never change the state", () => {
  const state = fold([request("deepseek-flash")]);
  assert.equal(applyEvent(state, null), state);
  assert.equal(applyEvent(state, "nope"), state);
  assert.equal(applyEvent(state, { type: "assistant/message", data: { usage: { inputTokens: "x" } } }), state);
});

test("the view memoizes by state identity and drops empty buckets", () => {
  const view = createView();
  const state = fold([request("deepseek-flash"), message(1, 1, usage(100, 10))]);
  const first = view(state);
  assert.equal(view(state), first);
  assert.equal(first.v, 1);
  assert.equal(first.buckets.length, 1);
  assert.equal(first.totals.requests, 1);
  assert.notEqual(view({ ...state }), first);
});
