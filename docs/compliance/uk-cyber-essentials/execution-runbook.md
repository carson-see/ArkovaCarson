# UK Cyber Essentials Plus — Execution Runbook

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson (CISO)
> **Jira:** SCRUM-978 (TRUST-07) | **External action:** SCRUM-891 (IASME assessor engagement)
> **Pairs with:** `readiness-checklist.md` | **Target certificate:** 2026-09-30

---

## Purpose

`readiness-checklist.md` (shipped in PR #413) has the technical
control map against the 5 CE+ control families (Firewalls, Secure
Configuration, User Access Control, Malware Protection, Patch
Management). This doc is the **execution runbook** from "I think we
meet the control requirements" to "IASME-issued certificate in hand"
— with named steps, owners, and costs.

## How to use this document

1. Work Section 3 top-to-bottom. Each step names owner + deadline.
2. The assessor engagement (SCRUM-891) is the only external-dependency
   step. Everything else is self-preparation.
3. Section 6 is the annual-recertification calendar. Set a reminder
   before expiration.

## 1. Why CE+ (and not just CE)

- **Cyber Essentials (CE)** is a self-assessment questionnaire —
  ~£300/year, answer online, get a badge. Useful for UK procurement
  gates but carries less weight.
- **Cyber Essentials Plus (CE+)** adds a **hands-on technical
  assessment** by an IASME-accredited assessor who runs vulnerability
  scans against our production surface + confirms the controls from
  the questionnaire are actually live. Costs ~£1,500-£3,000 and
  takes 1-2 weeks of assessor time. This is what procurement teams
  respect in 2026.

## 2. IASME assessor shortlist

IASME is the official delivery body; any of its accredited assessors
can issue the certificate. Candidates (UK-based):

| Assessor | Why | Contact |
|----------|-----|---------|
| **IT Governance Ltd** | Highest-volume CE+ issuer in UK; familiar with SaaS scope. | <info@itgovernance.co.uk> |
| **NCC Group (UK CE+ arm)** | Pentest firm we're already engaging for SCRUM-962; potential bundle. | <cyberessentials@nccgroup.com> |
| **Pentest People** | SaaS-specialist assessor; good on cloud scoping. | <info@pentestpeople.com> |
| **CyberSmart** | Self-service + assessor hybrid; lowest cost; shortest turnaround. | <hello@cybersmart.com> |

Decision factor: if we go with NCC Group, we get a bundled discount
with the CREST pentest (TRUST-04). CyberSmart is the lowest-friction
option if time is tight.

## 3. Execution steps

### Step 1 — Confirm readiness (owner: CTO; deadline: 2026-06-30)

Before engaging an assessor, run every row of
`readiness-checklist.md` ourselves:

- [ ] Firewalls — Cloudflare WAF rules documented; default-deny on
  worker origin.
- [ ] Secure Configuration — GCP Cloud Run services, Supabase, Vercel
  each on latest LTS versions + hardening baselines.
- [ ] User Access Control — SSO enforced for all admin; MFA on
  GitHub + GCP + Supabase + Vercel + Cloudflare.
- [ ] Malware Protection — N/A for SaaS (no end-user devices in
  scope); confirm the exclusion language with assessor at
  pre-engagement.
- [ ] Patch Management — Dependabot on all repos; 14-day SLA for
  Critical + High CVEs; evidence = GitHub screenshot.

**Exit:** every row has an evidence link + a screenshot dated within
the last 30 days.

### Step 2 — Engage assessor (owner: Carson; deadline: 2026-07-15)

- Email all 4 shortlisted assessors with:
  - Scope statement: "Arkova SaaS platform (frontend + worker + edge
    + Supabase DB). No end-user devices. No office network. UK
    data-residency via EU+UK CF edge."
  - Readiness checklist attached as PDF.
  - Budget range: £1,500-£3,000.
  - Timeline: certificate target 2026-09-30.
- Pick one within 10 business days of quotes in hand.
- Sign SOW + pay 30% kickoff.

**External-action tracked in** [SCRUM-891](https://arkova.atlassian.net/browse/SCRUM-891).

### Step 3 — Pre-assessment scan (owner: assessor; deadline: 2026-08-15)

Assessor runs authenticated + unauthenticated vulnerability scans
against:
- Public frontend (`app.arkova.ai`, `arkova-26.vercel.app`)
- Public API (`api.arkova.ai` / Cloud Run edge)
- MCP endpoint (`edge.arkova.ai/mcp`)
- Supabase REST API (requires test key, scoped to a test org)

Output: pre-assessment findings report. Remediation window: 14 days.
Coordinate with the `pentest-execution-runbook.md` window so the
same vendor-IP allowlist + WAF adjustments apply.

### Step 4 — Remediation (owner: CTO + Engineering; deadline: 2026-08-29)

Any Critical/High finding fixed within 14 days. Assessor re-scans.
File each finding as a GitHub issue with regression test.

### Step 5 — Certification issuance (owner: assessor; deadline: 2026-09-30)

IASME reviews the assessor's report, issues the certificate PDF +
unique certificate number. Certificate is valid **12 months** (CE+
has no "level 2" — it's a single annual certification).

Deliverables:
- Certificate PDF → `docs/compliance/evidence-binder/2026-Q3/ce-plus-certificate.pdf`
- Certificate number → `complianceMapping.ts` + marketing
  CompliancePage.
- IASME public registry listing
  (<https://iasme.co.uk/cyber-essentials/certified-organisations>).

## 4. Scope + exclusions (negotiate up-front)

CE+ scopes typically include every device/network a user could use to
access organisation data. For a pure SaaS like Arkova the in-scope
surface is small:

| In scope | Notes |
|----------|-------|
| Cloud Run edge workers | CF + GCP managed; OS patching handled by CF/GCP, but we must evidence the managed-service contract. |
| Supabase project | Shared-responsibility matrix documents the boundary. |
| Cloudflare Workers | Same. |
| Admin laptops (Carson + CTO) | FileVault + OS auto-update + password manager. |

| Explicitly out of scope | Justification |
|-------------------------|---------------|
| End-user customer devices | CE+ scopes the organisation's IT, not customers'. |
| Contractor devices (if any) | Must be separately scoped or contractor must hold own CE+. |
| Office network | None — Arkova is remote-first. |

Document the scope exclusions in a signed Scope Exclusion Form that
the assessor will want before Stage 1.

## 5. Cost breakdown

| Item | Budget |
|------|--------|
| IASME assessor fee | £1,500 - £3,000 |
| Remediation engineering time (est.) | ~£3,000 opportunity cost |
| Annual recertification fee (Year 2 onward) | £1,500 - £2,500 |
| **Year-1 all-in external spend** | **~£3,000** |

## 6. Annual recertification

CE+ certificates expire **12 months** after issuance. Procedure:

- **Month 9** (2027-06): calendar nudge to Carson. Start by running
  Section 3 Step 1 readiness check fresh.
- **Month 10** (2027-07): book the same assessor for a lightweight
  retest (typically 30% of Year-1 effort since baseline is known).
- **Month 11** (2027-08): reassessment + any remediation.
- **Month 12** (2027-09): new certificate issued before the old one
  expires. No grace period — a lapsed certificate is a gap auditors
  and procurement teams will flag.

## 7. Cross-links

- `readiness-checklist.md` — control-by-control evidence map.
- `pentest-execution-runbook.md` (SCRUM-962) — bundle opportunity.
- `iso27001-implementation-roadmap.md` (SCRUM-966) — ISO 27001 covers
  a superset of CE+; CE+ is a stepping stone for UK public sector
  deals that need it before ISO ships.

## 8. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial execution runbook (SCRUM-978 TRUST-07). |
