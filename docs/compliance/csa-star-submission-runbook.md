# CSA STAR Level 1 — Submission Runbook

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson
> **Jira:** SCRUM-960 (TRUST-02) | **Pairs with:** `csa-star-caiq-self-assessment.md`
> **Target listing URL:** <https://cloudsecurityalliance.org/star/registry/arkova>

---

## Purpose

We already have the Consensus Assessments Initiative Questionnaire
(CAIQ 4.0.3) answered in `csa-star-caiq-self-assessment.md`. What's
missing is the four external actions that turn an internal document
into a **publicly-verifiable STAR Level 1 listing** — the single
artefact enterprise procurement teams actually check.

This runbook is the step-by-step procedure so any operator can take it
from draft to live listing without re-learning the CSA portal.

## How to use this document

1. Work top-to-bottom through Section 2. Each task has an owner + a
   verification step.
2. When a task requires a human (payment, signature, form submit), the
   "next manual action" inbox item lands in carson@arkova.ai and the
   Jira ticket moves to `Blocked` with the pending owner recorded.
3. On completion, the public URL from Section 3 is stamped into
   `complianceMapping.ts`, the compliance dashboard, and the marketing
   compliance page.

## 1. Pre-submission readiness (done)

| Check | Evidence | Status |
|-------|----------|--------|
| CAIQ 4.0.3 answered | `csa-star-caiq-self-assessment.md` | ✅ Done (2026-04-17) |
| Architecture diagram for "Client-side Only" processing model | `docs/architecture/arkova-architecture.md` | ✅ Done |
| 13 regulatory frameworks listed | `services/worker/src/lib/complianceMapping.ts` | ✅ Done |
| Incident-response plan published | `docs/compliance/incident-response-plan.md` | ✅ Done |

## 2. Submission steps

### Step 1 — Create CSA account (owner: Carson)

- Navigate to <https://cloudsecurityalliance.org/> → **Sign Up**.
- Register with `carson@arkova.ai` (platform admin). Set organisation
  name to **Arkova, Inc.** exactly — this becomes the public slug.
- Verify email + enable 2FA (authenticator app; SMS is rejected by CSA
  for registry submitters).
- Upload a logo (1024×1024 PNG, transparent background). Source at
  `arkova-marketing/public/brand/arkova-logo-1024.png`.

**Verify:** `https://cloudsecurityalliance.org/profile` renders the
Arkova name + logo. Save a screenshot at
`docs/compliance/evidence-binder/2026-Q2/csa-profile.png`.

### Step 2 — Complete the CAIQ form on the CSA portal (owner: Carson)

- CSA portal: **STAR Registry → Submit Self-Assessment → Level 1**.
- Select **CCM v4.0.12** as the control framework (maps 1:1 to our
  existing CAIQ 4.0.3 answers).
- Upload `csa-star-caiq-self-assessment.md` as the supporting document.
- Fill the portal's per-question text box by copy-paste from the
  markdown source. Each answer is ≤ 500 chars — no restructuring
  needed.
- Tick the **Consensus Assessments License** checkbox (CC BY 4.0).

**Verify:** CSA portal "Preview" step shows every CAIQ control
answered + our evidence link column populated.

### Step 3 — Pay the listing fee (owner: Carson, card on file)

- STAR Level 1 self-assessment: **$0** for CSA member orgs, **$500** for
  non-members. Arkova joined CSA on 2026-04-03 (corporate membership —
  see `docs/compliance/vendor-register.md` row "Cloud Security
  Alliance"), so no fee applies. If membership lapses before
  submission, refresh first.
- Download the member invoice PDF + stash at
  `docs/compliance/evidence-binder/2026-Q2/csa-member-invoice.pdf` so
  the audit can trace the free-submission path.

### Step 4 — Submit + capture the public URL (owner: Carson)

- On the CSA portal Preview, click **Submit for Listing**.
- CSA review SLA: **10 business days** for Level 1.
- When the listing goes live, CSA emails the public URL to the
  submitter. Paste it into:
  1. `docs/compliance/csa-star-submission-runbook.md` Section 3.
  2. `complianceMapping.ts` — new entry under CSA STAR with the URL.
  3. `arkova-marketing/src/pages/CompliancePage.tsx` — CSA STAR badge
     hyperlinks to the registry URL.
- File a follow-up ticket **TRUST-02-FU** to migrate to Level 2
  third-party audit (SCRUM-968).

**Verify:** Registry URL loads publicly without login; our
organisation name + logo + CAIQ download are all visible.

## 3. Public listing (filled on completion)

| Field | Value |
|-------|-------|
| STAR registry URL | _to be filled on submission_ |
| Listing date | _to be filled_ |
| CAIQ version | 4.0.3 |
| CCM version | 4.0.12 |
| Next-action owner | Carson |
| Renewal cadence | Annual (re-submit CAIQ every 12 months) |

## 4. Renewal cadence (annual)

- Calendar reminder: **10 months** after the listing date — start the
  re-assessment so the CAIQ is refreshed before the 12-month expiry.
- Verify all control answers still match the current architecture. If
  the client-side processing model changes (Constitution 1.6), flag
  here + on the CAIQ.
- Regenerate the PDF + upload via the CSA portal **Update Listing**
  flow. The URL stays stable across renewals.

## 5. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial runbook (SCRUM-960 TRUST-02). |
