# tests/infra/agents.md

Infrastructure integration tests. Verify operational scripts, edge workers, and security configurations.

## 2026-09-05 — `agent-skills-digests.test.ts` (new): a published digest that trails its file takes the skill OFFLINE

`public/.well-known/agent-skills/index.json` publishes a `sha256:` digest per SKILL.md.
Nothing recomputed them. That failure mode is not "stale guidance": a client honouring the
discovery spec hashes what it fetched and REFUSES a mismatch, so the skill stops working
for anyone checking, while the repo looks healthy. The MCP tool-name corrections in this
change would have shipped exactly that way.

The test hashes the files on disk — deliberately NOT a snapshot of expected hex, which
would have to be updated by the same hand that edited the file, i.e. the step that gets
skipped. It also pins each entry's `url` to the file it hashed and fails when a skill
directory exists but is unindexed (undiscoverable), and fails closed on an empty index.

Also in this folder on the same change: `mcp-manifest-parity.test.ts`, `mcp-server.test.ts`
and `llms-txt.test.ts` re-pinned to the `arkova_*` names, and (edge lane)
`edge-wrangler-vars-parity.test.ts` added, which compares `wrangler.soak.toml`'s `[vars]`
against `wrangler.toml` so a var missing on the rig cannot produce a green hollow soak.

## Files
- **`healthcheck.test.ts`** — tests for the healthcheck runner (SCRUM-1056): result ordering, timing, error capture.
- **`batch-queue.test.ts`** — tests for batch queue processing infrastructure.
- **`crawler.test.ts`** — tests for web crawler/indexing behavior.
- **`cross-tenant-assertions.test.ts`** — DEG-4 (SOAK-PREMORTEM-SOC2-2026-08-11 §4): pins the hardened blocked/positive-access semantics of `e2e/helpers/cross-tenant-assertions.ts`. A /login redirect must evaluate NOT-blocked (the old spec's hollow-pass), record content rendering is a leak not a block, and precondition failures carry the distinct `precondition: <label> session not authenticated` message. This is the local RED proof that an expired accessor session makes `e2e/cross-tenant.spec.ts` fail.
- **`dlp-verification.test.ts`** — tests for DLP (Data Loss Prevention) policy enforcement.
- **`signout-scope-guard.test.ts`** — unit tests for `e2e/helpers/signout-scope-guard.ts` plus a ratchet scan of every `e2e/**/*.ts` file: bare `auth.signOut()` (supabase-js default `scope: 'global'`) revokes a shared seed user's storageState session and cascades /login bounces through every later spec in a single-invocation run (2026-08-15 side-rig cascade, introduced by PR #2213's cross-tenant `afterAll`). E2e code must pass an explicit scope.
- **`llms-txt.test.ts`** — tests for `llms.txt` AI crawler discovery file.
- **`agent-skills-digests.test.ts`** — recomputes the sha256 of every `public/.well-known/agent-skills/*/SKILL.md` and compares it to the `digest` published in `index.json`. A spec-honouring client refuses a mismatch, so a stale digest takes the skill offline rather than serving old text. Also pins each entry's `url` to the file it hashed, fails on a skill directory that exists but is not indexed, and fails closed on an empty index.
- **`mcp-claim-parity.test.ts`** — BUG-026 guard, run against the LIVE surfaces. Runs `scripts/ci/check-mcp-claim-parity.ts` over the five published MCP claim surfaces and asserts zero unbaselined violations, plus baseline hygiene (no duplicate keys, every entry owned, no `reference-coverage` exceptions). The rule logic is unit-tested on synthetic fixtures next to the script; this file is the live assertion so `npm test` catches drift without waiting for CI. Complements `mcp-manifest-parity.test.ts`, which pins names/schemas and explicitly does NOT compare description text.
- **`mcp-server.test.ts`** — tests for the MCP server edge deployment. Also carries the BUG-028 `anchor_document` receipt contract: `public_id` must be an explicit `null` (never a dropped key), the receipt must name `verify_document` + the `content_hash` it actually accepts, and the internal `public_records` UUID must never be substituted as an identifier. One test reads the baseline migration to assert `public_records` still has no `public_id` column — if a migration adds one, that test fails so whoever adds it revisits the receipt instead of leaving a permanently-null agent-facing field.
- **`r2-report.test.ts`** — tests for Cloudflare R2 report storage.
- **`rls-suite-parallel-safety.test.ts`** — SCRUM-3618/3577 ratchet over `tests/rls/**` + `src/tests/rls/helpers.ts`: (1) no `auth.getUser()` — fixture identities must be the pinned `DEMO_CREDENTIALS.*Id` / `ORG_IDS.*` constants, because a parallel suite's sign-out of a shared demo user invalidates the session round-trip mid-run and poisoned `member_integrations` fixtures to `user_id ''` (22P02); (2) no bare `auth.signOut()` — reuses `e2e/helpers/signout-scope-guard.ts`'s detector, extending the 2026-08-15 e2e ratchet to the RLS suite it never covered. See `tests/rls/agents.md` "Fixture rules for full-parallel runs".
- **`row-snapshot.test.ts`** — BUG-030 / E-3: pins the snapshot-and-restore contract of `e2e/helpers/row-snapshot.ts`. The load-bearing case is that a FAILED capture throws rather than degrading to "captured nothing" — a no-op restore would reproduce the original defect (a spec deleting the seed individual's `subscriptions` row and walking away) behind a helper that looks like a fix. Also pins exact restore (original primary keys), empty-restores-to-empty, and idempotence.
- **`supabase-storage-key.test.ts`** — BUG-030 / E-2: pins `supabaseAuthStorageKey()` reproducing supabase-js's own default. The regression guard is that the local URL still derives exactly `sb-127-auth-token`; if that drifts, every local and CI run of `onboarding` / `identity` / `route-guards` breaks, and this fails first instead of 15 auth timeouts.
- **`secret-audit.test.ts`** — tests for secret rotation audit compliance.
- **`seed-fixture-uuids.test.ts`** — DEG-5 (`docs/staging/fullsoak-2026-08/deg5-org-queue-triage.md`): every UUID literal in a seeding artifact (`supabase/seed.sql`, `scripts/staging/seed-baseline-fixture.sql`) and in the shared fixtures that pin those rows (`src/tests/rls/helpers.ts`, `e2e/fixtures/supabase.ts`) must parse under the same strict `z.string().uuid()` the worker runs. Zeroed version/variant nibbles are valid to Postgres and rejected by Zod 4, which 500'd `/jobs/org-queue-scheduler` once per reclaim cycle on the fullsoak rig. Adding a seeding artifact to `SEEDING_ARTIFACTS` is what keeps the ratchet honest.
- **`security-headers.test.ts`** — tests for HTTP security headers on all endpoints.

## Conventions
- These tests verify infrastructure behavior, not application logic.
- External services are mocked; no real GCP/Cloudflare calls in tests.
## 2026-09-19 — MCP manifest count

The registered/server-card tool-set ratchet is 18: 15 default plus the 3 write-gated anchor, status, and UAT-23 import tools. Update the exact-count assertion only with a matching registry and server-card change.
