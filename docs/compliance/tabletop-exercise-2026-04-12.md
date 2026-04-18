# Incident Response Tabletop Exercise — 2026-04-12

> **Version:** 1.0 | **Date:** 2026-04-12 | **Classification:** CONFIDENTIAL
> **SOC 2 Controls:** CC7.3 (Detection), CC7.4 (Response), CC7.5 (Recovery)
> **Jira:** SCRUM-515 | **Owner:** Carson
> **Reference:** `docs/compliance/incident-response-plan.md`

---

## Exercise Overview

| Field | Value |
|-------|-------|
| **Format** | Tabletop exercise — walkthrough of 3 scenarios |
| **Duration** | ~60 minutes per scenario |
| **Participants** | Carson (IC + TL), team review |
| **Objective** | Validate incident response plan, identify gaps, document improvements |

---

## Scenario 1: Data Breach — RLS Bypass via Crafted JWT

### Inject

A security researcher reports via responsible disclosure that by crafting a JWT with a manipulated `org_id` claim, they can access anchors belonging to other organizations. The researcher provides a proof-of-concept showing they retrieved 3 anchor records from a different org.

### Severity Assessment

**P1 — Critical:** Confirmed data breach. RLS bypass allowing cross-tenant data access.

### Response Timeline

| Time | Action | Owner | Notes |
|------|--------|-------|-------|
| T+0 min | Disclosure received via security@arkova.ai | IC | Acknowledge within 1 hour per policy |
| T+5 min | Severity assessed as P1 — activate full response team | IC | All hands on deck |
| T+10 min | **Containment:** Rotate Supabase JWT secret to invalidate all sessions | TL | `supabase secrets set JWT_SECRET=<new>` |
| T+15 min | **Containment:** Deploy emergency RLS patch — add `auth.uid()` cross-check on all org-scoped policies | TL | Compensating migration |
| T+30 min | **Investigation:** Audit log review — query `audit_events` for cross-org access patterns | TL | `SELECT * FROM audit_events WHERE actor_org_id != target_org_id` |
| T+45 min | **Investigation:** Identify affected records — compare JWT claims in verification_events | TL | ip_hash-based correlation |
| T+1 hr | **Notification:** Draft breach notification to affected organizations | CL | Template from incident-response-plan.md |
| T+2 hr | **Recovery:** Verify RLS fix deployed and tested | TL | Run full RLS test suite |
| T+4 hr | **Communication:** Send notification to affected orgs with: what happened, what data, what we did | CL | Email via Resend |
| T+24 hr | **Post-incident:** Begin root cause analysis | TL | Document in post-mortem |
| T+72 hr | **Regulatory:** Assess GDPR Art. 33 notification requirement (72-hour window) | IC | DPA notification if EU data affected |

### Detection Mechanisms

| Mechanism | Would it detect? | Gap? |
|-----------|-----------------|------|
| RLS test suite (CI) | YES — if test covers cross-org scenario | Ensure cross-org JWT test exists |
| Sentry error tracking | MAYBE — depends on error thrown | Add RLS violation alerting |
| Cloud Logging | YES — PostgREST 403 errors logged | Create alert policy for unusual 403 spikes |
| Audit events | PARTIAL — logs actions but not failed access | Consider logging denied access attempts |

### Gaps Identified

1. **GAP-001:** No automated alert for unusual cross-org access patterns in audit_events
2. **GAP-002:** No mechanism to quickly identify which records were accessed in a breach
3. **GAP-003:** JWT secret rotation procedure not documented (now in endpoint-security.md)

---

## Scenario 2: Key Compromise — Bitcoin Treasury Key Exposure

### Inject

During a routine log review, an engineer notices that 3 weeks ago a deployment temporarily logged the `BITCOIN_TREASURY_WIF` environment variable in Cloud Run startup logs. The logs have been accessible to anyone with `roles/logging.viewer` in the GCP project.

### Severity Assessment

**P1 — Critical:** Treasury key potentially exposed. Financial system compromise risk.

### Response Timeline

| Time | Action | Owner | Notes |
|------|--------|-------|-------|
| T+0 min | Key exposure discovered in Cloud Run logs | TL | During routine log review |
| T+5 min | Severity assessed as P1 | IC | Treasury key = highest sensitivity asset |
| T+10 min | **Containment:** Delete affected log entries immediately | TL | `gcloud logging delete` with filter |
| T+15 min | **Containment:** Disable current treasury wallet — set `ENABLE_PROD_NETWORK_ANCHORING=false` | TL | Stops all anchoring immediately |
| T+20 min | **Investigation:** Audit GCP IAM — who has `roles/logging.viewer`? | TL | `gcloud projects get-iam-policy arkova1` |
| T+30 min | **Investigation:** Check treasury wallet for unauthorized transactions | TL | Mempool API — compare expected vs actual UTXO set |
| T+45 min | **Remediation:** Generate new KMS key pair (no more WIF) | TL | `gcloud kms keys create …` (GCP KMS is the production provider) |
| T+1 hr | **Remediation:** Update Cloud Run with new KMS key reference | TL | `gcloud run services update` |
| T+1.5 hr | **Recovery:** Transfer remaining funds from compromised wallet to new KMS-backed wallet | TL | Sweep transaction |
| T+2 hr | **Recovery:** Re-enable anchoring with new wallet | TL | `ENABLE_PROD_NETWORK_ANCHORING=true` |
| T+4 hr | **Post-incident:** Root cause — why was WIF logged? | TL | Fix: ensure treasury key never in `console.log` or startup banner |
| T+24 hr | **Prevention:** Add CI check scanning for `BITCOIN_TREASURY_WIF` in log statements | TL | TruffleHog custom pattern |

### Detection Mechanisms

| Mechanism | Would it detect? | Gap? |
|-----------|-----------------|------|
| TruffleHog (CI) | NO — scans code, not runtime logs | Add Cloud Logging scan |
| Gitleaks (CI) | NO — scans git history, not GCP logs | Not applicable |
| Cloud Logging alerts | MAYBE — would need custom alert policy | Create alert for secret-like patterns in logs |
| Manual log review | YES — how it was actually found | Slow (3-week gap) |

### Gaps Identified

4. **GAP-004:** No automated scanning of Cloud Run logs for secret-like patterns
5. **GAP-005:** KMS migration should be completed to eliminate WIF entirely (already done — KMS is live)
6. **GAP-006:** Need GCP IAM audit log monitoring for `roles/logging.viewer` grants

---

## Scenario 3: Worker Outage — Cloud Run Crash Loop

### Inject

At 2:00 AM, Sentry alerts fire showing the worker service is in a crash loop. The health endpoint returns 503. Anchoring pipeline is completely stopped. 847 anchors are in PENDING status. Stripe webhook events are queuing up.

### Severity Assessment

**P2 — High:** Partial service degradation. No data loss (anchors queued, webhooks buffered). Core verification still works (read-only from Supabase).

### Response Timeline

| Time | Action | Owner | Notes |
|------|--------|-------|-------|
| T+0 min | Sentry alert fires — worker health check failing | Automated | Sentry notification to #alerts |
| T+5 min | IC acknowledges, reviews Cloud Run logs | IC | `gcloud logging read "resource.type=cloud_run_revision"` |
| T+10 min | **Diagnosis:** Identify crash cause — OOM? Dependency? Config? | TL | Check revision diff, recent deploys |
| T+15 min | **Containment:** If bad deploy: rollback to previous revision | TL | `gcloud run services update-traffic arkova-worker --to-revisions=PREVIOUS=100` |
| T+20 min | **Containment:** If config issue: fix env var and redeploy | TL | `gcloud run services update arkova-worker --set-env-vars=...` |
| T+30 min | **Verification:** Health endpoint returns 200 | TL | `curl https://arkova-worker-*.run.app/api/health` |
| T+45 min | **Recovery:** Process backlog — trigger anchor processing | TL | Cloud Scheduler manual trigger |
| T+1 hr | **Recovery:** Verify Stripe webhook backlog processed | TL | Check webhook retry queue in Stripe dashboard |
| T+2 hr | **Monitoring:** Watch for 30 minutes — no new crashes | TL | Sentry + Cloud Logging |
| T+4 hr | **Post-incident:** Document root cause and preventive measures | IC | Post-mortem template |

### Detection Mechanisms

| Mechanism | Would it detect? | Gap? |
|-----------|-----------------|------|
| Sentry | YES — error tracking + crash notifications | Working as expected |
| Cloud Run health checks | YES — automatic restart on failure | Working, but crash loop = repeated restarts |
| Cloud Monitoring uptime check | YES — if configured | Verify uptime check exists for worker |
| Stripe webhook failure emails | YES — after 3+ failed deliveries | Delayed detection (hours) |

### Gaps Identified

7. **GAP-007:** Need Cloud Monitoring uptime check for worker health endpoint (not just Cloud Run internal)
8. **GAP-008:** No PagerDuty/Opsgenie integration for after-hours P1/P2 alerting
9. **GAP-009:** Stripe webhook dead letter queue should alert on queue depth > 100

---

## Gap Summary & Remediation Plan

| Gap ID | Description | Priority | Remediation | Jira |
|--------|------------|----------|-------------|------|
| GAP-001 | No cross-org access pattern alerting | HIGH | Add Cloud Logging alert for unusual cross-org queries | To create |
| GAP-002 | No breach impact assessment tooling | MEDIUM | Build admin query for "what records did user X access" | To create |
| GAP-003 | JWT rotation procedure undocumented | LOW | Documented in endpoint-security.md | DONE |
| GAP-004 | No Cloud Run log scanning for secrets | MEDIUM | Add Cloud Logging sink + DLP API scan | To create |
| GAP-005 | WIF should be replaced by KMS | LOW | Already completed — KMS is live on mainnet | DONE |
| GAP-006 | IAM audit log monitoring | MEDIUM | Enable GCP Data Access audit logs for IAM | To create |
| GAP-007 | External uptime check for worker | HIGH | Create Cloud Monitoring uptime check | To create |
| GAP-008 | After-hours alerting (PagerDuty) | MEDIUM | Evaluate PagerDuty vs Opsgenie for on-call | To create |
| GAP-009 | Webhook DLQ depth alerting | LOW | Add webhook queue depth monitoring to admin dashboard | To create |

---

## Exercise Conclusion

### Overall Assessment

The incident response plan is **well-structured** and covers the critical phases. The team demonstrated ability to:
- Correctly assess severity levels
- Follow escalation procedures
- Identify containment actions quickly
- Plan recovery steps in logical order

### Key Takeaways

1. **Detection is the weakest link** — most scenarios rely on manual discovery or delayed alerting
2. **Containment playbooks are strong** — clear actions for each scenario type
3. **KMS migration (completed)** significantly reduced treasury key exposure risk
4. **Cloud Logging** needs more proactive alerting policies

### Next Exercise

Schedule next tabletop for Q3 2026 (2026-07-12) — focus on:
- Supply chain compromise (dependency injection)
- Supabase outage / data recovery from backup
- Social engineering / phishing targeting team credentials
