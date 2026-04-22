# .github/workflows/ — CI/CD Workflows

## Files

| File | Purpose | Jira |
|------|---------|------|
| `ci.yml` | Secret scan, dependency audit, TDD enforcement, typecheck, lint, lockfile integrity, dep pinning | SCRUM-1004/1005/1006 |
| `deploy-worker.yml` | Cloud Run worker deployment | — |
| `migration-drift.yml` | Read-only diff: local migrations vs prod applied set. Prevents the scorecard-outage class of bug. | SCRUM-908 |
| `nightly-secret-scan.yml` | Full-history Gitleaks + TruffleHog scan (03:00 UTC daily) | SCRUM-1004 |
| `supply-chain-monitor.yml` | Socket.dev + OpenSSF Dependency Review on package.json changes | SCRUM-1001 |
| `eol-tracking.yml` | Weekly runtime EOL check via endoflife.date API | SCRUM-1009 |

## Patterns

- Workflows use pinned action SHAs (not `@v4` tags) for supply-chain safety.
- `migration-drift.yml` is read-only — it never applies or modifies anything.
- Exempt-list changes in `migration-drift.yml` require a code comment + Jira ticket.
- Secrets: `SUPABASE_ACCESS_TOKEN` (read-only PAT), `SUPABASE_PROJECT_REF`, `SOCKET_SECURITY_API_KEY` (optional).

## Related

- `docs/runbooks/migration-drift-playbook.md` — operator runbook for when the drift check fails
- `docs/runbooks/cve-triage.md` — CVE triage SLA and response runbook (SCRUM-1002)
- `docs/runbooks/supply-chain-triage.md` — supply chain triage decision tree (SCRUM-1001)
