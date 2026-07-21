# 0358 Prod-Apply Runbook — migrate-before-merge (SCRUM-2692 / PR #1552)

**Owner:** Release/Train lane (RTE-delegated prod migration apply, `feedback_rte_owns_prod_migration_apply`). **Status:** STAGED RUNBOOK — **do NOT execute.** **Founder-gated:** apply only on Carson's explicit go-ahead. Draft / `do-not-merge`.

> This runbook does **not** touch PR #1552, its `railb2` soak rig, or prod. It is the pre-written procedure to run **after** the #1552 T3 soak matures and the founder authorizes the apply. Nothing here is a claim of applied prod state.

---

## 0. Why migrate-before-merge

`0358_scrum2692_anchor_txid_journal.sql` is the durable pre-broadcast txid journal — a **T3 money-path + anchor-lifecycle** migration. Per §0 rule 10 and the migration-reservation policy, a PR-owned numeric migration is **applied to prod before the PR merges**, then reconciled in the ledger, so the schema exists before the code that depends on it lands. #1552 carries `0358`; the apply precedes the merge.

**Sequencing gate:** this runs only after
1. the #1552 railb2 T3 soak has **matured** (48h + trigger cycles) and is green — verified via the release-evidence cron, **not assumed** (`feedback_frozen_soak_head_not_orphan`), and
2. Carson has given explicit go-ahead (founder-gated; RTE does not self-authorize a money-path prod DDL).

---

## 1. What 0358 does to prod (lock surface)

| Step | Object | Lock on hot tables |
|---|---|---|
| `CREATE TABLE public.anchor_txid_journal` (+ RLS, indexes) | **new, empty** table | none on existing hot tables |
| `CREATE FUNCTION persist_anchor_txid_journal / resolve_anchor_txid_journal` (SECURITY DEFINER, `SET search_path=public`, `SET statement_timeout='60s'`) | functions | none |
| **`CREATE TRIGGER guard_anchor_txid_journal_lifecycle BEFORE UPDATE OF status ON public.anchors`** (line 428–429) | **`public.anchors` (~3M rows / ~22 GB, hot)** | **`SHARE ROW EXCLUSIVE`** — conflicts with concurrent INSERT/UPDATE/DELETE on anchors and with other DDL; concurrent **SELECT is not blocked** |
| `NOTIFY pgrst, 'reload schema'` (line 758) | PostgREST cache | none |

**The single risk is the trigger on `public.anchors`.** Everything else is a new empty table + functions. Acquiring `SHARE ROW EXCLUSIVE` on anchors while the batch-drain or a feeder is mid-write will (a) block until it can grab the lock and (b) once queued, make every subsequent anchor writer wait behind it — a lock-queue pileup on the busiest table. The two mitigations below eliminate that.

---

## 2. Pre-apply checklist (verify, do not assume)

- [ ] #1552 soak matured + green (release-evidence cron output pasted into the apply record).
- [ ] Carson go-ahead captured (founder-gated).
- [ ] Confirm prod ref `vzwyaatejekddvltxyye` and that `list_migrations` head is `0357` (0358 not yet present).
- [ ] Confirm the **anchor feeder crons are PAUSED** (they already are per `259k pending-anchoring backlog`; re-verify via Cloud Scheduler) and that we are **outside the nightly ~03:00 batch-drain window** — pick a drain-quiet slot so no batch is holding/updating anchor rows.
- [ ] Rollback rehearsed on an isolated clean mirror (the migration footer ROLLBACK block, lines 760–769) — forward + drop + clean re-apply proven before this apply.
- [ ] Have the rollback SQL (footer) ready to paste if the apply misbehaves.

---

## 3. Drain-quiet window + lock_timeout (the safe-apply core)

Run the trigger DDL inside a bounded lock window so it can never pile up behind — or block — anchor writers.

1. **Enter a drain-quiet window.** Feeders already paused; additionally confirm no `POST /jobs/batch-anchors` run is in flight and none is scheduled to fire during the apply. The window need only cover the few seconds of DDL, but must be genuinely quiet on anchor writes.
2. **Bound the lock wait.** Apply with a short `lock_timeout` so the trigger DDL either grabs the lock near-instantly (quiet window) or fails fast instead of queuing:
   ```sql
   SET lock_timeout = '3s';        -- fail fast rather than queue behind a writer
   SET statement_timeout = '60s';  -- belt-and-suspenders
   ```
   If it errors with `canceling statement due to lock timeout`, that means an anchor writer was still active — **do not retry blindly**: re-confirm the quiet window (§2), then re-attempt. A timeout is the safe outcome; a silent multi-minute block is the failure we are preventing.
3. **Apply via MCP** `apply_migration` (name `0358_scrum2692_anchor_txid_journal`, the file body). Supabase wraps a migration in a single transaction, so the whole file (table + functions + trigger + `NOTIFY`) commits atomically or not at all.

> Note: 0358 uses **no `CREATE INDEX CONCURRENTLY`** (all its indexes are on the new empty `anchor_txid_journal`), so — unlike the 0313/0330/0342 convention — there is no non-transactional operator-applied step here. The trigger is the only hot-table touch and it is transactional.

---

## 4. §0 rule 10 — numeric-ledger reconcile (the one expected ledger write)

MCP `apply_migration` records a **timestamp-style** `version` in `supabase_migrations.schema_migrations`, but the migration-drift gate's "PR numeric ledger drift" check requires the **numeric prefix** `0358` present in prod. Immediately after apply, in the same session, reconcile:

```sql
UPDATE supabase_migrations.schema_migrations
SET version = '0358'
WHERE name = '0358_scrum2692_anchor_txid_journal.sql'
  AND version !~ '^[0-9]{4}$';
```

This is the **one expected ledger write** under §1.11A (operator-approved by rule) — it is NOT a `migration repair` and NOT a shared-staging ledger edit. Then confirm the numeric head:

```
list_migrations  -->  head must show 0358 (numeric), not a 14-digit timestamp
```

Do not declare the apply done until `list_migrations` shows the numeric `0358` head.

---

## 5. Post-apply verification

- [ ] `NOTIFY pgrst, 'reload schema'` fired (in the migration) — confirm PostgREST sees the new functions.
- [ ] `anchor_txid_journal` exists with RLS + `FORCE ROW LEVEL SECURITY`, deny-all client policy, service-role `SELECT, DELETE` grant only.
- [ ] `persist_anchor_txid_journal` / `resolve_anchor_txid_journal` present, `SECURITY DEFINER`, `search_path=public`.
- [ ] Trigger `guard_anchor_txid_journal_lifecycle` present on `public.anchors`.
- [ ] `list_migrations` numeric head = `0358`.
- [ ] **Resume feeders / normal drain** only after the above are green.
- [ ] Record the apply (prod ref, migration name, deploy/apply timestamp, `list_migrations` output, soak-evidence link) — then #1552 is clear to merge (release-ops/Carson), since the schema it depends on is now live.

---

## 6. Rollback

If verification fails, apply the footer ROLLBACK block (lines 760–769): drop the trigger, the two functions, `resolve_anchor_txid_journal`, then the table, and `NOTIFY pgrst, 'reload schema'`. The table is new and empty at apply time, so rollback loses no data. Re-confirm `list_migrations` no longer shows `0358` before re-attempting.

---

## 7. Pre-mortem

- **Lock-queue pileup** — mitigated by the drain-quiet window + short `lock_timeout`; a timeout is a safe abort, not a failure to retry blindly.
- **Ledger left timestamp-style** — the numeric-reconcile (§4) is mandatory; skipping it trips the migration-drift gate and the SCRUM-2500 orphan-ledger audit (see `project_orphan_ledger_audit_vs_prod_apply`; 0358 is exempted in `ledger-numeric-exemptions.json` as a pre-merge prod-apply, verify that exemption is present before merge).
- **Applying before the soak matures** — forbidden; the sequencing gate (§0) is the guard. Verify soak via release-evidence cron, never infer from the PR being "old" (`feedback_frozen_soak_head_not_orphan`).
- **Self-authorizing** — forbidden; money-path prod DDL is founder-gated. This runbook is staged, not a go-ahead.

_Last refreshed: 2026-07-21 by RTE — lock surface + rollback verified against `supabase/migrations/0358_scrum2692_anchor_txid_journal.sql` on the #1552 head (agent/s33-w2-l1-t0-gate-audit); NOT executed, no prod state asserted, #1552 and its rig untouched._
