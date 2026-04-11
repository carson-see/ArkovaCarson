# Kenya Data Protection Compliance

_Legal basis: Data Protection Act, No. 24 of 2019 (Kenya)_
_Regulator: Office of the Data Protection Commissioner (ODPC)_
_Stories: REG-15 (SCRUM-576), REG-16 (SCRUM-577)_

---

## Documents in this directory

| File | Purpose | Status |
|------|---------|--------|
| `README.md` | Directory index + compliance status tracker | Draft |
| `odpc-registration.md` | ODPC registration application packet (REG-15) | Draft — awaiting submission |
| `dpia.md` | Data Protection Impact Assessment per Section 31 (REG-16) | Draft |
| `privacy-notice.md` | Kenya-specific privacy notice for DPA Section 29 disclosure | Draft |

---

## Compliance Status

| Requirement | DPA Section | Status | Owner | Due |
|-------------|------------|--------|-------|-----|
| ODPC registration (data controller) | 56-57 | **DRAFT — NOT SUBMITTED** | Legal | — |
| DPIA for sensitive personal data | 31 | **DRAFT** | Compliance | — |
| Data subject rights workflow | 26, 31-38 | Pending REG-11 | Engineering | — |
| Cross-border transfer assessment | 48-49 | Covered in DPIA | Compliance | — |
| Breach notification procedure (72h to ODPC, reasonable time to subject) | 43 | Pending REG-13 | SRE | — |
| Privacy notice disclosure | 29 | Draft | Legal | — |
| Information security measures | 41 | Covered by SOC 2 evidence (`../soc2-evidence.md`) | SRE | Evidenced |

---

## Applicability to Arkova

Arkova becomes subject to Kenya DPA 2019 when:

1. **Kenyan data subjects' personal data is processed** — e.g., a Kenyan student's credential is anchored via a Kenyan institution, or a Kenyan professional's licence is verified via the Verification API.
2. **Processing happens in Kenya** — not currently applicable (Arkova has no Kenyan infrastructure), but will become applicable if we add Nairobi-region deployment.
3. **Kenyan institutions are direct customers** — e.g., University of Nairobi, KMTC, Kenyan professional bodies (KMPDC, KenBar, etc.).

The DPA has **extraterritorial reach** (Section 4(2)(b)) — even without Kenyan infrastructure, processing Kenyan data subjects' information triggers the Act.

---

## Registration Requirements (Sections 56-57)

Under the Data Protection (Registration of Data Controllers and Data Processors) Regulations, 2021, organizations must register with ODPC if they process personal data and meet any of:

- Annual turnover > KES 5 million (≈ USD 39K)
- Process data of more than 10,000 data subjects
- Process sensitive personal data (Section 2: health, biometric, genetic, racial, religious, etc.)
- Operate in specific sectors: education, healthcare, finance, telecoms, public sector

**Arkova triggers this via sensitive education/healthcare credentials + credential verification.**

### Registration fees (as of 2026)

| Entity size | Fee (KES) | USD equiv |
|-------------|-----------|-----------|
| Micro | 4,000 | ~$31 |
| Small | 25,000 | ~$194 |
| Medium | 50,000 | ~$388 |
| Large | 100,000 | ~$776 |

Arkova will register at the **Small** tier initially (< 50 employees), upgrading as we scale.

---

## Renewal

ODPC registration is valid for **24 months** and must be renewed before expiry. Set a calendar reminder to begin renewal 60 days before expiration.

**Renewal tracker:**
- [ ] Initial registration submitted: _pending_
- [ ] Registration number obtained: _pending_
- [ ] Renewal due: _pending (24 months from initial)_
- [ ] Google Calendar reminder set for 60-day lead time: _pending_

---

## Penalties (for non-compliance)

- Administrative fine: up to **KES 5,000,000** (≈ USD 39K) or **1% of annual turnover**, whichever is lower (Section 63)
- Criminal liability: fine up to KES 3M and/or 10 years imprisonment (Section 72)
- Civil suit by aggrieved data subjects (Section 65)

---

## Cross-references

- `../../confluence/03_security_rls.md` — RLS policies enforce org-scoping for Kenyan institutional data
- `../../confluence/08_payments_entitlements.md` — billing pathway for Kenyan institutional customers
- `../../compliance/soc2-evidence.md` — SOC 2 controls map to DPA Section 41 (security)
- `../gdpr-chain-limitation.md` — precedent for cross-border transfer reasoning
- `../../../CLAUDE.md` — project directive

---

_Last updated: 2026-04-11 | Owner: Compliance | Next review: before initial ODPC submission_
