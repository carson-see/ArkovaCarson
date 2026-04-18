# Arkova self-hosted reference — main.tf
#
# Story: SCRUM-901 SELF-HOST-01
# Scope: GCP-only stack (per memory/feedback_no_aws.md). This is a skeleton
# meant to be copied to a per-customer project and expanded with their
# specific region, instance sizes, and VPC layout.
#
# Prereqs:
#   terraform >= 1.7
#   gcloud auth application-default login
#
# Minimum variables (override in terraform.tfvars):
#   project_id      — target GCP project
#   region          — default us-central1; pick africa-south1 for Kenya-adjacent
#   worker_image    — Artifact Registry URL of the Arkova worker container
#   bitcoin_network — "mainnet" | "testnet4" | "signet"
#
# Applies a minimal stack: KMS ring + proof-signing key, service account for
# the Cloud Run worker, and the Cloud Run service itself. Supabase self-host
# is out of scope for this file — follow docs/deployment/self-hosted/README.md
# §4.1 to stand that up separately.

terraform {
  required_version = ">= 1.7"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.44" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type        = string
  description = "GCP project ID that will host Arkova."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Primary region. Use africa-south1 for Kenya residency."
}

variable "worker_image" {
  type        = string
  description = "Container image URL for services/worker."
}

variable "bitcoin_network" {
  type        = string
  default     = "testnet4"
  description = "mainnet | testnet4 | signet. Start on testnet4 for pilot."
}

resource "google_project_service" "enabled" {
  for_each = toset([
    "run.googleapis.com",
    "cloudkms.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "iam.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_kms_key_ring" "arkova" {
  name     = "arkova-prod"
  location = var.region
  depends_on = [google_project_service.enabled]
}

resource "google_kms_crypto_key" "proof_signing" {
  name     = "proof-signing"
  key_ring = google_kms_key_ring.arkova.id
  purpose  = "ASYMMETRIC_SIGN"
  version_template {
    algorithm        = "EC_SIGN_ED25519"
    protection_level = "SOFTWARE"
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "bitcoin_treasury" {
  name     = "bitcoin-treasury"
  key_ring = google_kms_key_ring.arkova.id
  purpose  = "ASYMMETRIC_SIGN"
  version_template {
    algorithm        = "EC_SIGN_SECP256K1_SHA256"
    protection_level = "HSM"
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "worker" {
  account_id   = "arkova-worker-sa"
  display_name = "Arkova worker service account"
}

resource "google_kms_crypto_key_iam_member" "worker_can_sign_proof" {
  crypto_key_id = google_kms_crypto_key.proof_signing.id
  role          = "roles/cloudkms.signerVerifier"
  member        = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_kms_crypto_key_iam_member" "worker_can_sign_treasury" {
  crypto_key_id = google_kms_crypto_key.bitcoin_treasury.id
  role          = "roles/cloudkms.signerVerifier"
  member        = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_cloud_run_v2_service" "worker" {
  name     = "arkova-worker"
  location = var.region

  template {
    service_account = google_service_account.worker.email
    containers {
      image = var.worker_image
      resources {
        limits = {
          memory = "1Gi"
          cpu    = "1000m"
        }
      }
      env {
        name  = "BITCOIN_NETWORK"
        value = var.bitcoin_network
      }
      env {
        name  = "KMS_PROVIDER"
        value = "gcp"
      }
      env {
        name  = "GCP_KMS_KEY_RESOURCE_NAME"
        value = google_kms_crypto_key.bitcoin_treasury.id
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
    }
    max_instance_request_concurrency = 80
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }
  }

  depends_on = [google_project_service.enabled]
}

output "worker_url" {
  value       = google_cloud_run_v2_service.worker.uri
  description = "Paste this into the frontend's VITE_API_BASE_URL."
}

output "proof_signing_key_id" {
  value       = google_kms_crypto_key.proof_signing.id
  description = "Pass to the worker as PROOF_SIGNING_KEY_ID (or the resource name for KMS-backed signing)."
}

output "worker_service_account" {
  value       = google_service_account.worker.email
  description = "Grant this SA access to the Supabase service role secret."
}
