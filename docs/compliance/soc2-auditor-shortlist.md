# SOC 2 Auditor Shortlist — Readiness Assessment

**Purpose:** Unblock SCRUM-522 ("Engage SOC 2 auditor for readiness assessment") with a structured shortlist instead of open-ended sales calls.
**Last updated:** 2026-04-17
**Baseline evidence:** `docs/compliance/soc2-evidence.md`, `docs/compliance/soc2-type2-evidence-matrix.md`, `docs/compliance/soc2-type2-decision.md`
**Decision owner:** Matthew (external owner) + Carson (final sign-off)
**Related:** depends on SCRUM-516 (framework selection — Type II confirmed)

---

## Hard requirements

| # | Requirement | Why |
|---|-------------|-----|
| R1 | AICPA-licensed CPA firm with active peer-review status | Statutory requirement to issue a SOC 2 report |
| R2 | Demonstrated experience auditing SaaS companies <100 employees | Ensures scope and evidence expectations match ours |
| R3 | Willing to run a readiness assessment *before* Type II observation window | Catches gaps early; cheaper than failing Type II |
| R4 | Uses an evidence-portal (Drata, Vanta, Hyperproof, Strike Graph, in-house) that can ingest our existing evidence layout | Avoids manual evidence re-keying |
| R5 | Named partner signs the report (not an anonymous manager) | Enterprise buyers check the signing partner |
| R6 | Willingness to sign our MSA + $5M E&O coverage | Standard compliance gate |

Firms that fail any row are filtered out before scoring.

---

## Scoring rubric (100 points)

| Dimension | Weight | What we measure |
|-----------|--------|-----------------|
| SaaS-specific depth | 25 | Number of annual SOC 2 engagements in SaaS; partner's CV |
| Control framework fit (Trust Services Criteria 2017 + 2022 update) | 15 | Specifically around CC7 (change mgmt), CC8 (risk mgmt), CC9 (vendor mgmt) |
| Readiness assessment quality | 15 | Deliverable format: gap report with OWNER + severity + target close date |
| Evidence-portal integration | 10 | Can we keep our evidence layout (`docs/compliance/*.md` + migration manifests) or do we re-build in their tool? |
| Turnaround | 10 | Readiness → 3 weeks; Type II window opens within 6 weeks of readiness close |
| Price | 10 | Readiness: $8–18K; Type II: $20–45K depending on scope |
| Continuity (will the same partner return for the annual Type II?) | 10 | Prevents re-audit-team overhead year-over-year |
| Communication cadence | 5 | Weekly status for the readiness window, daily during fieldwork |

Threshold for engagement: **≥75 / 100**.

---

## Candidate pool

Three firms to RFP. None selected — this is a starting set.

### 1. Prescient Assurance (US, ~$15K readiness + $30K Type II)

- **Strength:** SOC 2 factory; fast turnaround; integrates with Drata, Vanta, Hyperproof out of the box. Handles Type I→Type II transitions cleanly.
- **Gap:** Less customisation — best for shops that adopt their evidence format exactly.
- **Sample report:** request via sales.

### 2. A-LIGN (US, ~$20K readiness + $45K Type II)

- **Strength:** Larger firm, offers SOC 2 + ISO 27001 + HIPAA under one roof. Good if we want to stack frameworks in year 2 (CE+, ISO 27001).
- **Gap:** Pricing at top of our band; account-manager churn reported by peers.
- **Sample report:** available under NDA.

### 3. Johanson Group (US, ~$12K readiness + $28K Type II)

- **Strength:** Boutique; partner-signed reports; founder-friendly engagement model; responsive during evidence chase.
- **Gap:** Smaller bench — holiday / PTO risk on fieldwork timing.
- **Sample report:** Insist on an unredacted signed cover page to verify named partner.

Alternate / hold list (did not make the top three for the first round):
- Schellman — well-known but consistently 1.5–2× our pricing band for a ≤100-person SaaS.
- Dansa D'Arata Soucia (DDS) — strong on fintech; unknown track record outside BFSI.
- BARR Advisory — good; schedule historically 14–16 weeks out.

---

## RFP packet contents

1. `docs/compliance/soc2-evidence.md` (the current evidence index)
2. `docs/compliance/soc2-type2-evidence-matrix.md` (control-to-evidence mapping)
3. `docs/compliance/soc2-type2-decision.md` (the scope + framework decision memo)
4. Team size / employee-count / cloud-footprint one-pager
5. Pricing format: fixed-fee readiness; fixed-fee Type II with clear out-of-scope rates
6. Target timeline: readiness window close → Type II observation window opens immediately

## Evaluation timeline

| Milestone | Target date | Owner |
|-----------|-------------|-------|
| RFP sent to 3 firms | T+0 | Matthew |
| Proposals received | T+2 weeks | Matthew |
| Scoring + shortlist-of-one | T+3 weeks | Carson + Matthew |
| MSA + SOW signed | T+5 weeks | Counsel |
| Readiness kick-off | T+6 weeks | Auditor PM |
| Readiness gap report delivered | T+9 weeks | Auditor |
| Gap remediation | T+9 to T+13 weeks | Engineering |
| Type II observation window opens | T+14 weeks | Auditor |

## Exit criteria (SCRUM-522 = readiness only)

- Readiness SOW signed and uploaded to `docs/compliance/vendor-register.md`
- Gap report received; items added to `docs/BACKLOG.md` with owners + target close dates
- `docs/compliance/soc2-evidence.md` updated with auditor-requested evidence links

The Type II observation window itself is a follow-up epic (not this story).
