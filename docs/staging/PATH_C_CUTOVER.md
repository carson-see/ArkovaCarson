# Path C — pg_dump baseline cutover plan

> **Jira:** [SCRUM-1668](https://arkova.atlassian.net/browse/SCRUM-1668) (parent [SCRUM-1246](https://arkova.atlassian.net/browse/SCRUM-1246) RECOVERY)
> **PR:** [#700](https://github.com/carson-see/ArkovaCarson/pull/700) (migration baseline; T3-class worker/staging evidence now owed before Done because anchor scheduler/batch code changed)
> **Status:** **BASELINE PROD LEDGER ROW RECORDED 2026-05-04** in project `vzwyaatejekddvltxyye` via Supabase MCP `execute_sql` (single ledger INSERT, RETURNING confirmed `version=00000000000000, name=baseline_at_main_HEAD`). `0295_pr700_rls_baseline_reconciliation.sql` was applied to prod on 2026-05-06 after explicit operator authorization; ledger/schema evidence is captured in [`PR700_PROD_0295_VERIFICATION_2026-05-06.md`](./PR700_PROD_0295_VERIFICATION_2026-05-06.md). Anchor batch-policy evidence is captured in [`PR700_ANCHOR_POLICY_VERIFICATION_2026-05-06.md`](./PR700_ANCHOR_POLICY_VERIFICATION_2026-05-06.md). PR #700 is not merge-ready until CI/review are green and worker/staging validation evidence is captured.
> **Cutover IS the metadata write to prod's ledger plus the repo-side baseline/archive move.** Merging PR #700 ships the repo-side rename. Both baseline halves are reversible: revert the PR for repo-side, run `DELETE FROM supabase_migrations.schema_migrations WHERE version='00000000000000'` for prod-side. The separate post-baseline `0295` reconciliation is a forward prod migration and must be tracked as prod schema state, not treated as part of the metadata-only cutover.

---

## 1. Why Path C exists

Fresh Supabase DBs (preview branches via `mcp__supabase__create_branch`, or local `npx supabase db reset`, or a brand-new project via `npx supabase db push`) replay **all** migrations from version `0000` in numeric order. At Path C creation on 2026-05-04, the historical chain was **285 files spanning prefixes 0000..0289** (290 ledger rows in prod, with two 0278 collisions and several lettered/timestamp variants). PR #700 archives that historical replay chain and leaves only the baseline plus active post-baseline migrations in `supabase/migrations/`.

This has caused two production incidents:

1. **Pre-existing fresh-DB ordering bug at migration 0056** — `0022_seed_schema_alignment.sql` was never applied to prod's ledger because its prefix was claimed by `public_verification_revoked`. Prod has the columns the seed migration would have added (out-of-band ALTER during early dev), but a fresh DB does not, so 0056 fails with `column a.issued_at does not exist`. PR #691 ships `0055b_seed_alignment_idempotent.sql` as a CLI bridge.
2. **Lettered-suffix incompatibility** — Supabase preview-branch builders parse `^(\d{14}|\d{1,4})_`. They skip `0055b_*` outright, so PR #691 only fixes the CLI path, not preview branches. The `arkova-staging` branch from CLAUDE.md §1.11 cannot be provisioned via preview-branch path until this is resolved.

Path C is the structural fix: stop replaying 0000..0289 on every fresh DB. Snapshot the prod schema at main HEAD, store it as a single `00000000000000_baseline_at_main_HEAD.sql`, then apply active post-baseline migrations on top. On the current #700 head, those live migrations are `0292_microsoft_graph_webhook_nonces.sql`, `0293_msgraph_nonce_payload_hash_and_compound_rpc.sql`, and `0295_pr700_rls_baseline_reconciliation.sql`.

The 14-digit zero-timestamp prefix matches the Supabase preview-branch builder regex natively, sorts before all real migrations, and avoids the lettered-suffix incompatibility entirely.

## 2. Repo-side change (lands with the PR)

| Change | File(s) |
|---|---|
| Add baseline | `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql` |
| Archive historical chain | `ls supabase/migrations/ \| grep -E '^0[0-9]{3}' \| while read f; do git mv "supabase/migrations/$f" "docs/migrations-archive/$f"; done` |
| Archive index | `docs/migrations-archive/README.md` (per-version pointer to prod ledger row) |
| Drift gate | `.github/workflows/migration-drift.yml` no longer exempts `00000000000000_baseline_at_main_HEAD`; it matches the prod ledger row directly |
| Cutover record | `docs/staging/PATH_C_CUTOVER.md` (this file) |
| HANDOFF entry | `HANDOFF.md` |

After the PR merges:
- Repo `supabase/migrations/` contains only `00000000000000_baseline_at_main_HEAD.sql` plus active post-baseline migrations.
- Prod ledger keeps all historical rows plus the new `00000000000000` baseline row. The historical rows remain audit history; the drift gate accepts the baseline row directly.
- `npx supabase db reset` and any new preview branch replay only the baseline plus active post-baseline migrations, reaching `MIGRATIONS_DEPLOYED` without the historical 0000..0289 ordering trap.

## 3. Cutover Record

### 3.1 What Happened

On 2026-05-04, the baseline ledger row was inserted into prod project `vzwyaatejekddvltxyye` via Supabase MCP `execute_sql`. The operation wrote one metadata row to `supabase_migrations.schema_migrations`; it did not run DDL and did not change application data.

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('00000000000000', 'baseline_at_main_HEAD', ARRAY[...]::text[])
ON CONFLICT (version) DO NOTHING
RETURNING version, name, array_length(statements, 1) AS stmt_count;
-- {"version":"00000000000000","name":"baseline_at_main_HEAD","stmt_count":4}
```

Evidence is captured in [`PATH_C_VERIFICATION_2026-05-04.md`](./PATH_C_VERIFICATION_2026-05-04.md).

### 3.2 Completed Schema Verification

The PHASE 5 check was schema equivalence only. A branch project `aljheljcsrgbtgyshfss` was wiped to empty, the baseline was applied, and schema-object counts were compared against prod: tables, extensions, enums, functions, policies, triggers, and constraints matched. Indexes differed by three known invalid prod indexes (`pg_index.indisvalid=false`) that `pg_dump` correctly omits.

This is **not** a §1.12 worker soak.

### 3.3 Still Owed Before Done

- CI must be green on PR #700.
- `0295_pr700_rls_baseline_reconciliation.sql` is applied to prod `vzwyaatejekddvltxyye`; ledger row `20260506113532 / 0295_pr700_rls_baseline_reconciliation` plus schema/RLS evidence is captured in [`PR700_PROD_0295_VERIFICATION_2026-05-06.md`](./PR700_PROD_0295_VERIFICATION_2026-05-06.md), and Migration Drift rerun [25429502352 / 74603343923](https://github.com/carson-see/ArkovaCarson/actions/runs/25429502352/job/74603343923) passed.
- Fresh-DB/RLS CI must remain green with the baseline plus active post-baseline migrations.
- A worker validation path must run against an approved staging environment: either wait for the shared staging lease to release or use the explicitly approved isolated environment path. Because #700 now touches anchor scheduler/batch code, treat this as T3-class worker/staging evidence unless the source-of-truth DoD is explicitly changed.
- Anchor batch-policy evidence must include the fixed behavior: ordinary `PENDING` anchors are not individually broadcast; the 10,000 pending threshold fires immediately; the 3,000 pending threshold fires only once the oldest pending age reaches 3 hours; the forced flush path still works.
- PR body and evidence must clearly say schema-only equivalence until real worker/staging evidence exists.

### 3.4 Historical Ledger Decision

Keep the historical ledger rows. The rows are immutable audit history of what was applied when. Retiring them would lose that history (we'd have to manually map row to archived file). Keeping them costs nothing; `supabase_migrations.schema_migrations` is small. The drift gate does not fail on extra prod rows that aren't in repo.

## 4. Rollback

The cutover itself is metadata-only on prod. Rollback is symmetric:

1. **Revert the ledger insert.** Carson runs:
   ```sql
   DELETE FROM supabase_migrations.schema_migrations WHERE version = '00000000000000';
   ```
2. **Revert the repo-side PR.** `git revert <merge-sha>` and merge the revert PR. Repo `supabase/migrations/` returns to the historical chain plus whatever active main migrations are present outside #700.
3. **Restore the drift-gate exempt entry.**

Rollback complete for the baseline cutover. The baseline rollback path does not undo post-baseline forward migrations such as `0295`; those need their own reviewed rollback if prod application has already happened.

## 5. PR #697 interaction

PR #697 ("close 7 carry-over bugs from #689 squash race + 0290 migration") ships `supabase/migrations/0290_suborg_suspension_audit_and_service_role_fix.sql`. 0290 is **already present in prod** (per HANDOFF; verified via Supabase MCP).

The current #700 baseline already reflects the prod schema that includes 0290. PR #697 remains active in another session and owns its own migration-file decision (drop, renumber, or make idempotent/no-op). PR #700 should not mutate #697 or acquire the shared staging rig while #697/#695 work is active.

## 6. What the cutover does NOT do

- **Does not delete 0000..0289 prod ledger rows.** They remain in `supabase_migrations.schema_migrations` for audit history.
- **Does not change any schema object.** The pg_dump captures prod-as-it-is; the baseline file is a structural snapshot, not a refactor.
- **Does not change worker behavior.** The worker doesn't read `schema_migrations`. It reads the actual schema, which is unchanged.
- **Does not claim the shared staging rig.** #700 still needs real worker/staging evidence, but that must wait for the #695/#697 lease to release or use an explicitly approved isolated environment.

## 7. References

- [CLAUDE.md](../../CLAUDE.md) §1.2 (never modify an existing migration), §1.11 (staging mandatory), §1.12 (soak tier matrix)
- [HANDOFF.md](../../HANDOFF.md) `2026-05-04` block on the fresh-DB ordering issue + PR #691
- PR #691: `0055b_seed_alignment_idempotent.sql` — the CLI-only bridge that Path C subsumes
- PR #697: `0290_suborg_suspension_audit_and_service_role_fix.sql` — active in another session; #700 treats its migration state as folded into the prod-derived baseline
- PR #692/#699 staging scaffolding (`scripts/staging/`, `docs/staging/`, `staging-evidence.yml`) — use the lease workflow before any #700 soak
