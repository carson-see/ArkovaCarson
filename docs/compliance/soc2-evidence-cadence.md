# SOC 2 Type II — Evidence Collection Cadence

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson
> **Jira:** SCRUM-959 (TRUST-01) | **Paired with:** `soc2-type2-decision.md`
> **Observation window:** 2026-06-01 → 2026-11-30 (183 days)

---

## Purpose

SOC 2 Type II tests that controls were **operating effectively** over the
observation window — not just that they were designed. Auditors want a
trail of time-stamped evidence showing each control ran on its
prescribed cadence. A single missed weekly access-review log entry is a
finding; a single missed quarterly pentest-retest is a qualified
opinion.

This document is the **operating-cadence calendar**. Every row names
the control, the cadence, the artefact, who runs it, and where the
evidence lands.

## How to use this document

1. **At the top of every week** (Monday), run the "Weekly" block below.
   Missed block = evidence gap → log as `BUG-SOC2-YYYY-MM-DD-NNN` in
   the [Bug Tracker spreadsheet](https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4/edit?gid=0#gid=0).
2. **First business day of every month**, run the "Monthly" block. The
   monthly `change-management.md` sync must be saved + timestamped.
3. **First business day of the quarter**, run the "Quarterly" block.
4. **At day 90 of the observation window**, run the mid-window
   self-assessment (Section 4).
5. **At day 183**, export the evidence binder to the auditor portal.

---

## 1. Weekly cadence

| Control | Artefact | Tool | Owner | Notes |
|---------|----------|------|-------|-------|
| CC6.1 Logical access review | `access-review-log.md` entry | Google Sheets | CISO | Run query: `select email, role, last_login from auth.users`. Note adds / removes. |
| CC7.2 Anomaly monitoring | Sentry triage count | Sentry | CISO | Confirm every error above `warning` severity triaged. |
| CC7.3 Log review | Cloud Logging saved search | GCP Cloud Logging | Eng on call | Confirm audit logs present for `anchor` + `verify` + `mcp` surfaces. |
| A1.2 Backup verification | Supabase PITR health | Supabase dashboard | CISO | Screenshot showing "PITR enabled, RPO < 2 min". |

## 2. Monthly cadence

| Control | Artefact | Tool | Owner | Notes |
|---------|----------|------|-------|-------|
| CC8.1 Change management | Monthly change log in `change-management.md` | GitHub → md file | CTO | List all PRs merged to main tagged `cc8.1`. |
| CC6.6 Access recertification | Access review sign-off | DocuSign | CISO | Users + API keys recertified. Revoked keys documented. |
| CC2.3 Vendor review | Vendor register update | `vendor-register.md` | CFO | New SaaS adds + removals; SBOM refresh. |
| CC9.2 DR tabletop | DR drill notes | `dr-test-results/` | CTO | ≥ 1 simulated failover per quarter (three-month cadence ok; run every month during observation window). |
| CC7.1 Vulnerability scan | Dependabot digest | GitHub | CTO | Confirm all P0/P1 alerts triaged. |

## 3. Quarterly cadence

| Control | Artefact | Tool | Owner | Notes |
|---------|----------|------|-------|-------|
| CC7.1 External pentest | Pentest report / retest letter | Vendor (CREST — SCRUM-962) | CISO | Must be within 90 days of observation end. |
| CC4.1 Security training | Training completion log | DocuSign / LMS | CTO | Every full-time engineer signs off on the current training module. |
| CC3.2 Risk assessment refresh | BIA re-assessment | `bia-assessment.md` | CISO | Reassess top-10 risks. |
| CC5.3 Policy review | Policy acknowledgment log | DocuSign | CISO | Acceptable-use + incident-response + data-retention reviewed. |
| A1.3 Capacity review | Capacity dashboard export | GCP monitoring | CTO | Headroom vs current burn. |

## 4. Mid-window self-assessment (day 90 — 2026-08-30)

Use this as a pre-mortem before the final 90 days close. A gap found
here still has time to heal without restarting the window.

- [ ] Every control in `soc2-type2-evidence-matrix.md` has ≥ 1 piece of
  evidence from the current window.
- [ ] Zero missed weekly access-review entries — or remediation tickets
  on any missed entry.
- [ ] Zero monthly change-management blocks missed.
- [ ] Pentest retest scheduled for month 5 (SCRUM-962).
- [ ] Compliance automation platform (SCRUM-964) ingesting every
  continuous-control source (GitHub, GCP, Supabase, Cloudflare).
- [ ] Evidence binder export job runs green on a scheduled test run.
- [ ] Any open bugs tagged `soc2-cadence-miss` have remediation
  timelines that resolve before day 183.

## 5. Burn-down dashboard (lightweight)

The compliance automation platform (SCRUM-964 TRUST-06) surfaces a
"days remaining" gauge. Until that's in place, maintain the gauge
manually by appending one row per day here (or linked sheet):

| Day | Date | Access-review logged? | Cloud Logging review? | Sentry triage done? | Notes |
|-----|------|-----------------------|-----------------------|---------------------|-------|
| 1 | 2026-06-01 | | | | |
| 7 | 2026-06-07 | | | | |
| 14 | 2026-06-14 | | | | |
| … | | | | | |
| 90 | 2026-08-30 | | | | mid-window self-assessment |
| 180 | 2026-11-28 | | | | cut-off |
| 183 | 2026-12-01 | | | | window closed — binder export |

## 6. Evidence binder export

On day 184 (2026-12-01), run the evidence-binder export process:

1. Tag the final commit of the observation window as
   `soc2-type2-window-close-2026-11-30`.
2. Export all weekly + monthly + quarterly logs to a date-stamped
   folder in `docs/compliance/evidence-binder/2026-11-30/`.
3. Archive the Supabase PITR + Cloud Logging + Cloudflare analytics
   snapshots covering the full window into the same folder.
4. Upload to the auditor's portal (Drata / Vanta per SCRUM-964) within
   5 business days of the window close.
5. Transition SCRUM-959 to QA; auditor kickoff (2026-12-15) transitions
   it to Done on sign-off.

## 7. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial version (SCRUM-959 TRUST-01). |
