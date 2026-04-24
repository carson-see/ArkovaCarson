# scripts/secrets — Secret Manager drift audit

**Jira:** [SCRUM-1055 (SEC-HARDEN-02)](https://arkova.atlassian.net/browse/SCRUM-1055)
**Runbook (the actual migration):** `docs/runbooks/sec-harden/sec-harden-02-secret-manager-migration.md` (lands via PR #481)

Read-only drift audit between the secrets the Cloud Run worker is currently bound to (`.github/workflows/deploy-worker.yml` `--set-secrets`) and the SEC-HARDEN-02 expected-secrets contract.

This is a **gate**, not a writer. It will never call `gcloud`, never touch Cloud Run. Run it before walking the migration runbook to know exactly which secrets still need to be moved.

## Usage

```bash
npm run audit:secrets             # exit 0 if no drift, 1 if drift
npm run audit:secrets -- --json   # machine-readable output (CI / scripts)
```

Sample output:

```
✓ STRIPE_SECRET_KEY                 stripe-secret-key:latest
✓ SUPABASE_SERVICE_ROLE_KEY         supabase-service-role-key:latest
✗ ANTHROPIC_API_KEY                 (missing — needs `gcloud secrets create`)
✗ RUNPOD_API_KEY                    (missing — needs `gcloud secrets create`)
…

20/23 bound. 3 drift.
```

## Adding a new expected secret

1. Add the env-var name to `EXPECTED_SECRETS` in [`audit-env.ts`](./audit-env.ts).
2. If it's high-risk, add it to the `required` list in [`tests/infra/secret-audit.test.ts`](../../tests/infra/secret-audit.test.ts) so future drift is caught explicitly.
3. Run the migration runbook for that secret, then re-run `npm run audit:secrets` and confirm it now shows `✓`.

## Why this lives separate from `scripts/healthcheck/`

| Tool | When you run it | What it proves |
|---|---|---|
| `scripts/healthcheck/` | Day-2 / post-rotation | The credentials currently in env work against the live API |
| `scripts/secrets/audit-env` | Before/after Secret Manager migration | The right set of secrets is wired into Cloud Run via `--set-secrets` |

healthcheck answers *"do my keys work?"*. audit-env answers *"are my keys flowing through Secret Manager rather than env vars?"*. Both are required to declare SEC-HARDEN done.
