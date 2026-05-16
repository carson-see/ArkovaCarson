# scripts/staging/migrations/agents.md

Staging-only SQL migrations. Applied to the staging Supabase project (`ujtlwnoqfhtitcmsnrpq`) only, NOT to production.

## Files
- **`staging_only_deploy_log_and_lease_pk.sql`** — (SCRUM-1803) adds PK constraint to `staging_lease` and creates `staging_deploy_log` append-only audit table. Prevents deploy collisions between concurrent PR soaks.

## Conventions
- Apply via Supabase MCP `apply_migration`, not via `supabase/migrations/`.
- Migration names are prefixed with `staging_only_` to make scope explicit.
- These files exist for auditability; the actual application target is the staging database.
