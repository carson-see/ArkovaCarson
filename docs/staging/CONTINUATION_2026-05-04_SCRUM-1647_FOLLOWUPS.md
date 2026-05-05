# Continuation prompt — SCRUM-1647 carryover + staging-rig 0055b fix

Copy the block below into the next session verbatim. It is self-contained.

---

```text
You are picking up SCRUM-1647 carryover follow-ups + a staging-rig 0055b
hotfix. Read CLAUDE.md, HANDOFF.md (the top "Now" entry titled "2026-05-04
(afternoon) — SCRUM-1647 carryover follow-ups"), and any agents.md in
services/worker/ + supabase/migrations/ before doing anything. Do NOT
merge any PR to main without explicit `merge {N}` from Carson.

CONTEXT (verified at end of previous session)

* PR #697 is OPEN AS DRAFT on branch `claude/scrum-1647-followups` head
  `77696882`. It closes 7 of 12 carryover bugs from PR #689's squash race
  + commits `supabase/migrations/0290_suborg_suspension_audit_and_service_role_fix.sql`
  to repo. 0290 was already applied to prod via Supabase MCP earlier in
  the day (re-apply is no-op via CREATE OR REPLACE). Local verification
  is in the commit body of `77696882`: 4930 / 4930 worker tests pass,
  10/10 frontend useActiveOrg, lint + RLS auth.uid + license deny-list
  + lint:copy + migration prefix uniqueness all clean.
* Bug #10 (orgSuspensionGuard wired into anchor write paths) is in flight
  in PR #696, separate session, separate branch, disjoint file set.
* Bug #12 (~50 callsites of profile.org_id → useActiveOrg, SCRUM-1651
  page-by-page) is intentionally NOT in PR #697 — ships as PR-A2 with
  its own T2 soak.
* arkova-staging Supabase preview branch was provisioned in the previous
  session via Supabase MCP `create_branch` against project_ref
  `vzwyaatejekddvltxyye`. The branch returned project_ref
  `rathfqiqyfuomkfnbkzu` with status `MIGRATIONS_FAILED`. The branch
  builder skipped `0055b_seed_alignment_idempotent.sql` entirely (does
  not recognize lettered-suffix migration filenames; only matches
  `^(\d{14}|\d{1,4})_`) so migration 0056 ran without its prerequisite
  columns and failed with `ERROR: column a.issued_at does not exist`.
* arkova-worker-staging Cloud Run service is NOT yet provisioned. gcloud
  auth in the previous session's shell was expired; needs interactive
  `gcloud auth login` from Carson before that step can proceed.
* HANDOFF.md was refreshed at the end of the previous session with a
  full verification-artifact footer.

YOUR JOB IN THIS SESSION (in order, no deferring)

1. DELETE the broken staging branch first thing.
   * Confirm via Supabase MCP `list_branches` that
     `rathfqiqyfuomkfnbkzu` is still in `MIGRATIONS_FAILED`. Then call
     `delete_branch` against branch id
     `08b02c0f-aa21-41a5-9004-fdcc88f212dd`. This stops the cost clock.

2. Author Path A — `supabase/migrations/0291_fresh_db_recovery.sql` —
   on a NEW branch `claude/scrum-1647-fresh-db-recovery-0291`. The
   migration must:
   * Use a 4-digit numeric prefix (the Supabase preview-branch builder
     parses `^(\d{14}|\d{1,4})_`; 4-digit is what works for both the
     CLI and the branch builder).
   * Be idempotent everywhere via `IF NOT EXISTS` so re-applying on a
     prod that already has the columns is a no-op.
   * Include every schema element 0055b added: `anchor_status` enum
     value `EXPIRED`, `user_role` enum value `ORG_MEMBER`,
     `anchors.label`/`issued_at`/`expires_at`/`revoked_at`/
     `revocation_reason`, the `memberships` table, the
     `anchors_revocation_consistency` / `anchors_label_length` /
     `anchors_revocation_reason_length` constraints, and a defensive
     `CREATE OR REPLACE FUNCTION get_my_credentials` that matches what
     0056 expects.
   * Note: 0291 alone DOES NOT fix 0056's failure on a fresh build,
     because 0056 runs before 0291 in version order. The actual fix
     for fresh-DB compatibility is harder than just adding 0291. See
     step 3.

3. Pick the fresh-DB fix STRATEGY. The hard constraint: Supabase preview
   branches re-apply ALL migrations from version 0000 in numeric order,
   so anything that runs after 0056 cannot help. There is NO 4-digit
   prefix between 0055 and 0056 — they are consecutive integers. Three
   options. PICK ONE WITH CARSON BEFORE WRITING CODE:

   A. CLI-FORWARD WORKFLOW: change the `arkova-staging` provisioning
      strategy to use `npx supabase db push --linked` against a fresh
      Supabase project (not a preview branch). The CLI flow recognizes
      `0055b_*` lettered suffixes. PR-B's scripts/staging/seed.ts +
      claim.sh would be re-pointed at this kind of branch. Pro: keeps
      PR #691's 0055b in place. Con: changes the rig design.

   B. MOVE `0055b` CONTENT INTO `0056`: write a NEW
      `0056_anchor_recipients.sql` (replacing the existing one)
      that begins with all the IF NOT EXISTS guards from 0055b before
      doing 0056's original work. Migrate the existing `0055b` file
      to a no-op tombstone so the historical entry stays. CLAUDE.md
      "never modify an existing migration" applies to migrations that
      are APPLIED to prod; 0056 IS in prod. Carson must explicitly
      waive the constitution rule.

   C. NEW BASELINE: stop replaying 0001..0290 on every staging branch
      build. Generate a single `00000_baseline_at_main_HEAD.sql`
      pg_dump of the prod schema; subsequent migrations 0291+ apply
      on top. Best long-term. Largest scope.

4. Once strategy chosen, implement + run end-to-end:
   * Re-create `arkova-staging` Supabase branch via MCP `create_branch`
     (cost was confirmed in previous session: $0.01344/hr — recheck
     via `get_cost`/`confirm_cost` per MCP requirements).
   * Verify branch reaches `MIGRATIONS_DEPLOYED` / `ACTIVE_HEALTHY`
     state via `list_branches`. If still `MIGRATIONS_FAILED`, debug
     via `get_logs(service='postgres')` and iterate.
   * Apply 0290 to staging via `apply_migration` (already in prod, this
     just registers it on the branch).

5. Provision arkova-worker-staging Cloud Run.
   * Ask Carson to run `gcloud auth login` interactively in the shell
     this session uses, then `gcloud config set project arkova1`, then
     confirm via `gcloud run services list --region us-central1`.
   * Once auth works, `gcloud run deploy arkova-worker-staging
     --source=services/worker --region=us-central1 --no-traffic
     --min-instances=0 --service-account=<TBD> --set-env-vars
     SUPABASE_URL=<staging-branch-url>,SUPABASE_SERVICE_ROLE_KEY=<staging-key>,...`.
     Pull the staging branch URL from Supabase MCP `get_project_url`.
     Pull `SUPABASE_SERVICE_ROLE_KEY` only from the approved service-role
     secret/key source for that project_ref; do not use publishable/anon
     key helpers for the worker service-role env var.

6. Run the T2 soak per CLAUDE.md §1.12.
   * `bash scripts/staging/claim.sh "PR #697 — SCRUM-1647 followups"`
   * `npx tsx scripts/staging/seed.ts` against the staging branch
   * `npx tsx scripts/staging/load-harness.ts` for ≥4h
   * Rollback rehearsal: apply 0290 → run rollback per the file's
     `-- ROLLBACK:` block → re-apply. Confirm app survives both
     transitions.
   * Capture every required field per
     `docs/staging/PR_TEMPLATE.md` T2 block:
     Tier, Staging branch, Worker revision, Soak start, Soak end,
     E2E result, Migration applied, Rollback rehearsed.
   * Edit PR #697 body via `gh pr edit 697 --body ...` and replace
     all the `TBD-AWAITING-RIG` placeholders with real values.
   * `gh pr ready 697` to flip out of draft.

7. Hold for Carson `merge {697}`. Do NOT merge, even if all checks
   green and no review threads remain.

8. After PR #697 merges, deploy to prod via deploy-worker.yml on push
   to main, monitor /health for git_sha match, transition the five
   stories per CLAUDE.md §3 gate 2 — but only after the operator
   [Verify] subtasks (SCRUM-1655/1658/1661/1664/1667) finish their
   sandbox + prod-smoke + Confluence steps.

9. PR-A2 (page-by-page useActiveOrg) is NOT in scope for this
   continuation; it's its own session.

10. PR #693 (zk-proof CI) is also NOT in scope here; sync-with-main +
    re-soak that PR after the rig is healthy.

CONSTRAINTS
* Staging IS mandatory per CLAUDE.md §1.11. No code reaches prod
  without the rig running first.
* Reporter ≠ Resolver Atlassian Automation rule: Carson cannot flip
  any of the five stories to Done unless someone else resolves them.
* `gh pr merge --admin` only with explicit `merge {N}` from Carson.
* If you discover further bugs in PR #697's diff during review, fix
  them on the same branch — do not open a 2nd follow-up PR.
* If an MCP cost-bearing tool is needed (create_branch / create_project),
  call get_cost + confirm_cost first and surface the dollar value to
  Carson before proceeding.
* End the session by updating HANDOFF.md (top "Now" section + the
  verification-artifact footer) and writing a continuation prompt for
  the NEXT session.
```

---

**Reference context that may help (read for understanding, do not paste):**

* [PR #697](https://github.com/carson-see/ArkovaCarson/pull/697)
* [PR #696](https://github.com/carson-see/ArkovaCarson/pull/696) (in flight, parallel)
* [PR #693](https://github.com/carson-see/ArkovaCarson/pull/693)
  (zk-proof, blocked on rig)
* [PR #692](https://github.com/carson-see/ArkovaCarson/pull/692) (rig scaffolding)
* [PR #691](https://github.com/carson-see/ArkovaCarson/pull/691)
  (0055b that didn't survive)
* [SCRUM-1647 epic](https://arkova.atlassian.net/browse/SCRUM-1647)
