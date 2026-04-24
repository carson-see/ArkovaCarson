# agents.md — scripts/secrets/

_Last updated: 2026-04-24_

## What This Folder Contains

SEC-HARDEN-02 secret-inventory audit tooling. The CLI here is the enforcement backbone for [SCRUM-1055](https://arkova.atlassian.net/browse/SCRUM-1055) — it flags drift between the required Secret Manager inventory (`EXPECTED_SECRETS`) and the actual `--set-secrets` bindings in `.github/workflows/deploy-worker.yml`, while reporting optional tooling-only secrets separately.

| File | Purpose |
|------|---------|
| `audit-env.ts` | `parseDeployWorkerSecrets` (YAML → `SecretBinding[]`) + `auditDrift` (expected vs bound) + `main()` CLI. Exported so `tests/infra/secret-audit.test.ts` can import the pure fns without spawning a subprocess. |
| `README.md` | Operator usage: `npm run audit:secrets [--json]`. Exit 0 = clean, exit 1 = drift. |

## Conventions

- **Pure functions + thin CLI shell.** `parseDeployWorkerSecrets` and `auditDrift` are pure; the `main()` function is the only I/O boundary. Tests feed hardcoded YAML strings — never the real workflow file — so unit tests stay fast and isolated.
- **`matchAll` for multi-line `--set-secrets`.** The workflow historically uses one `--set-secrets` line, but the inventory is growing and future splits across multiple invocations would silently break drift detection under a `match()` (non-global) parse. Use the global regex form + accumulate every binding.
- **Inventory source of truth.** `EXPECTED_SECRETS` mirrors required production worker secrets in `docs/runbooks/sec-harden/sec-harden-02-secret-manager-migration.md`; `OPTIONAL_SECRETS` mirrors tooling-only or disabled-provider secrets. When that runbook's inventory changes, these constants change in the same PR.
- **Exit codes.** 0 when every required expected secret is bound, 1 on any required drift — so CI can gate on the script without forcing unused optional providers into production.

## What NOT to do here

- Do not add a real YAML parser dependency unless the workflow schema grows past what the single-line regex can handle. The current approach is intentionally dep-free.
- Do not read the real `.github/workflows/deploy-worker.yml` inside unit tests — couples the test suite to workflow churn. Feed strings.
- Do not expand `EXPECTED_SECRETS` to cover every env var. The scope is **Secret Manager** secrets only; non-secret config (URLs, flags) stays in `--set-env-vars`.

## Related

- Runbook: [`docs/runbooks/sec-harden/sec-harden-02-secret-manager-migration.md`](../../docs/runbooks/sec-harden/sec-harden-02-secret-manager-migration.md) (lands with PR #481).
- Sibling CLI: [`scripts/healthcheck/`](../healthcheck/) — service-check CLI with the same dual-use (exec + import-for-tests) guard pattern.
