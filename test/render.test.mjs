import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A deliberately small React stand-in: enough of createElement and the hooks
// this bundle uses to execute every component function once and walk the tree.
// It cannot prove React behaviour, but it proves the components do not touch
// undefined props or call hooks conditionally.
const registered = [];
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			registered.push(definition);
		}
	}
};

function createElement(type, props, ...children) {
	const merged = { ...(props ?? {}) };
	const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
	if (flat.length === 1) merged.children = flat[0];
	else if (flat.length > 1) merged.children = flat;
	return { type, props: merged };
}

const ReactStub = {
	createElement,
	useEffect: () => {},
	useMemo: (factory) => factory(),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}]
};

await import(pathToFileURL(join(import.meta.dirname, "..", "lib", "client.js")).href);
const definition = registered.find((entry) => entry.id === "reasonix-token-hud");
const client = definition.factory((name) => {
	if (name === "react") return ReactStub;
	throw new Error("unexpected module request: " + name);
});

/** Render a node tree depth-first, expanding function components. */
function render(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (Array.isArray(node)) {
		for (const child of node) render(child, out);
		return out;
	}
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (typeof node.type === "function") {
		render(node.type(node.props ?? {}), out);
		return out;
	}
	if (typeof node.type === "string") {
		render(node.props.children, out);
		return out;
	}
	return out;
}

const meter = {
	v: 1,
	totals: { uncachedInput: 1200, cacheRead: 48000, cacheWrite: 0, output: 3400, requests: 7 },
	buckets: [
		{
			provider: "deepseek-account",
			model: "deepseek-flash",
			tier: "peak",
			uncachedInput: 900,
			cacheRead: 30000,
			cacheWrite: 0,
			output: 2400
		},
		{
			provider: "deepseek-account",
			model: "deepseek-flash",
			tier: "off",
			uncachedInput: 300,
			cacheRead: 18000,
			cacheWrite: 0,
			output: 1000
		}
	],
	firstAt: Date.now() - 3600_000,
	lastAt: Date.now()
};

const fixtures = {
	usageMeter: meter,
	tokenUsage: { uncachedInputTokens: 1200, cacheReadTokens: 48000, cacheWriteTokens: 0, outputTokens: 3400 },
	contextPressure: { projectedTokens: 92000, pressureTokens: 88000, contextWindow: 128000 },
	contextBreakdown: { systemTokens: 15000, toolsTokens: 24000, messageTokens: 53000 },
	title: "侧边栏用量插件"
};

/** Install the plugin against a fake client context and collect registrations. */
function boot() {
	const slots = [];
	const tabTypes = [];
	const opened = [];
	const scope = {
		effect: (factory) => {
			const dispose = factory();
			return typeof dispose === "function" ? dispose : () => {};
		},
		slots: {
			inject: (_name, callback) => callback(),
			register: (options, component) => {
				slots.push({ ...options, component });
				return () => {};
			}
		},
		sidebarRightTabs: {
			register: (value) => {
				tabTypes.push(value);
				return () => {};
			}
		},
		sidebarRight: {
			openTab: (kind) => opened.push(kind)
		}
	};
	client.apply({
		inject: (_deps, callback) => callback(scope),
		get: () => undefined
	});
	return { slots, tabTypes, opened };
}

const panelProps = {
	useProjection: (key) => fixtures[key],
	useSession: (select) => select({ running: true }),
	sessionId: "session-test"
};

test("the tab type registers a page kind with one guide entry", () => {
	const { tabTypes } = boot();
	assert.equal(tabTypes.length, 1);
	const type = tabTypes[0];
	assert.equal(type.id, "reasonix-token-hud");
	assert.equal(type.kind, "reasonix-token-hud");
	assert.equal(type.title(), "用量与费用");
	assert.ok(Array.isArray(type.guide));
	assert.equal(type.guide.length, 1);
	assert.equal(type.guide[0].id, "reasonix-token-hud");
	assert.equal(type.guide[0].order, 40);
	assert.equal(type.guide[0].title(), "用量与费用");
});

test("the tab body, header pill and dock chip all register", () => {
	const { slots } = boot();
	const names = slots.map((slot) => slot.name).sort();
	assert.deepEqual(names, ["conversation.composer.dock", "conversation.session.header.utilities", "sidebar.right.pane.tab"]);
	const body = slots.find((slot) => slot.name === "sidebar.right.pane.tab");
	assert.equal(body.key, "reasonix-token-hud");
	const dock = slots.find((slot) => slot.name === "conversation.composer.dock");
	assert.equal(dock.id, "balance");
	assert.equal(dock.order, 2);
});

test("the balance chip stays hidden until the balance source answers", () => {
	const { slots } = boot();
	const dock = slots.find((slot) => slot.name === "conversation.composer.dock");
	assert.equal(render(dock.component({})).length, 0);
});

test("the panel renders the cost, context, tokens and models", () => {
	const { slots } = boot();
	const text = render(slots.find((slot) => slot.name === "sidebar.right.pane.tab").component(panelProps)).join(" ");
	assert.ok(text.includes("费用构成"), "cost card");
	assert.ok(text.includes("上下文占用"), "context card");
	assert.ok(text.includes("Token 用量"), "token card");
	assert.ok(text.includes("deepseek-flash"), "model row");
	assert.ok(text.includes("缓存命中"), "cache hit ratio");
	assert.ok(text.includes("本会话估算"), "hero label");
	assert.ok(/¥\d/.test(text), "a CNY amount");
});

test("the panel falls back to the built-in usage projection", () => {
	const { slots } = boot();
	const fallbackProps = {
		...panelProps,
		useProjection: (key) => (key === "tokenUsage" ? fixtures.tokenUsage : undefined)
	};
	const text = render(slots.find((slot) => slot.name === "sidebar.right.pane.tab").component(fallbackProps)).join(" ");
	assert.ok(text.includes("Host 投影未启用"));
	assert.ok(text.includes("Token 用量"));
});

test("an empty session shows the empty state", () => {
	const { slots } = boot();
	const text = render(
		slots
			.find((slot) => slot.name === "sidebar.right.pane.tab")
			.component({ useProjection: () => undefined, useSession: (select) => select({ running: false }), sessionId: "s" })
	).join(" ");
	assert.ok(text.includes("还没有计费用量"));
});

test("the header pill shows cost, opens the tab and hides while empty", () => {
	const { slots, opened } = boot();
	const pill = slots.find((slot) => slot.name === "conversation.session.header.utilities");
	const tree = pill.component({ ...panelProps, open: () => opened.push("clicked") });
	const text = render(tree).join(" ");
	assert.ok(/¥\d/.test(text));
	tree.props.onClick();
	assert.ok(opened.includes("clicked"));

	const hidden = pill.component({
		...panelProps,
		useProjection: () => undefined,
		open: () => {}
	});
	assert.equal(hidden, null);
});

test("the header inject face opens the sidebar tab", () => {
	const { slots, opened } = boot();
	const pill = slots.find((slot) => slot.name === "conversation.session.header.utilities");
	const face = pill.inject();
	face.open();
	assert.deepEqual(opened, ["reasonix-token-hud"]);
});
