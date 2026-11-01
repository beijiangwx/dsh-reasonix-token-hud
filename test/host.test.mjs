import assert from "node:assert/strict";
import test from "node:test";

import { apply, name } from "../lib/index.js";

test("the host half registers exactly one client-visible projection", () => {
	const registered = [];
	const scope = {
		effect: (factory) => {
			const dispose = factory();
			assert.equal(typeof dispose, "function");
		},
		sessionProjections: {
			register: (definition) => {
				registered.push(definition);
				return () => {};
			}
		}
	};
	apply({
		inject: (deps, callback) => {
			assert.deepEqual(deps, ["sessionProjections"]);
			callback(scope);
		}
	});
	assert.equal(name, "reasonix-token-hud");
	assert.equal(registered.length, 1);
	const definition = registered[0];
	assert.equal(definition.key, "usageMeter");
	assert.equal(definition.stateVersion, 1);
	assert.equal(typeof definition.init, "function");
	assert.equal(typeof definition.apply, "function");
	assert.equal(typeof definition.wire.view, "function");
	assert.equal(definition.stateSchema.parse({ any: "thing" }).any, "thing");
});

test("the registered fold produces a JSON-serializable wire value", () => {
	const registered = [];
	apply({
		inject: (_deps, callback) =>
			callback({
				effect: (factory) => factory(),
				sessionProjections: {
					register: (definition) => {
						registered.push(definition);
						return () => {};
					}
				}
			})
	});
	const definition = registered[0];
	let state = definition.init({ createdAt: 1 });
	state = definition.apply(state, {
		type: "request/header",
		time: 2,
		data: { header: { config: { provider: "deepseek-account", model: "deepseek-flash" } } }
	});
	state = definition.apply(state, {
		type: "assistant/message",
		time: Date.parse("2026-11-02T02:00:00Z"),
		data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 } }
	});
	const value = definition.wire.view(state);
	assert.equal(value.totals.uncachedInput, 10);
	assert.equal(value.totals.cacheRead, 90);
	assert.equal(value.totals.requests, 1);
	assert.equal(value.buckets.length, 1);
	assert.equal(value.buckets[0].tier, "peak");
	assert.equal(JSON.parse(JSON.stringify(value)).buckets[0].model, "deepseek-flash");
});
