# agents.md — `docs/sprint-0/lane2/`

**What lives here:** the Lane 2 (Product & Growth) slice of PI-1 Sprint 0 — **specs + designs only, no code**. Authored 2026-06-18 by Claude operating the Lane-2 personas (Architect, API Engineer, Full-stack, Front-end, DBA) under Carson's oversight.

**Status:** draft PR `lane2/s0-visibility-predesign` → GitHub milestone #24 (Sprint 0 — Foundation & Hardening). T0. Carson merges (after #1208, which carries the lane manifest these docs reference).

**Index:** see [`README.md`](./README.md) — contents table, DoD scorecard, findings (F1–F11), and Carson decisions.

## Rules for editing this folder
- These are **internal engineering specs**. Per CLAUDE.md §4, **Confluence is the source-of-truth doc**; the canonical S0-5.1 spec page lives under the Sprint-0 AUDIT page (Confluence 83689473). Keep this folder and that page in sync, or demote one to a pointer.
- **Don't add running-surface changes here.** This is the spec lane; implementation is Sprint 1 (VIS-01 = SCRUM-2510, KEY-EXPIRY = SCRUM-2507) and later (revenue funnel O2, Instant Secure O3).
- **Stay in Lane 2.** Chain/proof (Lane 1), CE/connectors/BigQuery (Lane 3), CLAUDE.md (Carson), the migration ledger + `database.types.ts` (sprint migration owner) are **cite-only** from here.
- The **shared-threshold table** in `S0-5.1-...spec.md` §5 is consumed by both VIS-01 and Lane-1's S0-5.2 drift gate — **any change is a cross-lane change**.

## Handoffs
- **CONSUME ←** lane manifest + operating model (PR #1208); Lane-1 visibility-signal inventory + Bitcoin-Dev review (PR #1208); CLAUDE.md v-next pointer (PR #1210).
- **PRODUCE →** VIS-01 (SCRUM-2510) + KEY-EXPIRY (SCRUM-2507) build lists; shared thresholds → Lane-1 S0-5.2; Instant-Secure dependency map → Lane-1 chain RPC (Train D 0341, incoming).
