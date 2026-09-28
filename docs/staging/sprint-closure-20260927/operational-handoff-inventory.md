# Operational handoff inventory — current packet

Prepared from the committed release/soak packet on 2026-09-28. This is an operator checklist, not an execution receipt. No live case has run and no soak has started.

## Exact remaining acceptance cases

All 23 matrix cases remain `OPEN / NOT RUN`:

- **Required pre-window/timed product cases:** `UAT14-1`, `UAT14-2`, `UAT23-1`, `UAT23-2`, `PROOF-1`, `DRIVE-1`, `DRIVE-2`, `CID-1`, `CID-2`, `CID-3`, `TAG-1`.
- **Required final-review recovery cases:** `CID-4`, `CID-5`, `DRIVE-3`, `ROLLBACK-1`.
- **Conditional partner/issuer cases, reported separately and blocking only when selected as release commitments:** `HAKI-1`, `HAKI-2`, `CRED-A1`, `CRED-T1`, `CRED-CE1`, `CRED-L1`, `SEK-1`, `SEK-2`.

The combined T3 acceptance window is at least 25 hours and 301 complete five-minute cycles because UAT-14/UAT-23 are stricter than the generic 24-hour floor. The closing cycle starts only after both wall-clock and monotonic 25-hour floors. Missing cycles extend or invalidate the window.

## Required names — no values

### Operator identities and permissions

- One named release operator and one independent verifier.
- Google Cloud identity authorized for the existing `arkova1` project and `us-central1` resources needed by the reviewed rig: Artifact Registry read, Cloud Run deploy/read, service-account creation and `actAs`, exact Secret Manager resource creation/access-policy binding, Cloud Scheduler create/read, logs/metrics read, and VPC connector use only when the selected chain endpoint requires it.
- A pre-created deterministic rig runtime service account `ark-rig-<rig-hash>-run@arkova1.iam.gserviceaccount.com` and Scheduler OIDC account `ark-rig-<rig-hash>-oidc@arkova1.iam.gserviceaccount.com`; no default compute identity.
- Supabase organization/project-creation authority for organization `byhkazrpmivhcsuqjtva`, plus `STAGING_NEW_SUPABASE_DB_PASSWORD`; the resulting new project ref, URL and service-role key are recorded without printing values.
- Authorized internal test organizations/users with AAL2 where required, API keys scoped to the named cases, approved recipient mailboxes, partner/issuer authorization, and retention/deletion instructions for synthetic data.

### Five per-rig secret resources

For rig name `ar20-closure-20260927`:

- `supabase-url-ar20-closure-20260927-staging`
- `supabase-service-role-key-ar20-closure-20260927-staging`
- `ip-hash-pepper-ar20-closure-20260927-staging`
- `recipient-identifier-pepper-ar20-closure-20260927-staging` — pinned version `1`
- `cron-secret-ar20-closure-20260927-staging`

The runtime account receives `secretAccessor` only on the exact resources it needs. The OIDC account receives only the reviewed service-level invoker role. Effective inherited/group/deny access remains a live preflight check.

### Existing dependency secret names required by every worker profile

- `stripe-secret-key-staging` → `STRIPE_SECRET_KEY`
- `stripe-webhook-secret-staging` → `STRIPE_WEBHOOK_SECRET`
- `api-key-hmac-secret-staging` → `API_KEY_HMAC_SECRET`

Their names do not prove test-mode contents or isolation. The operator must verify an enabled latest version, intended nonproduction ownership, exact runtime access, and production denial before provisioning.

### Additional names required only by selected profiles or acceptance cases

- **Chain profile:** `STAGING_GETBLOCK_RPC_URL_SECRET`, `STAGING_GETBLOCK_RPC_AUTH_SECRET`, `STAGING_TREASURY_WIF_SECRET`, `STAGING_BITCOIN_NETWORK`, `STAGING_BITCOIN_UTXO_PROVIDER`, `STAGING_KMS_PROVIDER`; private signet source names currently documented are `arkova-s33-rig-b1-bitcoin-core-signet-rpc-url`, `arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth`, and `arkova-s33-rig-b1-treasury-wif-signet`, with VPC connector `fullsoak-btc-rpc`. KMS signing also requires the reviewed key resource and runtime KMS permission.
- **Gemini profile:** `gemini-api-key-staging`, `STAGING_GEMINI_TUNED_MODEL`, and `STAGING_GEMINI_V6_PROMPT`.
- **Drive cases:** approved Google OAuth client configuration, authorized test account, selected test folder, refresh token held by the product path, and Scheduler/OIDC or cron authority for the hourly reconciliation route. Do not paste OAuth tokens into evidence.
- **ComputeID cases:** `ENABLE_COMPUTEID_INTEGRATION`, `COMPUTEID_WEBHOOK_SECRET`, `COMPUTEID_CA_CERT_PEM`, authorized partner passport/receipt fixtures, API key with the documented agent-management authority, and an approved callback receiver.
- **Email/UAT-23:** `RESEND_API_KEY`, approved sender/domain configuration, and approved test mailboxes. Ambiguous delivery is held for disposition and never automatically replayed.
- **Hosted MCP/edge cases:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, and `MCP_IP_HASH_PEPPER`; legacy HS256 testing alone additionally uses `SUPABASE_JWT_SECRET`. Hosted MCP needs its own candidate routing proof and must not inherit production secrets into an isolated edge environment.
- **Webhook cases:** customer callback URL and retrievable signing secret managed through the existing subscription path; evidence records neither value nor signed body.
- **Bulk recipient case:** `ENABLE_BULK_RECIPIENT_PROVISIONING` stays literal `false` unless that exact case is separately approved and observed. The flag covers only the bulk path, not independent recipient/admin entrypoints.

## Pre-clock prerequisites

1. Freeze the final candidate commit/tree after the native-outbox fixture-only correction, its immutable image digest, main baseline, included PR heads, and T3 classification. The earlier `a284855…` image is historical once that follow-up lands.
2. Use fallback source `0334eee90b1c84842828e42d64d62827ceb6cf79`, tree `85768f5bfe4ffdae256737c3153be96568804902`, immutable digest `sha256:c839d2073cdc3d941f602324ff236529a5d8ac354c65fc07c55a1a434b6e3868`.
3. Record final hosted CI truth. At this checkpoint the candidate native-outbox job failed on a seeded organization UUID collision and root was skipped; fallback run `36363082828` is still running. Neither is called fully green here.
4. Freeze the ordered database plan for `0488`, `0489`, `0491`–`0496`; explicitly decide other-owned `0490`. Apply only to the isolated staging project first and capture before/after ledger checksums.
5. Provision the named isolated rig from the reviewed `#3153` tooling; prove the new Supabase project, exact image digest, dedicated identities, five per-rig secrets, dependency access, and production/shared-project denial before the clock.
6. Establish the compatible-worker floor and rehearse `ROLLBACK-1`: all incompatible pre-A worker/job paths quiesced before the first owned row from fallback emergency DELETE or candidate traffic; fallback drains candidate-format rows; register, all PATCH and key mint remain maintenance `503`; emergency DELETE remains usable.
7. Freeze explicit background-job mode. `DISABLE_IN_PROCESS_ANCHOR_CRON` covers only anchor-related jobs, so it is not proof that all timers are paused. Inventory Scheduler and in-process jobs, allow only named routes/callers, and capture restoration state.
8. Provide verified UI preview routing, hosted-MCP routing, and preview client artifact hashes. API/SDK/CLI/stdio origins alone do not establish UI or hosted-MCP reachability.
9. Complete every applicable pre-window matrix row and record baseline errors, latency, queues, accounting, credits and identity. Start the clock only after all release-required prerequisites pass.

## Network choice and start authority

The founder has assigned the root tech-lead session ownership of starting and monitoring the soak when ready. The tech lead selects isolated signet with test coins. Network configuration remains unverified while isolated database setup and non-chain pre-window work proceed, including browser routing, Auth/Storage, Drive UI recovery, tag search, lifecycle authorization and synthetic import setup. Use the `mock` rig profile for that bounded work; it sets `USE_MOCKS=true` and `ENABLE_PROD_NETWORK_ANCHORING=false`.

That work does **not** pass chain-backed anchoring, downstream confirmation, natural batch-flush, proof availability, or the combined T3 window. Before any chain-dependent case or acceptance clock starts, verify signet RPC, signer/WIF, applicable KMS, VPC and test-coin spending controls. No production-network funds or production traffic are authorized by this staging choice. Source defaults the chain profile to `mainnet`; the three documented `arkova-s33-rig-b1-*` secret names describe signet, but their existence was not confirmed by the current resource check. Signet requires explicit `STAGING_BITCOIN_NETWORK=signet` plus the private VPC connector. A mock-only or mismatched-network run stays `OPEN`, never a pass.
