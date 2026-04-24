# Kenya ODPC Filing Checklist

**Confluence mirror:** [Top-10 Sprint Batch 3 - 2026-04-17 §7](https://arkova.atlassian.net/wiki/spaces/A/pages/13795329) - "Kenya ODPC Filing Checklist - REG-15 (SCRUM-576)"
**Jira:** [SCRUM-576 / REG-15](https://arkova.atlassian.net/browse/SCRUM-576)
**HakiChain coordination story:** [SCRUM-1176](https://arkova.atlassian.net/browse/SCRUM-1176)
**HakiChain Confluence page:** https://arkova.atlassian.net/wiki/spaces/A/pages/26312754/SCRUM-1176+-+HAKI-REQ-07+Kenya+filing+coordination+checklist+with+HakiChain+local+support
**Last updated:** 2026-04-24
**Owner:** Kenyan counsel (engaged 2026-04-11) + Carson (platform admin, funds filing fee) + HakiChain local-support contact (to be named)
**Regulator:** [Office of the Data Protection Commissioner (ODPC)](https://www.odpc.go.ke/)
**Registration portal:** [https://odpc.go.ke/register/](https://odpc.go.ke/register/)
**Engineering status:** Complete — registration dossier, privacy notice, DPIA v0.1, and DPO designation template all authored in `docs/compliance/kenya/`. Filing is an external-process task.

---

## How to use this document

The dossier is drafted; what remains is a portal submission + fee payment. This checklist turns that into a 5-step playbook for the counsel + platform admin:

1. **Pre-submission review** (§Pre-submission checks) — counsel reviews every field in `odpc-registration.md` against Section 56-57 requirements; flag any that counsel wants to amend before submission.
2. **DPO appointment** (§DPO prerequisite) — designate a DPO per `../dpo-designation.md`; counsel is OK to act as interim DPO if an internal appointment is not ready.
3. **Portal submission** (§Portal submission) — counsel logs into ODPC portal, enters dossier values, uploads supporting docs, pays fee.
4. **Registration number receipt** (§Post-registration) — ODPC returns a registration number within 14 business days; Carson or counsel updates `privacy-notice.md` and ships a follow-up PR embedding the number in the Kenya tenant UI.
5. **Calendar renewal** — set calendar 60 days before 24-month renewal.

Transition SCRUM-576 Blocked → Done once the registration number is received and surfaced in the UI.

## HakiChain local-support lane (SCRUM-1176)

HakiChain confirmed in the 2026-04-22 partner intake that they can help with regulatory process guidance, coordination with local legal/compliance counsel, document preparation, required attestations, and follow-through tracking.

That support is useful, but it is not a substitute for Arkova approval. Treat HakiChain as a local coordination partner, not as an autonomous filer.

| Step | Arkova owner | HakiChain/local owner | Evidence location | Status |
|------|--------------|-----------------------|-------------------|--------|
| Name HakiChain filing contact | Carson | HakiChain business/legal lead | Jira SCRUM-1176 comment + vendor/contact tracker | **Needs human** |
| Confirm confidentiality channel | Carson + counsel | HakiChain contact | Counsel-approved email or secure shared folder | **Needs human** |
| Share filing checklist + target timeline | Carson | HakiChain contact | Confluence/Jira link only; no sensitive attachments in Jira | Ready |
| Local procedural review | Kenyan counsel | HakiChain local support | Counsel notes stored with filing evidence | Pending |
| Representative/DPO path | Carson + counsel | HakiChain local support, if they can introduce providers | `vendor-register.md` + DPO designation record | Pending |
| Portal submission support | Counsel | HakiChain local support for process questions only | ODPC receipt/certificate evidence folder | Pending human approval |
| Follow-through tracking | Carson + counsel | HakiChain contact | Jira SCRUM-1176 + REG-15 comments | Pending |

### Contact and confidentiality rules

- Do not send passport copies, IDs, certificates, payment receipts, or regulator correspondence through Jira comments.
- Use Jira for status and links only.
- Use counsel-approved secure email or shared folder for sensitive filing artifacts.
- If HakiChain introduces local counsel or an outsourced DPO, run the contact through vendor review before sharing Arkova non-public data.
- Carson or an explicitly delegated Arkova operator must approve any ODPC portal submission and fee payment.

### HakiChain handoff package

Send HakiChain only the information needed for local process support:

- Link to this checklist.
- Current blocker list: DPO, Kenyan representative/local counsel path, fee, portal submission, certificate receipt.
- Target timeline and desired review date.
- List of questions for local counsel:
  - Can counsel's firm serve as appointed representative under Section 58?
  - Should Arkova file as controller, processor, or both for HakiChain pilot facts?
  - Is an outsourced DPO required before portal submission, or can counsel interim support it?
  - Do the SCCs + DPIA satisfy the current ODPC cross-border transfer posture?
  - Are any local attestations required before submission?

### Board state

Keep SCRUM-1176 in **Needs Human** until the HakiChain filing contact and approval channel are named. Transition to Done only when this checklist has named owners and REG-15/REG-16 have been updated with the agreed coordination path.

---

## Pre-submission checks (counsel owns)

- [ ] `docs/compliance/kenya/odpc-registration.md` reviewed against the [ODPC registration regulations 2021](https://www.odpc.go.ke/wp-content/uploads/2022/03/Data-Protection-Registration-of-Data-Controllers-and-Data-Processors-Regulations-2021-1.pdf).
- [ ] Fee tier confirmed against current ODPC schedule. Earlier draft assumed **Small** tier (KES 25,000 / ~USD 194); ODPC public FAQ/guidance may show updated fee bands, so counsel must confirm before payment.
- [ ] DPO designated (see §DPO prerequisite).
- [ ] Entity classification: **Data Controller + Data Processor**. Both Kenya DPA roles apply because we process credentials on behalf of institutions and also hold the anchoring record.
- [ ] Kenyan representative (Section 58): counsel's firm or an engaged Nairobi representative.
- [ ] Cross-border transfer basis (Section 48): **Standard Contractual Clauses** referenced in DPIA §7; confirm counsel accepts SCCs as adequate basis.
- [ ] All claims in `odpc-registration.md` match claims in `privacy-notice.md` and `dpia.md`. Inconsistencies between the 3 documents are the #1 rejection cause.
- [ ] Supporting docs assembled: certificate of incorporation (Delaware), MSA template (redacted), SCC template, DPIA v0.1.

---

## DPO prerequisite

Kenya DPA Section 24 requires a DPO for any processor handling sensitive personal data. Status today: **template at `../dpo-designation.md`, no appointment yet.** Three options:

| Option | Pros | Cons | Recommended? |
|--------|------|------|--------------|
| Internal DPO (Arkova FTE) | Full context, fastest issue-resolution | Requires Kenyan DPO registration + CV + ID — we don't have a Kenyan FTE | No (timing) |
| Outsourced DPO (Kenyan firm, part-time) | Fast to stand up; expert on ODPC | $600–1200/month | **Yes — for year 1** |
| Counsel acts as interim DPO | No extra cost | Conflict of interest (same party advising + filing + DPO duties) | Only if counsel explicitly accepts dual hat |

Action: counsel selects interim/outsourced DPO; record designation letter (copy template at `../dpo-designation.md`) in `vendor-register.md`.

---

## Portal submission

Counsel logs in at [https://odpc.go.ke/register/](https://odpc.go.ke/register/) and enters:

| Portal field | Source in our dossier | Notes |
|--------------|-----------------------|-------|
| Organisation name | `odpc-registration.md` §1 | Exact incorporation name, no abbreviations |
| Entity type | `odpc-registration.md` §1 | Select: Data Controller + Data Processor (tick both) |
| Physical address | `odpc-registration.md` §1 + Kenyan rep | Kenyan representative address goes here |
| Email / phone | `odpc-registration.md` §1 | `counsel@<firm>.co.ke` (counsel) + `carson@arkova.ai` (platform admin) |
| Nature of processing | `odpc-registration.md` §3 | Cite Sections 26, 29, 31, 41, 48 as applicable |
| Categories of data subjects | `odpc-registration.md` §4 | Students, patients, professionals, public-record subjects |
| Categories of personal data | `odpc-registration.md` §5 | Include "sensitive personal data" per Section 2 |
| Recipients of data | `odpc-registration.md` §6 | Customers of the verification API |
| Cross-border transfers | `odpc-registration.md` §7 | Basis: SCCs. Destinations: US, EU, UK. |
| Security measures | `odpc-registration.md` §8 + `../soc2-evidence.md` | Reference SOC 2 controls CC6-CC8 |
| Retention period | `odpc-registration.md` §9 + `../data-retention-policy.md` | 7 years default; 90 days on revocation |
| DPO name + contact | `../dpo-designation.md` | Must match DPO designation letter |
| Supporting documents | §Pre-submission checks | Upload as PDFs |

**Fee:** counsel must confirm the current ODPC fee schedule before payment. Earlier draft assumed KES 25,000 (~USD 194), but public ODPC FAQ/guidance may show updated fee bands. Payment via ODPC portal card or M-Pesa. Receipt goes into the approved filing evidence location; do not attach payment evidence to Jira.

---

## Post-registration

ODPC returns a **registration number** within 14 business days of complete submission. When received:

- [ ] Counsel sends registration number to Carson with copy of the certificate.
- [ ] Carson updates `docs/compliance/kenya/privacy-notice.md` header with: registration number, issue date, renewal date (24 months forward).
- [ ] Carson opens small PR surfacing the registration number in the Kenya tenant UI. Target: `JurisdictionPrivacyNotices` component in `src/components/compliance/JurisdictionPrivacyNotices.tsx` — add a `kenyaRegistrationNumber` prop with conditional render.
- [ ] Carson files the certificate under `docs/compliance/kenya/` as `odpc-registration-certificate.pdf` (redact any PII if needed).
- [ ] Carson sets a Google Calendar reminder 60 days before the 2-year renewal.
- [ ] Carson transitions SCRUM-576 Blocked → Done.

---

## Rejection playbook

If ODPC rejects the application, common fixes:

| Reason | Fix |
|--------|-----|
| Inconsistent claims across registration / privacy notice / DPIA | Counsel re-reviews the 3 docs for consistency before resubmit |
| DPO credential insufficient | Appoint outsourced DPO with Kenyan residency |
| Cross-border basis unclear | Ship SCC annex + EU–US DPF certification evidence |
| Missing Kenyan representative | Counsel's firm acts as representative (Section 58) |

Refile within 30 days to avoid re-paying the fee.

---

## Manual-followup email

Per CLAUDE.md MANUAL-FOLLOWUP EMAIL MANDATE, counsel sends `carson@arkova.ai` an inbox note on submission (with payment receipt), on registration-number receipt (with certificate), and on any rejection (with reason + remediation plan).

---

## Definition of Done for SCRUM-576

- [ ] DPO designated (outsourced or counsel-interim).
- [ ] Registration submitted + fee paid.
- [ ] Registration number received.
- [ ] Number surfaced in Kenya tenant privacy UI (code PR merged).
- [ ] Renewal calendar reminder set.
- [ ] SCRUM-576 transitioned Blocked → Done.

## Definition of Done for SCRUM-1176

- [ ] HakiChain filing contact named.
- [ ] Confidential document-exchange channel approved.
- [ ] Counsel/local-support responsibility split documented.
- [ ] REG-15 and REG-16 comments updated with coordination path.
- [ ] Filing artifacts stay out of public Jira comments.
- [ ] Human approval path for ODPC submission and fee payment confirmed.
