# .github/workflows/ — CI/CD Workflows

## Files

| File | Purpose | Jira |
|------|---------|------|
| `ci.yml` | Secret scan, dependency audit, TDD enforcement, typecheck, lint, coverage-monotonic, handoff-claims, feedback-rules, count:'exact'-baseline | SCRUM-1248/1249/1252/1253/1254 |
| `deploy-worker.yml` | Cloud Run worker deployment. Worker lint uses `npm run lint` (matches CI). | SCRUM-1250 |
| `migration-drift.yml` | Read-only diff: local migrations vs prod applied set. Prevents the scorecard-outage class of bug. | SCRUM-908 |
| `revision-drift.yml` | 10-min cron — fetch worker `/health.git_sha`, compare to `git rev-parse origin/main`, fire Sentry on drift > 1h or `missing-sha`. | SCRUM-1247 |

## SCRUM-1068 — Sonatype SCA

- `ci.yml` includes a non-blocking `sonatype-sca` PR job for the first sprint.
- The local GPL/AGPL/SSPL deny-list is always enforced with `npm run security:license-denylist`; legacy `snarkjs` GPL transitive packages are documented in `scripts/security/license-denylist.allowlist.json`.
- Sonatype Lifecycle remote evaluation runs only when `SONATYPE_LIFECYCLE_URL`, `SONATYPE_LIFECYCLE_USERNAME`, `SONATYPE_LIFECYCLE_PASSWORD`, and `SONATYPE_LIFECYCLE_APPLICATION_ID` secrets exist.

## Patterns

- Workflows use pinned action SHAs (not `@v4` tags) for supply-chain safety.
- External downloads (e.g. `tla2tools.jar`) MUST verify SHA256. See ci.yml's `Pin TLA2TOOLS_JAR` step for the canonical pattern (SCRUM-1248 / R0-2).
- `migration-drift.yml` is read-only — it never applies or modifies anything.
- Exempt-list changes in `migration-drift.yml` require a code comment + Jira ticket.
- Secrets: `arkova1/supabase_access` in GCP Secret Manager for migration drift, `arkova1/Sonarcloud_Token` for the SonarCloud config guard, `SUPABASE_PROJECT_REF`, `SENTRY_DSN_OPS` (revision-drift Sentry alerts).
- Deploy gate ≡ CI lint job: deploy-worker.yml + ci.yml `Lint worker` step BOTH invoke `npm run lint` from `services/worker/`. Drift between them is enforced by `scripts/ci/check-deploy-lint-parity.ts`. Override label: `ci-config-change`.

## R0 anti-false-done CI jobs (SCRUM-1246 wave)

| Job | Script | Override label |
|---|---|---|
| `coverage-monotonic` | `scripts/ci/check-coverage-monotonic.ts` | `coverage-drop-allowed` + `Linked Jira: SCRUM-NNNN` in body |
| `handoff-claims` | `scripts/ci/check-handoff-claims.ts` | `handoff-narrative-only` |
| `feedback-rules` | `scripts/ci/check-feedback-rules.ts` (orchestrator) | per-rule label (see `memory/README.md`) |
| `count-exact-baseline` | `scripts/ci/check-count-exact-baseline.ts` | `count-exact-allowed` |
| `sonar-quality-gate-config` | `scripts/ci/check-sonar-quality-gate.ts` | none; fix SonarCloud Quality Gate / New Code Definition (SCRUM-1681) |

Continue-on-error remaining (3 of 6 stripped in R0-2): RLS tests, E2E tests, Lighthouse, Generated Types Check. Each carries an inline `SCRUM-1248` annotation pointing at the follow-up sub-story (SCRUM-1301/1302/1303/1309) that must close before strip.

## Related

- `docs/runbooks/migration-drift-playbook.md` — operator runbook for when the drift check fails
- `docs/confluence/16_migration_drift_prevention.md` — ADR for Option A (read-only diff)
