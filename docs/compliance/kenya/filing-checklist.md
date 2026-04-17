# Kenya ODPC Filing Checklist

**Jira:** [SCRUM-576 / REG-15](https://arkova.atlassian.net/browse/SCRUM-576)
**Last updated:** 2026-04-17
**Owner:** Kenyan counsel (engaged 2026-04-11) + Carson (platform admin, funds KES 25,000 fee)
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

---

## Pre-submission checks (counsel owns)

- [ ] `docs/compliance/kenya/odpc-registration.md` reviewed against the [ODPC registration regulations 2021](https://www.odpc.go.ke/wp-content/uploads/2022/03/Data-Protection-Registration-of-Data-Controllers-and-Data-Processors-Regulations-2021-1.pdf).
- [ ] Fee tier confirmed: **Small** tier (KES 25,000 / ~USD 194). Arkova < 50 FTE.
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

**Fee:** KES 25,000 (~USD 194). Payment via ODPC portal card or M-Pesa. Receipt goes into `vendor-register.md`.

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
