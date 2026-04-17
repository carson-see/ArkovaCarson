# Kenya DPIA — DPO Review Checklist

**Jira:** [SCRUM-577 / REG-16](https://arkova.atlassian.net/browse/SCRUM-577)
**Last updated:** 2026-04-17
**Owner:** DPO (to be designated per `filing-checklist.md` §DPO prerequisite) + Kenyan counsel
**DPIA under review:** [docs/compliance/kenya/dpia.md](./dpia.md) (v0.1, 2026-04-17)
**Statutory basis:** Kenya DPA 2019 Sections 25, 31, 41, 48

---

## How to use this document

v0.1 of the DPIA was engineered by the platform team; it's a complete draft covering all statutory DPIA elements (scope, processing operations, 10-item risk register, lawful basis, cross-border transfer, mitigations). What remains is DPO + counsel review, which produces v0.2.

Five concrete steps for the reviewer:

1. **Read** [docs/compliance/kenya/dpia.md](./dpia.md) end-to-end before starting this checklist.
2. **Walk the 9 sections** of the checklist below; annotate disagreements inline on a PR against `dpia.md` so history is preserved.
3. **Score the 10-item risk register** — flag any item where the DPO's residual-risk assessment differs from v0.1's.
4. **Decide submission** — if residual risk is **High** post-mitigation on any row, DPA Section 31(4) requires consultation with the ODPC *before* processing begins. The DPO flags this in writing.
5. **Publish v0.2** — merge revised doc; transition SCRUM-577 Blocked → Done (if no ODPC consultation required) or Blocked (if consultation required — SCRUM-577 stays open until consultation closes).

---

## 1. Scope (DPIA §1)

- [ ] Processing activities enumerated: credential anchoring, verification API responses, Nessie intelligence queries, pipeline public-record fetching.
- [ ] **Check:** Are there any Kenyan-customer-specific flows not listed?
- [ ] **Check:** Is ATS / background-check customer scope addressed?
- [ ] DPO signs off on scope completeness.

## 2. Categories of data subjects (DPIA §2)

- [ ] Students (education credentials).
- [ ] Patients (health credentials — HIPAA + KMPDC).
- [ ] Employees (background checks).
- [ ] Professionals (license verification).
- [ ] **Check:** Are minors (under 18) processed? If yes, Section 33 special-category consent rules kick in.

## 3. Lawful basis (Section 25 — DPIA §3)

- [ ] Consent via institutional customer is primary basis.
- [ ] Legitimate interest as secondary basis for record-fingerprinting (anchoring) — flag for DPO: is the balancing test documented?
- [ ] **Check:** Is there an explicit data-subject right to object documented?
- [ ] **Check:** For sensitive personal data (Section 2), is explicit consent captured at the institutional-customer level?

## 4. Data minimisation (Section 26(1)(c) — DPIA §4)

- [ ] Client-side processing boundary: documents never leave the user's device. DPO confirms this is materially reflected in DPIA.
- [ ] Only fingerprint + PII-stripped metadata is transmitted.
- [ ] **Check:** Is the PII-stripping algorithm in `src/lib/*` audited for false negatives?
- [ ] **Check:** Is retention minimised per Section 26(1)(e)? Cross-reference `docs/compliance/data-retention-policy.md`.

## 5. Cross-border transfer (Section 48 — DPIA §5)

- [ ] Destinations: US (primary), EU (backup region), UK (backup).
- [ ] Basis: Standard Contractual Clauses (SCCs); cross-referenced in `docs/compliance/scc/`.
- [ ] Adequacy: US has no Kenya adequacy decision; SCCs are the operative basis.
- [ ] **Check:** If EU-to-Kenya access paths exist (e.g., Arkova EU-region employee accessing Kenyan record), Section 48 applies in reverse — is that documented?
- [ ] **Check:** Does the DPIA cover Section 49 derogations (explicit consent, contractual necessity)?

## 6. Security measures (Section 41 — DPIA §6)

- [ ] SOC 2 controls referenced (CC6-CC8).
- [ ] Encryption at rest (KMS) + in transit (TLS) documented.
- [ ] RLS + `FORCE ROW LEVEL SECURITY` on every table referenced.
- [ ] Client-side fingerprinting reduces the attack surface.
- [ ] **Check:** Is the Bitcoin anchor chain analysis included as a security measure (tamper-evidence, not confidentiality)?

## 7. Data subject rights (Sections 26, 31-38 — DPIA §7)

- [ ] Right of access, rectification, erasure, restriction, portability, objection, not-to-be-subject-to-automated-decision-making.
- [ ] **Check:** Is the response-time commitment consistent with the statutory maximum (Section 26 — reasonable and prompt, at most 30 days)?
- [ ] **Check:** Is the subject notified about the chain-immutability limit on erasure? (Fingerprints on Bitcoin cannot be erased; only the link from fingerprint → identity can.) This is a material disclosure.

## 8. Risk register (10 items — DPIA §8)

For each row of the risk register:

- [ ] Likelihood (1-5) calibrated against our actual incident history.
- [ ] Impact (1-5) calibrated against penalty + reputational exposure.
- [ ] Residual risk **post-mitigation** stated.
- [ ] Any residual risk that is **High** triggers Section 31(4) ODPC consultation.

DPO's specific scoring questions to address during review:

| Risk # | Question DPO should answer |
|--------|---------------------------|
| 1 | Unauthorised access to anchoring fingerprints — is the residual risk genuinely Low given RLS + KMS, or does DPO estimate higher? |
| 2 | Linkability of pseudonymised fingerprints to subjects — is the risk Low given fingerprint-only transmission? |
| 3 | Cross-border transfer failure (US legal-process request) — is the SCC-only basis enough, or should we add EU-US DPF certification? |
| 4 | AI model over-extraction — is Gemini v5-reasoning's behaviour documented? |
| 5 | Institutional-customer insider threat — do RLS + audit events detect + prevent? |
| 6 | Chain-immutability + subject erasure conflict — is the disclosure to subjects clear enough? |
| 7 | Breach notification within 72 hours — is the SRE runbook tested? |
| 8 | Cross-regulation conflict (FERPA / HIPAA / FCRA overlay on Kenya DPA) — does DPIA address this? |
| 9 | Retention-policy drift between `retention` table and actual DB rows — is this audited? |
| 10 | Public-record pipeline over-fetch — are Kenyan subjects affected? |

## 9. Statutory conclusion

- [ ] DPO issues a written sign-off that the DPIA meets Section 31 requirements, OR
- [ ] DPO issues a written recommendation that ODPC consultation under Section 31(4) is required (attach DPO's residual-risk scoring).

---

## Post-review engineering follow-up

Even without a full v0.2 content change, the following may surface:

- If DPO asks for risk-register reshape: edit `dpia.md` §8; commit as v0.2.
- If DPO requires a specific disclosure in the privacy notice: edit `privacy-notice.md`.
- If DPO asks for a Kenyan subject-rights portal, that's a **new story** (scope creep) — do not bolt into this story; spawn SCRUM-xxx in BACKLOG.md.

---

## Manual-followup email (per CLAUDE.md)

DPO sends `carson@arkova.ai`:
- Review completion date + v0.2 PR link.
- Whether Section 31(4) ODPC consultation is required.
- If new stories surfaced, a list of proposed Jira tickets.

---

## Definition of Done for SCRUM-577

- [ ] DPO walked all 9 checklist sections.
- [ ] v0.2 of `dpia.md` published.
- [ ] If residual risk is High on any row, ODPC Section 31(4) consultation initiated (separate ticket).
- [ ] v0.2 cross-linked from `README.md` and `odpc-registration.md`.
- [ ] SCRUM-577 transitioned Blocked → Done (or held Blocked if ODPC consultation is required).
