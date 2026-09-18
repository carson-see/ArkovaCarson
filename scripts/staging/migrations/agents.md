# scripts/staging/migrations/agents.md

Staging-only SQL migrations. Applied to the staging Supabase project (`ujtlwnoqfhtitcmsnrpq`) only, NOT to production.

## Files
- **`staging_only_deploy_log_and_lease_pk.sql`** — (SCRUM-1803) adds PK constraint to `staging_lease` and creates `staging_deploy_log` append-only audit table. Prevents deploy collisions between concurrent PR soaks.

## Conventions
- Apply via Supabase MCP `apply_migration`, not via `supabase/migrations/`.
- Migration names are prefixed with `staging_only_` to make scope explicit.
- These files exist for auditability; the actual application target is the staging database.

## 2026-09-14 — Default privileges and append-only audit enforcement

`staging_only_deploy_log_and_lease_pk.sql` now revokes inherited service_role table grants before permitting only SELECT/INSERT, and resets sequence grants before permitting USAGE/SELECT. This closes the TRUNCATE bypass of row-level append-only triggers and prevents sequence resets. Reapplication preserves existing audit rows and identifiers. The historical project ref and apply_migration instruction above are not current targeting instructions: verify the owned staging project and apply this operational DDL without writing a production migration-ledger row. Never reset a rig or mutate old audit records to validate the bootstrap.

`verify-bootstrap-acl.py` runs the original bootstrap pinned at commit 663254b9 and current SQL against a fresh loopback PostgreSQL fixture with inherited ALL grants. It reproduces the TRUNCATE/sequence-reset bypasses, then proves actual role denials, retained lease/audit operations and data-preserving reapplication. It accepts only a new evidence directory and never connects to a hosted database.
