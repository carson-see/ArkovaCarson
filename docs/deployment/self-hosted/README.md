# Arkova — Self-Hosted Reference Architecture

**Story:** [SCRUM-901 SELF-HOST-01](https://arkova.atlassian.net/browse/SCRUM-901)
**Status:** v1 draft 2026-04-18 — pilot deployment pending
**Owner:** Carson Seeger + enterprise pilot design partner
**Target time-to-stand-up:** ≤ 4 hours from an empty GCP project.
**Critical constraint:** GCP-only (no AWS). See [memory/feedback_no_aws.md].

---

## 1. Why this document exists

A regulated enterprise prospect — e.g. Hakichain (Kenya DPA), or any SOC 2 Type II customer that requires cloud-sovereign deployment — may not want to use Arkova's hosted SaaS control plane. This document is the packaged reference architecture they can stand up inside their own GCP project.

It covers:
- Supabase self-host (or a Cloud SQL + Kong alternative).
- Cloud Run worker deployment (or GKE Autopilot alternative).
- GCP KMS key bootstrap for Bitcoin signing.
- Bitcoin treasury configuration — mainnet or testnet.
- Frontend deployment that preserves Constitution 1.6 (documents never leave the user's device).

It does NOT cover:
- Marketing-site hosting (trivial; any static host).
- llms.txt / GEO assets (those follow SaaS only).
- MCP edge worker (Cloudflare-specific; optional for self-host).

## 2. Architecture diagram (ASCII)

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Browser     │   │  Browser     │   │  Browser     │   (Constitution 1.6: docs never leave)
│  React app   │   │  React app   │   │  React app   │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       └─────────────┬────┴──────────────────┘
                     │ HTTPS (only PII-stripped metadata + fingerprints cross this line)
          ┌──────────▼──────────┐
          │  Cloud Load Balancer│     (GCP global LB, HTTPS termination, Armor WAF)
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  Arkova Worker      │     Cloud Run (1GB, max 5, concurrent 80) OR
          │  (services/worker)  │     GKE Autopilot 2-node deployment
          └──────────┬──────────┘
                     │
      ┌──────────────┼───────────────────────┐
      │              │                       │
┌─────▼─────┐  ┌─────▼─────┐           ┌────▼────────┐
│ Supabase  │  │  GCP KMS  │           │  Bitcoin    │
│ self-host │  │ asymmetric│           │  full node  │
│ Postgres  │  │ signing   │           │  (or mempool│
│ + Auth    │  │ secp256k1 │           │  .space RPC)│
└───────────┘  └───────────┘           └─────────────┘
```

## 3. Prerequisites

- GCP project with billing enabled + owner role on your operator account.
- Ability to create these APIs: Cloud Run, Cloud SQL (if using Postgres backend), KMS, Secret Manager, IAM, Cloud Storage.
- A Docker Hub / Artifact Registry for the worker image.
- Access to the Arkova worker source (`services/worker/`) — either this repo clone or a pinned container image.
- A Bitcoin RPC endpoint (your full node, a managed service like GetBlock, or mempool.space public API for reads).
- ≥ 2 hours of operator time for the first stand-up.

## 4. Step-by-step stand-up (short form)

### 4.1 Supabase self-host

1. Clone `https://github.com/supabase/supabase` (the `docker/` subdir is the canonical self-host).
2. Follow their [self-hosting guide](https://supabase.com/docs/guides/self-hosting/docker) but point the Postgres volume at a GCP Cloud SQL instance for PITR + automated backups.
3. Apply Arkova migrations in order: `supabase/migrations/0000_*.sql` through the latest.
4. Load the seed: `supabase/seed.sql` + any jurisdiction rule seeds you need.
5. Generate TS + Python SDK types: `npm run gen:types`.
6. Export the Supabase URL + anon key + service role key for the worker env.

### 4.2 GCP KMS key bootstrap

```bash
# Ed25519 for proof-bundle signing (SCRUM-900)
gcloud kms keyrings create arkova-prod --location=us-central1
gcloud kms keys create proof-signing \
  --location=us-central1 --keyring=arkova-prod \
  --purpose=asymmetric-signing --algorithm=ec-sign-ed25519

# secp256k1 for Bitcoin treasury (if you run mainnet)
gcloud kms keys create bitcoin-treasury \
  --location=us-central1 --keyring=arkova-prod \
  --purpose=asymmetric-signing --algorithm=ec-sign-secp256k1-sha256
```

Grant the worker service account `roles/cloudkms.signerVerifier` on both keys.

### 4.3 Worker deployment (Cloud Run)

```bash
cd services/worker
docker build -t gcr.io/$PROJECT/arkova-worker:$(git rev-parse --short HEAD) .
docker push gcr.io/$PROJECT/arkova-worker:$(git rev-parse --short HEAD)

gcloud run deploy arkova-worker \
  --image gcr.io/$PROJECT/arkova-worker:$(git rev-parse --short HEAD) \
  --region us-central1 \
  --memory 1Gi --cpu 1 \
  --max-instances 5 --concurrency 80 \
  --allow-unauthenticated \
  --service-account arkova-worker-sa@$PROJECT.iam.gserviceaccount.com \
  --set-env-vars \
    SUPABASE_URL=$SUPABASE_URL,\
    NODE_ENV=production,\
    BITCOIN_NETWORK=mainnet,\
    KMS_PROVIDER=gcp,\
    GCP_KMS_KEY_RESOURCE_NAME=projects/$PROJECT/locations/us-central1/keyRings/arkova-prod/cryptoKeys/bitcoin-treasury,\
    FRONTEND_URL=https://$YOUR_FRONTEND_DOMAIN,\
    ENABLE_PROD_NETWORK_ANCHORING=true
# Secrets (SUPABASE_SERVICE_ROLE_KEY, API_KEY_HMAC_SECRET, PROOF_SIGNING_KEY_ID, etc.)
# come from Secret Manager — not --set-env-vars.
gcloud run services update arkova-worker \
  --region us-central1 \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=supabase-service-role:latest,API_KEY_HMAC_SECRET=api-key-hmac:latest,PROOF_SIGNING_KEY_ID=proof-signing-key-id:latest
```

### 4.4 Frontend deployment

1. Build the frontend: `npm run build` → `dist/`.
2. Host on any static CDN — Cloud Storage + Load Balancer works; Vercel with org-locked DNS works if the customer allows it.
3. Set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` + `VITE_API_BASE_URL` (points at your Cloud Run URL) at build time.
4. **Constitution 1.6 check:** confirm `generateFingerprint` is NOT bundled into any server-side code. Our ESLint rule already enforces this; grep the build output for a secondary sanity check.

### 4.5 Bitcoin treasury

Two options:

- **Managed:** point `BITCOIN_UTXO_PROVIDER=mempool` + `MEMPOOL_API_URL=https://mempool.space/api` (or your own). Simplest; no full node required.
- **Sovereign:** run your own Bitcoin Core full node + Electrs or Esplora for API parity. Point `BITCOIN_UTXO_PROVIDER=rpc` + `BITCOIN_RPC_URL` + `BITCOIN_RPC_AUTH`.

Fund the treasury address returned by `gcloud kms asymmetric-decrypt` + `bitcoinjs-lib` public-key derivation; document the funding transaction as your operator's custodian-of-record.

## 5. Pilot deployment evidence

A pilot is part of Definition of Done for this story. Fill in this table once the pilot runs:

| Item | Value | Proof |
|---|---|---|
| Pilot customer | TBD | (design partner name) |
| Cloud project | TBD | `gcloud projects describe <project>` |
| Supabase version | TBD | `supabase --version` |
| Worker image tag | TBD | Cloud Run revision URL |
| First SECURED anchor | TBD | mempool.space TX link |
| Proof bundle verifies | TBD | `curl …/verify/<id>/proof?format=signed` + `node -e "…verifySignedBundle…"` output |
| Time from zero to first anchor | TBD | operator timestamps |
| Total GCP monthly spend | TBD | Cloud Billing export |

## 6. Terraform skeleton (reference)

Minimal starting point — copy to `deployment/self-hosted/terraform/` and expand per-customer. The current repo ships a skeleton at that path; see [../terraform/main.tf](../terraform/main.tf) (to be added alongside this doc when pilot kicks off).

```hcl
# main.tf — GCP-only stack for Arkova self-host
provider "google" {
  project = var.project_id
  region  = "us-central1"
}

resource "google_project_service" "enabled" {
  for_each = toset([
    "run.googleapis.com",
    "cloudkms.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
  ])
  service = each.value
  disable_on_destroy = false
}

resource "google_kms_key_ring" "arkova" {
  name     = "arkova-prod"
  location = "us-central1"
}

resource "google_kms_crypto_key" "proof_signing" {
  name            = "proof-signing"
  key_ring        = google_kms_key_ring.arkova.id
  purpose         = "ASYMMETRIC_SIGN"
  version_template {
    algorithm = "EC_SIGN_ED25519"
  }
}

resource "google_service_account" "worker" {
  account_id = "arkova-worker-sa"
}

resource "google_cloud_run_service" "worker" {
  name     = "arkova-worker"
  location = "us-central1"

  template {
    spec {
      service_account_name = google_service_account.worker.email
      containers {
        image = var.worker_image
        resources { limits = { memory = "1Gi", cpu = "1000m" } }
        env { name = "BITCOIN_NETWORK" value = var.bitcoin_network }
        env { name = "KMS_PROVIDER"   value = "gcp" }
        # Pull the rest from Secret Manager via --set-secrets.
      }
      container_concurrency = 80
    }
  }
  autogenerate_revision_name = true
}
```

## 7. Known gotchas

- **PostgREST schema reload:** after any migration that changes DB functions, run `NOTIFY pgrst, 'reload schema';` — our [CLAUDE.md §4](../../../CLAUDE.md) has the exact command.
- **Migration 0068a:** `ALTER TYPE anchor_status ADD VALUE 'SUBMITTED'` silently fails inside a transaction. Run it manually after `supabase db reset`.
- **Bitcoin mainnet:** `ENABLE_PROD_NETWORK_ANCHORING=true` is required. Don't ship without it or anchors stay PENDING forever.
- **FRONTEND_URL:** worker fails loudly (by design) if `NODE_ENV=production` and this is unset.
- **Service account principals:** Cron Scheduler must hit the worker via OIDC with the same service account that runs the worker. Otherwise 401.

## 8. How to use this document

1. **Before promising a self-hosted deployment to a customer, read §3 Prerequisites** and check the customer can satisfy them (GCP billing owner, Bitcoin RPC access, ≥ 2 hr operator).
2. **Before a pilot run, create a new `deployment/self-hosted/pilots/<customer>/` subdirectory** for their customer-specific Terraform vars + deployment log.
3. **During the pilot run, fill in §5 Pilot deployment evidence** in real time — the "time from zero to first anchor" number is the claim we are selling.
4. **After the pilot completes**, record the cost + any new gotchas in §7 so the next pilot starts from better footing.
5. **Re-audit this document quarterly** for AWS drift — we do not run on AWS in production ([memory/feedback_no_aws.md]).

## 9. Cross-links

- [SCRUM-901](https://arkova.atlassian.net/browse/SCRUM-901) — this story.
- [SCRUM-899](https://arkova.atlassian.net/browse/SCRUM-899) — Kenya data-residency options (may drive region choice).
- [SCRUM-900](https://arkova.atlassian.net/browse/SCRUM-900) — PROOF-SIG-01; the Ed25519 key created in §4.2 is consumed there.
- [SCRUM-902](https://arkova.atlassian.net/browse/SCRUM-902) — AWS removal; keep this doc aligned.
- [docs/confluence/15_operational_runbook.md](../../confluence/15_operational_runbook.md) — prod runbook the self-host track mirrors.
- [docs/runbooks/nca-audit-uat.md](../../runbooks/nca-audit-uat.md) — UAT runbook self-host pilots can re-use.
