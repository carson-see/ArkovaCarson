# EU-US Data Privacy Framework — Self-Certification Runbook

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson
> **Jira:** SCRUM-963 (TRUST-05)
> **Target listing URL:** <https://www.dataprivacyframework.gov/s/participant-search>

---

## Purpose

Without an active DPF self-certification, every EU → US personal-data
transfer must rely on per-customer Standard Contractual Clauses
(SCCs). DPF replaces that with a single published commitment and gets
enterprise procurement past the transfer-impact-assessment question
in one check instead of twenty.

This runbook takes us from "SCCs only" to "DPF active + privacy
notice updated", with every external action explicit.

## How to use this document

1. Work Section 4 top-to-bottom. Each step names the owner, the
   artefact produced, and the verification check.
2. Step 2 is the only paid step; remainder is free (federal
   self-certification).
3. Once DPF is active, run Section 5 (evidence + docs update) in a
   single PR.

## 1. Why DPF (not just SCCs)

| Mechanism | Arkova-cost | Customer-visibility | Annual work |
|-----------|-------------|---------------------|-------------|
| Per-customer SCCs | Legal review each deal | Buried in MSA Schedule B | Renegotiate on SCC v2 changes |
| **EU-US DPF** | **Single federal self-certification** | **Publicly listed; one-line MSA ref** | **Annual recertification + complaint handling** |

DPF also covers the UK Extension (since the UK-US Data Bridge) — so
this is simultaneously the mechanism for UK → US transfers. Swiss-US
DPF requires a separate submission (same portal, extra fee; see
Section 6).

## 2. Pre-certification readiness

- [ ] DPO identified → `docs/compliance/dpo-designation.md`
- [ ] Privacy notice exists + already references GDPR rights →
  `arkova-marketing/src/pages/PrivacyPage.tsx` + `JurisdictionPrivacyNotices`
- [ ] Complaint-handling process live → `docs/compliance/complaint-handling.md`
- [ ] HR-data scope documented (DPF distinguishes HR-data from
  non-HR data; each requires separate commitments)
- [ ] Third-party vendors with EU personal data listed in the
  vendor register → `docs/compliance/vendor-register.md`

## 3. Scope decision

DPF offers HR / non-HR / both. Arkova processes:

| Data type | Source | Our handling |
|-----------|--------|--------------|
| Customer contacts (non-HR) | EU customers signing up for credential verification | ✅ In scope |
| Employer-uploaded credential metadata (non-HR) | ATS integrations (Bullhorn, Greenhouse) | ✅ In scope |
| Arkova employee HR data | Gusto / Rippling (outside app) | ❌ Out of scope |

Submission decision: **Non-HR Data only** (saves ~$150/yr + simpler
renewals). If Arkova later hires EU-based employees, expand scope at
next annual recertification.

## 4. Submission steps

### Step 1 — Create account on the DPF portal (owner: Carson; deadline: 2026-04-30)

- Register at <https://www.dataprivacyframework.gov/s/register>.
- Org name = **Arkova, Inc.** (must match Delaware C-corp filing
  exactly; mismatches block review).
- Primary contact = Carson Seeger (CEO) + backup = future DPO.

**Verify:** Activation email received + account profile loads
with Arkova name.

### Step 2 — Pay the annual fee (owner: Carson, card on file; deadline: 2026-05-07)

- ITA annual fee scale (2026):
  - <$5M revenue — **$200/yr**
  - $5M–$25M — **$675/yr**
  - $25M–$100M — **$3,250/yr**
- Arkova Year-1 projected revenue <$1M → **$200/yr bucket**.
- Plus ICDR arbitration coverage: **$200/yr** for the non-HR
  complaint body.
- Total Year-1: **$400/yr** (non-HR scope, single dispute resolution
  provider).
- Save invoice PDF at
  `docs/compliance/evidence-binder/2026-Q2/dpf-fee-invoice.pdf`.

### Step 3 — Complete the self-certification form (owner: Carson; deadline: 2026-05-14)

Portal form sections + our answers:

| Section | Arkova answer |
|---------|---------------|
| Notice | ✅ Privacy notice at <https://arkova.ai/privacy>; covers purposes, third parties, rights, choice |
| Choice | ✅ Opt-out for non-sensitive data; opt-in for sensitive (biometric, minor status) |
| Accountability for Onward Transfer | ✅ Vendor DPAs in place (Supabase, Vercel, CF, GCP); DPA links in vendor register |
| Security | ✅ TLS 1.3, RLS on all tables, client-side-only doc processing |
| Data Integrity & Purpose Limitation | ✅ Retention schedule in `data-retention-policy.md`; anchored-only policy in Constitution 1.6 |
| Access | ✅ Right-of-access portal at `/settings` → DataCorrectionForm |
| Recourse, Enforcement & Liability | ✅ ICDR (US) as dispute resolution; FTC jurisdiction |

### Step 4 — Select independent dispute resolution (owner: Carson; deadline: 2026-05-14)

Non-HR data options + the 3 most-used:

| Provider | Fee | Notes |
|----------|-----|-------|
| **ICDR (International Centre for Dispute Resolution)** | $200/yr | US-based; familiar to DoC review team |
| BBB National Programs | $300/yr | Higher brand recognition among US consumers |
| VeraSafe | $250/yr | Strong cross-border track record |

**Selected:** ICDR.

### Step 5 — Submit + answer Commerce Dept. follow-up (owner: Carson; deadline: 2026-05-28)

- Click "Submit for Certification".
- Commerce-Department review: **up to 6 weeks**. Typically follow-up
  email from DoC asking for:
  1. Proof of TRUSTe / ICDR registration payment.
  2. Clarification on anything where the privacy notice is ambiguous.
  3. Confirmation of the physical US address.
- Reply within 5 business days of each DoC email.

**Verify:** Status on the portal changes to "Active" + Arkova appears
in the public participant search at
<https://www.dataprivacyframework.gov/s/participant-search>.

### Step 6 — Swiss-US DPF extension (owner: Carson; deadline: 2026-06-30; optional)

- Additional $200/yr + 2-week review.
- Low-effort because the framework is near-identical; adds Switzerland
  coverage to the same portal record.
- **Decision:** Add once the EU-US listing is active, before the first
  Swiss customer lands.

### Step 7 — Update privacy notice + MSA (owner: CTO; deadline: 2026-06-15)

Once active, land these in a single PR (follow-up to this runbook):

1. `arkova-marketing/src/pages/PrivacyPage.tsx` → add DPF commitment
   paragraph + link to ICDR.
2. `docs/compliance/msa-transfer-addendum.md` → replace SCC-only
   language with: "Arkova participates in the EU-US Data Privacy
   Framework; SCCs apply only to data categories outside the DPF
   scope or for customers who elect SCCs."
3. `complianceMapping.ts` → new `EU_US_DPF` entry with the public
   participant URL.
4. Compliance dashboard badge.

### Step 8 — Annual recertification calendar (owner: Carson)

- DPF recert reminder **60 days before** the annual anniversary (2027-05).
- If DPO + privacy practices unchanged, recert is a one-page
  confirmation + fee payment.
- Any material change (new sub-processor, new data category, new
  purpose) triggers full re-answer of Section 3.

## 5. Evidence binder checklist (post-activation)

- [ ] DoC activation letter → `evidence-binder/2026-Q2/dpf-activation.pdf`
- [ ] Portal screenshot showing "Active" status + Arkova public URL
- [ ] ICDR registration confirmation
- [ ] Updated privacy notice deployed + diff PR URL
- [ ] `complianceMapping.ts` + dashboard updates

## 6. Risk register

- **Risk:** CJEU invalidates DPF (Schrems III scenario).
  **Mitigation:** SCC template stays in the MSA library; revert by
  flipping the addendum paragraph + notifying affected customers.
- **Risk:** DPF fee increase makes non-HR scope uneconomic.
  **Mitigation:** Annual review of scope + fees at recertification.
- **Risk:** ICDR dispute against Arkova before SOC 2 attestation.
  **Mitigation:** Complaint-handling runbook
  (`complaint-handling.md`) covers the 45-day response SLA; DPO is
  the first responder.

## 7. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial runbook (SCRUM-963 TRUST-05). |
