# Shared-Resource Register — cross-environment audit (FULLSOAK 2026-08)

**Author:** systemic read-only audit (Claude), 2026-08-15
**Scope:** every resource that is bound by, or reachable from, more than one Arkova environment (prod worker · standing staging worker · isolated soak rigs · connector side-rig · Cloudflare edge · GitHub Actions CI).
**Status:** READ-ONLY. No service, secret, DB, or IAM binding was modified. This file is left in the working tree, uncommitted, per the audit charter. Nothing here was applied.

> **Root-cause thesis.** BUG-031 (cross-env verify-cache poisoning) and the cross-env rate-budget bugs are not two isolated defects — they are two symptoms of one structural fact: **every non-prod Cloud Run service runs in the same GCP project (`arkova1`), reads from the same Secret Manager, runs as the same service account, and — for a long list of resources — binds the *same* credential prod binds, with no environment discriminator anywhere in the key, tag, or ciphertext.** The register below enumerates that surface so the sharing is validated deliberately instead of assumed.

> **Freeze note.** FULLSOAK-2026-08 is running (SOC2 clock to 2026-08-19T15:51:30Z). **Nothing in the "fix list" may touch the frozen rig, its secrets, or its config until the window closes.** Fixes are separated into *post-freeze code/config*, *rotation*, *console/infra*, and *founder decision*. The soak's own risk ruling for BUG-031 (`bug-031-risk-acceptance.md`) already accepted the residual for ≤4 days.

> **ID caveat.** The prompt referenced `BUG-018` / `BUG-032` as the cross-env rate-budget bugs. In this working tree those literal IDs resolve only to an unrelated March UAT sweep (`docs/bugs/uat_systematic_sweep_2026_03_31.md`). The rate-budget defects are actually tracked as **D-7 / D-8 / SCRUM-3139** (`gap-closure-mcp-e2e-ratelimit.md`). BUG-031 is real and correctly named. Confirm the ID mapping before citing in a fix PR.

---

## 0. Environment inventory (what "binds" means below)

| Environment | Cloud Run service / component | Runtime identity | Supabase project | Public? |
|---|---|---|---|---|
| **prod** | `arkova-worker` (rev `01310-god`) | `270018525501-compute@` (Owner) | `vzwyaatejekddvltxyye` | **yes** — `invoker-iam-disabled=true`, `ingress=all`; `/health` → 200 unauth |
| **staging (standing)** | `arkova-worker-staging` (`00294-tev`) | `270018525501-compute@` | `ujtlwnoqfhtitcmsnrpq` (its backing project was deleted per BUG-015 → currently inert) | invoker IAM-gated |
| **soak rig (frozen)** | `arkova-worker-fullsoak-2026-08-staging` (`00013-mrw`) | `270018525501-compute@` | `gnkuaywlpmsaezwvlvhk` (isolated) | invoker: compute SA + monitoring SA |
| **side-rig** | `arkova-worker-connector-sidecar-2026-08-staging` (`00013-zqx`) | `270018525501-compute@` | `ehqqearcitrgloibtjqx` (isolated) | **`allUsers` invoker** — internet-reachable, `/health` → 200 |
| **mcp** | `chaindump-mcp` | `270018525501-compute@` | — | **`allUsers` invoker** |
| **edge** | Cloudflare Worker `edge.arkova.ai` | CF account | — | public |
| **CI** | GitHub Actions | WIF → `github-actions-deploy@` | all | — |
| **bitcoind** | VM `arkova-s33-rig-b1-bitcoin-core-signet` (10.33.10.10) | `s33-rig-b1-bitcoin-core@` | — | isolated VPC |

The recurring amplifier: **five Cloud Run services — including the two `allUsers` ones — all run as the `270018525501-compute@` default SA, which holds `roles/owner` on the project and has a user-managed downloadable key** (key `fd2b4667…`, created 2026-03-25). So "a non-prod environment misbehaves" is rarely contained to that environment.

---

## 1. Shared-resource matrix

Verdict legend: **SAFE-BY-DESIGN** · **NEEDS-NAMESPACE** (add env discriminator to key/tag/AAD) · **NEEDS-SEPARATE-INSTANCE** (per-env credential/key/instance/SA) · **NEEDS-ROTATION** (credential exposed or was in git history).

### Identity & IAM

| # | Resource | Who binds it | State that crosses envs | Blast radius if a non-prod env misbehaves | Verdict |
|---|---|---|---|---|---|
| 1 | **`270018525501-compute@` default SA** (`roles/owner` + downloadable key) | prod, staging, soak rig, **public side-rig**, **public chaindump-mcp** all run as it | The runtime identity itself. Same principal everywhere. | RCE/SSRF in the internet-facing side-rig or chaindump-mcp = **project Owner** = read every secret (incl. `bitcoin-treasury-wif`), sign mainnet via KMS, deploy any revision. The downloadable key means the identity is exfiltratable, not just assumable. | **NEEDS-SEPARATE-INSTANCE** (per-service least-priv SA) + **NEEDS-ROTATION** (kill the downloadable key) — matches known P0 `gcp_iam_downloadable_keys_p0`. Founder-reserved. |
| 2 | **`arkova-cli@` SA** (`secretmanager.admin` + `cloudkms.admin` + `run.admin` + downloadable key `00548b68…`, 2026-04-16) | operator/CLI, CI-adjacent | Admin over all secrets + KMS across every env | A leaked key reads `BITCOIN_TREASURY_WIF` and can re-sign mainnet; admin on all env secrets. | **NEEDS-ROTATION** (downloadable key) — founder-reserved. |
| 3 | **`github-actions-deploy@` SA + single WIF provider** | one WIF + one deploy SA deploys prod, staging, and rigs | Deploy authority to every service | A compromised CI run can deploy a poisoned image to prod. `run.admin` + `artifactregistry.writer`. | **SAFE-BY-DESIGN** (WIF, no static key) — note the single deploy identity; keep OIDC-only. |

### Cron / control plane

| # | Resource | Who binds it | State that crosses envs | Blast radius | Verdict |
|---|---|---|---|---|---|
| 4 | **`cron-secret`** (one Secret Manager secret) | **prod worker, staging worker, soak rig, side-rig, AND the Cloudflare edge** all bind the *same* `cron-secret` (rig provisioner even hard-codes the non-`-staging` name; runbook §2.2 documents it as intentional) | A single shared bearer value | `verifyCronAuth` (`services/worker/src/routes/cron.ts:191`) accepts a raw **`X-Cron-Secret` header alone** as sufficient — no OIDC required on that path. Prod is internet-reachable (`invoker-iam-disabled=true`). So a leak of the secret from *any* rig, the edge, or git history lets anyone on the internet trigger **110 prod `/jobs/*` routes** including `/mainnet-migration`, `/daily-anchor-flush`, `/batch-anchors?force=true`, `/process-revocations`, `/monthly-allocation-rollover`, `/reconcile-credit-conservation`, `/consolidate-utxos`, `/bq-export-*`. The value was hard-coded in git history 2026-03-24→2026-08-10 (rotated to v2 2026-08-10; **exposure-window audit still owed**). | **NEEDS-SEPARATE-INSTANCE** (per-env secret) **+ code:** drop the `X-Cron-Secret` path on prod entirely — prod schedulers are OIDC-only (`CRON_OIDC_AUDIENCE` is per-service and correct). |
| 5 | **GH repo variables** `DEPLOY_WORKER_PAUSED` (=true), `SOAK_GATE_DISABLED` (=false), `GOLDEN_AUDIT_ENFORCE` | one repo, all envs' merge/deploy semantics | Control-plane switches | `SOAK_GATE_DISABLED="true"` short-circuits the entire staging-soak evidence gate to a pass (`scripts/ci/check-staging-evidence.ts`). Currently `false` (enforcing). `DEPLOY_WORKER_PAUSED=true` freezes prod deploys but `workflow_dispatch` bypasses it. | **SAFE-BY-DESIGN** (admin-only, read fresh per run) — but **remove `SOAK_GATE_DISABLED` from the workflow** once the freeze closes; a live no-op switch on the merge gate should not persist. |

### Cryptographic material

| # | Resource | Who binds it | State that crosses envs | Blast radius | Verdict |
|---|---|---|---|---|---|
| 6 | **KMS `integration-tokens`** (`projects/arkova1/…/cryptoKeys/integration-tokens`) | prod, staging, side-rig via `GCP_KMS_INTEGRATION_TOKEN_KEY` (identical string); every worker runs as the SA that holds `cryptoKeyEncrypterDecrypter` | Connector OAuth token ciphertext | **No AAD anywhere** (`services/worker/src/integrations/oauth/crypto.ts:47,53` — plain `encrypt/decrypt`, repo-wide `additionalAuthenticatedData` grep = 0 hits). Ciphertext carries no env/org/tenant binding; the only context is `token_kms_key_id` stored *next to* the blob. **A prod-encrypted connector token is byte-for-byte decryptable by any rig**, with no signal a rig did it. Already exercised on a rig against "the real integration-tokens KMS key" (`drive-oauth-and-ce-drift-closure.md` §2.1). | **NEEDS-SEPARATE-INSTANCE** (per-env KMS key) **+ NEEDS-NAMESPACE** (bind org/env as AAD so a prod blob can't be decrypted out of context). |
| 7 | **KMS `bitcoin-mainnet`** signing key | signable by `270018525501-compute@` (every worker) + `arkova-cli@` | Mainnet signing capability | Every rig runs as the SA that can call KMS to sign a **mainnet** Bitcoin transaction, regardless of the rig's signet config. | **NEEDS-SEPARATE-INSTANCE** (rigs must run as a non-prod SA without mainnet-signer) — folds into #1. |
| 8 | **`bitcoin-treasury-wif`** (mainnet treasury private key) | **prod worker AND staging worker** both mount it | The live mainnet treasury WIF | `arkova-worker-staging` mounts the **mainnet** treasury key even though it runs `USE_MOCKS=true` / `ENABLE_PROD_NETWORK_ANCHORING=false`. Inert only because its Supabase project is deleted; a revived or compromised staging worker holds the real treasury signer. (Soak rig correctly uses `treasury-wif-legacy-soak-2026-08-staging`, signet.) | **NEEDS-SEPARATE-INSTANCE** — unbind mainnet WIF from staging; give it a signet/mock WIF. |
| 9 | **Google OAuth client `270018525501-llo9…`** (`google-oauth-client-id`/`-secret`) | prod, staging, side-rig all bind the *same* client; **no `-staging` variant exists** | One OAuth app identity + its consent grants | Redirect URI is built from the request host at runtime (`drive-oauth.ts:354`), and the documented remediation on file is to **add rig callback URIs to the prod client** (`connector-sidecar-evidence.md` §2.3), widening it. Consent tokens **accumulate all previously granted scopes** (`include_granted_scopes=true`, `drive.ts:143`) — a Drive connect was observed carrying 33 scopes incl. `gmail.modify`. One leaked refresh token = broad Google access under this single client across every env that shares it. | **NEEDS-SEPARATE-INSTANCE** (dedicated OAuth client per env, console action) **+ NEEDS-NAMESPACE** (stop `include_granted_scopes` scope accumulation; request minimal scopes). |
| 10 | **`INTEGRATION_STATE_HMAC_SECRET`** | prod, staging, side-rig — single value, no per-env variant | OAuth `state` signing key | A rig-signed OAuth `state` validates on prod and vice-versa. | **NEEDS-SEPARATE-INSTANCE** (per-env) — lower priority. |
| 11 | **`api-key-hmac-secret`** | prod worker + **staging worker** bind the prod value (rigs correctly use `-staging`) | API-key HMAC | API keys minted on prod hash-validate on staging. Blast radius bounded by staging being inert. | **NEEDS-SEPARATE-INSTANCE** (repoint staging to `-staging`). |
| 12 | **`supabase-jwt-secret`** | prod worker + **staging worker** bind the prod value | JWT verification key | A prod-minted user JWT is accepted by the staging worker (which then talks to a different DB) — config drift + cross-env auth. | **NEEDS-SEPARATE-INSTANCE**. |

### Shared datastores (the BUG-031 family)

| # | Resource | Who binds it | State that crosses envs | Blast radius | Verdict |
|---|---|---|---|---|---|
| 13 | **Upstash Redis** `tops-mayfly-40057.upstash.io` (one DB) | **prod worker + staging worker** bind `UPSTASH_REDIS_REST_URL/TOKEN`; soak rig & side-rig do **not** (side-rig unbound 2026-08-15 per `bug-031-risk-acceptance.md`) | Verify-response cache, idempotency replay, rate counters | **Zero env namespacing on any prefix.** `verify:v5:${publicId}` stores the full public verify response body (TTL 300s) — a non-prod writer poisons a prod caller (BUG-031). `idem:${scopeId}:…` replays HTTP responses (TTL 7200s); anon `scopeId` is a **raw client IP** → prod/staging collide on shared egress. Unprefixed rate-limit keys sit at the Redis root as **bare client IPs / API-key IDs** (`utils/rateLimit.ts:122`). Fix PR #2223 (`arkova:rl:` prefix, still env-less) is **not in this tree**. | **NEEDS-NAMESPACE** (env discriminator on every prefix — `verify:v5:`, `idem:`, unprefixed, `arkova:v2:`) **or NEEDS-SEPARATE-INSTANCE** (separate Upstash DB per env). Code PR, already scoped post-freeze. |
| 14 | **Cloudflare KV** (`MCP_RATE_LIMIT_KV`, `MCP_ORIGIN_ALLOWLIST_KV`) | edge worker; hardcoded namespace IDs in `wrangler.toml:41-48`, **no `[env.*]` override** | MCP per-tool rate counters (`rl:…`), x402 IP counters, HMAC origin allowlist (`allow:${apiKeyId}`) | Same env-less-key defect as Upstash, on a different store. Bindings **fail-open** when absent. Every deploy from this config shares one KV namespace. | **NEEDS-NAMESPACE** (env-prefixed keys) **or NEEDS-SEPARATE-INSTANCE** (per-env KV namespace). |
| 15 | **`supabase_access` PAT** (`sbp_*`, org-wide Management API token) | CI (`migration-drift.yml`, defaults `SUPABASE_PROJECT_REF` to the **prod** ref) + ad-hoc scripts; reads prod `vzwya…` and rig `gnkua…` ledgers in one invocation | An account-level token that can read/create **any** project in the org | A leak = read/alter migration ledgers and create projects across prod + every rig. Nothing in-repo scopes it to a project list. | **NEEDS-ROTATION** + scope-reduction (project-scoped read tokens where the API allows) — founder decision (account-level token). |
| 16 | **`arkova_analytics` BigQuery dataset** | `bq-export-schemas.ts:78` hardcodes `DATASET_ID='arkova_analytics'`, project `arkova1` — **no env var override**; compute SA (all workers) has `bigquery.dataEditor` | Analytics tables (anchors, verifications, audit_events, …) | Isolation is *accidental* (missing rig config), not enforced: the side-rig demonstrably wrote **23 audit rows into prod's dataset** via `/bq-export-backfill` (`side-rig-cron-coverage.md:140`). | **NEEDS-NAMESPACE** (env-derived dataset name; default rigs to a no-op dataset) — code PR. |

### Third-party / vendor credentials

| # | Resource | Who binds it | State that crosses envs | Blast radius | Verdict |
|---|---|---|---|---|---|
| 17 | **`gemini-api-key`** | prod, soak rig, side-rig bind the **prod** key (a `gemini-api-key-staging` exists but rigs don't use it) | AI Studio quota/billing | Rig soak traffic drew down **prod Gemini quota** (side-rig: 1,000/1,000 embeddings on `gemini-api-key`). A rig runaway rate-limits prod AI. | **NEEDS-SEPARATE-INSTANCE** (bind `-staging` on rigs) — config. |
| 18 | **DocuSign: `docusign_integration_key` + `docusign_client_secret` + `docusign_connect_hmac_secret`** | prod uses `_prod`-suffixed HMAC/client secrets, but **rigs + side-rig bind the unsuffixed shared `docusign_connect_hmac_secret` / `docusign_integration_key`**; side-rig ran the real prod DocuSign creds end-to-end | One DocuSign app identity; a rig `provisionConnectListener` can create a Connect listener on the **production** DocuSign account pointing at a rig URL | Rig can register webhooks against the prod DocuSign account; the RC-T2 manifest deliberately used an **inert random** HMAC precisely to prevent this — the fullsoak/side-rig did not. | **NEEDS-SEPARATE-INSTANCE** (dedicated DocuSign integration + inert/random HMAC on non-prod). |
| 19 | **DocuSign refresh-token storage** (`docusign-token-store.ts:29-67`) | rig token-store derives the Secret Manager project from `GCP_KMS_INTEGRATION_TOKEN_KEY` → **`arkova1`** | Refresh-token secrets | **Rig-issued DocuSign refresh tokens land in the prod project's Secret Manager namespace** (`arkova-docusign-{orgId}-…-refresh-token`). | **NEEDS-SEPARATE-INSTANCE** (rig project-id must not fall back to `arkova1`). |
| 20 | **Stripe `stripe-secret-key` / `stripe-webhook-secret`** | prod = `sk_live_`; **staging worker binds the prod `sk_live` key**; rigs use `-staging` (`sk_test_`) | Payments API + webhook signing | Staging worker holds the **live** Stripe key + prod webhook secret (inert only via deleted DB). Rigs are safe (test keys, all observed 401). | **NEEDS-SEPARATE-INSTANCE** (staging → `-staging`); rig posture SAFE-BY-DESIGN. |
| 21 | **Public-record fetch keys** (`courtlistener-api-token`, `openstates-api-key`, `sam-gov-api-key`, `edgar-user-agent`, `together-api-key`, `runpod-api-key`, `resend-api-key`) | prod, staging, side-rig share the same values | Vendor quota/identity | Rig usage consumes/exposes prod vendor quota — observed `courtlistener` **OVER QUOTA (429)** and `sam-gov` **INVALID (401)** during side-rig runs; a rig can quota-DoS prod ingestion. `resend` can send mail as prod. | **NEEDS-SEPARATE-INSTANCE** (per-env vendor keys) — medium. |
| 22 | **`cloudflare-api-token` / `cloudflare-tunnel-token`** | prod worker + staging worker bind them | CF account control + tunnel | A staging-worker compromise yields CF API/tunnel control. | **NEEDS-SEPARATE-INSTANCE** / scope-review — medium. |

### Observability / infra (mostly contained)

| # | Resource | Who binds it | State that crosses envs | Blast radius | Verdict |
|---|---|---|---|---|---|
| 23 | **Sentry DSN** (`sentry-dsn`, one worker DSN) | prod + (optionally) staging; rigs currently **off** | Error events | Env separation is by tag, not DSN: `SENTRY_ENVIRONMENT` is derived from `K_SERVICE`, so a rig that set the DSN would still tag as its own service (prevents flooding prod alerts). Rigs report "SENTRY_DSN not configured". | **SAFE-BY-DESIGN** (runtime env-tag separation; rigs off). |
| 24 | **`alert-delivery-proof` Pub/Sub topic + the 2 notification channels** (email `carson@arkova.io` + the pubsub proof channel) | one topic, one channel set; **both prod and soak alert policies page the same channels** | Alert routing | During the soak, rig pages (revision drift, bitcoind down, cold start) hit the same channel prod pages use. No env var configures it; no per-env topic. | **SAFE-BY-DESIGN** (intentional for the watched soak) — optional NEEDS-NAMESPACE (separate rig channel) post-soak. |
| 25 | **Artifact Registry `arkova1/arkova-worker-images/arkova-worker`** | one repo/image for prod, staging, rigs | Container images | Prod pins by full SHA/digest (safe), and the rig ran prod's exact digest as a true mirror. But `deploy-staging.yml` pushes `:latest` into the **prod-serving repo with no image scan**, and the bitcoind image lives in the same repo. Supply-chain surface: a poisoned `:latest` or a non-prod push into the prod repo. | **NEEDS-NAMESPACE** (separate non-prod repo/tag; stop `:latest` from staging; scan all pushes). |
| 26 | **bitcoind VM + RPC credential + VPC** | VM on `arkova-s33-rig-b1-bitcoin-core-signet-vpc`; RPC firewall allows **only** `10.33.11.0/28` (the `fullsoak-btc-rpc` connector); RPC secrets bound only to the fullsoak rig | Signet RPC | Network-isolated: the `/28` holds only the fullsoak connector, so "reachable from any 10.33.11.x workload" is bounded to that one connector. Cross-**rig** secret reuse exists (fullsoak binds the torn-down b1 rig's RPC secrets + the deleted legacy rig's signet WIF) but all non-prod signet. | **SAFE-BY-DESIGN** (network isolation holds) — hygiene note on cross-rig secret reuse. |

**Also verified separated (not shared) — no action:** `ip-hash-pepper` / `RECIPIENT_IDENTIFIER_PEPPER` (prod + each rig have their own; side-rig pepper "deliberately NOT reused"), `HEALTH_DETAIL_TOKEN` (prod own + `-fullsoak` variant), `supabase-url` / `-service-role-key` (genuinely per-project). A second `redis_token` secret exists but is bound to no live service.

**Total distinct shared resources audited: 26** (+ 3 confirmed-separated classes noted for completeness).

---

## 2. Verdict tally

| Verdict | Count | Resource #s |
|---|---|---|
| **SAFE-BY-DESIGN** | 5 | 3 (WIF deploy SA), 5 (repo vars), 23 (Sentry), 24 (Pub/Sub alerts), 26 (bitcoind VM/VPC) |
| **NEEDS-NAMESPACE** | 4 | 13 (Upstash), 14 (CF KV), 16 (BigQuery), 25 (Artifact Registry) |
| **NEEDS-SEPARATE-INSTANCE** | 13 | 1 (compute SA), 7 (KMS mainnet), 8 (treasury WIF on staging), 9 (OAuth client), 10 (state HMAC), 11 (API HMAC), 12 (JWT secret), 17 (Gemini), 18 (DocuSign app), 19 (DocuSign token project), 20 (Stripe on staging), 21 (vendor keys), 22 (CF tokens) |
| **NEEDS-ROTATION** | 2 primary + 3 compound | 2 (arkova-cli key), 15 (supabase PAT); compound on 1 (compute key), 4 (cron-secret), 9 (OAuth) |
| **NEEDS-NAMESPACE + NEEDS-SEPARATE-INSTANCE (dual)** | resource 6 (KMS integration-tokens: separate key **and** AAD) | 6 |

(Resource 4 `cron-secret` carries a NEEDS-SEPARATE-INSTANCE verdict plus a code change; several items carry a compound rotation obligation. The tally above lists each resource under its primary verdict.)

---

## 3. Prioritized fix list

Tier key: **[CODE]** merge-gated code/config PR · **[ROT]** secret rotation · **[CON]** GCP/Google/CF console or IAM action · **[FND]** founder decision (reserved identity or account-level). All items marked **post-freeze** must not touch the frozen rig/secrets before 2026-08-19T15:51:30Z.

### P0 — do first after the freeze (or now if it does not touch the rig)

1. **[CON][FND] Kill the downloadable keys on `270018525501-compute@` and `arkova-cli@`, and stop running public services as Owner** (res. 1, 2). Give the side-rig and chaindump-mcp their own least-priv SAs; remove `roles/owner` from the runtime SA. This is the single biggest blast-radius reducer and the existing `gcp_iam_downloadable_keys_p0`. Founder-reserved.
2. **[CODE] Remove the `X-Cron-Secret` header path from prod cron auth** (res. 4). Prod schedulers already use per-service OIDC (`CRON_OIDC_AUDIENCE`); the shared-secret door on an internet-reachable worker is the cross-env prod-cron takeover vector. Then **[ROT]** move rigs to a per-env cron secret and complete the 2026-03-26→2026-08-10 git-history exposure audit.
3. **[CON] Unbind the mainnet `bitcoin-treasury-wif` from `arkova-worker-staging`** (res. 8) and repoint its Stripe/`sk_live`, API-HMAC, and JWT secrets to `-staging` variants (res. 11, 12, 20). The standing staging worker is currently prod-credentialed; its rebuild is already a tracked decision — do not revive it until repointed.

### P1 — cross-env cryptographic isolation (post-freeze)

4. **[CODE][CON] KMS `integration-tokens`: add per-env keys + AAD** (res. 6). Bind `{env, org_id}` as `additionalAuthenticatedData` on encrypt/decrypt so a prod token blob cannot be decrypted out of context, and split the key per environment. Until then, connector token blobs are the clearest "rig can replay prod state" path.
5. **[CON] Dedicated Google OAuth client per environment** (res. 9) instead of adding rig redirect URIs to the prod client; and **[CODE]** drop `include_granted_scopes=true` / request minimal scopes so consent tokens stop accumulating `gmail.modify`-class grants.
6. **[CODE] Fix rig DocuSign token project fallback** (res. 19) so rig refresh tokens stop landing in prod's Secret Manager; give non-prod an inert/random Connect HMAC + dedicated integration key (res. 18).

### P1 — shared-datastore namespacing (the BUG-031 family, post-freeze)

7. **[CODE] Env-namespace every Upstash prefix** (res. 13) — `verify:v5:`, `idem:`, the unprefixed rate-limit keys, and `arkova:v2:` — or split to a per-env Upstash DB. Land PR #2223's `arkova:rl:` work **with** an env discriminator (its current form is still env-less per D-8). Add `UPSTASH_*` to the worker Zod config schema so it fails closed instead of silently degrading.
8. **[CODE] Env-namespace the Cloudflare KV keys / add `[env.*]` namespace overrides** (res. 14).
9. **[CODE] Make `DATASET_ID` env-configurable and default rigs to a throwaway dataset** (res. 16) so a rig cron can't write into `arkova1.arkova_analytics`.

### P2 — quota / vendor isolation & supply chain (post-freeze)

10. **[ROT][FND] Rotate and scope-reduce the `supabase_access` PAT** (res. 15); stop defaulting CI's `SUPABASE_PROJECT_REF` to the prod ref.
11. **[CON] Bind `gemini-api-key-staging` (and per-env vendor keys) on rigs** (res. 17, 21) so soak traffic stops drawing on prod quota.
12. **[CODE][CON] Separate non-prod Artifact Registry repo/tag; stop `deploy-staging.yml` pushing `:latest`; scan all pushes** (res. 25).
13. **[CON] Per-env `INTEGRATION_STATE_HMAC_SECRET` and Cloudflare tokens** (res. 10, 22).

### Housekeeping

14. **[CODE] Remove `SOAK_GATE_DISABLED` from `staging-evidence.yml`** once the freeze closes (res. 5) — a live merge-gate no-op switch should not persist.
15. Reconcile the **BUG-018/032 ↔ D-7/D-8/SCRUM-3139** ID mapping before any fix PR cites them.

### Founder-decision items (surface, do not action)

- Downloadable keys / Owner SA (res. 1, 2) — reserved.
- `supabase_access` account-level PAT rotation (res. 15).
- Google OAuth client split + consent-screen scopes (res. 9).
- Rebuild vs. retire of the standing `arkova-worker-staging` (already tracked; it is the largest single prod-credential concentration outside prod).

---

## 4. The five worst findings

1. **One Owner service account runs every service, including two `allUsers`-invocable ones, and is exfiltratable via a downloadable key** (res. 1). This is the multiplier that turns every other row from "non-prod annoyance" into "prod compromise." RCE/SSRF in the public side-rig or chaindump-mcp = project Owner.
2. **`cron-secret` + internet-reachable prod `/jobs`** (res. 4). The same secret authenticates prod, staging, both rigs, and the edge; `X-Cron-Secret` alone authorizes 110 prod cron routes (incl. `mainnet-migration`, forced anchor flush, revocations) with no OIDC; the value was in git history for ~4.5 months.
3. **KMS `integration-tokens` has no AAD and is decryptable estate-wide** (res. 6). A prod connector-OAuth token blob is byte-for-byte decryptable by any rig, with zero cryptographic signal — the literal "rig-decrypted blob replayed against prod rows" scenario, already exercised on a rig.
4. **One Google OAuth client for prod and every rig, widened by adding rig redirect URIs, with scope accumulation** (res. 9). A single leaked refresh token grants broad Google access (a Drive connect observed carrying 33 scopes incl. `gmail.modify`) under a client shared across environments.
5. **Upstash Redis has zero environment namespacing** (res. 13, the actual BUG-031). The public verify response cache (`verify:v5:`), idempotency replay (`idem:`), and rate counters (bare client IPs at the DB root) are all shared prod↔staging with no discriminator — the confirmed cross-env cache-poisoning and rate-budget root cause.

_Runners-up: the standing staging worker mounting prod `sk_live` + mainnet treasury WIF (res. 8, 20); the org-wide `supabase_access` PAT reaching prod and all rigs in one call (res. 15)._

---

_Read-only audit. Sources: live `gcloud`/`gh` inventory of project `arkova1` (Secret Manager, Cloud Run env/secret bindings, IAM, KMS, Scheduler, Pub/Sub, Artifact Registry, VPC/firewall, monitoring) + repository code census (`services/worker`, `services/edge`, `.github/workflows`, `scripts/staging`, `docs/staging/fullsoak-2026-08`). No mutation performed; file left uncommitted in the working tree._
