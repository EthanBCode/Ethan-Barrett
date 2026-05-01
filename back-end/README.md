# back-end lambdas

This folder contains Lambda handlers split by route:
- leaderboard
- state
- click
- trade
- buy

`state/index.mjs` includes a fix for long-offline accounts by capping per-request trade step replay to prevent Lambda timeout on `/state` when users return after long gaps.

`click`, `trade`, and `buy` now each have dedicated handlers and all trade-aware endpoints share the long-idle replay cap via common helpers.
