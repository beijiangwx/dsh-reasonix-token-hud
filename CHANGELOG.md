# Changelog

## 1.0.4 — 2026-11-25

dsh-go native package: per-turn cost, peak / off-peak countdown.

- Status strip now carries the session total, the latest turn's cost and a price-tier
  countdown: `总¥0.04·本轮¥0.042·1h3m后峰`. The two money figures are never dropped;
  the account balance and the countdown give way first.
- Long-press any reply →「本轮费用」shows that reply's own turn cost and copies it. Every
  `assistant/message` id is mapped to its turn, so a reply resolves to its own turn rather
  than the newest one.
- Panel: 「本会话估算」and 「本轮」side by side, a per-turn table (last 50 turns), peak and
  off-peak totals with amounts, and a countdown line
  (`峰时 · 2小时29分后进入谷时（12:00）`).
- Turn note (`turn.note`) adds `¥0.042·峰` to a turn's footnote. Note that the app drops
  plugin notes first when the footnote does not fit (duration → steps → cost → tokens →
  note), so on narrow screens the strip and the long-press menu are the reliable places.
- Peak tiers follow the official pricing page: weekdays 09:00–12:00 and 14:00–18:00 Beijing
  time; weekends and Chinese public holidays are off-peak. The holiday calendar is not
  bundled — set `PEAK_HOLIDAYS` to a JSON array of `YYYY-MM-DD` days to include it.

## 1.0.2 — 2026-11-01

Metadata fix: the package now points at the actual repository,
<https://github.com/beijiangwx/dsh-reasonix-token-hud>. No runtime changes.

## 1.0.1 — 2026-11-01

First public release, renamed from the internal `dsh-usage-hud` build.

- Right-sidebar tab「用量与费用」: session cost, context occupancy, token
  breakdown, cost composition, per-model peak/off-peak split and editable rates.
- Conversation-header cost pill; click opens the sidebar tab.
- Composer-dock balance chip next to「缓存命中」, fed by the first-party account
  controller (`ctx.remote.account.getBalance`) and refreshed on click / every
  five minutes.
- Host-side `usageMeter` session projection: per-sample provider/model and
  peak/off-peak attribution with token-meter-compatible replacement and retry
  semantics.
- 29 Node tests covering the fold, pricing, rendering and plugin registration.

## 0.1.0 — 2026-11-01

Internal build before the public rename: sidebar tab, header pill, cost estimate.
