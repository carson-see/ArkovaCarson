# Owed: Jira story + Confluence Bug Tracker row

**These were NOT filed.** The Atlassian connector is unauthenticated in this
session and it is non-interactive, so the OAuth flow could not be run here. It
needs authorizing from claude.ai connector settings, or via `claude mcp` / `/mcp`
in an interactive session. Everything below is paste-ready so filing is
mechanical.

`CLAUDE.md` §3 gates 2, 3 and 4 are **NOT met** until these land.

---

## 1. Jira story

**Project:** SCRUM · **Type:** Story · **Parent epic:** required (§5.1 — a story
without a parent gets bounced to Needs Human by live rule
`019dca9d-8cd5-73c1-b911-77a481538d2f`). File under the epic that owns the edge
MCP / verification surface, the same one SCRUM-3797 sits under.

**Summary:**

```
Verify-by-fingerprint times out in prod — bpchar/text mismatch makes idx_anchors_fingerprint_lookup unusable
```

**Description** (§5.1 caps this at ~200 chars plus the Confluence link — longer
payloads round-trip-fail through the MCP edit endpoint):

```
get_public_anchor_by_fingerprint compares character(64) to text, so Postgres casts the column and the index goes unused; the SECURED-partition scan exceeds statement_timeout. Fix: migration 0442. See Confluence.
```

**Labels:** `bug`, `production`, `T3`

**Acceptance criteria:**

1. `get_public_anchor_by_fingerprint` casts the parameter (`lower(p_fingerprint)::bpchar`), never the column.
2. Prod `EXPLAIN` for a fingerprint lookup shows `Index Scan using idx_anchors_fingerprint_lookup` with an `Index Cond`.
3. The edge MCP tools `verify` (by fingerprint) and `get_fingerprint` return a result rather than `isError: "Document verification timed out"`, re-smoked against `https://edge.arkova.ai`.
4. `tests/rls/fingerprint-lookup-index-plan.test.ts` is green in CI, and demonstrably red against the pre-0442 body.
5. T3 soak evidence attached: 48h window, clean-mirror or isolated rig, rollback rehearsal.
6. Migration 0442 applied to prod and the ledger row reconciled to the numeric prefix `0442` (CLAUDE.md §0 rule 10).

**Subtasks** (§5.1 — every story needs them, and each must close before the
parent can go Done; avoid the `[DoD]` summary prefix, it collides with the
Jira→Confluence sync hook):

* `[Soak] Provision an isolated rig and run the 48h T3 window for 0442`
* `[Verify] Re-smoke verify-by-fingerprint and get_fingerprint against edge.arkova.ai`
* `[Close-out] Apply 0442 to prod and reconcile the ledger row to numeric 0442`
* `[Close-out] Confluence Data Model page + Bug Tracker row`

**Confluence page to create** (§5.1 title format
`SCRUM-NNN — <summary>`, parented under space `A` homepage `163950`): use the
content of `VERIFICATION.md` in this directory as the body.

**Doc Update Matrix (§4):** this changes a DB function, so the **Data Model**
page is the one owed.

---

## 2. Confluence Bug Tracker row

Master log: [Bug Tracker — Master Log](https://arkova.atlassian.net/wiki/spaces/A/pages/88768514)
(canonical since 2026-04-26; the Google Sheet is archive only).

| Field | Value |
|---|---|
| **ID** | next free `BUG-2026-09-08-NNN` |
| **Date found** | 2026-09-08 |
| **Found by** | SCRUM-3797 edge catch-up deploy smoke, check 5 and 6 |
| **Severity** | High — a shipped, user-facing feature is 100% unavailable in production |
| **Status** | Fix written, pre-soak, not applied to prod |
| **Component** | Database / `public.get_public_anchor_by_fingerprint`; surfaces on edge MCP `verify` + `get_fingerprint` |
| **Environment** | Production, Supabase `vzwyaatejekddvltxyye` |
| **Symptom** | `verify` (by fingerprint) and `get_fingerprint` on `https://edge.arkova.ai` return `isError: "Document verification timed out"` |
| **Root cause** | `anchors.fingerprint` is `character(64)`; the RPC parameter is `text`. No `bpchar = text` operator exists, so Postgres casts the COLUMN (`Filter: ((fingerprint)::text = …)`), which makes the btree `idx_anchors_fingerprint_lookup` unusable. The planner falls back to `idx_anchors_status_secured_submitted` at cost 2,302,395 over the ~3.5M-row SECURED partition and blows `statement_timeout`. |
| **Fix** | Migration `0442_fingerprint_lookup_bpchar_cast.sql` — cast the PARAMETER: `lower(p_fingerprint)::bpchar`. Prod `EXPLAIN (ANALYZE)` with the cast: `Index Scan using idx_anchors_fingerprint_lookup`, 3.020 ms. |
| **Regression test** | `tests/rls/fingerprint-lookup-index-plan.test.ts` — pins the PLAN (Index Cond under `enable_seqscan = off`), not the clock. Verified red against the 0386 body, green against 0442. |
| **Why it escaped** | The 12h retro-soak rig fixture is 10 rows, where a sequential scan is instant. The defect is invisible below roughly a million rows. Same family as `project_hollow_200_statement_timeout_swallow.md`, except this one fails CLOSED — the caller gets `isError`, never a hollow success. |
| **Related** | `0370` / SCRUM-3031 — the identical bpchar/text mismatch on this same column, in `batch_insert_anchors`. Third occurrence of the class (0370, this, and 0386's incorrect comment asserting the index was safe). |
| **Evidence** | `docs/staging/fingerprint-timeout-0442/VERIFICATION.md`, `docs/staging/edge-retro-2026-09-07/DEPLOY.md` finding 1 |

### Second row owed from the same smoke — NOT this PR

`DEPLOY.md` finding 2 is a separate, unfixed defect and needs its own row:
`api.arkova.ai/api/v1/verify/:id` publishes `created_at` under the field name
`anchor_timestamp`, understating the anchoring moment by up to ten minutes on a
frozen public contract (§1.8) and against §1.5's "Network Observed Time". The
edge is now correct and the worker is wrong. Out of scope here — this PR touches
one migration.
