# CSA STAR Level 2 — Upgrade Plan

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson (CISO)
> **Jira:** SCRUM-968 (TRUST-11) | **Depends on:** SCRUM-960 (L1 live) + SCRUM-966 (ISO 27001 cert)
> **Target listing:** 2027-Q4 (after ISO 27001 Stage 2 passes)

---

## Purpose

SCRUM-960 (TRUST-02) gets us on the CSA STAR registry at Level 1 —
self-assessed. Level 2 requires **third-party attestation** and
usually piggybacks on an existing ISO 27001 or SOC 2 audit. This doc
sequences the L2 upgrade so it reuses the SOC 2 + ISO 27001 work
already in flight, rather than commissioning a standalone STAR audit.

## How to use this document

1. Do not start until **both** SOC 2 Type II (SCRUM-979) AND ISO 27001
   (SCRUM-966) are done. STAR L2 reuses their evidence; starting
   early duplicates effort.
2. Section 3 explains the two L2 paths — pick one.
3. Section 4 is the execution sequence.
4. Section 5 sets expectations with procurement teams about what
   L2 buys us vs L1.

## 1. STAR tier map

| Tier | Assessment mechanism | Cost | Value to procurement |
|------|----------------------|------|----------------------|
| **Level 1 — Self-Assessment** | We answer CAIQ ourselves, publish on registry | $0 (we're a CSA member) | "They have a documented security posture" |
| **Level 2 — Third-party Audit** | Auditor verifies CAIQ answers + CCM evidence | ~$10k incremental over SOC 2 | "They have an independent attestation" |
| **Level 3 — Continuous Monitoring** | Real-time CloudTrail / equivalent feed | ~$40k/yr + infra | Niche; mostly hyperscalers |

Level 3 is overkill for Arkova's stage. Level 2 is the sweet spot.

## 2. Two Level 2 paths

### Path A — STAR Attestation (SOC 2-aligned)

- Maps CSA CCM controls to SOC 2 Type II evidence.
- Same auditor issues both reports in one engagement.
- Cheapest path; most US-centric.
- Appears on registry with the attestation report publicly downloadable.

### Path B — STAR Certification (ISO 27001-aligned)

- Maps CSA CCM controls to ISO 27001 Annex A + 27002 guidance.
- Certification body that issues 27001 can also issue STAR Cert.
- More EU-recognized; preferred by European enterprise.

**Recommendation:** pursue **BOTH** since we're doing both underlying
audits. STAR Registry shows "Attestation + Certification" as two
separate listings on the same org record — maximum trust-signal
surface area.

## 3. Prerequisites (must be true before L2 kickoff)

- [ ] CSA STAR L1 live and current (SCRUM-960).
- [ ] SOC 2 Type II report delivered (SCRUM-979, target 2027-02-28).
- [ ] ISO 27001 Stage 2 passed (SCRUM-966, target 2027-09-01).
- [ ] CCM v4 Control Applicability Matrix updated with evidence
  pointers to either SOC 2 or ISO control test results.

## 4. Execution steps

### Step 1 — Mapping phase (2027-10-01 → 2027-10-31)

CISO builds the CCM-to-SOC2 + CCM-to-ISO crosswalk:

- Download CSA CCM v4 control spreadsheet.
- Column A = CCM ID, Column B = SOC 2 TSC + control, Column C =
  ISO 27001 Annex A control, Column D = evidence path.
- Typical mapping success rate: ~95% of CCM controls map to at least
  one framework we already have.
- The remaining ~5% are CSA-unique (typically around cloud-specific
  data residency / supply-chain attestation). File new stories for
  gap closure.

### Step 2 — Auditor engagement (2027-11-01 → 2027-11-30)

For Path A (Attestation):
- Contract the SOC 2 auditor for the STAR add-on. Typically $8-12k.

For Path B (Certification):
- Contract the ISO 27001 certification body for the STAR add-on.
  Typically $10-15k.

Both can be quoted as part of the Year-2 audit renewal to minimize
back-and-forth.

### Step 3 — Attestation + Certification audits (2027-12-01 → 2028-01-31)

Auditors pull SOC 2 / ISO evidence + verify CCM answers match
observed controls. Minimal new evidence requested because the audit
windows overlap.

### Step 4 — Registry upload (2028-02-15)

- Auditor issues attestation letter + CSA-registry-ready packet.
- Submit via the CSA portal (same account as L1).
- L2 listings take ~5 business days to go live.
- Update the public URL in `complianceMapping.ts` + marketing page.

## 5. Value vs cost summary

| Lever | L1 | L2 |
|-------|-----|-----|
| Annual cost | $0 | ~$10k incremental |
| Procurement-blocking strength | Low (self-assessed) | Medium-High (attested) |
| Listing visibility | Text search only | Promoted in CSA registry + downloadable report |
| Renewal cadence | Annual | Annual |

L2 is worth the $10k once enterprise revenue is > ~$500k/yr — by which
point a single lost procurement deal would cover it. Until then, L1 is
enough.

## 6. Risk register

- **Risk:** SOC 2 Type II slips past 2027-02-28.
  **Mitigation:** L2 slips by the same delta; no independent work
  required since we're piggybacking.
- **Risk:** CSA releases CCM v5 between our audit and the L2 submission.
  **Mitigation:** L2 remains valid under v4 for the 12-month cycle;
  upgrade to v5 at annual renewal.
- **Risk:** Registry URL changes if CSA restructures.
  **Mitigation:** Always serve a 302 on `arkova.ai/trust/csa-star` so
  the outbound link survives their backend changes.

## 7. Cross-links

- `csa-star-caiq-self-assessment.md` — L1 CAIQ.
- `csa-star-submission-runbook.md` (SCRUM-960) — L1 execution.
- `soc2-type2-audit-execution-runbook.md` (SCRUM-979) — Path A source.
- `iso27001-implementation-roadmap.md` (SCRUM-966) — Path B source.

## 8. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial upgrade plan (SCRUM-968 TRUST-11). |
