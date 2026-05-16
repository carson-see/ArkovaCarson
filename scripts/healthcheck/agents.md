# scripts/healthcheck/agents.md

Credential and external-service smoke tests (SCRUM-1056 / SEC-HARDEN-03). Verifies every external dependency is reachable with current credentials.

## Files
- **`index.ts`** — CLI entry point. Usage: `npm run healthcheck [--fix] [--only=gcp,jira]`.
- **`checks.ts`** — check definitions: one per external service (GCP, Jira, Supabase, Stripe, etc.). Each returns `{ ok, detail }`.
- **`runner.ts`** — generic runner: executes checks in parallel, captures timing and errors, surfaces remediation hints.
- **`README.md`** — usage and check inventory documentation.

## Conventions
- Exit 0 = all green; exit 1 = any red.
- `--fix` flag prints remediation for each failed check.
- `--only=name1,name2` filters to specific checks.
- Uses 10s HTTP timeout per check.
