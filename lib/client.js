// reasonix-token-hud — client half (browser bundle).
//
// Adds one right-sidebar tab ("用量与费用") plus a compact live cost pill in the
// Conversation header. Every number is read from Session projections, so the
// HUD re-renders as the Host folds new events and needs no polling:
//
//   · usageMeter       — this plugin's Host unit: totals split by provider/model
//                        and by peak/off-peak tier (needed for exact pricing).
//   · tokenUsage       — dsh-token-meter totals; the fallback when the Host half
//                        is not composed.
//   · contextPressure  — prompt size and context window of the latest request.
//   · contextBreakdown — heuristic system/tools/message composition.
//
// Bundle format: the shell's __ModuleLoader__ CommonJS-style wrapper; only
// 'react' is required. No build step — this file is served raw.
window.__ModuleLoader__.load({
	id: "reasonix-token-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useEffect, useMemo, useState } = React;

		const ID = "reasonix-token-hud";
		const KIND = "reasonix-token-hud";
		const RATES_KEY = "reasonix-token-hud/rates/v1";
		const RATES_EVENT = "reasonix-token-hud:rates";

		// Account balance rides the first-party account controller
		// (ctx.remote.account.getBalance) — the same numbers Settings → Account
		// shows. Signed-out or API-key-only compositions return no balance and the
		// dock chip simply stays hidden.
		const BALANCE_POLL_MS = 300000;

		/** Peak rates in CNY per million tokens (DeepSeek-V4.1-Flash, official list). */
		const DEFAULT_RATES = { input: 2, cacheRead: 0.04, output: 8, offPeakHalf: true };

		const COLORS = {
			input: "#4c8cff",
			cacheRead: "#2fb673",
			cacheWrite: "#a06bff",
			output: "#f59e42"
		};

		// ── styles ───────────────────────────────────────────────────────────
		const CSS_TAG = "reasonix-token-hud/panel";
		if (typeof document !== "undefined") {
			const existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]");
			const tag = existing === null ? document.createElement("style") : existing;
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = [
				".uh-root{display:flex;flex-direction:column;gap:12px;height:100%;box-sizing:border-box;overflow:auto;padding:16px 14px 28px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.45;scrollbar-width:thin}",
				".uh-head{display:flex;align-items:center;justify-content:space-between;gap:10px}",
				".uh-eyebrow{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary,#9aa0a8);font-size:11.5px;letter-spacing:.03em}",
				".uh-dot{width:6px;height:6px;border-radius:50%;background:#2fb673;box-shadow:0 0 0 3px rgba(47,182,115,.16);flex:none}",
				".uh-dot.uh-idle{background:var(--dsw-alias-label-tertiary,#8a8f98);box-shadow:none;opacity:.7}",
				".uh-title{max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11.5px}",
				".uh-hero{display:flex;flex-direction:column;gap:1px;padding:2px 0 4px}",
				".uh-cost{font-size:32px;font-weight:650;line-height:1.08;letter-spacing:-.02em;font-variant-numeric:tabular-nums}",
				".uh-cost.uh-zero{color:var(--dsw-alias-label-tertiary,#8a8f98);font-weight:550}",
				".uh-sub{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11.5px}",
				".uh-card{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));border-radius:10px;padding:11px 12px;display:flex;flex-direction:column;gap:9px}",
				".uh-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}",
				".uh-card-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#9aa0a8);letter-spacing:.02em}",
				".uh-card-aside{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}",
				".uh-bar{height:6px;border-radius:3px;background:rgba(127,127,127,.16);overflow:hidden;display:flex}",
				".uh-bar>i{display:block;height:100%;min-width:0;transition:width .25s ease}",
				".uh-bar.uh-warn>i{background:#f0a33a!important}",
				".uh-bar.uh-danger>i{background:#e5484d!important}",
				".uh-context-nums{display:flex;align-items:baseline;justify-content:space-between;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}",
				".uh-context-nums b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600;font-size:12px}",
				".uh-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}",
				".uh-cell{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:1px;min-width:0}",
				".uh-cell b{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.25}",
				".uh-cell span{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				".uh-row{display:flex;align-items:center;gap:8px;font-size:11.5px;min-height:20px}",
				".uh-row .uh-name{flex:1;display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary,#9aa0a8)}",
				".uh-row .uh-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".uh-swatch{width:7px;height:7px;border-radius:2px;flex:none}",
				".uh-row .uh-num{color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums;min-width:54px;text-align:right}",
				".uh-row .uh-amt{font-variant-numeric:tabular-nums;min-width:64px;text-align:right;color:var(--dsw-alias-label-primary,#e6e6e6)}",
				".uh-tag{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:4px;font-size:10px;line-height:1;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-tertiary,#8a8f98);flex:none}",
				".uh-tag.uh-peak{background:rgba(245,158,66,.14);color:#e08a2e}",
				".uh-tag.uh-off{background:rgba(47,182,115,.14);color:#2a9d67}",
				".uh-saving{display:flex;align-items:center;gap:6px;font-size:11px;color:#2a9d67}",
				".uh-models{display:flex;flex-direction:column;gap:6px}",
				".uh-model{display:flex;flex-direction:column;gap:3px;padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14))}",
				".uh-model:first-child{border-top:none;padding-top:0}",
				".uh-model-head{display:flex;align-items:center;gap:6px;font-size:11.5px}",
				".uh-model-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6e6e6)}",
				".uh-model-cost{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#9aa0a8)}",
				".uh-model-sub{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}",
				".uh-settings{border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));padding-top:10px}",
				".uh-settings>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#9aa0a8);font-size:11.5px;user-select:none}",
				".uh-settings>summary::-webkit-details-marker{display:none}",
				".uh-settings>summary::before{content:\"\\2699\";font-size:11px;opacity:.8}",
				".uh-settings>summary::after{content:\"\\2304\";margin-left:auto;font-size:10px;opacity:.6;transition:transform .2s ease}",
				".uh-settings[open]>summary::after{transform:rotate(180deg)}",
				".uh-fields{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-top:10px}",
				".uh-field label{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-bottom:3px;white-space:nowrap}",
				".uh-field input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2));border-radius:6px;color:inherit;font:inherit;font-size:12px;padding:4px 6px;font-variant-numeric:tabular-nums}",
				".uh-check{display:flex;align-items:center;gap:7px;margin-top:9px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a8)}",
				".uh-check input{accent-color:#4c8cff;margin:0}",
				".uh-reset{align-self:flex-start;border:none;background:none;color:var(--dsw-alias-label-tertiary,#8a8f98);font:inherit;font-size:10.5px;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}",
				".uh-reset:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}",
				".uh-note{font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
				".uh-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;min-height:220px;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
				".uh-empty b{color:var(--dsw-alias-label-secondary,#9aa0a8);font-size:13px;font-weight:600}",
				".uh-empty span{font-size:11.5px;line-height:1.6;max-width:260px}",
				".uh-empty svg{width:30px;height:30px;opacity:.55;margin-bottom:2px}",
				".uh-pill{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2));background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a8);font:inherit;font-size:11.5px;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap}",
				".uh-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary,#e6e6e6)}",
				".uh-pill:focus-visible{outline:2px solid #4c8cff;outline-offset:1px}",
				".uh-pill svg{width:12px;height:12px;flex:none;opacity:.85}",
				// Composer-dock balance chip: mirrors ui-chat's StatsPills metrics so the
				// chip sits on the same 20px line as 「缓存命中」 rather than inventing a
				// second row style.
				".uhq-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}",
				".uhq-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}",
				".uhq-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
				".uhq-pill.uhq-low{color:#e08a2e}",
				".uhq-pill.uhq-critical{color:#e5484d}",
				".uhq-pill svg{flex:none;width:14px;height:14px}",
				".uhq-label{text-overflow:ellipsis;min-width:0;overflow:hidden}",
				"@media (max-width:520px){.uh-root{padding:12px 10px 24px}.uh-cost{font-size:28px}}"
			].join("");
			if (existing === null) document.head.appendChild(tag);
		}

		// ── formatting ───────────────────────────────────────────────────────
		/** Compact token count: 1,234 · 12.3K · 1.25M · 2.4B. */
		function fmtTokens(value) {
			const n = Number(value) || 0;
			const abs = Math.abs(n);
			if (abs >= 1e9) return trim(n / 1e9, 2) + "B";
			if (abs >= 1e6) return trim(n / 1e6, 2) + "M";
			if (abs >= 1e4) return trim(n / 1e3, 1) + "K";
			return Math.round(n).toLocaleString("en-US");
		}

		function trim(value, digits) {
			return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
		}

		/** CNY amount: keeps a readable precision for fractions of a cent. */
		function fmtCost(value) {
			const n = Number(value) || 0;
			if (n === 0) return "¥0.00";
			if (Math.abs(n) < 0.0001) return "¥" + n.toFixed(6);
			if (Math.abs(n) < 0.01) return "¥" + n.toFixed(4);
			if (Math.abs(n) < 1) return "¥" + n.toFixed(3);
			return "¥" + n.toFixed(2);
		}

		function fmtPct(value) {
			const n = Number(value) || 0;
			return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "%";
		}

		function totalTokensOf(totals) {
			if (!totals) return 0;
			return (
				(Number(totals.uncachedInput) || 0) +
				(Number(totals.cacheRead) || 0) +
				(Number(totals.cacheWrite) || 0) +
				(Number(totals.output) || 0)
			);
		}

		// ── account balance (dsh-key-usage integration) ──────────────────────
		function numberOrNull(value) {
			if (value === null || value === undefined || value === "") return null;
			const n = Number(value);
			return Number.isFinite(n) ? n : null;
		}

		/** CNY/USD amount with the symbol in front; two decimals is the billing precision. */
		function fmtMoney(amount, currency) {
			const n = Number(amount);
			if (!Number.isFinite(n)) return "—";
			const code = typeof currency === "string" ? currency.toUpperCase() : "";
			const symbol = code === "USD" ? "$" : code === "" || code === "CNY" ? "¥" : code + " ";
			const text = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
			return (n < 0 ? "-" : "") + symbol + text;
		}

		/**
		 * Fold the account controller's balance value into one display number.
		 * `value` holds topped-up wallets, `bonusWallets` the granted ones; the
		 * account page treats either as spendable, so the chip shows their sum and
		 * keeps the split for the tooltip. CNY wins when both currencies exist.
		 * @param state - `{ status: "ready", value, bonusWallets }` or a failure value.
		 * @returns a normalized balance, or null when nothing is spendable.
		 */
		function pickBalance(state) {
			if (!state || state.status !== "ready" || !Array.isArray(state.value)) return null;
			const wallets = state.value
				.map((wallet) => ({ currency: wallet?.currency, amount: numberOrNull(wallet?.balance) }))
				.filter((wallet) => wallet.amount !== null);
			if (wallets.length === 0) return null;
			const chosen = wallets.find((wallet) => wallet.currency === "CNY") ?? wallets[0];
			const gift = (Array.isArray(state.bonusWallets) ? state.bonusWallets : [])
				.filter((wallet) => wallet?.currency === chosen.currency)
				.reduce((sum, wallet) => sum + (numberOrNull(wallet.balance) ?? 0), 0);
			return {
				provider: null,
				currency: chosen.currency,
				topUp: chosen.amount,
				gift: gift > 0 ? gift : null,
				amount: chosen.amount + gift,
				fetchedAt: Date.now()
			};
		}

		// ── tier + pricing ───────────────────────────────────────────────────
		/** Same rule as the Host fold: Beijing weekdays 09–12 and 14–18 are peak. */
		function tierAt(time) {
			const t = typeof time === "number" && Number.isFinite(time) ? time : Date.now();
			const d = new Date(t + 8 * 60 * 60 * 1000);
			const day = d.getUTCDay();
			if (day === 0 || day === 6) return "off";
			const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
			const peak = (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
			return peak ? "peak" : "off";
		}

		function normalizeRates(raw) {
			const source = raw && typeof raw === "object" ? raw : {};
			const number = (value, fallback) => {
				const n = Number(value);
				return Number.isFinite(n) && n >= 0 ? n : fallback;
			};
			return {
				input: number(source.input, DEFAULT_RATES.input),
				cacheRead: number(source.cacheRead, DEFAULT_RATES.cacheRead),
				output: number(source.output, DEFAULT_RATES.output),
				offPeakHalf: source.offPeakHalf === undefined ? DEFAULT_RATES.offPeakHalf : source.offPeakHalf === true
			};
		}

		function loadRates() {
			try {
				const parsed = JSON.parse(localStorage.getItem(RATES_KEY) || "null");
				return normalizeRates(parsed);
			} catch {
				return { ...DEFAULT_RATES };
			}
		}

		function persistRates(rates) {
			try {
				localStorage.setItem(RATES_KEY, JSON.stringify(rates));
			} catch {
				// A locked-down storage area only costs us persistence.
			}
		}

		/** Rates shared by the panel and the header pill; panel edits pulse the pill. */
		function useRates() {
			const [rates, setRates] = useState(loadRates);
			useEffect(() => {
				const onChange = () => setRates(loadRates());
				window.addEventListener(RATES_EVENT, onChange);
				return () => window.removeEventListener(RATES_EVENT, onChange);
			}, []);
			const update = (next) => {
				const normalized = normalizeRates(next);
				setRates(normalized);
				persistRates(normalized);
				window.dispatchEvent(new Event(RATES_EVENT));
			};
			return [rates, update];
		}

		/**
		 * One shared balance source for the dock chip. The first subscriber starts
		 * a five-minute poll; the last one stops it. `configure` supplies the
		 * account query — the account Remote namespace is optional composition, so
		 * a signed-out or API-key-only deployment simply never yields a balance.
		 */
		function createBalanceStore() {
			let snapshot = {
				status: "idle",
				amount: null,
				currency: "CNY",
				topUp: null,
				gift: null,
				fetchedAt: null,
				provider: null,
				refreshing: false
			};
			const listeners = new Set();
			let timer = null;
			let inflight = null;
			let refs = 0;
			let source = null;
			const emit = (next) => {
				snapshot = next;
				for (const listener of listeners) listener(snapshot);
			};
			const load = (force) => {
				if (inflight !== null) return inflight;
				if (typeof source !== "function") {
					emit({ ...snapshot, status: "unavailable", refreshing: false });
					return Promise.resolve();
				}
				if (force) emit({ ...snapshot, refreshing: true });
				inflight = (async () => {
					try {
						const outcome = await source();
						const value = outcome && outcome.ok === true ? outcome.value : null;
						if (value === null) {
							// Signed out, or the account controller refused the read.
							emit({ ...snapshot, status: snapshot.amount === null ? "unavailable" : snapshot.status, refreshing: false });
							return;
						}
						const picked = pickBalance(value);
						if (picked === null) {
							const next =
								snapshot.amount !== null ? snapshot.status : value.status === "ready" ? "empty" : "unavailable";
							emit({ ...snapshot, status: next, refreshing: false });
							return;
						}
						emit({ ...picked, status: "ready", refreshing: false });
					} catch {
						emit({ ...snapshot, status: snapshot.amount === null ? "unavailable" : snapshot.status, refreshing: false });
					} finally {
						inflight = null;
					}
				})();
				return inflight;
			};
			return {
				configure(loader) {
					source = typeof loader === "function" ? loader : null;
					if (source !== null && refs > 0 && snapshot.status === "unavailable") void load(false);
				},
				get: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				start() {
					refs += 1;
					if (refs !== 1) return;
					void load(false);
					timer = setInterval(() => {
						void load(false);
					}, BALANCE_POLL_MS);
				},
				stop() {
					refs = Math.max(0, refs - 1);
					if (refs === 0 && timer !== null) {
						clearInterval(timer);
						timer = null;
					}
				},
				refresh(force) {
					return load(force === true);
				}
			};
		}

		const balanceStore = createBalanceStore();

		function useBalance() {
			const [snapshot, setSnapshot] = useState(() => balanceStore.get());
			useEffect(() => {
				const unsubscribe = balanceStore.subscribe(setSnapshot);
				balanceStore.start();
				return () => {
					unsubscribe();
					balanceStore.stop();
				};
			}, []);
			return [snapshot, (force) => balanceStore.refresh(force)];
		}

		/** Price one (model, tier) bucket. Cache writes are billed at the miss rate. */
		function bucketCost(bucket, rates) {
			const factor = bucket.tier === "off" && rates.offPeakHalf !== false ? 0.5 : 1;
			const input = (Number(bucket.uncachedInput) || 0) * rates.input;
			const cacheRead = (Number(bucket.cacheRead) || 0) * rates.cacheRead;
			const cacheWrite = (Number(bucket.cacheWrite) || 0) * rates.input;
			const output = (Number(bucket.output) || 0) * rates.output;
			const scale = factor / 1e6;
			return {
				input: input * scale,
				cacheRead: cacheRead * scale,
				cacheWrite: cacheWrite * scale,
				output: output * scale,
				total: (input + cacheRead + cacheWrite + output) * scale,
				saved: Math.max(0, (Number(bucket.cacheRead) || 0) * (rates.input - rates.cacheRead)) * scale
			};
		}

		/**
		 * Price every bucket and aggregate by category and model.
		 * @returns totals plus a `models` array sorted by token volume.
		 */
		function priceBuckets(buckets, rates) {
			const summary = {
				total: 0,
				saved: 0,
				cat: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
				peakTokens: 0,
				offTokens: 0,
				models: []
			};
			const byModel = new Map();
			for (const bucket of buckets) {
				const cost = bucketCost(bucket, rates);
				const tokens =
					(Number(bucket.uncachedInput) || 0) +
					(Number(bucket.cacheRead) || 0) +
					(Number(bucket.cacheWrite) || 0) +
					(Number(bucket.output) || 0);
				summary.total += cost.total;
				summary.saved += cost.saved;
				summary.cat.input += cost.input;
				summary.cat.cacheRead += cost.cacheRead;
				summary.cat.cacheWrite += cost.cacheWrite;
				summary.cat.output += cost.output;
				if (bucket.tier === "off") summary.offTokens += tokens;
				else summary.peakTokens += tokens;

				const name = typeof bucket.model === "string" && bucket.model !== "" ? bucket.model : "未知模型";
				let model = byModel.get(name);
				if (model === undefined) {
					model = { name, tokens: 0, cost: 0, peakTokens: 0, offTokens: 0 };
					byModel.set(name, model);
				}
				model.tokens += tokens;
				model.cost += cost.total;
				if (bucket.tier === "off") model.offTokens += tokens;
				else model.peakTokens += tokens;
			}
			summary.models = [...byModel.values()].sort((a, b) => b.tokens - a.tokens);
			return summary;
		}

		/**
		 * When the Host half is absent, reconstruct one bucket from the built-in
		 * `tokenUsage` totals, priced at the tier in force right now.
		 */
		function fallbackBuckets(usage) {
			if (!usage) return [];
			const bucket = {
				provider: null,
				model: null,
				tier: tierAt(Date.now()),
				uncachedInput: Number(usage.uncachedInputTokens) || 0,
				cacheRead: Number(usage.cacheReadTokens) || 0,
				cacheWrite: Number(usage.cacheWriteTokens) || 0,
				output: Number(usage.outputTokens) || 0
			};
			return totalTokensOf({
				uncachedInput: bucket.uncachedInput,
				cacheRead: bucket.cacheRead,
				cacheWrite: bucket.cacheWrite,
				output: bucket.output
			}) > 0
				? [bucket]
				: [];
		}

		function fallbackTotals(usage) {
			return {
				uncachedInput: Number(usage?.uncachedInputTokens) || 0,
				cacheRead: Number(usage?.cacheReadTokens) || 0,
				cacheWrite: Number(usage?.cacheWriteTokens) || 0,
				output: Number(usage?.outputTokens) || 0,
				requests: 0
			};
		}

		// ── small visuals ────────────────────────────────────────────────────
		function UsageGlyph() {
			return h(
				"svg",
				{ viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				h("rect", { x: 1.5, y: 8.5, width: 3, height: 6, rx: 1, fill: "currentColor" }),
				h("rect", { x: 6.5, y: 4.5, width: 3, height: 10, rx: 1, fill: "currentColor", opacity: 0.7 }),
				h("rect", { x: 11.5, y: 1.5, width: 3, height: 13, rx: 1, fill: "currentColor", opacity: 0.45 })
			);
		}

		function WalletGlyph() {
			return h(
				"svg",
				{ viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				h("rect", { x: 1.75, y: 3.75, width: 12.5, height: 8.5, rx: 2, stroke: "currentColor", strokeWidth: 1.2 }),
				h("path", { d: "M10.8 8h2.2", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" }),
				h("circle", { cx: 11.7, cy: 8, r: 0.65, fill: "currentColor" })
			);
		}

		function Card(props) {
			return h(
				"div",
				{ className: "uh-card" },
				props.title === undefined
					? null
					: h(
							"div",
							{ className: "uh-card-head" },
							h("span", { className: "uh-card-title" }, props.title),
							props.aside === undefined ? null : h("span", { className: "uh-card-aside" }, props.aside)
						),
				props.children
			);
		}

		function TokenCell(props) {
			return h(
				"div",
				{ className: "uh-cell", title: props.exact },
				h("b", null, fmtTokens(props.value)),
				h("span", null, props.label)
			);
		}

		function CategoryRow(props) {
			return h(
				"div",
				{ className: "uh-row" },
				h(
					"span",
					{ className: "uh-name" },
					h("i", { className: "uh-swatch", style: { background: props.color } }),
					h("span", null, props.label)
				),
				h("span", { className: "uh-num" }, fmtTokens(props.tokens)),
				h("span", { className: "uh-amt" }, fmtCost(props.cost))
			);
		}

		// ── panel sections ───────────────────────────────────────────────────
		function ContextCard(props) {
			const { pressure, breakdown } = props;
			const used =
				pressure && typeof pressure.projectedTokens === "number"
					? pressure.projectedTokens
					: pressure && typeof pressure.pressureTokens === "number"
						? pressure.pressureTokens
						: null;
			const windowSize = pressure && typeof pressure.contextWindow === "number" ? pressure.contextWindow : null;
			const pct = used !== null && windowSize !== null && windowSize > 0 ? Math.min(100, (used / windowSize) * 100) : null;
			const parts = breakdown
				? [
						{ key: "system", label: "系统", value: Number(breakdown.systemTokens) || 0, color: "#8a8f98" },
						{ key: "tools", label: "工具", value: Number(breakdown.toolsTokens) || 0, color: "#4c8cff" },
						{ key: "message", label: "消息", value: Number(breakdown.messageTokens) || 0, color: "#2fb673" }
					]
				: [];
			const partTotal = parts.reduce((sum, part) => sum + part.value, 0);

			return h(
				Card,
				{ title: "上下文占用", aside: pct === null ? "无采样" : fmtPct(pct) },
				pct === null
					? h(
							"div",
							{ className: "uh-context-nums" },
							h("span", null, "等待下一次请求的用量采样")
						)
					: h(
							"div",
							{ className: "uh-bar", "aria-hidden": true },
							h("i", {
								style: {
									width: Math.max(1.5, pct) + "%",
									background: pct >= 85 ? "#e5484d" : pct >= 60 ? "#f0a33a" : "#4c8cff"
								}
							})
						),
				pct === null
					? null
					: h(
							"div",
							{ className: "uh-context-nums" },
							h("b", null, fmtTokens(used), " / ", fmtTokens(windowSize)),
							h("span", null, pressure?.projectedTokens !== undefined ? "下次请求预计" : "最近请求")
						),
				partTotal > 0
					? h(
							"div",
							null,
							h(
								"div",
								{ className: "uh-bar", "aria-hidden": true, style: { height: "4px" } },
								parts.map((part) =>
									part.value <= 0
										? null
										: h("i", {
												key: part.key,
												style: { width: (part.value / partTotal) * 100 + "%", background: part.color }
											})
								)
							),
							h(
								"div",
								{ className: "uh-model-sub", style: { marginTop: "6px" } },
								parts.map((part) =>
									h(
										"span",
										{ key: part.key, style: { display: "inline-flex", alignItems: "center", gap: "4px" } },
										h("i", { className: "uh-swatch", style: { background: part.color } }),
										part.label,
										" ",
										fmtTokens(part.value)
									)
								)
							)
						)
					: null
			);
		}

		function CostCard(props) {
			const { buckets, price, totals } = props;
			const categories = [
				{ key: "input", label: "未缓存输入", color: COLORS.input, tokens: totals.uncachedInput, cost: price.cat.input },
				{ key: "cacheRead", label: "缓存读取", color: COLORS.cacheRead, tokens: totals.cacheRead, cost: price.cat.cacheRead },
				{ key: "cacheWrite", label: "缓存写入", color: COLORS.cacheWrite, tokens: totals.cacheWrite, cost: price.cat.cacheWrite },
				{ key: "output", label: "输出", color: COLORS.output, tokens: totals.output, cost: price.cat.output }
			].filter((category) => category.tokens > 0 || category.cost > 0);
			const sum = categories.reduce((total, category) => total + category.cost, 0);

			return h(
				Card,
				{ title: "费用构成", aside: fmtCost(price.total) },
				sum > 0
					? h(
							"div",
							{ className: "uh-bar", "aria-hidden": true },
							categories.map((category) =>
								category.cost <= 0
									? null
									: h("i", {
											key: category.key,
											style: { width: Math.max(1, (category.cost / sum) * 100) + "%", background: category.color }
										})
							)
						)
					: null,
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "2px" } },
					categories.map((category) =>
						h(CategoryRow, {
							key: category.key,
							label: category.label,
							color: category.color,
							tokens: category.tokens,
							cost: category.cost
						})
					)
				),
				price.saved > 0 ? h("div", { className: "uh-saving" }, "缓存命中已省 " + fmtCost(price.saved)) : null,
				price.peakTokens + price.offTokens > 0
					? h(
							"div",
							{ className: "uh-model-sub" },
							h("span", null, "高峰 " + fmtTokens(price.peakTokens)),
							h("span", null, "空闲 " + fmtTokens(price.offTokens))
						)
					: null,
				buckets.length === 0 ? h("div", { className: "uh-sub" }, "暂无计费用量") : null
			);
		}

		function ModelsCard(props) {
			const { models, totals } = props;
			if (models.length === 0) return null;
			return h(
				Card,
				{ title: "按模型", aside: totals.requests > 0 ? totals.requests + " 次请求" : undefined },
				h(
					"div",
					{ className: "uh-models" },
					models.slice(0, 6).map((model) =>
						h(
							"div",
							{ className: "uh-model", key: model.name },
							h(
								"div",
								{ className: "uh-model-head" },
								h("span", { className: "uh-model-name", title: model.name }, model.name),
								h("span", { className: "uh-model-cost" }, fmtCost(model.cost))
							),
							h(
								"div",
								{ className: "uh-model-sub" },
								h("span", null, fmtTokens(model.tokens) + " tokens"),
								model.peakTokens > 0 ? h("span", { className: "uh-tag uh-peak" }, "峰 " + fmtTokens(model.peakTokens)) : null,
								model.offTokens > 0 ? h("span", { className: "uh-tag uh-off" }, "闲 " + fmtTokens(model.offTokens)) : null
							)
						)
					)
				)
			);
		}

		function Settings(props) {
			const { rates, onChange } = props;
			const field = (key, label) =>
				h(
					"div",
					{ className: "uh-field" },
					h("label", { htmlFor: "uh-rate-" + key }, label),
					h("input", {
						id: "uh-rate-" + key,
						type: "number",
						min: 0,
						step: 0.01,
						value: rates[key],
						onChange: (event) => {
							const value = Number(event.target.value);
							onChange({ ...rates, [key]: Number.isFinite(value) && value >= 0 ? value : 0 });
						}
					})
				);
			return h(
				"details",
				{ className: "uh-settings" },
				h("summary", null, "计价设置 · CNY / 百万 tokens"),
				h("div", { className: "uh-fields" }, field("input", "输入（未命中）"), field("cacheRead", "缓存读取"), field("output", "输出")),
				h(
					"label",
					{ className: "uh-check" },
					h("input", {
						type: "checkbox",
						checked: rates.offPeakHalf !== false,
						onChange: (event) => onChange({ ...rates, offPeakHalf: event.target.checked })
					}),
					"空闲时段按高峰价 50% 计"
				),
				h(
					"button",
					{ type: "button", className: "uh-reset", onClick: () => onChange({ ...DEFAULT_RATES }) },
					"恢复默认价（deepseek-flash）"
				)
			);
		}

		function Empty() {
			return h(
				"div",
				{ className: "uh-empty" },
				h(UsageGlyph),
				h("b", null, "还没有计费用量"),
				h("span", null, "发送一条消息后，这里会实时显示 token 用量、上下文占用和本次会话费用。")
			);
		}

		function Panel(props) {
			const { useProjection, useSession } = props;
			const meter = useProjection("usageMeter");
			const usage = useProjection("tokenUsage");
			const pressure = useProjection("contextPressure");
			const breakdown = useProjection("contextBreakdown");
			const title = useProjection("title");
			const running = useSession((snapshot) => Boolean(snapshot && snapshot.running));
			const [rates, updateRates] = useRates();

			const model = useMemo(() => {
				const bucketList = meter && Array.isArray(meter.buckets) && meter.buckets.length > 0 ? meter.buckets : fallbackBuckets(usage);
				const totals = meter && meter.totals ? meter.totals : fallbackTotals(usage);
				return {
					buckets: bucketList,
					totals,
					price: priceBuckets(bucketList, rates)
				};
			}, [meter, usage, rates]);

			const tokens = totalTokensOf(model.totals);
			if (tokens === 0) {
				return h("div", { className: "uh-root" }, h(Empty));
			}

			const cacheHitBase = (Number(model.totals.uncachedInput) || 0) + (Number(model.totals.cacheRead) || 0) + (Number(model.totals.cacheWrite) || 0);
			const cacheHit = cacheHitBase > 0 ? ((Number(model.totals.cacheRead) || 0) / cacheHitBase) * 100 : null;
			const fallback = !(meter && Array.isArray(meter.buckets) && meter.buckets.length > 0);
			const sessionName = typeof title === "string" && title.length > 0 ? title : "当前会话";

			return h(
				"div",
				{ className: "uh-root", "data-reasonix-token-hud": true },
				h(
					"div",
					{ className: "uh-head" },
					h(
						"span",
						{ className: "uh-eyebrow" },
						h("i", { className: "uh-dot" + (running ? "" : " uh-idle") }),
						running ? "运行中" : "空闲"
					),
					h("span", { className: "uh-title", title: sessionName }, sessionName)
				),
				h(
					"div",
					{ className: "uh-hero" },
					h("div", { className: "uh-cost" }, fmtCost(model.price.total)),
					h(
						"div",
						{ className: "uh-sub" },
						"本会话估算 · CNY",
						model.totals.requests > 0 ? " · " + model.totals.requests + " 次请求" : "",
						model.price.saved > 0 ? " · 已省 " + fmtCost(model.price.saved) : ""
					)
				),
				h(ContextCard, { pressure, breakdown }),
				h(
					Card,
					{ title: "Token 用量", aside: cacheHit === null ? undefined : "缓存命中 " + fmtPct(cacheHit) },
					h(
						"div",
						{ className: "uh-grid" },
						h(TokenCell, { label: "未缓存输入", value: model.totals.uncachedInput }),
						h(TokenCell, { label: "缓存读取", value: model.totals.cacheRead }),
						h(TokenCell, { label: "缓存写入", value: model.totals.cacheWrite }),
						h(TokenCell, { label: "输出", value: model.totals.output })
					),
					h(
						"div",
						{ className: "uh-context-nums" },
						h("span", null, "本次会话合计"),
						h("b", null, fmtTokens(tokens) + " tokens")
					)
				),
				h(CostCard, { buckets: model.buckets, price: model.price, totals: model.totals }),
				h(ModelsCard, { models: model.price.models, totals: model.totals }),
				fallback
					? h(
							"div",
							{ className: "uh-note" },
							"Host 投影未启用：费用按当前时段单价整体估算，跨高峰边界的会话可能有偏差。"
						)
					: null,
				h(Settings, { rates, onChange: updateRates }),
				h(
					"div",
					{ className: "uh-note" },
					"数据来自本次会话的用量投影，随事件实时更新。空闲时段按高峰价 50% 计，未扣除中国法定节假日；估算值，以官方账单为准。"
				)
			);
		}

		/** Compact header monitor: live cost, hidden until the session has usage. */
		function HeaderPill(props) {
			const { useProjection, open } = props;
			const meter = useProjection("usageMeter");
			const usage = useProjection("tokenUsage");
			const [rates] = useRates();

			const totals = meter && meter.totals ? meter.totals : fallbackTotals(usage);
			const buckets = meter && Array.isArray(meter.buckets) && meter.buckets.length > 0 ? meter.buckets : fallbackBuckets(usage);
			const tokens = totalTokensOf(totals);
			if (tokens === 0) return null;
			const price = priceBuckets(buckets, rates);
			return h(
				"button",
				{
					type: "button",
					className: "uh-pill",
					title: "用量与费用：约 " + fmtCost(price.total) + " · " + fmtTokens(tokens) + " tokens",
					"aria-label": "查看用量与费用",
					onClick: open
				},
				h(UsageGlyph),
				h("span", null, fmtCost(price.total))
			);
		}

		/**
		 * Composer-dock chip: account balance on the same line as 「缓存命中」.
		 * Hidden before the first answer and when the key-usage route is absent;
		 * clicking asks key-usage for a live re-query.
		 */
		function BalancePill() {
			const [balance, refresh] = useBalance();
			if (balance.status === "idle" || balance.status === "unavailable") return null;
			const ready = balance.status === "ready";
			const currency = balance.currency || "CNY";
			const label = ready
				? "余额 " + fmtMoney(balance.amount, currency)
				: balance.refreshing
					? "余额 …"
					: "余额 —";
			const details = ready
				? [
						"账户余额 " + fmtMoney(balance.amount, currency),
						balance.topUp === null ? null : "充值 " + fmtMoney(balance.topUp, currency),
						balance.gift === null ? null : "赠送 " + fmtMoney(balance.gift, currency),
						balance.fetchedAt === null ? null : "更新于 " + clockText(balance.fetchedAt)
					].filter(Boolean)
				: ["尚未查询到余额"];
			details.push("点击刷新");
			const tone = ready ? (balance.amount < 1 ? " uhq-critical" : balance.amount < 5 ? " uhq-low" : "") : "";
			return h(
				"span",
				{ className: "uhq-anchor", "data-composer-stat": "balance" },
				h(
					"button",
					{
						type: "button",
						className: "uhq-pill" + tone,
						title: details.join(" · "),
						"aria-label": "账户余额",
						onClick: () => {
							void refresh(true);
						}
					},
					h(WalletGlyph),
					h("span", { className: "uhq-label" }, label)
				)
			);
		}

		function clockText(time) {
			try {
				return new Date(time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
			} catch {
				return "";
			}
		}

		// ── plugin entry ─────────────────────────────────────────────────────
		const inject = ["slots", "sidebarRightTabs", "sidebarRight"];

		/**
		 * Register the right-sidebar tab (type + body + guide entry) and the
		 * header monitor. Both surfaces are additive: the tab uses a fresh kind,
		 * the pill joins the utilities list.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.inject(inject, (inner) => {
				inner.effect(
					() =>
						inner.sidebarRightTabs.register({
							id: ID,
							kind: KIND,
							title: () => "用量与费用",
							guide: [
								{
									id: KIND,
									order: 40,
									title: () => "用量与费用",
									description: () => "实时 token 用量、上下文占用与会话费用"
								}
							]
						}),
					"reasonix-token-hud: tab type"
				);

				inner.slots.inject("sidebar.right.pane.tab", () =>
					inner.slots.register({ name: "sidebar.right.pane.tab", key: ID }, Panel)
				);

				inner.slots.inject("conversation.session.header.utilities", () =>
					inner.slots.register(
						{
							name: "conversation.session.header.utilities",
							id: ID,
							order: 40,
							inject: () => ({
								open: () => {
									try {
										inner.sidebarRight.openTab(KIND);
									} catch (error) {
										console.warn("[reasonix-token-hud] openTab failed", error);
									}
								}
							})
						},
						HeaderPill
					)
				);

				// The composer dock is the line carrying 「缓存命中」; order 2 puts the
				// balance chip right after that usage pill, before the context meter.
				inner.slots.inject("conversation.composer.dock", () =>
					inner.slots.register({ name: "conversation.composer.dock", id: "balance", order: 2 }, BalancePill)
				);
			});

			// The account namespace is optional composition: when it is absent (or
			// nobody is signed in) the balance store reports no value and the chip
			// stays hidden without affecting the rest of the HUD.
			ctx.inject(["remote", "remote.account", "locale"], (accountCtx) => {
				balanceStore.configure(async () => {
					const release = globalThis.__DSH_BOOT__ && globalThis.__DSH_BOOT__.release;
					const version =
						release && typeof release.version === "string" && release.version !== "" ? release.version : "0.2.1";
					const active = accountCtx.locale.getSnapshot().active;
					return accountCtx.remote.account.getBalance({
						version,
						locale: typeof active === "string" && active !== "" ? active : "zh-CN",
						timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
					});
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internal = {
			tierAt,
			fmtTokens,
			fmtCost,
			fmtMoney,
			pickBalance,
			numberOrNull,
			normalizeRates,
			bucketCost,
			priceBuckets,
			fallbackBuckets,
			DEFAULT_RATES
		};
		return module.exports;
	}
});
