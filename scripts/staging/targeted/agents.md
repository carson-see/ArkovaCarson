# scripts/staging/targeted/

**Targeted** soak drivers — the RIGHT soak foundation. Unlike `../load-harness.ts --mode mixed` (generic synthetic load that only proves the worker is UP → health-only, fails §1.12 + the Staging Soak Evidence Gate), each driver here hits the EXACT changed surface of a specific PR, drives every documented branch, and captures the response body that proves the branch was reached.

Root cause this replaces: the failed soak fleet ran `load-harness --mode mixed` which never touched any PR's changed path. A soak that doesn't exercise the change is not merge-grade evidence.

## What lives here

| File | Purpose |
|---|---|
| `driver-core.ts` | Shared plumbing: labeled-outcome recording, per-branch status classification against an allowed-status set (a 404 is EXPECTED evidence for the RECORD_NOT_FOUND branch, not a failure), structured evidence summary (status mix, per-branch counts, captured bodies), body helpers (`bodySnippet`, `captureProofErrorCode`), the `fireLabeled` HTTP fire, and `parseDriverArgs`. Pure — fully unit-tested. |
| `fixtures.ts` | Pure row builders + injectable `FixtureExecutor` for the minimal, clearly-synthetic fixtures each branch needs: `buildSecuredUnbatchedAnchor` (SECURED + on-chain receipt but no `anchor_proofs` row → NO_BATCH_PROOF), `buildDlqFixtureRow` (unresolved `webhook_dead_letter_queue` row), `buildOrgAndAdminProfile`. Every fixture is `TSOAK-`-tagged, uses `@staging.invalid.test` emails + `http://localhost` URLs, and carries only metadata (§1.11A / §1.6-safe). `makeDbExecutor` wires them to a service-role client at run time. |
| `runtime.ts` | Live-rig plumbing (NOT unit-tested beyond the two pure helpers): Cloud Run IAM token (30-min refresh, `STAGING_GCP_IDENTITY` override), service-role Supabase seeder, `writeEvidenceFile`, and the `runDriver` seed-once-then-fire-on-a-30s-cadence loop. |
| `verify-proof-driver.ts` (**#1439**) | GET `/api/v1/verify/:public_id/proof` — drives BOTH 404 branches (`record-not-found` unknown id → RECORD_NOT_FOUND; `no-batch-proof` seeded SECURED-but-unbatched id → NO_BATCH_PROOF) + a `invalid-public-id` 400. Captures each body's `proof_error_code`. |
| `ops-slo-driver.ts` (**#1441**) | GET `/api/admin/ops-slo-stats` — `admin-ok` (platform-admin JWT → 200, captures per-surface `available` map incl `available:false`), `non-admin-forbidden` (403), `unauthenticated` (401). |
| `webhooks-self-service-driver.ts` (**#1443**) | ORG_ADMIN JWT-gated `/api/v1/webhooks/self-service/*` — `test` (`/:id/test`), `replay` (`/deliveries/:id/replay`), `dlq-list` (`/dlq`), `dlq-resolve` (`/dlq/:id/resolve`) against a seeded DLQ fixture, + `unauthenticated` 401. Paces one pass every 65s so the long run proves the changed behavior without accidentally turning the whole soak into a batch-limiter 429 test. |
| `cpe-cle-exports-driver.ts` (**#1415**) | POST the three `/api/v1/exports/{cpe,cle,org/cpe}-log` endpoints in BOTH pdf+json, plus an explicit cross-user 403 isolation case, three Zod edges (bad format enum, malformed date, inverted period → 400), and a 401. |

## Design contract

- **Pure `plan*()` + thin runtime.** Each driver's branch logic is a pure `plan*()` returning a labeled request list — unit-tested with no network. The `main()` (auto-runs only when invoked directly via `import.meta.url === file://…argv[1]`) resolves the tag URL, seeds fixtures, runs the plan, and writes evidence.
- **Tag-URL-only.** All drivers resolve `STAGING_API_BASE` through `../load-harness-env.resolveStagingApiBase`, which refuses shared/main staging hosts — no parallel-soak contamination.
- **Expected ≠ failure.** A 401/403/404/400 that IS the branch under test counts as expected soak evidence; `evidence.allExpected` is false only when a real status surprise occurred.
- **Evidence out.** `--evidence-out docs/staging/<file>.json` writes the structured summary (per-label status mix + captured bodies) to drop into a PR's `## Staging Soak Evidence` block.

## Running (against an ISOLATED rig only)

```bash
STAGING_API_BASE=https://pr-1439---arkova-worker-staging-…run.app \
STAGING_SUPABASE_URL=… STAGING_SUPABASE_SERVICE_ROLE_KEY=… \
STAGING_FIXTURE_ORG_ID=… STAGING_FIXTURE_USER_ID=… \
npx tsx scripts/staging/targeted/verify-proof-driver.ts --duration 720 --evidence-out docs/staging/soak-pr-1439.json
```

Each driver runs directly via `tsx scripts/staging/targeted/<driver>.ts` (deliberately NOT wired into `package.json` scripts, so this PR stays a pure `scripts/**` T0 add — a root-`package.json` manifest change would earn a tier under `check-staging-evidence.ts`). `--dry-run` prints the plan without seeding or firing (used by the arg-parse test). This directory is **T0 tooling** (`scripts/**`) — no staging evidence block required for a PR that only adds these files; CI green suffices. Provisioning rigs, deploying, and running the actual soaks is a **separate** phase (real spend) — nothing here starts a soak on import.

## Tests

`driver-core.test.ts`, `fixtures.test.ts`, `runtime.test.ts`, and one `*-driver.test.ts` per driver — all red-first TDD, all pure (no live rig). Run: `npx vitest run scripts/staging/targeted/`.
