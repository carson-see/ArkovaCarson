# Disaster Recovery Drill Report

> **Template Version:** 2026-04-03 | **Classification:** CONFIDENTIAL
> **Reference:** docs/compliance/disaster-recovery.md

---

## 1. Drill Metadata

| Field | Value |
|-------|-------|
| **Date** | YYYY-MM-DD |
| **Drill Type** | Tabletop / Partial / Full |
| **Duration** | Start time - End time (UTC) |
| **Participants** | Name (Role), Name (Role) |
| **Drill Lead** | Name |
| **Environment** | Staging / Production |
| **Triggered By** | Scheduled quarterly / Ad-hoc / Incident follow-up |

---

## 2. Pre-Drill Checklist

- [ ] DR plan reviewed by all participants (docs/compliance/disaster-recovery.md)
- [ ] Backup status confirmed (Supabase dashboard: daily backup available, age < 24h)
- [ ] All participants have required access: Supabase dashboard, Cloud Run console, Vercel dashboard, GitHub repo
- [ ] Communication channel established (Slack channel / video call link)
- [ ] Staging environment available and isolated from production
- [ ] Rollback procedures documented and accessible
- [ ] Incident response contacts identified (see disaster-recovery.md Section 4)
- [ ] Backup validation script available (`services/worker/scripts/backup-validation.ts`)

---

## 3. Test Scenarios

### 3.1 Supabase Database Restore

**Objective:** Validate that a Supabase backup can be restored and the application functions correctly against the restored database.

| Step | Action | Expected Result | Actual Result | Pass/Fail |
|------|--------|-----------------|---------------|-----------|
| 1 | Initiate restore from Supabase dashboard (most recent backup) | New project created with restored data | | |
| 2 | Verify all critical tables exist (anchors, profiles, subscriptions, plans, api_keys, organizations, audit_events, credentials, attestations, public_records, x402_payments) | All tables present | | |
| 3 | Verify RLS enabled on all tables (`FORCE ROW LEVEL SECURITY`) | RLS active on 28+ tables | | |
| 4 | Verify triggers intact (credential_type immutability, audit PII null, platform admin protection) | All triggers present | | |
| 5 | Run backup validation script against restored instance | All checks pass | | |
| 6 | Run RLS test suite (`npm run test:rls`) | All tests pass | | |
| 7 | Verify `/health` endpoint returns healthy | 200 OK with healthy status | | |
| 8 | Verify public verification with known anchor public_id | Anchor resolves correctly | | |

**Measured RPO:** ___ (target: 24 hours for user data, 0 for anchored data)
**Measured RTO:** ___ (target: 4 hours full, 1 hour read-only verification)

---

### 3.2 Worker Failover (Cloud Run Redeploy)

**Objective:** Validate that the worker service can be redeployed to Cloud Run from the current container image or rebuilt from source.

| Step | Action | Expected Result | Actual Result | Pass/Fail |
|------|--------|-----------------|---------------|-----------|
| 1 | Identify current worker revision in Cloud Run console | Active revision noted | | |
| 2 | Deploy new revision from latest container image (`gcloud run deploy`) | New revision deployed successfully | | |
| 3 | Verify `/health` endpoint on new revision | 200 OK | | |
| 4 | Verify cron jobs executing (Cloud Scheduler triggers) | Batch anchoring and cleanup jobs fire | | |
| 5 | Verify webhook delivery (Stripe test event) | Webhook received and processed | | |
| 6 | Verify anchor processing (submit test anchor, confirm SUBMITTED -> CONFIRMED flow) | Anchor lifecycle completes | | |
| 7 | Roll back to previous revision if needed | Traffic shifts to previous revision | | |

**Measured RTO:** ___ (target: < 30 minutes)

---

### 3.3 Frontend Failover (Vercel Rollback)

**Objective:** Validate that the frontend can be rolled back to a previous deployment via Vercel.

| Step | Action | Expected Result | Actual Result | Pass/Fail |
|------|--------|-----------------|---------------|-----------|
| 1 | Identify current production deployment in Vercel dashboard | Active deployment noted | | |
| 2 | Select previous known-good deployment | Deployment identified | | |
| 3 | Promote previous deployment to production | Rollback completes, URL serves old build | | |
| 4 | Verify application loads at production URL | Login page renders correctly | | |
| 5 | Verify core flows: login, dashboard, document upload, verification | All flows functional | | |
| 6 | Verify no console errors or broken assets | Clean console, all assets load | | |

**Measured RTO:** ___ (target: < 15 minutes)

---

### 3.4 Bitcoin Anchoring Recovery

**Objective:** Validate that Bitcoin anchoring can resume after an outage, and that existing anchors remain verifiable via on-chain data.

| Step | Action | Expected Result | Actual Result | Pass/Fail |
|------|--------|-----------------|---------------|-----------|
| 1 | Verify existing SECURED anchors are independently verifiable via chain_tx_id | OP_RETURN data matches stored fingerprint | | |
| 2 | Confirm treasury wallet balance is sufficient for continued operations | Balance > minimum threshold | | |
| 3 | Verify KMS signing key is accessible (GCP KMS health check) | Key responds to sign request | | |
| 4 | Submit a test anchor and verify full lifecycle (PENDING -> SUBMITTED -> CONFIRMED -> SECURED) | Anchor reaches SECURED status | | |
| 5 | Verify batch anchoring cron resumes processing queued anchors | Queued anchors are picked up and processed | | |
| 6 | Verify mempool API connectivity for fee estimation | Fee rate returned successfully | | |

**Measured RTO:** ___ (target: < 1 hour after DB and worker recovery)

---

## 4. RPO/RTO Summary

| Metric | Target | Measured | Met? |
|--------|--------|----------|------|
| RPO (anchored data) | 0 | | |
| RPO (user data) | 24 hours | | |
| RPO (audit events) | 24 hours | | |
| RTO (full service) | 4 hours | | |
| RTO (read-only verification) | 1 hour | | |
| RTO (worker redeploy) | 30 minutes | | |
| RTO (frontend rollback) | 15 minutes | | |

---

## 5. Findings

### Issues Discovered

| # | Severity | Description | Impact | Remediation |
|---|----------|-------------|--------|-------------|
| 1 | | | | |

### Observations

- _Document any process improvements, documentation gaps, or tooling needs identified during the drill._

---

## 6. Remediation Actions

| # | Action | Owner | Due Date | Status |
|---|--------|-------|----------|--------|
| 1 | | | | |

---

## 7. Sign-Off

| Role | Name | Signature / Approval | Date |
|------|------|---------------------|------|
| Drill Lead | | | |
| Engineering Lead | | | |
| Product Lead | | | |

---

**Next scheduled drill:** YYYY-MM-DD (quarterly cadence)
