# Colombia Privacy Notice — Law 1581 of 2012

> **Version:** 1.0 | **Date:** 2026-04-17 | **Classification:** PUBLIC
> **Legal basis:** Law 1581 of 2012 + Decree 1377 of 2013 + Resolution 500 of 2021 (demonstrated accountability)
> **Regulator:** Superintendencia de Industria y Comercio (SIC) — https://www.sic.gov.co/
> **Jira:** SCRUM-724 (INTL-04) | **Owner:** Arkova Legal
> **Status:** DRAFT — awaiting SIC Registro Nacional de Bases de Datos (RNBD) entry

---

## 1. Who this notice applies to

This notice applies to data subjects (*titulares*) whose personal data is processed by Arkova Inc. in connection with services offered to organisations in Colombia or processing data subjects located in Colombia.

Arkova acts as the **responsible party** (*responsable del tratamiento*) and, when engaged by an institutional customer, also as the **processor** (*encargado*) under the instructions of that customer as the controller.

---

## 2. Data we process

| Category | Examples | Legal basis (Law 1581 Art. 9 + 10) |
|----------|----------|------------------------------------|
| Credential metadata | Credential type, issuing body, dates, identifiers | Prior express consent of the titular during onboarding |
| Cryptographic fingerprints | SHA-256 hashes of user documents (one-way, not reversible) | Legitimate interest (Art. 10(b)) — anti-fraud and integrity verification |
| Verification events | Who verified a credential, when, from which organisation | Contractual necessity (Art. 10(a)) |
| Sensitive data (if any) | Medical / educational credentials | Prior express **written** consent (Art. 6 + Decree 1377 Art. 5) |

Documents themselves **never leave the titular's device** — only fingerprints + metadata are transmitted. See Arkova Constitution §1.6.

---

## 3. Purposes

Credential verification, anti-fraud detection, compliance reporting to the institutional customer, and platform security. Cross-border transfers to the United States are inherent to the service (described in §6).

---

## 4. Rights of the titular (Art. 8)

Titulars in Colombia have the following rights and may exercise them by email to `privacy@arkova.ai`:

- **Access / consult** their data held by Arkova.
- **Update / rectify** inaccurate, incomplete, or outdated data.
- **Request deletion** when processing lacks legal basis or consent is withdrawn.
- **Revoke consent** at any time (without retroactive effect).
- **Obtain proof** that consent was granted (when consent is the legal basis).
- **Be informed** of the use to which their data has been put.
- **Lodge a complaint** with the SIC.

Arkova responds to titular requests within **10 business days** (Art. 14), extendable by up to 5 additional business days with written notification.

---

## 5. Database registration (RNBD)

Arkova is in the process of registering the following personal data databases with the SIC's *Registro Nacional de Bases de Datos*:

| Database | Purpose | Est. titulars |
|----------|---------|---------------|
| `credential_metadata_col` | Credential records associated with Colombia-based titulars | TBD |
| `verification_events_col` | Audit-trail of who viewed/verified which credential | TBD |

Registration is mandatory within **2 months** of the database coming into operation (Decree 090 of 2018, as amended). Status: in progress with Colombian counsel.

- [ ] RNBD account created by appointed representative
- [ ] Two databases registered with SIC
- [ ] Annual update filed by end of Q1 each year

---

## 6. International data transfers

Arkova processes data in the United States. Under Colombia's adequacy regime (SIC *Circular Externa 005 of 2017* as updated in 2025), the **United States is on the SIC adequacy list**, which means Law 1581 cross-border transfer restrictions do not require additional contractual safeguards for US-destined transfers.

Arkova nevertheless applies the following safeguards as a matter of best practice:

- Model Contractual Clauses (SIC model published December 2025) for customer-to-processor relationships on request.
- Client-side processing (documents stay on device).
- AES-256 at rest + TLS 1.2+ in transit.
- RLS multi-tenant isolation at the database layer.

If the United States is removed from the SIC adequacy list, Arkova will execute the SIC Model Contractual Clauses and update this notice within 30 days.

---

## 7. Retention

Credential metadata is retained while the underlying organisation subscription is active + 7 years thereafter to satisfy audit-trail requirements. Titulars may request deletion earlier when there is no legal obligation to retain (Art. 11(d) + Decree 1377 Art. 11).

---

## 8. Security incidents

Arkova notifies the SIC of a personal data breach within **15 business days** of becoming aware, per SIC Circular 003 of 2018 (as updated).

Affected titulars are notified in the same timeframe when the breach is likely to result in material risk.

---

## 9. Contact

| Purpose | Contact |
|---------|---------|
| Data protection queries | `privacy@arkova.ai` |
| Arkova Colombian representative | To be appointed (see `docs/compliance/colombia/sic-registration.md`) |
| SIC (regulator) | https://www.sic.gov.co/ · +57 601 587 0000 · protecciondedatos@sic.gov.co |

---

## 10. Changes to this notice

Material changes are communicated via in-app notice + email at least 30 days before taking effect. The effective date at the top of this notice is always updated.
