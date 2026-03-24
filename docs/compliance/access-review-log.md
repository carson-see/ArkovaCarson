# Access Review Log

> **Version:** 1.0 | **Date:** 2026-03-23 | **Classification:** CONFIDENTIAL
> **SOC 2 Controls:** CC6.1 (Logical Access Security), CC6.2 (Access Provisioning), CC6.3 (Access Removal)
> **Owner:** Arkova Security Team
> **Review Cadence:** Quarterly

---

## 1. Purpose

This document defines the quarterly access review process for all Arkova production systems and records completed reviews. Access reviews ensure that only authorized personnel retain appropriate access levels, supporting the principle of least privilege.

---

## 2. Review Schedule

| Quarter | Review Period | Deadline | Reviewer |
|---------|--------------|----------|----------|
| Q1 2026 | Jan 1 - Mar 31 | Apr 15, 2026 | CTO |
| Q2 2026 | Apr 1 - Jun 30 | Jul 15, 2026 | CTO |
| Q3 2026 | Jul 1 - Sep 30 | Oct 15, 2026 | CTO |
| Q4 2026 | Oct 1 - Dec 31 | Jan 15, 2027 | CTO |

---

## 3. Systems Under Review

| # | System | Access Type | Criticality | Review Focus |
|---|--------|-----------|-------------|--------------|
| 1 | **Supabase Dashboard** | Organization member roles (Owner, Admin, Developer, Read-only) | CRITICAL | Verify only active team members have access; confirm role appropriateness; check service role key holders |
| 2 | **Google Cloud IAM** | IAM roles on Cloud Run, Gemini API, Cloud Logging | CRITICAL | Verify IAM bindings; confirm service accounts have minimum permissions; check API key access |
| 3 | **Vercel Team** | Team member roles (Owner, Member, Viewer) | HIGH | Verify team membership; confirm deployment permissions; check environment variable access |
| 4 | **GitHub Repository** | Repository roles (Admin, Write, Read) | HIGH | Verify collaborator list; confirm branch protection rules; check Actions secrets access; review deploy keys |
| 5 | **Cloudflare Dashboard** | Account member roles (Super Admin, Admin, Member) | HIGH | Verify account members; confirm Tunnel access; check Workers/R2 permissions; review Zero Trust policies |
| 6 | **Stripe Dashboard** | Team member roles (Administrator, Analyst, Developer, View-only) | CRITICAL | Verify team membership; confirm API key access; check webhook endpoint owners; review test/live mode access |
| 7 | **Google AI API Keys** | API key holders and usage | HIGH | Verify active API keys; confirm key restrictions (IP, referrer); check usage anomalies; rotate if stale |
| 8 | **Resend Dashboard** | Team member roles | MEDIUM | Verify team membership; confirm API key access; check sending domain ownership |
| 9 | **Sentry** | Organization member roles | MEDIUM | Verify team membership; confirm project access; check PII scrubbing rules active |

---

## 4. Review Procedure

### 4.1 Pre-Review

1. Reviewer obtains current member list from each system (screenshots or API export)
2. Reviewer obtains current employee/contractor roster from HR
3. Reviewer cross-references: all system users must appear on active roster

### 4.2 Review Checklist

For each system, the reviewer must verify:

- [ ] All users with access are current, active team members
- [ ] No former employees/contractors retain access
- [ ] Each user's role/permission level is appropriate for their current responsibilities
- [ ] Service accounts and API keys are documented and have identified owners
- [ ] No shared credentials exist (each user has individual login)
- [ ] MFA/2FA is enabled for all users where supported
- [ ] Last activity date is within 90 days (flag inactive accounts)
- [ ] No privilege escalation since last review (unless approved)

### 4.3 Actions

| Finding | Action | Timeline |
|---------|--------|----------|
| Terminated employee with access | Remove immediately | Same day |
| Role too permissive for current duties | Downgrade to appropriate role | Within 5 business days |
| Inactive account (>90 days no activity) | Contact user; disable if no response in 5 days | Within 10 business days |
| Shared credential identified | Create individual accounts; rotate shared credential | Within 5 business days |
| Missing MFA | Enable MFA or escalate to management | Within 5 business days |
| Undocumented service account | Document owner and purpose or deactivate | Within 10 business days |

### 4.4 Post-Review

1. Reviewer completes review record (Section 5) with findings and actions
2. Reviewer signs off with date
3. Any remediation items tracked to completion
4. Evidence (screenshots, exports) archived in `docs/compliance/evidence/` directory

---

## 5. Review Template

Copy this template for each quarterly review.

### Access Review: Q[N] [YEAR]

**Review Date:** [DATE]
**Reviewer:** [NAME]
**Review Period:** [START DATE] - [END DATE]

#### Supabase Dashboard

| User | Email | Role | Last Activity | MFA | Action |
|------|-------|------|--------------|-----|--------|
| | | | | | |

**Findings:** [None / describe findings]

#### Google Cloud IAM

| User / Service Account | Email | Role(s) | Last Activity | MFA | Action |
|----------------------|-------|---------|--------------|-----|--------|
| | | | | | |

**Findings:** [None / describe findings]

#### Vercel Team

| User | Email | Role | Last Activity | MFA | Action |
|------|-------|------|--------------|-----|--------|
| | | | | | |

**Findings:** [None / describe findings]

#### GitHub Repository

| User | Username | Role | Last Activity | MFA | Action |
|------|----------|------|--------------|-----|--------|
| | | | | | |

**Findings:** [None / describe findings]

#### Cloudflare Dashboard

| User | Email | Role | Last Activity | MFA | Action |
|------|-------|------|--------------|-----|--------|
| | | | | | |

**Findings:** [None / describe findings]

#### Stripe Dashboard

| User | Email | Role | Last Activity | MFA | Action |
|------|-------|------|--------------|-----|--------|
| | | | | | |

**Findings:** [None / describe findings]

#### Google AI API Keys

| Key Name | Owner | Restrictions | Last Used | Action |
|----------|-------|-------------|----------|--------|
| | | | | |

**Findings:** [None / describe findings]

#### Resend Dashboard

| User | Email | Role | Last Activity | MFA | Action |
|------|-------|------|--------------|-----|--------|
| | | | | | |

**Findings:** [None / describe findings]

#### Sentry

| User | Email | Role | Last Activity | MFA | Action |
|------|-------|------|--------------|-----|--------|
| | | | | | |

**Findings:** [None / describe findings]

---

#### Summary

| Metric | Count |
|--------|-------|
| Total users reviewed | |
| Access removals | |
| Role changes | |
| Inactive accounts flagged | |
| MFA enforcement actions | |
| Service accounts documented | |

**Overall Findings:** [Summary of review findings]

**Remediation Items:**

| # | Finding | Action | Owner | Deadline | Status |
|---|---------|--------|-------|----------|--------|
| 1 | | | | | |

**Reviewer Sign-off:**

- Reviewer Name: ________________________
- Reviewer Title: ________________________
- Date: ________________________
- Signature: ________________________

---

## 6. Completed Reviews

### Q1 2026

**Status:** Scheduled (due April 15, 2026)

_No completed reviews yet. This section will be populated after the first quarterly review._

---

## 7. Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-23 | Arkova Security Team | Initial release |
