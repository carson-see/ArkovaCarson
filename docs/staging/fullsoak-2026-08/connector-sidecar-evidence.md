# Connector Side-Rig — Credential-Gated Coverage Evidence

**Date:** 2026-08-12
**Rig name:** `connector-sidecar-2026-08`
**Purpose:** Close the credential-gated coverage gap left DECLARED-UNTESTED by the 7-day full soak, on a
separate service + separate database, at the same image digest.

---

## 0. Provenance — read this first

> **This is SIDE-RIG evidence at the same image digest as prod/soak. It is NOT frozen-soak evidence and
> carries NO soak-tier authority.** It does not satisfy a T1/T2/T3 staging-soak requirement for any PR, it
> is not an RC-manifest input, and it must not be pasted into a `## Staging Soak Evidence` block.
>
> **The 7-day soak rig was never touched.** No command in this session mutated Cloud Run service
> `arkova-worker-fullsoak-2026-08-staging`, its revisions/env/secrets/scheduler, or Supabase project
> `gnkuaywlpmsaezwvlvhk`. Verified before and after: the soak service was on revision
> `arkova-worker-fullsoak-2026-08-staging-00013-mrw` at session start and remains on
> `arkova-worker-fullsoak-2026-08-staging-00013-mrw` (Ready=True) at session end.
>
> **Production was read-only.** The only prod touches were `gcloud run services describe arkova-worker`
> (to read `maxScale`/`minScale`) and a Supabase project listing. Prod worker remains `arkova-worker-01310-god`.
> No prod database read, write, or secret rotation occurred.

**Image digest (identical to prod and to the soak rig):**
`sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18`
**Worker `git_sha` reported by `/api/health`:** `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58`

---

## 1. Reused vs provisioned

### 1.1 Reuse was attempted first and was NOT possible

The Sprint-2 lane rigs named in the brief **no longer exist**. Their Secret Manager entries survive as
orphaned pointers to deleted Supabase projects:

| Secret | Points at | Reality |
|---|---|---|
| `supabase-url-lane3-s2-ds-staging` | `xmirrwyrewaestriubrl` | **deleted** — DNS does not resolve (curl exit 000) |
| `supabase-url-lane3-s2-drive-staging` | `zeivcujolgwdaoexuvte` | **deleted** — DNS does not resolve |
| `supabase-url-lane3-s2-ce-staging` | `obpgwzbsalzscckugvsq` | **deleted** — DNS does not resolve |

`list_projects` on org `byhkazrpmivhcsuqjtva` returns exactly **two** projects: prod
(`vzwyaatejekddvltxyye`) and the running soak rig (`arkova-fullsoak-2026-08` / `gnkuaywlpmsaezwvlvhk`).
No Cloud Run service survives for any lane3-s2 rig.

> **Collateral finding — the CLAUDE.md §1.11 "standing rig" is gone.** `ujtlwnoqfhtitcmsnrpq`, described in
> §1.11 and `docs/reference/STAGING_RIG.md` as the standing shared staging project, is **also deleted**
> (DNS does not resolve; `supabase-url-staging` still points at it). Any doc or runbook instructing
> `npx supabase db push --linked` against shared staging is currently pointing at nothing.

**Not reused (deliberately):** the CLI (but not MCP) also lists `sedlcvkquvconcjcywne`
(`supabase-cerulean-mountain`, INACTIVE, region us-east-1) under a **Vercel-managed org**
(`vercel_icfg_WS40aivFkglQixzB5aO4yUu6`). It was left untouched: unknown provenance, outside the Arkova
org, and it may back a live Vercel deployment. Restoring it and replaying 111 migrations into it would
have been a contamination risk that §1.11A exists to prevent. Flagged here for a human to reclaim or
delete if it is genuinely idle.

### 1.2 Provisioned

| Component | Value |
|---|---|
| Supabase project | `arkova-connector-sidecar-2026-08` — ref **`ehqqearcitrgloibtjqx`**, region `us-east-2`, PG 17 |
| Cloud Run service | **`arkova-worker-connector-sidecar-2026-08-staging`** (us-central1) |
| Service URL | `https://arkova-worker-connector-sidecar-2026-08-staging-270018525501.us-central1.run.app` |
| Final revision | `arkova-worker-connector-sidecar-2026-08-staging-00005-gpl` |
| Runtime SA | `270018525501-compute@developer.gserviceaccount.com` |
| Scaling | `min-instances=0`, `max-instances=2` |

**Schema replay result:** migration ledger head **`0409`**, 111 ledger rows, **115 public tables, 115 with
RLS enabled (100%)**.

**Secrets created for this rig (5):**
`supabase-url-connector-sidecar-2026-08-staging`,
`supabase-service-role-key-connector-sidecar-2026-08-staging`,
`supabase-anon-key-connector-sidecar-2026-08-staging`,
`supabase-db-password-connector-sidecar-2026-08`,
`ip-hash-pepper-connector-sidecar-2026-08-staging` (freshly minted — prod's pepper was deliberately NOT reused).

**KMS:** no grant needed. `270018525501-compute@developer.gserviceaccount.com` already holds
`roles/cloudkms.cryptoKeyEncrypterDecrypter` on
`projects/arkova1/locations/global/keyRings/arkova-signing/cryptoKeys/integration-tokens`.

---

## 2. Per-feature verdicts

| # | Feature | Verdict |
|---|---|---|
| 1 | DocuSign OAuth → fetch → server-side fingerprint → anchor | **PASS (full chain)** |
| 2 | Google Drive OAuth | **BLOCKED — needs two human actions in Google Cloud Console** |
| 3 | Stripe checkout end-to-end | **PARTIAL — webhook signature path PASS; checkout BLOCKED (no valid test key)** |
| 4 | Upstash distributed rate limiting | **PASS as a limiter — but see Finding F-1: it is not distributed** |

---

### 2.1 DocuSign — PASS (full chain, the prize)

`ENABLE_DOCUSIGN_OAUTH=true` + `ENABLE_DOCUSIGN_WEBHOOK=true` booted clean on the pinned digest.

**Token path.** The stored refresh token in
`arkova-docusign-40383eb2-f1cd-4a85-8099-afafff95e5cf-b14ab1af3eeba063fb9498711ce074c4-refresh-token`
is **live**: `POST https://account-d.docusign.com/oauth/token` → **HTTP 200**, `expires_in: 28800`,
`scope: "signature extended"`, identity `carson@arkova.ai`. It is **reusable** (a second refresh with the
same token also returned 200), so consuming it did not break the stored connection.

`sha256("cf5cfb61-bdd4-4d78-829c-7a3eba8a3e02")[0:32] = b14ab1af3eeba063fb9498711ce074c4` — **matches** the
secret name, confirming the token is genuinely bound to org `40383eb2-…` + DocuSign account `cf5cfb61-…`
under `buildDocusignRefreshTokenSecretName`.

**Test document.** The demo account held **zero** envelopes, so one was created as a **draft**
(`status: "created"` — DocuSign sends no email for drafts):
envelope **`8c76280c-7226-8ee4-80e0-095d3b800ccf`**.

**Server-side chain exercised through the real worker jobs** (not curl):

1. `POST /jobs/docusign-envelope-completed` → `{"claimed":1,"completed":1,"failed":0}`
   The worker resolved the connection, refreshed the token from Secret Manager, fetched the document from
   `https://demo.docusign.net/.../documents/combined`, and hashed it **in the worker** (§1.6A carve-out).
2. `POST /jobs/drain-connector-artifacts` → artifact materialized into an anchor.

**Resulting rows:**

```
connector_artifact  id=71279946-1c6a-47f6-8a6a-108e45ab67b4
                    source=docusign  external_ref=8c76280c-7226-8ee4-80e0-095d3b800ccf
                    fingerprint_sha256=cc2fd596b53bf3a14f5b0e3e24c82b9d3f210cc75a2673ec871f491ed7742097
                    byte_length=79179  status=queued  anchor_id=b6c16822-…

anchors             public_id=ARK-DOC-GEF7SP   status=PENDING
                    fingerprint=cc2fd596b53bf3a14f5b0e3e24c82b9d3f210cc75a2673ec871f491ed7742097
                    filename=docusign:8c76280c-7226-8ee4-80e0-095d3b800ccf
                    metadata.connector_source=docusign
                    metadata.connector_artifact_id=71279946-…
```

The anchor fingerprint equals the artifact fingerprint exactly. **`status=PENDING` because the chain client
is mocked** (`USE_MOCKS=true`, `ENABLE_PROD_NETWORK_ANCHORING=false`) — deliberate: a side-rig should not
spend real BTC or load the treasury WIF. The connector→fingerprint→anchor pipeline is proven; Bitcoin
broadcast is out of scope here and is already covered by the soak.

**Setup rows required to reach the anchor** (each was an undocumented prerequisite discovered by failing):
`organizations` row, `org_integrations` row (`token_secret_name` pointing at the existing secret),
`org_members` row with role `owner` (drain aborts with `no org owner/admin actor for connector artifact`),
and a `profiles` row (`anchors_user_id_fkey` → `public.profiles.id`).

---

### 2.2 §1.6A byte-hygiene check — PASS

**Positive scan.** All 234 worker log entries emitted during the connector run (306,061 chars of JSON) were
scanned. Every probe returned **0 hits**:

| Probe | Hits |
|---|---|
| `%PDF` header | 0 |
| `%%EOF` marker | 0 |
| PDF `stream` keyword | 0 |
| base64 run ≥200 chars | 0 |
| JFIF / PNG magic | 0 |
| `documentBase64` field | 0 |
| `<Buffer` / `Uint8Array` / `ArrayBuffer(` dumps | 0 |
| DocuSign JWT (`eyJ…`) | 0 |
| `refresh_token` | 0 |

**Negative (failure-mode) test — the one that actually matters.** A job was enqueued against a bogus
envelope id (`00000000-0000-0000-0000-0000deadbeef`) so DocuSign would return an **error response with a
body**. §1.6A requires that body never be captured. Result:

```
job_queue.last_error = "DocuSign completed document fetch failed"
```

Message only — no HTTP body, no bytes, no envelope payload. This matches the explicit guard in
`fetchDocusignCombinedDocument`, which does not read `res` on the non-OK path.

**Persisted metadata is PII-safe.** `connector_artifact.metadata` and `anchors.metadata` contain only
`account_id`, `envelope_id`, `integration_id`, `rule_event_id`, `queue_scope`, `content_type`,
`connector_source`, `connector_artifact_id`. No bytes, no filenames from the document, no signer PII.

---

### 2.3 Google Drive — BLOCKED (precise blocker identified)

`ENABLE_DRIVE_OAUTH=true` **booted successfully** on the pinned digest with
`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `INTEGRATION_STATE_HMAC_SECRET` /
`GCP_KMS_INTEGRATION_TOKEN_KEY` wired. The OAuth client is real and recognized by Google
(`270018525501-llo9qel0k6ikqgabavqd6s9ff496s034.apps.googleusercontent.com`).

**Why no token exists.** Unlike DocuSign (Secret Manager), Drive refresh tokens are persisted **in Postgres**
as `org_integrations.encrypted_tokens` (KMS-encrypted bytea) + `token_kms_key_id`. Every rig database that
ever held one has been deleted, and prod is read-only — and copying a production user's OAuth token into a
test rig would be an unacceptable privacy breach regardless. **There is no reachable Drive token.**

**The blocker is narrower than "consent was never granted".** Probing Google's authorize endpoint per
redirect URI:

| Redirect URI | Result |
|---|---|
| `https://arkova-worker-kvojbeutfa-uc.a.run.app/api/v1/integrations/google_drive/oauth/callback` | **ACCEPTED** (registered) |
| `https://app.arkova.ai/api/v1/integrations/google_drive/oauth/callback` | REJECTED — `redirect_uri_mismatch` |
| `https://arkova-worker-connector-sidecar-2026-08-staging-…run.app/api/v1/…/callback` | REJECTED — `redirect_uri_mismatch` |

The worker builds its redirect URI from its own request base URL
(`drive-oauth.ts:164`), so **only the prod worker host can currently complete a Drive consent.**

**What a human must click (2 actions):**
1. **Google Cloud Console → APIs & Services → Credentials →** OAuth client
   `270018525501-llo9qel0k6ikqgabavqd6s9ff496s034` → *Authorized redirect URIs* → add
   `https://arkova-worker-connector-sidecar-2026-08-staging-270018525501.us-central1.run.app/api/v1/integrations/google_drive/oauth/callback`
2. Sign in with a Google account holding a test file and grant the consent screen for scopes
   `drive.file` + `drive.activity.readonly` (`POST /api/v1/integrations/google_drive/oauth/start`
   returns the URL once the org/member rows exist).

Until (1) is done, no amount of rig configuration can complete a Drive OAuth flow.

---

### 2.4 Stripe — PARTIAL

**BLOCKED: no valid Stripe test key exists.** All three test-mode secrets are rejected by Stripe:

| Secret | Prefix | Length | `GET /v1/balance` |
|---|---|---|---|
| `stripe-secret-key-staging` | `sk_test_` | 39 | **401 invalid** |
| `stripe-secret-key-soak-i5` | `sk_test_` | 40 | **401 invalid** |
| `arkova-s33-rig-b1-stripe-secret-key` | `sk_test_` | 39 | **401 invalid** |
| `stripe-secret-key` (prod) | `sk_live_` | 107 | not called — live key, deliberately untouched |

A genuine Stripe secret key is ~107 chars (cf. the live key). At 39–40 chars these are **placeholders**
minted only to satisfy `config.ts`'s Zod boot requirement. Consequently: **test prices could not be
created**, the `plans` table could not be populated with real `stripe_price_id`s (it is empty on a fresh
rig), and no checkout session could be driven. **This does not test #2049 — that path remains blocked on a
human minting a real Stripe test key.**

**PASS: real webhook signature verification.** `stripe.webhooks.constructEvent()` was exercised for real by
setting `USE_MOCKS=false` (under `USE_MOCKS=true` the mock client parses JSON **without verifying**, so a
webhook test in mock mode proves nothing). Signature verification needs only the webhook secret, not the
API key. Matrix against `POST /webhooks/stripe`:

| Case | Result |
|---|---|
| Valid `t=…,v1=HMAC-SHA256(t.payload, whsec)` | **HTTP 200** `{"received":true}` |
| Tampered `v1` | **HTTP 400** `{"error":"Webhook signature verification failed"}` |
| Stale timestamp (t−3600, replay) | **HTTP 400** `{"error":"Webhook signature verification failed"}` |
| Missing `Stripe-Signature` header | **HTTP 400** `{"error":"Missing stripe-signature header"}` |

Replay protection (Stripe's 300 s tolerance) is confirmed working. The rig was reverted to
`USE_MOCKS=true` afterwards.

---

### 2.5 Upstash rate limiting — limiter PASS, distribution FAIL

**Limiter behaviour is correct.** Boot log: `Upstash Redis rate limiting initialized` (and
`Upstash Redis idempotency store initialized`), so the Upstash store — not the in-memory fallback — was
installed. Credentials verified live independently: `PING → PONG`, `SET/GET` roundtrip against
`https://tops-mayfly-40057.upstash.io` (probe key deleted afterwards).

Burst of 75 anonymous requests against `/api/v1/verify/*`: **28 × 503 → 47 × 429**. A 429 carries:

```
HTTP/2 429
retry-after: 27
x-ratelimit-limit: 60
x-ratelimit-remaining: 0
x-ratelimit-reset: 1786553999
{"error":"Too many requests","retry_after":27}
```

`Retry-After` + all three `X-RateLimit-*` headers present, per §1.10.

(The observed ceiling is 60, not 100, because `apiIpShadowGuard` in `index.ts:413` (60/min) sits in front of
the `anonRateLimiter` (100/min) in `api/v1/router.ts:195`. The 503s are the known fresh-environment
behaviour: `switchboard_flags` is empty on a new rig so `get_flag` fails closed and `/api/v1` is dark.)

**Key attribution is correct.** A controlled experiment (wait for window expiry → confirm zero keys → fire
exactly 5 requests → list keys) produced exactly one key: **`216.183.125.66`**, the real client IP. So
`app.set('trust proxy', 2)` resolves `req.ip` correctly behind Cloud Run. *(An earlier reading of Google-owned
IPs in the keyspace was unrelated background traffic to the public service, not misattribution — the
controlled test disproved that hypothesis.)*

**But the limiter is not actually distributed — see Finding F-1 below.**

---

## 3. Findings

### F-1 — SECURITY / CORRECTNESS: the "distributed" rate limiter shares no state across instances

**Severity: High.** Rate limiting is an abuse/DoS control and its documented guarantee is false.

Observed: HTTP headers decremented correctly (`remaining` 48 → 46 → 44) while the Upstash value for the
same key stayed frozen at `{"count":0,"resetAt":1786554172656}` across all three requests. Root cause is
unambiguous in the source:

* `services/worker/src/utils/upstashRateLimit.ts:41-44` — `get()` returns `this.cache.get(key)` and
  **never reads Redis**.
* `services/worker/src/utils/rateLimit.ts:137` — `rateLimitStore.set(...)` is called **only** inside the
  "create new entry" branch; the subsequent `entry.count++` (line ~162) mutates the object in place with
  **no write-back**. Redis therefore only ever receives the initial `count: 0`.
* `syncFromRedis()` exists (`upstashRateLimit.ts:68`) but is **never called anywhere** in non-test code.

Net effect: each Cloud Run instance enforces its own independent in-memory bucket; Redis is a write-once
mirror that is never consulted on the hot path. The module's own docstring — *"When Cloud Run auto-scales to
N instances, all share a single Redis store so rate limits are globally correct"* — is incorrect.

**Blast radius in prod** (`arkova-worker`: `maxScale=10`, `minScale=2`, read-only describe): effective
ceilings are up to **10×** the configured value, and cold starts reset counters.

| Limiter | Configured | Effective worst case |
|---|---|---|
| `auth` | 5/min | **~50/min** ← brute-force protection |
| `checkout` / `quotaCheck` | 10/min | ~100/min |
| `apiIpShadowGuard` | 60/min | ~600/min |
| anon `/api/v1` (§1.10) | 100/min | ~1,000/min |

The `auth` limiter is the most security-relevant. Recommended fix: make the store's read path consult Redis
(or move to an atomic `INCR`+`EXPIRE` server-side counter) and write back on every increment.

### F-2 — PROOF SEMANTICS: DocuSign combined-document fetches are not byte-stable

Four fetches of the **same, unchanged** draft envelope returned four different payloads:

| Fetch | Bytes | SHA-256 |
|---|---|---|
| manual #1 | 79,177 | `278a105de5f9ce90c6a8936b1bfa08cbf8b6d40100a3d6bab8f138b0a3ca8b1d` |
| worker (anchored) | 79,179 | `cc2fd596b53bf3a14f5b0e3e24c82b9d3f210cc75a2673ec871f491ed7742097` |
| manual #2 | 79,175 | `604c1c99ffc538f776905690f1260f57b7c9fc9cfacc33875e745c9cb4825841` |
| manual #3 | 79,179 | `e118f124eb6a81117de28b01ffe1107071f7811ad87465b0276f90888f77a662` |

DocuSign re-renders `/documents/combined` per request (per-render stamps/timestamps), so a
connector-sourced fingerprint is **not reproducible by re-fetching**. Implications:

* A verifier **cannot** re-derive an anchored DocuSign fingerprint by pulling the envelope again.
* Proof copy must say the anchor attests *these exact bytes as served at fetch time*, not *this envelope's
  content* — this is a §1.5 / §1.13 (R-7) "measured vs asserted" wording obligation.
* Deduplication must key on `envelope_id`, **never** on fingerprint. The code already does this correctly
  (`findExistingEnvelopeAnchor` across the three metadata keys) — this finding validates that design choice
  and argues it must never be "optimised" to a fingerprint check.

### F-3 — `docs/reference/STAGING_RIG.md` bootstrap snippet breaks a fresh rig

The documented bootstrap runs `CREATE EXTENSION … pg_trgm WITH SCHEMA extensions`, but the squashed baseline
`00000000000000_baseline_at_main_HEAD.sql` declares `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (public) and
then builds indexes with `public.gin_trgm_ops`. Pre-creating it in `extensions` makes the baseline's own
statement a no-op and the push dies at statement 1047:
`operator class "public.gin_trgm_ops" does not exist`. Fix applied: `ALTER EXTENSION pg_trgm SET SCHEMA public`.
The runbook's collision/enum workarounds (11 prefix-colliding files, `anchor_status` enum pre-adds) are also
stale — those migrations are now inside the baseline.

### F-4 — `supabase db push` cannot apply migration 0381

`0381_docusign_envelope_metadata_lookup_indexes.sql` fails with
`CREATE INDEX CONCURRENTLY cannot be executed within a pipeline (SQLSTATE 25001)` on CLI v2.109.1, despite
the file's header asserting a bare CONCURRENTLY file applies outside a transaction. Single-statement
CONCURRENTLY migrations (0366, 0389) applied fine; 0381 has three. Worked around by applying the three
`CREATE INDEX CONCURRENTLY` statements via the Management API and inserting the `0381` ledger row. Any
future clean rebuild will hit this again.

### F-5 — `docusign_wiring_info` is stale in two fields

| Field | `docusign_wiring_info` says | Actual (from live `/oauth/userinfo`) |
|---|---|---|
| Integration key | `5792ee71-d8be-4407-a738-46b9caad5de5` | **`c8a10703-8efd-48e0-9653-7a9b840f67e3`** |
| Account ID | `0a28da55-7a0d-4587-814b-f234973b654b` | **`cf5cfb61-bdd4-4d78-829c-7a3eba8a3e02`** |

Base URL (`https://demo.docusign.net`) is correct. Anyone wiring DocuSign from that note would fail
authentication. The second refresh-token secret
(`…-d0d00bc8385334315b9b2871f9df627b-…`) is **dead** (`400 invalid_request`) and can be deleted.

### F-6 — orphaned rig secrets

~150 `supabase-url-*` / `supabase-service-role-key-*` / `supabase-db-password-*` secrets point at deleted
Supabase projects (all `pr*`, `s3-*`, `train-*`, `rc-*`, `lane3-s2-*`, `soak*` families, plus
`supabase-url-staging`). They are inert but they make Secret Manager unreadable and invite exactly the
false-reuse assumption this task started from. Candidate for the `infra-hygiene-sweep`.

---

## 4. Running cost of what was left standing

| Item | Cost |
|---|---|
| Supabase project `ehqqearcitrgloibtjqx` | **$10/month** (Pro, prorated) — the only material cost |
| Cloud Run `arkova-worker-connector-sidecar-2026-08-staging` | ~$0 idle (`min-instances=0`, scales to zero) |
| 5 Secret Manager secrets | ~$0.30/month |
| Upstash | $0 — existing shared instance, probe key deleted |
| DocuSign draft envelope | $0 — demo/sandbox account |

**Total ≈ $10/month while it stands.** Nothing recurring was created in prod.

---

## 5. Teardown

Run when the Drive/Stripe follow-ups are done or abandoned. **Nothing here is soak evidence — teardown does
not invalidate any PR.**

```bash
export CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.14/bin/python3.14

# 1. Cloud Run service
gcloud run services delete arkova-worker-connector-sidecar-2026-08-staging \
  --project=arkova1 --region=us-central1 --quiet

# 2. Supabase project (the $10/mo) — via MCP delete, or dashboard
#    project ref: ehqqearcitrgloibtjqx

# 3. Rig secrets
for s in supabase-url-connector-sidecar-2026-08-staging \
         supabase-service-role-key-connector-sidecar-2026-08-staging \
         supabase-anon-key-connector-sidecar-2026-08-staging \
         supabase-db-password-connector-sidecar-2026-08 \
         ip-hash-pepper-connector-sidecar-2026-08-staging; do
  gcloud secrets delete "$s" --project=arkova1 --quiet
done

# 4. DocuSign draft envelope 8c76280c-7226-8ee4-80e0-095d3b800ccf — demo account,
#    draft, costs nothing; delete via the DocuSign demo UI only if you want a clean account.
```

### Keep (do NOT delete)

* **`arkova-docusign-40383eb2-…-b14ab1af3eeba063fb9498711ce074c4-refresh-token`** — the live, reusable
  DocuSign demo token. This is the single asset that made the DocuSign chain testable without a human
  click. Deleting it costs a re-consent.
* `integration-state-hmac-secret`, `docusign_integration_key`, `docusign_client_secret`,
  `docusign_jwt_private_key`, `docusign_connect_hmac_secret`, `google-oauth-client-id/secret`,
  `UPSTASH_REDIS_REST_*` — shared, not rig-specific.
* This document.

### Worth deleting independently of this rig

* `arkova-docusign-40383eb2-…-d0d00bc8385334315b9b2871f9df627b-refresh-token` (dead, F-5).
* The ~150 orphaned rig secrets (F-6).

---

## 6. Follow-ups for a human

1. **F-1 rate limiter** — fix the store read/write-back path. Highest-value item found; file as a bug.
2. **F-2 proof semantics** — review DocuSign proof copy against §1.5 / R-7; keep envelope-id dedup.
3. **Stripe test key** — mint a real `sk_test_` in the Stripe dashboard and replace the three placeholder
   secrets, then #2049 becomes testable.
4. **Drive redirect URI** — register the side-rig callback (§2.3) if Drive coverage is still wanted.
5. **F-3 / F-4** — correct `STAGING_RIG.md`; decide how 0381 should be applied on a clean rebuild.
6. **F-5 / F-6** — refresh `docusign_wiring_info`; sweep orphaned secrets.

_Generated 2026-08-12 from the `connector-sidecar-2026-08` side-rig. Side-rig evidence only — not soak evidence._
