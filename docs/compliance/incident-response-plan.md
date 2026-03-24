# Incident Response Plan

> **Version:** 1.0 | **Date:** 2026-03-23 | **Classification:** CONFIDENTIAL
> **SOC 2 Controls:** CC7.3 (Detection), CC7.4 (Response), CC7.5 (Recovery)
> **Owner:** Arkova Security Team
> **Review Cadence:** Annually or after any P1/P2 incident

---

## 1. Purpose

This document defines Arkova's formal incident response procedures for security events, service disruptions, and data-related incidents. All team members with production access must read and acknowledge this plan.

---

## 2. Scope

This plan covers all Arkova production systems:

- **Supabase** (PostgreSQL database, Auth, RLS)
- **Google Cloud Run** (Worker service, Gemini AI)
- **Vercel** (Frontend hosting)
- **Cloudflare** (Edge compute, Tunnel, WAF)
- **Stripe** (Payment processing)
- **Resend** (Transactional email)
- **GitHub** (Source code, CI/CD)
- **Bitcoin network** (Anchoring infrastructure)

---

## 3. Severity Levels

| Level | Name | Definition | Response Time | Update Cadence | Examples |
|-------|------|-----------|---------------|----------------|----------|
| **P1** | Critical | Complete service outage, confirmed data breach, or financial system compromise | 15 minutes | Every 30 minutes | Database breach; Stripe webhook compromise; treasury key exposure; RLS bypass in production |
| **P2** | High | Partial service degradation, potential data exposure, or security vulnerability actively exploited | 1 hour | Every 2 hours | Anchoring pipeline down; auth bypass discovered; worker crash loop; AI extraction returning PII |
| **P3** | Medium | Non-critical service issue, vulnerability identified but not exploited, or compliance gap | 4 hours | Daily | Elevated error rates; failed cron jobs; dependency CVE (high severity); rate limiting failure |
| **P4** | Low | Minor issue, informational security event, or process improvement needed | 24 hours | Weekly | Dependency CVE (low severity); failed login spike (likely credential stuffing); minor UI regression |

---

## 4. Roles and Responsibilities

### 4.1 Incident Commander (IC)

- Declares incident severity and activates response team
- Owns the incident timeline and coordinates all activities
- Makes escalation/de-escalation decisions
- Approves external communications
- Ensures post-incident review is scheduled

### 4.2 Technical Lead (TL)

- Leads root cause investigation
- Implements containment and remediation
- Coordinates with vendor support (Supabase, Google Cloud, Cloudflare, etc.)
- Documents technical timeline and evidence
- Validates fix effectiveness before all-clear

### 4.3 Communications Lead (CL)

- Drafts and sends all external communications (customers, partners)
- Manages internal status updates
- Coordinates with legal counsel when required
- Maintains the communications log
- Handles press/media inquiries if applicable

### 4.4 On-Call Rotation

| Role | Primary | Backup |
|------|---------|--------|
| Incident Commander | CTO | CEO |
| Technical Lead | Lead Engineer | Senior Engineer |
| Communications Lead | Head of Operations | CTO |

---

## 5. Incident Response Phases

### Phase 1: Detection and Triage (0-15 min)

1. Incident detected via: monitoring alert, customer report, team observation, or vendor notification
2. First responder creates incident record with timestamp and initial assessment
3. First responder assigns preliminary severity level (P1-P4)
4. Incident Commander activated for P1/P2; informed for P3/P4
5. Dedicated communication channel created (e.g., Slack channel `#incident-YYYY-MM-DD`)

### Phase 2: Containment (15 min - 2 hours)

1. Technical Lead assesses blast radius and identifies affected systems
2. Implement immediate containment:
   - **Database breach:** Rotate Supabase service role key; revoke compromised sessions
   - **API key compromise:** Invalidate affected API keys via HMAC rotation
   - **Worker compromise:** Scale Cloud Run to 0; deploy clean revision
   - **Frontend compromise:** Roll back Vercel deployment to last known good
   - **Treasury key exposure:** Immediately move funds; rotate `BITCOIN_TREASURY_WIF`
   - **Payment compromise:** Contact Stripe support; disable webhook endpoint
3. Preserve evidence (see Section 8)
4. Confirm containment is effective

### Phase 3: Eradication (2 hours - 24 hours)

1. Identify and remove root cause
2. Patch vulnerability or misconfiguration
3. Validate fix in staging environment
4. Deploy fix through standard CI/CD (or emergency procedure if P1)
5. Verify all indicators of compromise are addressed

### Phase 4: Recovery (24-72 hours)

1. Restore affected services to full operation
2. Monitor for recurrence (increased logging/alerting for 72 hours)
3. Confirm data integrity (run RLS test suite, verify anchor chain)
4. Re-enable any disabled features or rate limits
5. Incident Commander declares all-clear

### Phase 5: Post-Incident Review (within 5 business days)

1. Conduct blameless post-incident review (see Section 9)
2. Document lessons learned
3. Create action items with owners and deadlines
4. Update this plan if process gaps identified
5. File compliance evidence artifacts

---

## 6. Escalation Matrix

### 6.1 Internal Escalation

| Trigger | Escalate To | Method |
|---------|------------|--------|
| Any suspected security incident | Incident Commander | Phone + Slack |
| P1 declared | All roles activated | Phone tree |
| P2 declared | IC + TL activated | Phone + Slack |
| Incident exceeds 4 hours (P1) or 24 hours (P2) | CEO | Phone |
| Confirmed data breach | CEO + Legal Counsel | Phone |
| Financial system compromise | CEO + CFO | Phone |
| Regulatory reporting required | Legal Counsel | Phone + Email |

### 6.2 Vendor Escalation

| Vendor | Contact Method | SLA |
|--------|---------------|-----|
| Supabase | Support portal + emergency email | Per plan tier |
| Google Cloud | Cloud Console support case (P1: phone) | Per support plan |
| Vercel | Support ticket + status page | Per Enterprise plan |
| Cloudflare | Dashboard ticket (P1: emergency phone) | Per plan tier |
| Stripe | Dashboard support (P1: phone) | 24/7 for critical |
| GitHub | Support portal | Per plan tier |

### 6.3 External Escalation

| Trigger | Notify | Timeline |
|---------|--------|----------|
| Confirmed personal data breach (EU residents) | Supervisory authority (GDPR Art. 33) | Within 72 hours |
| Confirmed personal data breach (affected individuals) | Data subjects (GDPR Art. 34) | Without undue delay |
| Financial data compromise | PCI QSA + card brands (via Stripe) | Per PCI DSS requirements |
| Law enforcement request | Legal Counsel first | As directed by counsel |

---

## 7. Communication Templates

### 7.1 Customer Notification (Initial)

```
Subject: [Arkova] Security Incident Notification

Dear [Customer Name],

We are writing to inform you of a security incident affecting the Arkova platform
that was identified on [DATE] at [TIME] UTC.

What happened:
[Brief, factual description of the incident]

What we are doing:
Our security team is actively investigating and has implemented containment
measures. We are working to resolve this issue as quickly as possible.

What you should do:
[Specific actions customers should take, if any]

We will provide updates every [FREQUENCY] until this matter is resolved.
Our next update will be by [DATE/TIME] UTC.

If you have questions, please contact security@arkova.io.

Regards,
Arkova Security Team
```

### 7.2 Customer Notification (Resolution)

```
Subject: [Arkova] Security Incident Resolved

Dear [Customer Name],

We are writing to provide a final update on the security incident reported
on [ORIGINAL DATE].

Resolution:
The incident has been fully resolved as of [DATE] at [TIME] UTC.

Root cause:
[Brief, non-technical description of root cause]

Actions taken:
- [Containment action]
- [Remediation action]
- [Preventive measure implemented]

Impact to your data:
[Clear statement about whether customer data was affected]

If you have questions, please contact security@arkova.io.

Regards,
Arkova Security Team
```

### 7.3 Internal Status Update

```
Subject: [P{LEVEL}] Incident Update #{NUMBER} - {TITLE}

Incident ID: INC-YYYY-NNNN
Severity: P{LEVEL}
Status: [INVESTIGATING | CONTAINED | ERADICATING | RECOVERING | RESOLVED]
Incident Commander: [NAME]
Technical Lead: [NAME]

Timeline (UTC):
- [TIME] - [Event]
- [TIME] - [Event]

Current status:
[Description of current state]

Next steps:
- [Action] - Owner: [NAME] - ETA: [TIME]

Next update by: [DATE/TIME] UTC
```

### 7.4 Legal Notification

```
Subject: [CONFIDENTIAL] Security Incident — Legal Review Required

To: Legal Counsel
From: Incident Commander

Incident ID: INC-YYYY-NNNN
Severity: P{LEVEL}
Date discovered: [DATE/TIME] UTC

Summary:
[Factual description of incident]

Data potentially affected:
- Personal data: [YES/NO] — Estimated records: [NUMBER]
- Financial data: [YES/NO]
- Credential data: [YES/NO]

Jurisdictions potentially affected:
[List of jurisdictions based on affected users]

Regulatory notification assessment needed: [YES/NO]
Estimated timeline for notification: [DATE]

Evidence preserved: [YES/NO] (see Section 8 procedures)
```

---

## 8. Evidence Preservation Procedure

Upon detection of any P1 or P2 incident, the Technical Lead must immediately preserve the following evidence. Evidence must not be modified or deleted during an active investigation.

### 8.1 Evidence Collection Checklist

| Evidence Type | Source | Preservation Method | Retention |
|--------------|--------|-------------------|-----------|
| Application logs | Cloud Run, Vercel, Cloudflare | Export to locked storage bucket | 1 year minimum |
| Database audit logs | Supabase `audit_log` table | Snapshot + export | 1 year minimum |
| Auth session logs | Supabase Auth | Export before rotation | 1 year minimum |
| Network logs | Cloudflare WAF/Access | Export via API | 1 year minimum |
| Git history | GitHub | Branch protection prevents deletion | Permanent |
| Deployment history | Vercel + Cloud Run | Screenshot + API export | 1 year minimum |
| Stripe event logs | Stripe Dashboard | Export via API | Per Stripe retention |
| Email delivery logs | Resend | Export via API | 90 days (export immediately) |
| Screenshots/recordings | Incident responders | Upload to locked storage | 1 year minimum |

### 8.2 Evidence Integrity

- All exported evidence must include SHA-256 checksums
- Evidence storage bucket must have write-once policy (no deletion during investigation)
- Chain of custody log maintained: who accessed what evidence, when, and why
- Evidence access limited to Incident Commander and Technical Lead

### 8.3 Preservation Commands

```bash
# Export Cloud Run logs
gcloud logging read "resource.type=cloud_run_revision" \
  --project=arkova-prod \
  --format=json \
  --freshness=72h > evidence/cloud-run-logs-$(date +%Y%m%d).json

# Export Supabase audit log
psql $DATABASE_URL -c "COPY (SELECT * FROM audit_log WHERE created_at > NOW() - INTERVAL '72 hours') TO STDOUT WITH CSV HEADER" > evidence/audit-log-$(date +%Y%m%d).csv

# Checksum all evidence
find evidence/ -type f -exec sha256sum {} \; > evidence/checksums.sha256
```

---

## 9. Post-Incident Review Checklist

The post-incident review must be completed within 5 business days of incident resolution. All P1 and P2 incidents require a written report.

### 9.1 Review Meeting Agenda

- [ ] Review incident timeline (factual, blameless)
- [ ] Confirm root cause identification
- [ ] Assess detection effectiveness (how was it found? how could we detect sooner?)
- [ ] Assess response effectiveness (what went well? what was slow?)
- [ ] Review communication effectiveness (were stakeholders informed appropriately?)
- [ ] Identify systemic issues or process gaps
- [ ] Define corrective action items with owners and deadlines
- [ ] Determine if plan updates are needed
- [ ] Determine if additional monitoring/alerting is needed

### 9.2 Post-Incident Report Template

```
# Post-Incident Report: INC-YYYY-NNNN

## Summary
- Severity: P{LEVEL}
- Duration: [START] to [END] ([DURATION])
- Impact: [Users/systems affected]
- Data affected: [YES/NO — details]

## Timeline
[Minute-by-minute timeline]

## Root Cause
[Technical root cause analysis]

## Detection
- How detected: [Alert/Report/Manual]
- Time to detect: [DURATION]
- Detection gap: [What could have detected this sooner]

## Response Assessment
- Time to contain: [DURATION]
- Time to resolve: [DURATION]
- What went well: [LIST]
- What could improve: [LIST]

## Action Items
| # | Action | Owner | Deadline | Status |
|---|--------|-------|----------|--------|
| 1 | [Action] | [Name] | [Date] | Open |

## Compliance Impact
- Regulatory notification required: [YES/NO]
- Customer notification sent: [YES/NO]
- SOC 2 evidence updated: [YES/NO]
```

---

## 10. Testing and Maintenance

| Activity | Frequency | Owner |
|----------|-----------|-------|
| Tabletop exercise (simulated P1) | Semi-annually | Incident Commander |
| Contact list verification | Quarterly | Communications Lead |
| Runbook validation | Annually | Technical Lead |
| Full plan review and update | Annually or post-P1/P2 | Incident Commander |
| Vendor escalation path verification | Annually | Technical Lead |

---

## 11. Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-23 | Arkova Security Team | Initial release |
