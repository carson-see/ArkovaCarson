# HITRUST i1 — Scoping Decision

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson (CISO)
> **Jira:** SCRUM-982 (TRUST-14) | **Status:** CONDITIONAL — gated on healthcare-vertical revenue
> **Decision trigger:** ≥ $500k ARR from healthcare customers OR first enterprise hospital deal

---

## Purpose

HITRUST is the US healthcare industry's dominant compliance framework
— not legally required, but procurement-gating for most hospital
systems, payers, and large health-tech vendors. **HITRUST i1** is the
"implemented" mid-tier certification (1-year validity) that sits
between the self-attestation e1 tier and the full r2 (2-year)
certification.

This document is a **scoping decision doc**, NOT an execution runbook.
The engineering question it answers: **should we pursue HITRUST i1 in
the next 18 months, or defer**? With a trigger-condition for
reversal.

## How to use this document

1. Read Section 2 — current state + why we're not starting yet.
2. Section 3 is the go/no-go trigger conditions.
3. When a trigger fires, flip this ticket from CONDITIONAL to ACTIVE
   and write a follow-up execution runbook.
4. Re-evaluate quarterly at the CISO review.

## 1. What HITRUST i1 entails

- **Framework:** HITRUST CSF v11 (latest), which is itself a meta-framework
  that maps HIPAA + NIST 800-53 + ISO 27001 + 27002 + PCI + HITECH
  into one control set.
- **Scope:** All systems handling PHI. For Arkova this would be the
  full stack (frontend, worker, edge, Supabase) IF we accept PHI
  server-side — which today we do NOT (Constitution 1.6 keeps all
  documents client-side). This is material: HITRUST may narrow our
  scope dramatically because we don't store PHI.
- **Assessment:** ~60-80 control families, verified by an external
  HITRUST Authorized External Assessor (AEA).
- **Cost:** $40k-$80k for i1 + $20k-$40k annual renewal. r2 is
  $80k-$180k — probably Year-3 conversation.
- **Timeline:** 4-6 months from kickoff to certificate.

## 2. Current state — why we're NOT starting yet

- **Zero healthcare customer revenue today.** Our HIPAA work
  (BAA template, PHI procedures) is speculative infrastructure, not
  revenue-driven.
- **Client-side-only architecture** means we do not store PHI
  server-side. HITRUST MAY reduce scope dramatically (or conclude
  we're out of scope entirely), but that determination itself costs
  ~$10k in pre-engagement scoping.
- **SOC 2 Type II + HIPAA BAA template** covers most healthcare-
  adjacent sales questions for SMB deals. Enterprise hospital deals
  are the ones that hard-gate on HITRUST.
- **Opportunity cost:** engineering + CISO bandwidth is fully
  committed Q2-Q4 2026 on SOC 2 + ISO 27001 + CE+ + DPF. Adding
  HITRUST would mean sliding one of those.

## 3. Go/no-go triggers

Pursue HITRUST i1 IF any of these fire:

- [ ] **Revenue trigger:** ≥ $500k ARR from healthcare customers
  (hospitals, payers, large health-tech) — this is the point where
  a single lost procurement gate costs more than the certification.
- [ ] **First enterprise hospital deal:** a hospital system or payer
  asks for HITRUST in their RFP AND the deal size is ≥ $100k ACV.
- [ ] **Competitive gap signal:** a direct competitor publishes a
  HITRUST certification and starts winning healthcare deals against
  us on trust-signal grounds (tracked via competitive intel review
  at the CISO quarterly).
- [ ] **Regulatory trigger:** OCR changes the HIPAA breach-notification
  rule or adds a "reasonable safeguards" expectation that a HITRUST
  cert specifically addresses.

Do NOT pursue HITRUST because:
- An SMB healthcare customer "would like to see" it. The BAA template
  + SOC 2 Type II + a honest "HITRUST scoping in progress once
  revenue justifies" answer handles that pipeline today.
- It's a general-purpose trust signal. ISO 27001 + SOC 2 Type II
  outperforms HITRUST outside of healthcare, which is ~95% of our
  current TAM.

## 4. Pre-scope preparation (do NOW, even while deferring)

A small amount of pre-work lets us move fast if a trigger fires:

- [ ] Keep the HIPAA BAA template current
  (`docs/compliance/hipaa-baa-template.md`).
- [ ] Track: HITRUST AEAs who have PHI-not-stored scoping experience.
  Shortlist 3 (Coalfire, A-LIGN, Schellman).
- [ ] When the ISO 27001 CCM + SOC 2 controls are mapped (SCRUM-968
  STAR Level 2 work), ALSO cross-walk to HITRUST CSF so we have the
  evidence mapping ready.
- [ ] Keep `audit_events` retention long enough (7 years for HIPAA
  events vs 3 years for SOC 2 — Constitution 1.5 timestamp policy).

## 5. Cost model (if a trigger fires)

| Phase | Cost |
|-------|------|
| AEA pre-engagement scoping | $5k - $10k |
| i1 full assessment (Year 1) | $40k - $80k |
| Gap remediation engineering time | ~$30k opportunity cost |
| Annual renewal (Year 2+) | $20k - $40k/yr |
| **Year-1 all-in** | **~$80k - $120k** |

## 6. Alternative paths

- **Stay out of HITRUST entirely** and use SOC 2 Type II + HIPAA BAA +
  a pointed "PHI never stored server-side" architectural claim.
  Valid for all SMB + mid-market healthcare.
- **Pursue HITRUST e1** (self-attestation tier) if triggered by a
  customer ask but the deal is < $100k. $5k-$10k; validates for 1
  year; non-blocking procurement signal.
- **Pursue HITRUST r2** (top tier) only if an existing i1 is no
  longer sufficient — this is Year-3+ territory.

## 7. Decision log

| Date | Decision | Trigger |
|------|----------|---------|
| 2026-04-21 | DEFER — conditional on triggers in Section 3 | No healthcare-vertical revenue yet |

## 8. Cross-links

- `docs/compliance/hipaa-baa-template.md` — existing HIPAA scaffolding.
- `docs/compliance/csa-star-level2-upgrade-plan.md` (SCRUM-968) —
  parallel decision path for cross-framework mapping.
- `iso27001-implementation-roadmap.md` — core framework that HITRUST
  would build on.

## 9. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial scoping decision (SCRUM-982 TRUST-14). |
