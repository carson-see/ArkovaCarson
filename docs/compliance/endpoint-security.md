# Endpoint Security — FileVault & Service Account Key Rotation

> **Version:** 1.0 | **Date:** 2026-04-12 | **Classification:** CONFIDENTIAL
> **SOC 2 Controls:** CC6.7 (Encryption of Data at Rest), CC6.1 (Logical Access)
> **Jira:** SCRUM-514 | **Owner:** Carson
> **Review Cadence:** Quarterly (key rotation) + annually (endpoint policy)

---

## 1. FileVault Disk Encryption (CC6.7)

### Status: ENABLED

All development machines with access to Arkova production systems must have FileVault (macOS) or BitLocker (Windows) enabled.

**Evidence collected 2026-04-12:**
```
$ fdesetup status
FileVault is On.
```

### Policy

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Full-disk encryption enabled | PASS | `fdesetup status = On` |
| Recovery key escrowed | REQUIRED | Apple MDM or secure vault |
| Encryption algorithm | AES-XTS-128 | macOS default with FileVault |
| Auto-lock on sleep/idle | REQUIRED | System Preferences > Security > Require password immediately |

### Compliance Mapping

- **SOC 2 CC6.7:** Data at rest is encrypted using industry-standard algorithms
- **SOC 2 CC6.1:** Logical access to sensitive data is restricted
- **ISO 27001 A.8.3.1:** Management of removable media

---

## 2. GCP Service Account Key Rotation

### Current Service Account

| Field | Value |
|-------|-------|
| **Account** | `270018525501-compute@developer.gserviceaccount.com` |
| **Project** | `arkova1` |
| **Usage** | Cloud Scheduler OIDC authentication for cron jobs |
| **Key Type** | Google-managed (OIDC) — no user-managed JSON key |

### Rotation Procedure

**Important:** Arkova uses OIDC tokens (not JSON key files) for Cloud Scheduler authentication. OIDC tokens are automatically rotated by Google. However, if any user-managed keys exist, they must follow the 90-day rotation schedule below.

#### Step 1: Audit Existing Keys

```bash
gcloud iam service-accounts keys list \
  --iam-account=270018525501-compute@developer.gserviceaccount.com \
  --project=arkova1 \
  --format="table(name.basename(), validAfterTime, validBeforeTime, keyType)"
```

#### Step 2: Create New Key (if user-managed keys exist)

```bash
gcloud iam service-accounts keys create new-key.json \
  --iam-account=270018525501-compute@developer.gserviceaccount.com \
  --project=arkova1
```

#### Step 3: Deploy New Key

1. Update Cloud Run secret with new key
2. Redeploy worker: `gcloud run services update arkova-worker --region=us-central1`
3. Verify Cloud Scheduler jobs still execute: check Cloud Logging

#### Step 4: Delete Old Key

```bash
gcloud iam service-accounts keys delete OLD_KEY_ID \
  --iam-account=270018525501-compute@developer.gserviceaccount.com \
  --project=arkova1
```

#### Step 5: Verify

```bash
# Verify Cloud Scheduler OIDC still works
gcloud scheduler jobs list --project=arkova1 --location=us-central1
# Trigger a test job
gcloud scheduler jobs run process-pending-anchors --project=arkova1 --location=us-central1
```

### 90-Day Rotation Schedule

| Quarter | Rotation Date | Owner | Status |
|---------|--------------|-------|--------|
| Q2 2026 | 2026-04-12 | Carson | CURRENT — audit completed |
| Q3 2026 | 2026-07-12 | Carson | SCHEDULED |
| Q4 2026 | 2026-10-12 | Carson | SCHEDULED |
| Q1 2027 | 2027-01-12 | Carson | SCHEDULED |

**Calendar reminder:** Set recurring quarterly reminder titled "GCP SA Key Rotation — Arkova" with link to this document.

### Compliance Mapping

- **SOC 2 CC6.1:** Logical access credentials are rotated periodically
- **SOC 2 CC6.3:** Access is removed when no longer needed
- **NIST SP 800-63B:** Authenticator lifecycle management

---

## 3. Additional Endpoint Requirements

| Requirement | Status | Notes |
|-------------|--------|-------|
| OS auto-updates enabled | REQUIRED | macOS Software Update > Automatic |
| Firewall enabled | REQUIRED | System Preferences > Security > Firewall ON |
| Screen lock < 5 min | REQUIRED | System Preferences > Lock Screen |
| No production secrets on disk | REQUIRED | All secrets in `.env` (gitignored) or GCP Secret Manager |
| Antivirus/XProtect active | PASS | macOS XProtect enabled by default |

---

## 4. Evidence Artifacts

| Artifact | Location | Purpose |
|----------|----------|---------|
| FileVault status | This document, Section 1 | CC6.7 encryption evidence |
| SA key audit log | GCP IAM console | CC6.1 key rotation evidence |
| Rotation calendar | Google Calendar (Carson) | CC6.1 periodic review |
| Endpoint checklist | This document, Section 3 | CC6.7 endpoint hardening |
