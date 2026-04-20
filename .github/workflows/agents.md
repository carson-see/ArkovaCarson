# .github/workflows/ — CI/CD Workflows

## Files

| File | Purpose | Jira |
|------|---------|------|
| `ci.yml` | Secret scan, dependency audit, TDD enforcement, typecheck, lint | — |
| `deploy-worker.yml` | Cloud Run worker deployment | — |
| `migration-drift.yml` | Read-only diff: local migrations vs prod applied set. Prevents the scorecard-outage class of bug. | SCRUM-908 |

## Patterns

- Workflows use pinned action SHAs (not `@v4` tags) for supply-chain safety.
- `migration-drift.yml` is read-only — it never applies or modifies anything.
- Exempt-list changes in `migration-drift.yml` require a code comment + Jira ticket.
- Secrets: `SUPABASE_ACCESS_TOKEN` (read-only PAT), `SUPABASE_PROJECT_REF`.

## Related

- `docs/runbooks/migration-drift-playbook.md` — operator runbook for when the drift check fails
- `docs/confluence/16_migration_drift_prevention.md` — ADR for Option A (read-only diff)
