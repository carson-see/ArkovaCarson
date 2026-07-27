# Rail Verification Log — 24h Watch Window (2026-07-20 → 07-21)

**Owner:** Release/Train lane (RTE) — VERIFY-only per the ownership boundary. The parallel release-ops session drives the requeues/merges/prod-apply; this log records outcomes + pre-stages the exact read-only checks to run when each gated event fires. Snapshot captured 2026-07-20 ~19:00Z via `gh`/`gcloud`.

---

## T2 — Deps rail close-out (~02–04Z Jul 21) — PENDING (matures first)

**Rail:** rcb20260719, Supabase `aqvlmkjfvpywdwjykcic`, clock 2026-07-20T13:06:26Z → matures **01:06–01:36Z Jul 21**, close-out ~02–04Z.

**Current snapshot (not yet close-out time):**
| PR | State | Note |
|---|---|---|
| #1524 | **CLOSED 16:47Z** | dependabot auto-closed — "updatable in another way" (NOT an RTE/merge action) |
| #1543 | **CLOSED 16:48Z** | dependabot auto-closed — same |
| #1515 | OPEN | vite+vitest /services/api-gateway |
| #1517 | OPEN | esbuild+vitest /services/api-gateway |
| #1526 | OPEN | undici 7.28→8.7 /services/worker |
| #1587 | OPEN, **queued** | wrangler 4.110→4.112 /edge — in Mergify queue now |
| #1572 | OPEN | adm-zip — to close as superseded by #1524 (per RM) |

**Pending verification (run at close-out):** for each PR that merges, record merge SHA (`gh pr view <n> --json mergeCommit`); confirm prod green post-deploy (`/health` git_sha advances, no 5xx regression). Note the pre-window premise: #1524/#1543 already auto-closed, so the "6-PR deps rail" is effectively #1515/#1517/#1526/#1587 (+#1572 close). Record the actual merged set — do not assume the original 6.

---

## T3 — 1550 → 1555 retarget → 1570 — PARTIAL (1550 verified; 1555/1570 in flight)

| PR | State (19:00Z) | Verified |
|---|---|---|
| #1550 | **MERGED** c7d455df @ 17:58:39Z | ✅ base AI rail landed |
| #1549 | **MERGED** 31764c38 @ 17:58:49Z | ✅ (rode wave3) |
| #1555 | OPEN, base main, `mss=BLOCKED`, do-not-merge+needs-carson-merge | ⏳ retarget→main done (base=main); merge pending — release-ops drives. Recent commits show airail manifest refreshed for #1555 head post-main-merge. |
| #1570 | OPEN, **still Draft**, `mss=BLOCKED` | ⏳ not merged; lands on disclosed-partial per CTO ruling |

**Pending 1570 prod credit-deduction check (run AFTER #1570 merges + deploys):**
- **Trigger:** one REAL anchor from ORGANIC traffic (do NOT create the anchor — §W4/ownership boundary; wait for organic).
- **PRECONDITION (DBA review — the check is vacuous without this):** first assert `ENABLE_ORG_CREDIT_ENFORCEMENT` is **ON** in prod. The credit gate short-circuits to `allowed=true` with NO deduction and NO ledger row when the flag is off (and off is the code/test default). If enforcement is off (plausible under the subscription / no-per-doc-fee model), an organic anchor writes **0** rows and there is nothing to verify. Read `switchboard_flags` / worker env for the org first.
- **Read-only query (prod Supabase `vzwyaatejekddvltxyye`, service-role REST or MCP):**
  ```sql
  -- Post-deploy organic anchor, by its anchor row id. Filter to the create reason
  -- so a legitimate same-anchor refund row (reason='anchor.refund') can't inflate the count.
  SELECT reference_id, reason, count(*) AS rows
  FROM org_credit_deductions
  WHERE reference_id = '<new_anchor_row_id>' AND reason = 'anchor.create'
  GROUP BY reference_id, reason;
  ```
- **Corrected pass/fail rubric (DBA):** the table has `UNIQUE (org_id, reference_id, reason)`, so **2 rows for one (reference_id, reason) is physically impossible** — the old "FAIL = 2 rows" rubric can never fire. **PASS = exactly 1 row AND `reference_id == anchor.id`. RED = 0 rows (with enforcement confirmed ON) or an idempotency-key conflict.** Do NOT use a `GROUP BY reference_id HAVING count(*)>1` fleet sweep: the constraint makes it constraint-blind to the real bug, and it false-positives on refunded anchors (refund shares the same `reference_id` under `reason='anchor.refund'`). The real fleet reconciliation is the SCRUM-2973 per-org sweep (sum of `anchor.create` deductions vs count of billable anchors).
- Rollback pre-staged = 2-commit revert, no schema (per CTO ruling). #1571 dead-man watches the area.
- **Boundary:** release-ops does the immediate post-deploy verification per the CTO ruling; this lane independently confirms the exactly-one-row invariant read-only.

---

## T5 — 1553 → 1558 sequential stack lifts — PENDING (after 1552 rail closes 17:13Z Jul 21)

**Stack:** #1552 (0358) → #1553 (journal-aware crash/fault evidence) → #1558 (freeze signet admission + drain contracts). Stacked-merge protocol (per HANDOFF): merge #1552 → delete branch → #1553 → delete → #1558.

**Current snapshot:**
| PR | Base | State |
|---|---|---|
| #1553 | `agent/s33-w2-l1-t0-gate-audit` (= #1552 head) | OPEN, do-not-merge |
| #1558 | `agent/s33-w2-l1-a-journal-fault-evidence` (= #1553 head) | OPEN, do-not-merge |

**Pending verification (after 17:13Z + #1552 merges):** observe each sequential lift; record that after #1552 merges + its branch deletes, #1553 auto-retargets to main (base→delete-branch auto-retarget preserves CI — `feedback_stacked_pr_retarget_drops_ci`); same for #1558. Record merge SHAs + that CI stayed green through each retarget (no manual `--base` stranding). Blocker inherited from #1552: see the Policy-Lints/DIRTY memo — the stack cannot lift until #1552's conflict + 0358 prod-apply resolve.

---

## Boundary reminder
This lane does not requeue, retarget, merge, prod-apply, or push any of the above objects. It records verified outcomes and flags escalations (see the 1552 memo for the CTO decision owed before 17:13Z).
