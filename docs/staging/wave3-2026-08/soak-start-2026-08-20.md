# Wave 3 soak stand-up — 2026-08-20

> **Tier: T2.** Union of 7 T2/T1 members + a stacked pair (#2230→#2236), on a
> brand-new isolated rig. Founder approved the wave plan 2026-08-20 with
> explicit instruction: "SAME standards (in regards to quality) as the 7 day
> soak" — no hollow soaks. This doc records exactly what was and was not
> exercised, with live evidence for every claim.

## Union branch

- **Branch:** `rc/wave3-2026-08`
- **Base:** `origin/main` at `6b4847c0b257cfb28085afdf6570971493bf4c85`
- **Union head:** `25465f5dadf868bc4cdd0c54ab63a0d548dd87c6`
- **Members merged, in order** (base first for the #2230→#2236 stack):

| # | PR | Head SHA | What |
|---|---|---|---|
| 1 | #2272 | `08014061b40fd142e21dfbc0f602746dde482741` | Queue digest (`ENABLE_QUEUE_DIGEST`) default-on |
| 2 | #2276 | `0c40fea9793ea8b18df3bb8882c90698d9948312` | Platform-admin health digest job + cron route |
| 3 | #2232 | `7b7a7d42abe24adb3b72e5566e5a1cc516186459` | MCP audit log P0 + unmounted proof-keys + anchor_document contract |
| 4 | #2246 | `d7f666004e92a435ccf19204f59cbd705929f453` | Connector-fingerprint proof caveat (§1.5) |
| 5 | #2220 | `9f67e98b6c09001f080b12dcc23301c0b206dfb2` | API-key revocation/deletion reachable; revoke stamps CC6.8 |
| 6 | #2252 | `ddbe9a108791d391cbc17e9f019a49b5d352b820` | sdk-py model-drift audit (supersedes #2247) |
| 7 | #2274 | `a6755f3256b74e3339be7951454430c8a9653233` | npm publication prep — `arkova` + `arkova-mcp-server` |
| 8 | #2230 | `274ad17eb9af17f910b9b39d39d50434672d1928` | Drive connect: separate `org_scope_required` from `not_admin` |
| 9 | #2236 | `945b4a64ddd3a8edadc7c963a6a94614a71b6ec3` | Claims: Nessie fails closed; Drive individual scope dropped |

All nine head SHAs verified live via `gh pr view` immediately before merging —
exact match to what was specified. #2230→#2236 confirmed a clean single-commit
stack (`git merge-base --is-ancestor 274ad17eb 945b4a64d` = true) before
merging both.

### Merge conflicts resolved (union-additive, not either/or)

- `.github/workflows/deploy-worker.yml` (#2276 vs #2272): both digest
  activation comment blocks kept; both `ENABLE_QUEUE_DIGEST=true` and
  `ENABLE_PLATFORM_HEALTH_DIGEST=true` kept in the same `--set-env-vars`
  string.
- `scripts/gcp-setup/cloud-scheduler.sh` (#2276 vs #2272): both
  `NOT_SCHEDULED` entries kept, #2272's updated (flag-now-true) queue-digest
  line taken over the stale "off" one it was racing against.
- `sdks/mcp-server/src/index.ts` + `packages/sdk/README.md` (#2274 vs #2236):
  #2274's Nessie copy predates CTO ruling R-1 STRENGTHENED (2026-08-12); took
  #2236's current "permanently disabled, fails closed" copy in both places.
- `agents.md` append-only check run twice (post-merge, before and after the
  fallout-fix commit): **clean both times** — `No dropped agents.md content.`

### Pre-existing gap found, not introduced by this merge

`packages/sdk/agents.md`, `packages/sdk/examples/agents.md`,
`sdks/mcp-server/agents.md` show as "content removed" against
`origin/main` under the append-only check — traced to PR #2274's own branch
(verified via `git show a6755f325:<file>` predating any merge here): a
deliberate npm-scope-rename rewrite (old `@carsonarkova/sdk` explanation
superseded by the 2026-08-18 CTO ruling, old text moved to `HANDOFF.md`
`## History`), not a union-merge data loss. PR #2274 does not currently carry
the `agents-md-deletion-approved` label — flagged for whoever merges #2274,
out of scope for this soak.

## Full gates (root `npm install` was empty; ran everything fresh)

| Gate | Root | Worker |
|---|---|---|
| typecheck | 0 errors | 0 errors |
| lint | 0 errors (1 pre-existing warning) | 0 errors |
| lint:copy | clean (4 allowlisted, 8 grandfathered) | n/a |
| test | **6344/6344 pass**, 58 skipped | pass except one file, see below |

### Real integration fallout found and fixed (commit `25465f5da`)

1. `tests/infra/mcp-claim-parity.test.ts` — `public/.well-known/mcp/server-card.json`'s
   `anchor_document` description was never updated for #2232's BUG-028 fix
   (`services/edge/src/mcp-tools.ts` canonical description changed). Fixed the
   manifest text to match verbatim, manifest's own conditional-availability
   sentence kept appended after.
2. `services/worker/src/mcp-tools.test.ts` — worker-side mirror of edge's
   `handleAnchorDocument` tests (imports the real handler directly) still
   asserted the OLD `public_id: 'ARK-2026-999'` echo. #2232's fix makes
   `anchorSubmittedResult()` always return `public_id: null` (the column
   doesn't exist on `public_records`; a `verify_with` pointer was added
   instead). Updated both assertions to the new, intentional contract.

Both confirmed real (not flakes) by isolated re-run before the fix, and green
after.

### Confirmed flakes (resource contention from parallel install/tsc/lint/test), not real failures

`scripts/ci/check-ledger-numeric-integrity.test.ts`,
`scripts/ci/feedback-rules/secdef-function-grants.test.ts`,
`src/tests/f5c-monthly-count-null-identity-guard.test.ts`,
`src/components/credentials/CredentialSourceImportDialog.test.tsx`,
`src/pages/AdminOrganizationsPage.test.tsx`,
`src/ai/eval/s33-wave3-deterministic-eval-gates.test.ts` (worker),
`src/ai/eval/s33-wave2-batch-acceptance.test.ts` (worker) — all pass clean in
isolated re-run with no other process competing for CPU.

### One remaining local-environment gap (not Wave-3-caused, confirmed pre-existing)

`services/worker/src/ai/eval/s33-batch-acceptance.test.ts` (32 tests) fails
with `fatal: invalid reference: FETCH_HEAD` / `warning: rejected <sha> because
shallow roots are not allowed to be updated`. Root-caused: this worktree
checkout is a **shallow clone** (`git rev-parse --is-shallow-repository` =
`true`); the test spins up a scratch git repo and does `git fetch <this
worktree> <historical sha>` + `git switch --detach FETCH_HEAD`, which a
shallow source refuses. Reproduced standalone outside the test harness with
the exact same error. CI runs with `fetch-depth: 0` (full history) and does
not hit this. `services/worker/src/ai/zk-proof.test.ts` (whole suite,
missing compiled circuit artifacts) was fixed by running
`npm run build:circuit` locally (circom 2.1.9 available at
`/Users/carson/.local/bin/circom`) — now green.

## Rig provisioning — Supabase `jiotjhqmedkajdsojsbn` (`arkova-wave3-2026-08`)

- **Region:** us-east-2 (matches prod). **Status:** ACTIVE_HEALTHY.
  **Postgres:** 17.6.1.155. **Created:** 2026-08-20T15:30:49Z.
- Extensions bootstrapped: `uuid-ossp` + `pgcrypto` in `extensions`, `pg_trgm`
  in `public` (matches prod's actual placement, verified via MCP
  `list_extensions` on `vzwyaatejekddvltxyye`).
- Migrations: `npx supabase db push --linked --include-all --yes` from this
  union branch (111 `.sql` files, prod ledger head `0409` at replay time,
  matching exactly — **no new migrations in any Wave 3 member**). 109/111
  applied cleanly; `0381_docusign_envelope_metadata_lookup_indexes.sql` and
  `0389_anchors_ce_registry_ctid_partial_index.sql` (both bare
  `CREATE INDEX CONCURRENTLY`, no txn) set aside per
  `docs/reference/STAGING_RIG.md`'s documented gotcha, applied individually
  via `psql` against the session pooler
  (`aws-0-us-east-2.pooler.supabase.com:5432`, user
  `postgres.jiotjhqmedkajdsojsbn`), all four resulting indexes verified
  `indisvalid=true`, ledger rows inserted to match the CLI's naming
  convention, files restored byte-identical to the working tree.
- Baseline fixture: `scripts/staging/seed-baseline-fixture.sql` (1 SUBMITTED
  anchor, satisfies preflight Check 5).
- **DB password** set via Management API `PATCH /v1/projects/{ref}/database/password`
  (not surfaced by `create_project`), stored in Secret Manager as
  `supabase-db-password-jiotjhqmedkajdsojsbn`.
- **Preflight** (`scripts/ci/staging-honesty-preflight.ts`), run 2026-08-20T16:06:52Z:

  ```json
  {
    "environment_type": "clean_mirror",
    "staging_project_ref": "jiotjhqmedkajdsojsbn",
    "checks": [
      { "name": "staging_only_rows", "passed": true },
      { "name": "duplicate_names", "passed": true },
      { "name": "duplicate_versions", "passed": true },
      { "name": "known_artifacts", "passed": true },
      { "name": "submitted_anchors", "passed": true, "details": "1 SUBMITTED anchor(s) found." },
      { "name": "prod_divergence", "passed": true, "details": "Rig ledger reconciles with repo migration files + canonical baseline." }
    ]
  }
  ```

  All 6 checks pass — `environment_type=clean_mirror`, the CLAUDE.md §1.11A
  target state.

### Soak-driver fixtures (additive, `scripts/staging/wave3-soak-fixtures.sql`)

Beyond the standard baseline fixture, seeded specifically to exercise Wave 3's
role-resolution and opt-out behavior with real, distinguishable rows:

- **Org C** (`5eed0003-…c1`, VERIFIED) — one `PENDING_RESOLUTION` anchor,
  no opt-out. Default-enrolled per #2272.
- **Org D** (`5eed0003-…c2`, VERIFIED) — one `PENDING_RESOLUTION` anchor
  (same shape as Org C — the control), **plus** an explicit
  `organization_rules` row (`trigger_type='QUEUE_DIGEST'`, `enabled=false`).
- **Platform-admin fixture** (`5eed0003-…a3`, `profiles.is_platform_admin=true`,
  no org) — #2276's only recipient source.
- **Member fixture** (`5eed0003-…a4`, `ORG_MEMBER` of the baseline Seed
  Fixture Org, no `org_members` admin row) — for the Drive `not_admin` case.
- One SECURED, connector-sourced anchor (`public_id=ARK-WAVE3-CONN01`,
  `metadata.connector_source='docusign'`) — for #2246.

Also seeded a `switchboard_flags` row (`ENABLE_VERIFICATION_API=true`) — a
fresh rig's `switchboard_flags` table is empty and `get_flag()` fails closed,
so `/api/v1/*` is dark by env var alone until this row exists (known,
documented gotcha).

## Cloud Run — `arkova-worker-wave3-2026-08-staging`

- **Region:** us-central1. **Auth:** `--no-allow-unauthenticated`; IAM policy
  has exactly one binding
  (`serviceAccount:270018525501-compute@developer.gserviceaccount.com` →
  `roles/run.invoker`) — **verified no `allUsers` binding**
  (`gcloud run services get-iam-policy` before AND after).
- **Image:** `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:wave3-25465f5dadf868bc4cdd0c54ab63a0d548dd87c6`
  (linux/amd64, built via Cloud Build — build id `89ba1737-74e2-4bae-ac34-93914aebbccb`,
  `--build-arg BUILD_SHA=25465f5dadf868bc4cdd0c54ab63a0d548dd87c6`).
- **Image digest:** `sha256:90ea4e06b1c563045da151a6f7da934d91d20cfbaa667234bb3154976a08bd81`
- **Own secrets** (never repointing what live rigs use):
  `supabase-url-wave3`, `supabase-service-role-key-wave3`,
  `ip-hash-pepper-wave3`, `supabase-db-password-jiotjhqmedkajdsojsbn` — all
  new Secret Manager resources created this session. Shared, non-project-
  specific secrets reused by reference only (never mutated): `supabase-jwt-secret`,
  `stripe-secret-key-staging`, `stripe-webhook-secret-staging`,
  `api-key-hmac-secret-staging`, `cron-secret`, `sentry-dsn`,
  `google-oauth-client-id`, `google-oauth-client-secret`,
  `integration-state-hmac-secret`.
- **`MEMPOOL_API_URL` intentionally NOT set** (freezes soaks per BUG-2026-07-26-003).
- **`RESEND_API_KEY` intentionally NOT set** — see "No real email" below.
- **Revision history** (env/secret corrections needed to reach a fully working
  config; each is a config change on the SAME image/git_sha, not a code
  change):

  | Revision | Result | Why |
  |---|---|---|
  | `-00001-9t5` | Healthy, served ~22 min | Initial deploy. `/health` 200, `git_sha` matched union head exactly. |
  | `-00002-zlq` | **Failed** | Added `ENABLE_DRIVE_OAUTH=true` without `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`/`INTEGRATION_STATE_HMAC_SECRET` — `config.ts` boot-time `superRefine` guard fired (`Invalid worker configuration`). Prior revision (`-00001`) kept serving throughout — no downtime. |
  | `-00003-twt` | **Failed** | Added the three secrets above; still crashed — `GCP_KMS_INTEGRATION_TOKEN_KEY` also required once `ENABLE_DRIVE_OAUTH=true` is set (symmetric KMS key for OAuth token encryption). |
  | `-00004-cjk` | **Healthy, serving 100%** | Added `GCP_KMS_INTEGRATION_TOKEN_KEY=projects/arkova1/locations/global/keyRings/arkova-signing/cryptoKeys/integration-tokens` (same resource name prod uses; only the resource reference, not a secret). `/health` 200 again. |

- **Serving revision / soak clock:** `arkova-worker-wave3-2026-08-staging-00004-cjk`,
  created **2026-08-20T16:40:21Z** — this is the clock (Cloud Run revision
  uptime, matching this repo's established soak-clock convention; a probe
  loop's own liveness is not the clock). Revisions `-00001`/`-00002`/`-00003`
  do not count toward the T2 clock; the config only reached its final, fully
  correct shape at `-00004`.
- **Tag URL:** none — this is a brand-new dedicated service (no shared-service
  tag routing involved). Main URL:
  `https://arkova-worker-wave3-2026-08-staging-270018525501.us-central1.run.app`
- **`/health` at `-00004`, identity-token auth:**
  `{"status":"healthy","version":"0.1.0","git_sha":"25465f5dadf868bc4cdd0c54ab63a0d548dd87c6","uptime":65,"network":"mainnet","checks":{"database":"ok","anchoring":"ok","kms":"warning"}}`
  — `git_sha` matches the union head exactly. `kms: warning` is expected
  (`ENABLE_PROD_NETWORK_ANCHORING=false`, `USE_MOCKS=true`, no KMS/WIF signer
  configured — by design, this rig never touches Bitcoin).

## Soak clock

- **Start:** 2026-08-20T16:40:21Z (revision `-00004-cjk` creation).
- **Target end (T2, 12h):** 2026-08-21T04:40:21Z.
- **Status at the time this doc was written: clock running, NOT yet matured
  to 12h.** This session ran the deploy, the full per-member correctness
  verification below (all real, all live against the rig), and one ~45-minute
  sustained-load chunk (`docs/staging/wave3-2026-08/soak-load-chunk1-20260820.json`).
  The revision itself keeps running and passing health checks independent of
  any probe loop's own process lifetime — reaching the 12h mark requires
  either a scheduled re-invocation of `scripts/staging/wave3-load-loop.sh` (or
  equivalent) periodically through the window, or a follow-up session before
  2026-08-21T04:40:21Z. **Do not read this doc's existence as "soak complete."**

### Sustained load

`scripts/staging/load-harness.ts` refuses this rig's URL by design — its
`STAGING_API_BASE` validator (`scripts/staging/load-harness-env.ts`) only
accepts tag-routed URLs on the shared `arkova-worker-staging` service, a
control against contaminating the shared rig; it does not apply to a
dedicated standalone service like this one. Wrote
`scripts/staging/wave3-load-loop.sh` instead: mixed `GET /health` (~30/min),
`GET /api/v1/verify/ARK-WAVE3-CONN01` (~20/min),
`GET /.well-known/arkova-keys.json` (~12/min), plus both digest cron jobs
fired every 5 minutes. First chunk: 2026-08-20T16:46Z → 2026-08-20T17:31Z
(2700s), evidence at `docs/staging/wave3-2026-08/soak-load-chunk1-20260820.json`.

## Per-member evidence

### #2272 — queue digest default-on (`ENABLE_QUEUE_DIGEST`)

Triggered `POST /jobs/queue-digest` live (`X-Cron-Secret` auth). Response:
`{"admins":2,"sent":0,"suppressed":0,"skippedEmpty":1,"alreadySent":0,"failed":1}`.
`audit_events` rows confirm the real mechanism, not the count alone:

- Org C (enrolled, non-empty queue): `QUEUE_DIGEST_SENT` then
  `EMAIL_DELIVERY_FAILED` (`email_type: queue_reminder`,
  `recipient: orgc-admin-fixture@seed-fixture.invalid` — the REAL role-resolved
  ORG_ADMIN of Org C, never a hardcoded address).
- Org D (opt-out, same non-empty queue as Org C): **zero rows** — the
  opt-out was honored despite an identical queue shape to the org that WAS
  digested.
- Baseline Seed Fixture Org (empty queue — no `PENDING_RESOLUTION` anchors):
  **zero rows** — matches `skippedEmpty:1` in the response.

### #2276 — platform-admin health digest

Triggered `POST /jobs/platform-health-digest` live. Response:
`{"admins":1,"sent":0,"alreadySent":0,"failed":1}` — matches the one seeded
platform-admin fixture exactly. `audit_events`:
`EMAIL_DELIVERY_FAILED`, `org_id: null` (platform-wide, correctly distinct
from #2272's per-org model), `email_type: notification`,
`recipient: platform-admin-fixture@seed-fixture.invalid`. The baseline
seed-fixture-user (ORG_ADMIN, NOT platform admin) never appears — confirms
the recipient set is `profiles.is_platform_admin=true`, not any broader
admin definition.

**Both digests — no real email sent.** `RESEND_API_KEY` is deliberately unset
on this service. Per `services/worker/src/email/sender.ts` (SCRUM-3012), a
missing key in production does NOT silently succeed — `sendEmail()` returns
`{success:false, error:'Email delivery is not configured'}` and every attempt
writes an honest `EMAIL_DELIVERY_FAILED` `audit_events` row (confirmed above
for both digests) rather than a fabricated `EMAIL_SENT`. This makes "no real
email, ever" an architectural guarantee of this rig's config, not a hope, and
gives a queryable, durable audit trail of every recipient the code actually
resolved. §1.4 (document fingerprints / other users' emails) is satisfied
structurally: the email HTML body is generated in-process but the audit log
only ever records `recipient` + `email_type`, never the body — the body is
never transmitted anywhere (no Resend call fires) and never logged.

### #2232 — MCP audit log P0 + unmounted proof-keys

- **Proof-keys route reachable:** `GET /.well-known/arkova-keys.json` → HTTP
  200 with the real key registry (`arkova-proof-2026-q2`, Ed25519, active) —
  this route 404'd for everyone before the fix (`proofKeysRouter` was never
  mounted; BUG-024).
- **Audit log actually writes a row (the P0):** imported the real, shipped
  `logMcpToolCall` from `services/edge/src/mcp-audit-log.ts` (no
  reimplementation) via `scripts/staging/wave3-mcp-audit-probe.ts` and
  invoked it against this rig's real Postgres. Confirmed row:
  `event_type=MCP_TOOL_CALL, event_category=SECURITY, actor_id=<seed user>,
  target_type=mcp_tool, target_id=anchor_document, details={api_key_id:null,
  args_hash:<sha256, never raw args>, outcome:success, latency_ms:42,
  ip_hash:null}`. `ip_hash:null` is the documented fail-closed behavior for an
  unset `MCP_IP_HASH_PEPPER` (never falls back to an enumerable bare hash).
- **NOT exercised:** the actual Cloudflare `edge.arkova.ai` HTTP MCP
  transport (`services/edge/src/mcp-server.ts`'s `handleMcpRequest`) — that
  Worker is Carson's shared, standing infra (`memory/project_mcp_edge_server.md`),
  not part of this rig, and this task's scope was a Cloud Run service, not an
  edge Worker deploy. The write MECHANISM is proven directly against real
  Postgres; the HTTP-to-Cloudflare-to-write pipeline as a whole was not.

### #2246 — connector fingerprint proof caveat (§1.5)

`GET /api/v1/verify/ARK-WAVE3-CONN01` (a seeded SECURED anchor with
`metadata.connector_source='docusign'`) → HTTP 200,
`fingerprint_rederivability: "fetch_time_snapshot"` plus the full
Measured/Asserted/Not-asserted proof text verbatim from
`services/worker/src/constants/connectorFingerprint.ts`, over live HTTP
against the real deployed worker.

### #2220 — API-key revocation/deletion reachable

Real end-to-end HTTP round trip, no mocks:

1. Generated a synthetic key with the EXACT scheme `apiKeyAuth.ts` uses
   (`ak_live_` + 32 random bytes hex, HMAC-SHA256 with the real
   `api-key-hmac-secret-staging` value) — `scripts/staging` had no ready-made
   tool for this so it was done via a short inline Node script using the
   real algorithm from `generateApiKey`/`hashApiKey`, then inserted into
   `api_keys` (`is_active=true, revoked_at=NULL`).
2. `GET /api/v1/verify/ARK-WAVE3-CONN01` with `X-API-Key: <raw>` → HTTP 200,
   `x-ratelimit-limit: 1000` (the keyed tier, not anonymous 100/min) —
   confirms the key authenticated for real.
3. `UPDATE api_keys SET revoked_at=now(), revocation_reason=... WHERE id=...`
   — the exact mutation shape `PATCH /api/v1/keys/:keyId` performs (verified
   by reading the route: revoke stamps `revoked_at` + `revocation_reason`,
   guarded by `revoked_at IS NULL`, distinct from the hard-delete `DELETE`
   route).
4. **Same key, same request, immediately after** → HTTP 401
   `{"error":"api_key_revoked","message":"This API key has been revoked."}`
   — revoked keys are genuinely rejected on the next request.

**NOT exercised via HTTP:** the JWT-gated management endpoints themselves
(`POST /api/v1/keys`, `PATCH /api/v1/keys/:keyId`, `DELETE /api/v1/keys/:keyId`).
Confirmed **reachable** — hitting `DELETE /api/v1/keys/<uuid>` with a valid
GCP identity token returns a proper app-level JSON 401
(`{"error":"Invalid or expired authentication token"}`), not a 404 or a
platform-level rejection — but a full HTTP round trip through these routes
needs a real Supabase user JWT in the SAME `Authorization` header that Cloud
Run's own IAM check consumes on an IAM-protected (`--no-allow-unauthenticated`)
service; the two cannot coexist in one header. This is a pre-existing,
already-documented limitation of every IAM-protected rig in this repo —
`docs/reference/STAGING_RIG.md` states outright that "JWT-protected client
paths aren't load-tested by the soak harness" for the exact same reason on
the shared `arkova-worker-staging` rig. Not Wave-3-specific, not fixed here.

### #2230 / #2236 — Drive connect deny-reason separation

Same JWT/IAM collision as above blocks the HTTP route
(`POST /api/v1/integrations/google_drive/oauth/start`). Proved the underlying
logic directly instead: imported the real, shipped
`resolveDriveConnectEligibility` (`services/worker/src/integrations/connectors/drive-connect-eligibility.ts`,
no reimplementation) via `scripts/staging/wave3-drive-eligibility-probe.ts`,
run against real seeded rig data:

| Case | Caller | Result |
|---|---|---|
| `not_admin` | ORG_MEMBER of Seed Fixture Org, own org_id | `{"allowed":false,"reason":"not_admin"}` |
| `org_scope_required` | ORG_ADMIN of Seed Fixture Org, personal path (no org_id) | `{"allowed":false,"reason":"org_scope_required"}` |
| control (`org_unverified`) | ORG_ADMIN, own org_id, org is UNVERIFIED | `{"allowed":false,"reason":"org_unverified"}` |

Confirms the admin check runs BEFORE the verification-status check (a
non-admin gets `not_admin` even though the org happens to be unverified too —
the control case shows what an admin of the SAME unverified org gets
instead), and that the personal-path/org-path distinction produces the two
FD-D3 codes correctly.

**NOT exercised:** the HTTP route itself (same collision as #2220), and the
`logConnectDenial()` structured `logger.warn` line specifically — that call
lives in the route handler, not in `resolveDriveConnectEligibility`, so the
direct-invocation approach that proved the deny-reason logic did not exercise
it. Not independently confirmed this session.

### #2274 (npm publication prep) / #2252 (sdk-py model drift) — §1.12 exception

Both are SDK-path-only changes (`packages/sdk/`, `sdks/mcp-server/`,
`packages/arkova-py/`) — `memory/project_sdk_paths_are_hard_t2.md`: SDK paths
force T2 with no override label, but an SDK-only PR **deploys nothing**, so
there is no worker/rig surface for either to soak. Founder granted a §1.12
exception for exactly this shape. Recorded here rather than inventing a soak
that would exercise nothing: no Cloud Run traffic, no DB rows, and no
attempt was made to fabricate either.

## Explicitly NOT exercised (complete list)

1. **12h clock maturity** — clock started 2026-08-20T16:40:21Z; only ~45 min
   of sustained load run within this session. Needs continued relaunching of
   `scripts/staging/wave3-load-loop.sh` (or equivalent) to reach
   2026-08-21T04:40:21Z.
2. **#2232's Cloudflare `edge.arkova.ai` HTTP MCP transport** — only the
   underlying `logMcpToolCall` write mechanism was proven directly; the full
   Worker request pipeline is shared prod infra, out of this rig's scope.
3. **#2220's JWT-gated key-management HTTP endpoints** (`POST`/`PATCH`/`DELETE
   /api/v1/keys*`) — confirmed reachable (proper app 401, not 404); full round
   trip blocked by the Cloud-Run-IAM-vs-Supabase-JWT header collision, a
   pre-existing limitation of every IAM-protected rig in this repo. The
   underlying revoke/reject mechanism WAS proven via `X-API-Key` HTTP calls
   (see #2220 above).
4. **#2230/#2236's HTTP route** (`POST /google_drive/oauth/start`) and the
   `logConnectDenial()` warn-log line — same collision as #3; underlying
   eligibility logic WAS proven via direct invocation.
5. **§1.4 email-body content review** — the digest HTML templates were never
   independently line-read for cross-org/PII leakage this session; the
   guarantee that they never reach a real inbox is architectural
   (`RESEND_API_KEY` unset), not a content audit.
6. **Rollback rehearsal** — N/A, no migrations in this union (confirmed: zero
   `supabase/migrations/*.sql` diff between `origin/main` and the union head).
7. **`services/worker/src/ai/eval/s33-batch-acceptance.test.ts`** (32 tests) —
   confirmed pre-existing shallow-clone environment limitation of this
   worktree, not Wave-3-caused, not fixed (would require unshallowing the
   full repo).
8. **#2274/#2252 (SDK members)** — §1.12 exception; nothing deploys, nothing
   to soak. See above.
9. **Migration replay's two manually-applied indexes** (`0381`, `0389`) were
   NOT exercised under real query load in this session — they're pre-existing
   prod-applied indexes from before Wave 3, replayed onto this rig only as
   part of standard provisioning, not a Wave 3 member's own change.

---
_Written 2026-08-20T~17:20Z. Prod (`vzwyaatejekddvltxyye`) was READ-ONLY this
entire session (migration ledger comparison only). No PR was readied or
merged. No other rig (`arkova-worker-staging`, `arkova-worker-fullsoak-2026-08-staging`,
`arkova-worker-wave2-2026-08-staging`) or their Supabase projects
(`ujtlwnoqfhtitcmsnrpq`, `gnkuaywlpmsaezwvlvhk`, `fizyjojbebyalirtjjht`,
`tkciooifwxwnkoizgalp`) was queried, deployed to, or referenced by any
command in this session._
