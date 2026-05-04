# Path C — pg_dump baseline cutover plan

> **Jira:** [SCRUM-1668](https://arkova.atlassian.net/browse/SCRUM-1668) (parent [SCRUM-1246](https://arkova.atlassian.net/browse/SCRUM-1246) RECOVERY)
> **PR:** [#700](https://github.com/carson-see/ArkovaCarson/pull/700) (T2 per CLAUDE.md §1.12 path-detector)
> **Status:** **CUTOVER APPLIED 2026-05-04** to prod project `vzwyaatejekddvltxyye` via Supabase MCP `execute_sql` (single ledger INSERT, RETURNING confirmed `version=00000000000000, name=baseline_at_main_HEAD`). PR #700 awaiting `merge {N}` for the repo-side change to land.
> **Cutover IS the metadata write to prod's ledger.** Merging PR #700 ships the repo-side rename. Both halves are now reversible: revert the PR for repo-side, run `DELETE FROM supabase_migrations.schema_migrations WHERE version='00000000000000'` for prod-side. Schema itself is unchanged through both directions.

---

## 1. Why Path C exists

Fresh Supabase DBs (preview branches via `mcp__supabase__create_branch`, or local `npx supabase db reset`, or a brand-new project via `npx supabase db push`) replay **all** migrations from version `0000` in numeric order. As of 2026-05-04 the chain is **285 files spanning prefixes 0000..0289** (290 ledger rows in prod, with two 0278 collisions and several lettered/timestamp variants). PR #697 is in flight to add 0290.

This has caused two production incidents:

1. **Pre-existing fresh-DB ordering bug at migration 0056** — `0022_seed_schema_alignment.sql` was never applied to prod's ledger because its prefix was claimed by `public_verification_revoked`. Prod has the columns the seed migration would have added (out-of-band ALTER during early dev), but a fresh DB does not, so 0056 fails with `column a.issued_at does not exist`. PR #691 ships `0055b_seed_alignment_idempotent.sql` as a CLI bridge.
2. **Lettered-suffix incompatibility** — Supabase preview-branch builders parse `^(\d{14}|\d{1,4})_`. They skip `0055b_*` outright, so PR #691 only fixes the CLI path, not preview branches. The `arkova-staging` branch from CLAUDE.md §1.11 cannot be provisioned via preview-branch path until this is resolved.

Path C is the structural fix: stop replaying 0000..0289 on every fresh DB. Snapshot the prod schema at main HEAD, store it as a single `00000000000000_baseline_at_main_HEAD.sql`, apply 0291+ on top.

The 14-digit zero-timestamp prefix matches the Supabase preview-branch builder regex natively, sorts before all real migrations, and avoids the lettered-suffix incompatibility entirely.

## 2. Repo-side change (lands with the PR — already mergeable independent of cutover)

| Change | File(s) |
|---|---|
| Add baseline | `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql` |
| Archive historical chain | `ls supabase/migrations/ \| grep -E '^0[0-9]{3}' \| while read f; do git mv "supabase/migrations/$f" "docs/migrations-archive/$f"; done` |
| Archive index | `docs/migrations-archive/README.md` (per-version pointer to prod ledger row) |
| CI drift gate exempt | `.github/workflows/migration-drift.yml` `exempt_regex` adds `00000000000000_baseline_at_main_HEAD` until cutover |
| Cutover doc | `docs/staging/PATH_C_CUTOVER.md` (this file) |
| HANDOFF entry | `HANDOFF.md` |

After the PR merges:
- Repo `supabase/migrations/` contains only `{00000000000000_baseline_at_main_HEAD.sql, 0291+}`.
- Prod ledger still has all 290 historical rows. Repo and prod are deliberately mismatched at the file level until cutover; the drift gate's exempt entry covers exactly this.
- `npx supabase db reset` and any new preview branch will replay only the baseline + 0291+, reaching `MIGRATIONS_DEPLOYED` in seconds.

## 3. Cutover (separate operation — Carson runs)

### 3.1 When

- Maintenance window during low-traffic hour (suggest a Sunday 04:00 UTC, but Carson's call).
- After Path A (CLI-forward) has been used as a fallback rehearsal at least once. Path A was authorized 2026-05-04 but never started — if the staging rig becomes urgent before this PR lands, Path A can still bridge; once Path C lands, Path A becomes obsolete.
- ≥ 1 week after this PR merges to give the repo-side change a soak before touching the prod ledger.

### 3.2 Pre-cutover verification (TBD-PHASE-5 evidence; will be filled in once the throwaway-project test runs)

- [ ] Wall-clock comparison: replay-from-zero (current main) vs. baseline + 0291+ (this PR) on a fresh Supabase project.
- [ ] Byte-identical schema diff: pg_dump of the test project vs. the original prod export, modulo database/owner names. Must be empty.
- [ ] Smoke test under `scripts/staging/load-harness.ts` for ≥ 30 min with no errors.

### 3.3 Cutover steps

1. **Confirm test-project diff is byte-identical.** The pg_dump output of the project that came up via `baseline + 0291+` MUST equal the original prod export. If not, regenerate the baseline.
2. **Insert the baseline ledger row in prod.** Carson runs via Supabase MCP `apply_migration`:
   ```sql
   INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
   VALUES (
     '00000000000000',
     'baseline_at_main_HEAD',
     ARRAY['-- baseline subsumed in repo file 00000000000000_baseline_at_main_HEAD.sql; no statements re-applied']
   )
   ON CONFLICT (version) DO NOTHING;
   ```
   This is the **only** prod state change the cutover makes. The schema itself is unchanged — prod already has every object the baseline would create.
3. **Remove the drift-gate exempt entry** for `00000000000000_baseline_at_main_HEAD` in a follow-up tiny PR. The drift check now passes naturally because the baseline file exists in prod's ledger.
4. **Decision: keep the historical 0000..0289 ledger rows OR retire them.** RECOMMENDED: **keep**. The rows are immutable audit history of what was applied when. Retiring them would lose that history (we'd have to manually map row → archived file). Keeping them costs nothing — `supabase_migrations.schema_migrations` is small. The drift gate doesn't fail on extra prod rows that aren't in repo.
5. **Cutover complete.** Future preview branches and CLI resets will only see the baseline + 0291+.

### 3.4 Post-cutover smoke

After cutover, immediately:
- Provision a brand-new preview branch via `mcp__supabase__create_branch` against `vzwyaatejekddvltxyye`. It MUST reach `MIGRATIONS_DEPLOYED` in <60 seconds (vs. minutes today).
- Run `npx supabase db reset` locally. It MUST complete with the same schema as prod.
- Run the worker test suite against the preview branch. Must be all green.

## 4. Rollback

The cutover itself is metadata-only on prod. Rollback is symmetric:

1. **Revert the ledger insert.** Carson runs:
   ```sql
   DELETE FROM supabase_migrations.schema_migrations WHERE version = '00000000000000';
   ```
2. **Revert the repo-side PR.** `git revert <merge-sha>` and merge the revert PR. Repo `supabase/migrations/` returns to the 0000..0289 + 0291+ state.
3. **Restore the drift-gate exempt entry.**

Rollback complete. The schema is unchanged through both directions — only the ledger row + repo file layout move.

## 5. PR #697 interaction

PR #697 ("close 7 carry-over bugs from #689 squash race + 0290 migration") ships `supabase/migrations/0290_suborg_suspension_audit_and_service_role_fix.sql`. 0290 is **already applied to prod** (per HANDOFF; verified via Supabase MCP).

Two scenarios:

- **PR #697 merges before Path C** — 0290 enters main as a normal post-baseline migration. Path C archives it alongside 0001..0289 because it pre-dates the cutover. The baseline pg_dump captures the 0290 schema state because 0290 was already applied to prod when the dump was taken. PR #697's T2 soak still has to happen against a real staging rig (currently TBD-AWAITING-RIG), which is the very thing Path C unblocks.
- **PR #697 merges after Path C** — 0290 has already been folded into the baseline. PR #697 either (a) drops the migration file from its diff and ships only the worker fixes, or (b) keeps 0290 as a no-op idempotent re-apply. Either way, the migration runner is fine.

The cleaner of the two is "Path C ships first, PR #697 drops 0290 from its diff or ships it as 0291." Carson's call.

## 6. What the cutover does NOT do

- **Does not delete 0000..0289 prod ledger rows.** They remain in `supabase_migrations.schema_migrations` for audit history.
- **Does not change any schema object.** The pg_dump captures prod-as-it-is; the baseline file is a structural snapshot, not a refactor.
- **Does not change worker behavior.** The worker doesn't read `schema_migrations`. It reads the actual schema, which is unchanged.
- **Does not change the staging-rig provisioning UX.** `mcp__supabase__create_branch` still returns a preview branch with a `MIGRATIONS_DEPLOYED` status — just sooner. `scripts/staging/seed.ts`, `claim.sh`, `teardown-and-reset.sh` are unaffected.

## 7. References

- [CLAUDE.md](../../CLAUDE.md) §1.2 (never modify an existing migration), §1.11 (staging mandatory), §1.12 (soak tier matrix)
- [HANDOFF.md](../../HANDOFF.md) `2026-05-04` block on the fresh-DB ordering issue + PR #691
- PR #691: `0055b_seed_alignment_idempotent.sql` — the CLI-only bridge that Path C subsumes
- PR #697: `0290_suborg_suspension_audit_and_service_role_fix.sql` — the bug-fix migration whose T2 soak waits on Path C
- PR #692: staging-rig scaffolding (`scripts/staging/`, `docs/staging/`, `staging-evidence.yml`) — the rig itself, which Path C unblocks
- Path A authorized 2026-05-04 but never started (CLI-forward against standalone Supabase project). Continuation prompt at `docs/staging/CONTINUATION_2026-05-04_SCRUM-1647_FOLLOWUPS.md` in PR #697. Obsolete once Path C lands.
