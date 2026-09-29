# 0494 agent-key/delete lock correction evidence

Captured 2026-09-27 against the owned disposable full-lineage PostgreSQL database documented by `ar20-13-full-replay-0493/receipt.md`. No hosted database was read or written.

## Reproduced regression

Before applying 0494:

```text
UAT03_DATABASE_URL=<owned-disposable-local-database> services/worker/scripts/test-agent-revoke-concurrency-full-schema.sh
physical agent delete left an active/resumable key or lacked its audit
agent revoke full-schema concurrency contract failed; fixture output withheld (append-only audit rows: 8; required identity rows: 3)
exit 1
```

The baseline direct service-role `DELETE FROM public.agents` removed the agent, the existing `ON DELETE SET NULL` FK orphaned an active key, and no physical-delete audit existed.

## Corrected result

Applied only `supabase/migrations/0494_scrum5300_agent_key_delete_lock_corrections.sql` to the disposable database, then reran the same harness:

```text
agent revoke full-schema concurrency contract passed
agent revoke full-schema cleanup passed (append-only audit rows: 18; required identity rows: 3)
exit 0
```

The harness proves both parent-lock orderings, forces the former two-backend API-key mint/machine-revoke inversion while observing real lock waits, ratchets mint to target-agent-before-caller, checks lifecycle and physical-delete audit-failure rollback plus clean retry/idempotency, and verifies physical delete permanently deactivates active/admin-resumable/provider-resumable keys while preserving an unrelated compromised-key reason. Operational fixtures are removed; immutable audit rows and their required identities remain only in the disposable database and are count-reported.

## Static gates

- `bash -n services/worker/scripts/test-agent-revoke-concurrency-full-schema.sh`: PASS
- `git diff --check` on the four owned paths: PASS
- `npx tsx scripts/ci/feedback-rules/secdef-function-grants.ts`: PASS
- `npx tsx scripts/ci/check-hot-table-ddl-lock-timeout.ts`: PASS; zero new violations
- `npx tsx scripts/ci/check-migration-prefix-uniqueness.ts`: PASS; no new collision
- Function ACL readback: trigger function is SECURITY DEFINER with fixed `public, pg_temp` search path; anon/authenticated execute false. Mint RPC service-role execute true, authenticated false. Trigger enabled `O`.

Frozen hashes:

- migration: `11e3db7802e3636d3225eca1746074f5809fa8eebf38c97735020cdc3a029836`
- harness: `722c3c162c6b359bfc09a470d4de1e559336aada0b02b3bef5243c3ba86b15ff`

## Deliberate limits

Audit/outbox insertion remains in the revocation transaction. If audit/outbox persistence fails, revocation rolls back and the key remains active; the caller/operator must retry or escalate. This avoids an unaudited successful revoke.

0491 still contains an `ALTER TABLE public.webhook_delivery_logs` and non-concurrent indexes inside one transaction. Its migration-level `lock_timeout='5s'` limits lock acquisition and `statement_timeout='60s'` bounds statements, but a later migration cannot shorten that already-authored operation. Before apply, the operator must inspect the current ledger/table size/blockers and choose a controlled maintenance window; failure to acquire the lock is a failed migration, not a reason to bypass the gate.

- `check-rls-policy-coverage.ts`: PASS in a scratch tracked-index simulation including the new, still-untracked 0494 file; the live worktree scanner uses `git ls-files`, so it cannot see 0494 until commit. The exemption is the explicit service-only `Deny-all by design` table comment, not a permissive policy or label override.

## Round-3 correction to the evidence scope

The migration and native harness hashes above were rechecked on 2026-09-27 and still match the candidate. This historical receipt is included to repair the broken reference in `0494-review.md`; it is not a new replay. The referenced `ar20-13-full-replay-0493/receipt.md` is an external local evidence artifact, not a file in this directory. Its absence from a reader's checkout must not be treated as a reproduced full replay.

The earlier policy-coverage scanner result did **not** prove the separate UAT04 restrictive-MFA policy census. Round 3 identified that gap; forward migration 0495 and its native verification own the correction. The prior source PASS does not close this new finding or admit the candidate for soak.
