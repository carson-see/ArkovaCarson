# Migrations archive — pre-baseline historical chain

The 285 files in this directory are the historical migrations 0000..0289 that ran on every fresh Arkova DB stand-up before Path C ([SCRUM-1668](https://arkova.atlassian.net/browse/SCRUM-1668)). Their schema effects are now subsumed into [`supabase/migrations/00000000000000_baseline_at_main_HEAD.sql`](../../supabase/migrations/00000000000000_baseline_at_main_HEAD.sql).

## Why these moved

Replaying 0000..0289 from zero on every preview-branch / `npx supabase db reset` was:
- **Slow:** minutes per fresh DB
- **Fragile:** the 0055/0056 ordering bug and the lettered-suffix `0055b_*` preview-branch incompatibility blocked the §1.11 staging rig entirely

Path C ships a single 14-digit-zero-timestamp baseline that lexicographically sorts before all real migrations and matches the Supabase preview-branch builder regex `^(\d{14}|\d{1,4})_` natively. Migrations 0291+ continue to apply on top.

## Don't run these manually

- These files are **historical**. The runtime schema came from these migrations being applied to prod between 2024 and 2026-05-04. The current schema state is captured in the baseline.
- A fresh DB built today via the baseline + 0291+ should be functionally equivalent (same tables, columns, constraints, indexes, functions, triggers, policies, grants).
- If you need to understand WHY a particular column / constraint / index exists, `git log` on this directory will get you back to the commit that introduced the migration. The migration filenames preserve the sortable version prefix.

## Cutover

This archive landed at the same time as the baseline. The prod ledger (`supabase_migrations.schema_migrations`) still has all 0000..0289 rows — they're the immutable audit history of what was applied when. Cutover (a separate gated op) inserts a new ledger row for `00000000000000` so the drift gate accepts the new repo layout. See [`docs/staging/PATH_C_CUTOVER.md`](../staging/PATH_C_CUTOVER.md).

## Index

285 files, prefix range `0000..0289` (with prefix collisions at `0068`, `0088`, `0174`, `0175`, `0176`, `0180`, `0236`, `0258`, `0262`, `0265`, `0273`, `0274`, `0278`, `0286` — see `scripts/ci/snapshots/migration-prefix-baseline.json`). For per-file content, read the file directly or check the prod ledger row via Supabase MCP `list_migrations`.
