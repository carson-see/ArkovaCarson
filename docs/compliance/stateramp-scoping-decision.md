# StateRAMP — Scoping Decision

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson (CISO)
> **Jira:** SCRUM-983 (TRUST-15) | **Status:** CONDITIONAL — gated on public-sector revenue
> **Decision trigger:** ≥ $500k ARR from state/local government OR a state RFP requires it

---

## Purpose

StateRAMP is the state-government analog of FedRAMP — a standardized
security assessment + authorization program for cloud services sold
to US state + local governments. Some states (Texas, Arizona, Colorado,
Illinois) now require StateRAMP for vendors above certain data-
sensitivity thresholds.

This is a **scoping decision** document. Like HITRUST (SCRUM-982), we
defer until a revenue trigger fires, but prepare pre-work so we can
move fast if/when it does.

## How to use this document

1. Section 2 explains why we're deferring.
2. Section 3 is the go/no-go triggers.
3. Section 4 lists the small amount of pre-work worth doing now.
4. Section 5 is the cost model if triggered.

## 1. What StateRAMP entails

- **Three impact levels:** Low, Moderate, High. Driven by FIPS 199
  categorization of the data being processed.
- **Low** — most likely level for Arkova given no PII beyond auth
  emails + client-side-only document processing. Still ~$50k cost.
- **Moderate** — if we accept CJI (criminal justice info) or regulated
  government data server-side. Not our path today.
- **Assessment:** performed by a **3PAO** (third-party assessment org),
  same vendor pool as FedRAMP (Coalfire, A-LIGN, Schellman, etc.).
- **Reciprocity:** a FedRAMP authorization is almost always accepted
  for StateRAMP — but the reverse is not true. If we ever have federal
  ambitions, go FedRAMP directly.
- **Timeline:** 6-12 months from kickoff to authorization.
- **Cost:** $50k-$150k for Low-level assessment + ~$30k/yr ongoing
  monitoring.

## 2. Why we're NOT starting yet

- **Zero state/local government revenue today.** Arkova's TAM today
  is credential verification for private-sector hiring + compliance —
  state government is a Year-2+ TAM expansion.
- **Client-side-only architecture** means data residency + boundary
  questions largely resolve themselves — we may be scoped very
  narrowly by a 3PAO. But pre-engagement is still ~$10k.
- **Procurement is years-long.** State government deals have 6-18
  month sales cycles; we'd see the RFP long before the certification
  gate bites.
- **Cost-benefit:** StateRAMP at ~$50k Year-1 + $30k/yr recurring is
  worse ROI than the same dollars spent on SOC 2 Type II + ISO 27001,
  which unlock private-sector revenue today.

## 3. Go/no-go triggers

Pursue StateRAMP IF:

- [ ] **Revenue trigger:** ≥ $500k ARR from state / local government
  customers. At $500k ARR, a single lost procurement deal is
  cheaper than the certification.
- [ ] **RFP trigger:** a state RFP explicitly requires StateRAMP
  authorization AND the deal size is ≥ $250k ACV. Sub-$250k state
  deals rarely justify even the Low-level cost.
- [ ] **Strategic partner trigger:** a major StateRAMP-certified
  reseller (e.g. Carahsoft, SHI) wants to co-list us — they usually
  co-fund or bear part of the assessment cost.
- [ ] **Adjacent-market expansion:** if we launch a
  government-adjacent product (e.g. credential verification for
  public-university transfer programs) that naturally crosses the
  state-data threshold.

Do NOT pursue StateRAMP because:
- A single state RFP in Section 3 of its requirements "prefers" it.
- Broad "trust signal" reasons — FedRAMP > StateRAMP for brand, and
  SOC 2 Type II > StateRAMP for outside of US state/local market.

## 4. Pre-scope preparation (do NOW)

Small pre-work items that pay off if a trigger fires:

- [ ] Maintain FIPS 199 data categorization decision in the
  `data-classification.md` doc. Update if architecture changes.
- [ ] Keep data-residency option open — current stack (GCP
  us-central1 + CF + Supabase us-east) is acceptable for Low-level
  StateRAMP but would need adjustment for Moderate.
- [ ] Shortlist 3 3PAOs familiar with cloud-native SaaS (Coalfire,
  A-LIGN, Schellman). Relationship check annually.
- [ ] When SOC 2 Type II + ISO 27001 evidence is mapped, ALSO
  crosswalk to NIST 800-53 Rev 5 baselines (StateRAMP reuses those).
  Mapping effort ~10% of the SOC 2 evidence work.
- [ ] Monitor the StateRAMP Authorized Product List quarterly to see
  which direct competitors appear.

## 5. Cost model (if triggered)

### Low-level authorization

| Phase | Cost |
|-------|------|
| 3PAO pre-engagement + scoping | $8k - $12k |
| FIPS 199 categorization + PTA | $3k - $5k |
| Readiness assessment + gap closure | ~$25k (engineering time) |
| Formal 3PAO assessment | $40k - $70k |
| Authorization sponsorship (state agency) | $0 - $20k (agency-dependent) |
| Annual continuous-monitoring | $20k - $30k/yr |
| **Year-1 all-in** | **~$80k - $140k** |

### Moderate-level authorization

Roughly 2-3× the Low cost. Only pursue if actively displacing a
Moderate-certified incumbent.

## 6. Alternative paths

- **Stay out of StateRAMP** and target federal/state sub-contracting
  via primes that already hold the authorization.
- **Obtain a state-specific authorization** (e.g. Texas DIR, California
  CDT) as a cheaper first step. Some states accept alternative
  attestations.
- **Pursue FedRAMP Low** instead — slightly more expensive but
  federal + state reciprocity. Only worth it if federal + state
  revenue is simultaneously in play.

## 7. Decision log

| Date | Decision | Trigger |
|------|----------|---------|
| 2026-04-21 | DEFER — conditional on Section 3 triggers | No state/local government revenue yet |

## 8. Cross-links

- `data-classification.md` — FIPS 199 foundational doc.
- `iso27001-implementation-roadmap.md` — core framework that maps
  heavily to NIST 800-53 + StateRAMP.
- `hitrust-i1-scoping-decision.md` (SCRUM-982) — parallel deferred
  decision for the healthcare vertical.
- `disaster-recovery.md` — covers BCP/DR which StateRAMP cares about.

## 9. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial scoping decision (SCRUM-983 TRUST-15). |
