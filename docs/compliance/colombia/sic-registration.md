# SIC Registro Nacional de Bases de Datos (RNBD) — Application Packet

> **Story:** SCRUM-724 (INTL-04) — Colombia Law 1581 compliance
> **Legal basis:** Law 1581 of 2012 §17; Decree 1377 of 2013; Decree 090 of 2018 (as amended by Decree 1759 of 2016)
> **Status:** DRAFT — awaiting Colombian counsel engagement

---

## 1. Portal + channel

**URL:** https://www.sic.gov.co/registro-nacional-de-bases-de-datos
**Account type:** *Usuario externo* under Arkova's legal identifier (NIT assigned to the Colombian representative)
**Filing fee:** none (registration itself is free; representative costs separate)

---

## 2. Required fields

### Entity details

| Field | Value |
|-------|-------|
| Razón social | Arkova Inc. |
| Tipo de persona | Jurídica |
| País de origen | Estados Unidos (Delaware) |
| NIT / RUT | To be assigned via Colombian representative |
| Domicilio en Colombia | None — extraterritorial applicability under Law 1581 §2(b) (processing of Colombian titulars) |
| Correo electrónico | `privacy@arkova.ai` |
| Sitio web | https://arkova.ai |
| Rol | **Responsable** (data controller) — also **Encargado** when processing on behalf of institutional customers |

### Appointed representative

Required because Arkova has no establishment in Colombia:

- [ ] Colombian counsel engaged (target: 2026-Q3)
- [ ] Representative letter of appointment signed
- [ ] NIT assigned via representative
- [ ] Representative contact details filed with SIC

### DPO / *Oficial de Privacidad*

Law 1581 does not require a statutory DPO, but SIC Resolution 500 of 2021 (*Guía de Responsabilidad Demostrada*) treats the appointment as an accountability best-practice.

| Field | Value |
|-------|-------|
| Nombre | TBD — see REG-28 Global DPO designation |
| Correo | `dpo@arkova.ai` |
| Teléfono | TBD |

---

## 3. Databases to register

| # | Nombre de la base | Propósito | Categorías de titulares | Categorías de datos | Transferencias internacionales |
|---|-------------------|-----------|-------------------------|---------------------|-------------------------------|
| 1 | `credential_metadata_col` | Verificación y archivo de credenciales profesionales | Trabajadores, profesionales certificados, estudiantes | Identificativos, credencial, tipo, fechas, huellas criptográficas | EE.UU. (en la lista de países adecuados de la SIC) |
| 2 | `verification_events_col` | Registro de auditoría de consultas de credenciales | Verificadores institucionales + titulares | Identificativos, correo, timestamp, organización verificadora | EE.UU. (adecuado) |

---

## 4. Accountability measures (Resolution 500 of 2021)

The RNBD filing requires attaching evidence of the organisational programme. Arkova's mapping:

| Accountability element | Arkova evidence |
|------------------------|-----------------|
| Written policies | `docs/compliance/colombia/privacy-notice.md` + `docs/compliance/data-retention-policy.md` |
| Programme owner | DPO (shared across jurisdictions) |
| Risk management | DPIA performed per jurisdiction — see `docs/compliance/kenya/dpia.md` as template |
| Training | Annual privacy training (`docs/compliance/security-training.md`) |
| Incident response | `docs/compliance/incident-response-plan.md` — SIC breach timeline embedded (15 business days) |
| Vendor management | `docs/compliance/vendor-register.md` |

---

## 5. Annual update

Registrants must submit an annual update between **March 1 and June 30** each year (Decree 090 of 2018 §4). Arkova sets a Cloud Scheduler reminder for **February 15** annually once the initial filing lands, to allow internal counsel review before the window opens.

---

## 6. Cost breakdown

| Line item | Estimate |
|-----------|----------|
| Colombian counsel — initial filing + representation | $1,500 – $3,000 |
| Ongoing annual update + representation retainer | $500 – $1,200 / yr |
| Arkova internal engineering time | $500 (4h) |
| **Total Year 1** | **$2,000 – $4,700** |

---

## 7. Next steps

- [ ] Engage Colombian counsel (recommended: Baker McKenzie Bogotá or Posse Herrera Ruiz — both have active privacy practices)
- [ ] Counsel obtains NIT + representative appointment
- [ ] Portal registration of two databases
- [ ] Receive RNBD certificate
- [ ] Ship `JurisdictionPrivacyNotices` colombia entry (this PR)
- [ ] Add Colombia badge to `/trust` page
- [ ] Update `docs/BACKLOG.md` REG-INTL section to "Tier 2: Colombia ✅"

---

## 8. References

- SIC adequacy list: https://www.sic.gov.co/ (Circular Externa 005 of 2017, latest update)
- SIC Model Contractual Clauses (Dec 2025): https://www.sic.gov.co/
- Resolution 500 of 2021 (Accountability Guide): https://www.sic.gov.co/
