import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The bundle is written for the Web shell's module loader: it calls
// window.__ModuleLoader__.load({ factory }) and only requires 'react'. Capture
// the registration and materialize the factory with a minimal React stub so the
// pure pricing helpers can be exercised in Node.
const registered = [];
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			registered.push(definition);
		}
	}
};

const ReactStub = {
	createElement: () => null,
	useEffect: () => {},
	useMemo: (factory) => factory(),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}]
};

await import(pathToFileURL(join(import.meta.dirname, "..", "lib", "client.js")).href);

const definition = registered.find((entry) => entry.id === "reasonix-token-hud");
assert.ok(definition, "the bundle registers itself");
const client = definition.factory((name) => {
	if (name === "react") return ReactStub;
	throw new Error("unexpected module request: " + name);
});

const {
	priceBuckets,
	tierAt,
	fmtTokens,
	fmtCost,
	fmtMoney,
	pickBalance,
	normalizeRates,
	fallbackBuckets,
	bucketCost,
	DEFAULT_RATES
} = client.__internal;

test("peak bucket prices input and output at the full rate", () => {
	const cost = bucketCost(
		{ tier: "peak", uncachedInput: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
		DEFAULT_RATES
	);
	assert.equal(cost.total, 10); // ¥2 input + ¥8 output
	assert.equal(cost.saved, 0);
});

test("off-peak bucket is billed at half the peak rate", () => {
	const cost = bucketCost(
		{ tier: "off", uncachedInput: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
		DEFAULT_RATES
	);
	assert.equal(cost.total, 5);
});

test("cache reads are cheap and their saving is reported", () => {
	const cost = bucketCost(
		{ tier: "peak", uncachedInput: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 },
		DEFAULT_RATES
	);
	assert.equal(cost.cacheRead, 0.04);
	assert.equal(Math.round(cost.saved * 100) / 100, 1.96);
});

test("priceBuckets splits categories, tiers and models", () => {
	const buckets = [
		{ provider: "p", model: "deepseek-flash", tier: "peak", uncachedInput: 100, cacheRead: 900, cacheWrite: 0, output: 50 },
		{ provider: "p", model: "deepseek-flash", tier: "off", uncachedInput: 200, cacheRead: 0, cacheWrite: 0, output: 20 },
		{ provider: "p", model: "deepseek-pro", tier: "peak", uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 10 }
	];
	const price = priceBuckets(buckets, DEFAULT_RATES);
	assert.equal(price.models.length, 2);
	assert.equal(price.models[0].name, "deepseek-flash");
	assert.equal(price.models[0].tokens, 1270);
	assert.equal(price.peakTokens, 1060);
	assert.equal(price.offTokens, 220);
	assert.ok(price.total > 0);
	assert.ok(price.cat.cacheRead < price.cat.input + 0.001);
});

test("rates are normalized away from missing or negative values", () => {
	const rates = normalizeRates({ input: -1, cacheRead: "0.5", offPeakHalf: false });
	assert.equal(rates.input, DEFAULT_RATES.input);
	assert.equal(rates.cacheRead, 0.5);
	assert.equal(rates.offPeakHalf, false);
	assert.equal(normalizeRates(null).input, DEFAULT_RATES.input);
});

test("token and cost formatting stays compact", () => {
	assert.equal(fmtTokens(1234), "1,234");
	assert.equal(fmtTokens(12_345), "12.3K");
	assert.equal(fmtTokens(1_250_000), "1.25M");
	assert.equal(fmtCost(0), "¥0.00");
	assert.equal(fmtCost(0.0832), "¥0.083");
	assert.equal(fmtCost(0.0005), "¥0.0005");
});

test("fallback buckets mirror the built-in tokenUsage value", () => {
	const buckets = fallbackBuckets({
		uncachedInputTokens: 100,
		cacheReadTokens: 900,
		cacheWriteTokens: 0,
		outputTokens: 50
	});
	assert.equal(buckets.length, 1);
	assert.equal(buckets[0].cacheRead, 900);
	assert.equal(buckets[0].tier, tierAt(Date.now()));
	assert.deepEqual(fallbackBuckets(undefined), []);
});

test("balance amounts format with their currency", () => {
	assert.equal(fmtMoney(123.456, "CNY"), "¥123.46");
	assert.equal(fmtMoney(12.3, "USD"), "$12.30");
	assert.equal(fmtMoney(-1.2, "CNY"), "-¥1.20");
	assert.equal(fmtMoney(1234.5, "CNY"), "¥1,234.50");
	assert.equal(fmtMoney(Number.NaN, "CNY"), "—");
});

test("pickBalance sums topped-up and granted wallets and prefers CNY", () => {
	const picked = pickBalance({
		status: "ready",
		value: [
			{ currency: "USD", balance: "10.5" },
			{ currency: "CNY", balance: "123.45" }
		],
		bonusWallets: [
			{ currency: "CNY", balance: "23.45" },
			{ currency: "USD", balance: "1" }
		]
	});
	assert.equal(picked.currency, "CNY");
	assert.equal(picked.topUp, 123.45);
	assert.equal(picked.gift, 23.45);
	assert.equal(picked.amount, 146.9);
	assert.equal(typeof picked.fetchedAt, "number");
	assert.equal(pickBalance({ status: "failed" }), null);
	assert.equal(pickBalance(null), null);
	assert.equal(pickBalance({ status: "ready", value: [] }), null);
	assert.equal(pickBalance({ status: "ready", value: [{ currency: "CNY", balance: "n/a" }] }), null);
	assert.equal(pickBalance({ status: "ready", value: [{ currency: "CNY", balance: "0E-16" }] }).amount, 0);
});
