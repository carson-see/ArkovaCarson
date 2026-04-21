# SOC 2 Type II Audit — Execution Runbook

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson
> **Jira:** SCRUM-979 (TRUST-12) | **Depends on:** SCRUM-959 (TRUST-01) + SCRUM-522 (auditor engagement)
> **Target report delivery:** 2027-02-28

---

## Purpose

TRUST-01 (SCRUM-959) sets up a 6-month observation window running
2026-06-01 → 2026-11-30 with continuous evidence collection via Drata.
TRUST-04 (SCRUM-962) gets a CREST pentest on file. TRUST-06 (SCRUM-964)
selects Drata.

This runbook covers the **actual audit fieldwork** that happens AFTER
the observation window closes — when the auditor pulls evidence
samples, interviews control owners, and writes the opinion letter.

Without a runbook, a first-time SOC 2 audit turns into weeks of
surprises. This document lists every deliverable, every meeting,
every evidence sample the auditor will ask for, and who owns each.

## How to use this document

1. At observation-window close (2026-11-30), run Section 3 prep.
2. From the auditor kickoff call (2026-12-15), work Section 4
   top-to-bottom.
3. When the opinion draft arrives (2027-02-01 target), run Section 5.
4. At sign-off + report delivery (2027-02-28), run Section 6 and flip
   the Jira ticket to Done.

## 1. Scope (from SCRUM-516 framework selection)

Trust Service Criteria (TSCs) in scope:

- **CC — Common Criteria** (Control Environment, Communication,
  Risk Assessment, Monitoring, Control Activities, Logical + Physical
  Access, System Operations, Change Management, Risk Mitigation)
- **A — Availability**
- **C — Confidentiality**
- **PI — Processing Integrity**
- **P — Privacy**

Not in scope (Year-1 defer):

- FedRAMP (SCRUM-983 conditional).
- HITRUST (SCRUM-982 conditional).

## 2. Responsible parties

| Role | Person | What they own |
|------|--------|---------------|
| Audit sponsor | Carson (CEO) | Contract, budget, final sign-off |
| Audit PM | CISO (Carson, dual-hat Year 1) | Day-to-day auditor liaison |
| Control owners | CTO + CISO + Legal | Interview responses per control |
| Evidence custodian | Drata (SCRUM-964) | Automated evidence pulls |
| External auditor | TBD via SCRUM-522 RFP | Opinion-letter author |

## 3. Pre-fieldwork checklist (run at 2026-11-25 through 2026-12-14)

- [ ] Observation window officially closes 2026-11-30.
- [ ] No control changes between 2026-11-25 and 2026-12-01 (freeze).
- [ ] Evidence binder exported from Drata + filed to
  `docs/compliance/evidence-binder/2026-11-30/` (see
  `soc2-evidence-cadence.md` Section 6).
- [ ] Pentest retest letter from SCRUM-962 confirmed to be within 90
  days of 2026-11-30.
- [ ] Every policy in `docs/compliance/` bears a 2026 date + owner
  signature (check DocuSign envelopes).
- [ ] All engineers + admins have completed annual security training
  within the observation window.
- [ ] CISO reviews `soc2-type2-evidence-matrix.md` row-by-row to
  confirm every mapped control has ≥ 1 evidence artifact.

## 4. Fieldwork runbook (2026-12-15 → 2027-02-01)

### Step 1 — Kickoff (2026-12-15)

60-minute call. Auditor provides:
- Evidence Request List (ERL) — usually 200-400 items pulled from SOC 2
  AICPA Trust Services Criteria.
- Secure file-sharing portal URL.
- Interview scheduling slots.

Carson to provide:
- Org chart + control-owner contacts.
- Drata read-only URL for continuous evidence pulls.
- Observation-window window-close date + evidence binder link.

### Step 2 — Evidence upload (2026-12-16 → 2026-12-31)

For every ERL item the auditor requests, file the evidence + screenshot
in their portal. Expected categories:

| Category | Sample ERL items |
|----------|-----------------|
| **Access reviews** | Quarterly access-review exports (4 × ~15MB each) |
| **Change management** | 6 months of PR history + CI logs |
| **Incident response** | Runbook + 1 incident simulation |
| **Backup + DR** | Supabase PITR health exports + DR tabletop notes |
| **Vendor management** | Vendor register + DPAs |
| **Security training** | Completion logs from DocuSign / LMS |
| **Pentest** | CREST final report + retest letter |
| **Policies** | All 30 `docs/compliance/*.md` with sign-off dates |

### Step 3 — Control-owner interviews (2027-01-05 → 2027-01-19)

Auditor schedules 30-60 minute interviews. Expect ~15-20 interviews:
- CC1: Control environment (Carson, 60 min)
- CC3: Risk assessment (Carson + Board chair, 45 min)
- CC5+CC6: Access controls (CTO + CISO, 60 min)
- CC7: System monitoring (CTO, 45 min)
- CC8: Change management (CTO, 45 min)
- CC9: Risk mitigation (CISO, 45 min)
- A1: Availability / DR (CTO, 45 min)
- C1: Confidentiality (CTO, 30 min)
- PI1: Processing integrity (CTO, 45 min)
- P1-P8: Privacy (CISO + DPO, ~90 min total)

**Prep per interview:** ensure the control owner has the relevant
`docs/compliance/*.md` and `docs/confluence/*.md` open before joining.
Bring specific evidence artifacts.

### Step 4 — Exception tracking (continuous during fieldwork)

Any control the auditor flags as exception or observation goes into a
running log: `docs/compliance/evidence-binder/2026-11-30/exceptions.md`
with date + severity + owner + remediation plan. Some exceptions are
resolved mid-audit; some become footnotes in the opinion letter.

### Step 5 — Draft opinion review (2027-02-01 → 2027-02-15)

Auditor delivers draft opinion letter in `.docx`. CISO review:

- Management's assertion language — does it match our actual
  architectural claims (Constitution 1.6 client-side-only, etc.)?
- Factual accuracy per control description.
- Exception descriptions — are they as narrow as the facts support?
- Report period — confirm 2026-06-01 → 2026-11-30.

Mark up + return within 10 business days. Auditor incorporates.

## 5. Opinion-letter acceptance (2027-02-15 → 2027-02-28)

- [ ] Final opinion letter received.
- [ ] CISO + CEO counter-sign the Management Letter.
- [ ] Auditor issues the official Type II report PDF.
- [ ] PDF filed (encrypted) at
  `docs/compliance/soc2-type2-report-2026-Q2.pdf` with access-list:
  read-only for Carson, CTO, CISO, auditor, legal.
- [ ] Report summary filed at
  `docs/compliance/soc2-type2-report-2026-Q2-summary.md` (public-safe
  summary for sales, no raw opinion text).

## 6. Post-audit publishing

- [ ] Share the full report on request via sales (DocSend with expiry).
- [ ] Start SOC 3 bundle (SCRUM-981) using the Type II report as
  source.
- [ ] Update `complianceMapping.ts` to reference the Type II
  attestation date.
- [ ] Add SOC 2 Type II badge + report-request link to the marketing
  CompliancePage.
- [ ] File a TRUST-12-FU follow-up story for the Year-2 re-audit
  (target window open 2027-06-01).
- [ ] Transition SCRUM-979 to Done.

## 7. Budget

| Item | Estimate |
|------|----------|
| Auditor SOW Year 1 | $35,000 - $55,000 (CPA firm, full 5-TSC scope) |
| Internal ops (CISO time, Year 1) | ~$30,000 opportunity cost |
| Drata platform (Year 1) | $15,000 (SCRUM-964) |
| CREST pen test Year 1 | $30,000 - $40,000 (SCRUM-962) |
| **Total Year-1 all-in** | **~$110k - $140k** |

Year 2 re-audit drops to ~$25k auditor fee because scoping work is
reusable.

## 8. Risk register

- **Risk:** Auditor flags a material control exception we can't remediate
  in-cycle.
  **Mitigation:** Day-90 mid-window self-assessment (SCRUM-959 Section
  4) catches gaps with time to fix. If one surfaces late, negotiate
  with auditor to document as known exception with remediation
  timeline rather than delay the opinion.
- **Risk:** Scope creep — auditor pulls in controls outside the stated
  TSCs.
  **Mitigation:** SOW must explicitly enumerate TSCs. Reject scope
  additions; negotiate Year-2 inclusion.
- **Risk:** Observation window re-starts mid-cycle because a material
  control changed.
  **Mitigation:** 2026-11-25 freeze. Any change after that requires
  CISO approval AND a written auditor concurrence.

## 9. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial runbook (SCRUM-979 TRUST-12). |
