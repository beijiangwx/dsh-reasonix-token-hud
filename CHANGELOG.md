# Changelog

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
