#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# GCP Infrastructure Setup for Arkova Worker
# Story: MVP-01 / MVP-26
#
# Prerequisites:
#   1. gcloud CLI installed (brew install google-cloud-sdk)
#   2. gcloud auth login
#   3. Billing enabled on project
#
# This script:
#   1. Sets the active project
#   2. Enables required APIs
#   3. Creates Artifact Registry repository
#   4. Creates Secret Manager secrets (empty — you fill values)
#   5. Creates a service account for GitHub Actions (Workload Identity Federation)
#   6. Prints next steps
# ─────────────────────────────────────────────────

PROJECT_ID="arkova1"
REGION="us-central1"
SERVICE_NAME="arkova-worker"
REPOSITORY="arkova-worker-images"
SA_NAME="github-actions-deploy"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
REGISTRY="${REGION}-docker.pkg.dev"
GITHUB_REPO="${GITHUB_REPO:-carson-see/ArkovaCarson}"  # Override via env if needed

echo "═══════════════════════════════════════════════"
echo "  Arkova Worker — GCP Infrastructure Setup"
echo "═══════════════════════════════════════════════"
echo ""

# ── Step 1: Set project ───────────────────────────
echo "▸ Step 1: Setting active project to ${PROJECT_ID}..."
gcloud config set project "${PROJECT_ID}"

# ── Step 2: Enable APIs ──────────────────────────
echo "▸ Step 2: Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com

echo "  ✓ APIs enabled"

# ── Step 3: Create Artifact Registry ─────────────
echo "▸ Step 3: Creating Artifact Registry repository..."
if gcloud artifacts repositories describe "${REPOSITORY}" \
    --location="${REGION}" --format="value(name)" 2>/dev/null; then
  echo "  ✓ Repository already exists"
else
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Arkova worker Docker images"
  echo "  ✓ Repository created"
fi

# ── Step 4: Create secrets (empty placeholders) ──
echo "▸ Step 4: Creating Secret Manager secrets..."

SECRETS=(
  "supabase-url"
  "supabase-service-role-key"
  "stripe-secret-key"
  "stripe-webhook-secret"
  "cloudflare-tunnel-token"
  "bitcoin-treasury-wif"
)

for secret in "${SECRETS[@]}"; do
  if gcloud secrets describe "${secret}" --project="${PROJECT_ID}" 2>/dev/null; then
    echo "  ✓ ${secret} already exists"
  else
    echo -n "placeholder" | gcloud secrets create "${secret}" \
      --data-file=- \
      --replication-policy="automatic" \
      --project="${PROJECT_ID}"
    echo "  ✓ ${secret} created (placeholder — update with real value)"
  fi
done

# ── Step 5: Service account for GitHub Actions ───
echo "▸ Step 5: Setting up GitHub Actions service account..."

if gcloud iam service-accounts describe "${SA_EMAIL}" 2>/dev/null; then
  echo "  ✓ Service account already exists"
else
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="GitHub Actions Deploy" \
    --description="Used by GitHub Actions to deploy worker to Cloud Run"
  echo "  ✓ Service account created"
fi

# Grant roles
echo "  Granting IAM roles..."
ROLES=(
  "roles/run.admin"
  "roles/artifactregistry.writer"
  "roles/secretmanager.secretAccessor"
  "roles/iam.serviceAccountUser"
)

for role in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${role}" \
    --quiet > /dev/null 2>&1
done
echo "  ✓ IAM roles granted"

# ── Step 6: Workload Identity Federation ─────────
echo "▸ Step 6: Setting up Workload Identity Federation..."

WIF_POOL="github-actions-pool"
WIF_PROVIDER="github-actions-provider"

# Create pool
if gcloud iam workload-identity-pools describe "${WIF_POOL}" \
    --location="global" 2>/dev/null; then
  echo "  ✓ Workload Identity Pool already exists"
else
  gcloud iam workload-identity-pools create "${WIF_POOL}" \
    --location="global" \
    --display-name="GitHub Actions Pool"
  echo "  ✓ Workload Identity Pool created"
fi

# Create provider
if gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER}" \
    --location="global" \
    --workload-identity-pool="${WIF_POOL}" 2>/dev/null; then
  echo "  ✓ Workload Identity Provider already exists"
else
  gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
    --location="global" \
    --workload-identity-pool="${WIF_POOL}" \
    --display-name="GitHub Actions Provider" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}'"
  echo "  ✓ Workload Identity Provider created"
fi

# Look up project number dynamically (never hardcode)
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
echo "  Project number: ${PROJECT_NUMBER}"

# Allow GitHub Actions to impersonate the service account
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${GITHUB_REPO}" \
  --quiet > /dev/null 2>&1

echo "  ✓ Workload Identity Federation configured"

# ── Done ─────────────────────────────────────────
WIF_PROVIDER_FULL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ GCP Infrastructure Ready"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Project:    ${PROJECT_ID}"
echo "  Region:     ${REGION}"
echo "  Registry:   ${REGISTRY}/${PROJECT_ID}/${REPOSITORY}"
echo "  Service:    ${SERVICE_NAME}"
echo ""
echo "  NEXT STEPS:"
echo ""
echo "  1. Update secret values (replace placeholders):"
echo ""
for secret in "${SECRETS[@]}"; do
  echo "     echo 'YOUR_VALUE' | gcloud secrets versions add ${secret} --data-file=-"
done
echo ""
echo "  2. Add these GitHub repo secrets:"
echo ""
echo "     GCP_WORKLOAD_IDENTITY_PROVIDER:"
echo "       ${WIF_PROVIDER_FULL}"
echo ""
echo "     GCP_SERVICE_ACCOUNT:"
echo "       ${SA_EMAIL}"
echo ""
echo "  3. Push to main (touching services/worker/) to trigger deploy"
echo ""
echo "═══════════════════════════════════════════════"
