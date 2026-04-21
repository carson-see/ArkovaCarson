# ISO 27001:2022 — Implementation Roadmap

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson (CISO)
> **Jira:** SCRUM-966 (TRUST-09) | **Pairs with:** `iso27001-gap-to-action-plan.md`
> **Target certificate:** 2027-10-15 (18 months out)

---

## Purpose

TRUST-08 (`iso27001-gap-to-action-plan.md`) names every gap and an
external consultant. This doc is the **18-month quarterly roadmap**
that sequences those gaps into something a one-person CISO team can
actually run while SOC 2 Type II and the 13 regulatory frameworks are
also in flight.

## How to use this document

- Read Section 2 for the Q-by-Q milestones. Each row has exit
  criteria.
- At the end of each quarter, the CISO runs Section 3 (quarterly
  review) and flips the "next quarter" status.
- Section 4 is the risk log — items that could blow the 2027-10 date.
- Section 5 is the budget commitment.

## 1. Dependencies outside this roadmap

- **SOC 2 Type II report** (SCRUM-979) must land by 2027-02-28 — the
  ISO audit reuses 85% of that evidence.
- **Drata** (SCRUM-964) must be live and feeding evidence from
  2026-05-20.
- **CREST pentest** (SCRUM-962) must have current retest within 90
  days of Stage 2 audit (2027-09-01).
- **Cyber insurance** (SCRUM-961) must be bound before certificate
  issuance.
- **CSA STAR L1 + L2** (SCRUM-960 / SCRUM-968) — L2 is the "third-party
  audited" STAR tier that usually leverages ISO 27001 certification,
  so they are complementary. L1 ships first; L2 builds on ISO.

## 2. Quarterly roadmap

| Quarter | Focus | Exit criteria |
|---------|-------|---------------|
| **Q2 2026** (Apr-Jun) | SOC 2 observation window opens (2026-06-01). ISO work in planning only. | Consultant shortlist ready; no ISO ticketed work that would distract from SOC 2. |
| **Q3 2026** (Jul-Sep) | Consultant sprint (10 days); SoA + ISMS manual draft; risk treatment plan. | SoA v1 + ISMS manual v1 on file. |
| **Q4 2026** (Oct-Dec) | Operationalize the ISMS. First internal audit cycle runs. Management review #1 lands. | Internal audit report on file; mgmt review minutes signed. |
| **Q1 2027** (Jan-Mar) | Second internal audit + management review #2. Certification body selected + pre-audit engagement. | Stage-1 booking confirmed with BSI or A-LIGN. |
| **Q2 2027** (Apr-Jun) | Stage 1 audit (documentation review). Remediation of any Stage 1 findings. | Stage 1 report "no major findings" or remediations closed within 30 days. |
| **Q3 2027** (Jul-Sep) | Stage 2 audit (implementation review). Final remediation. | Stage 2 pass; recommend-for-certification letter in hand. |
| **Q4 2027** (Oct) | Certificate issued. Launch announcement + marketing update. | Certificate PDF filed; compliance dashboard badge live. |

## 3. Quarterly review checklist

Run at the close of every quarter (Mar-31, Jun-30, Sep-30, Dec-31):

- [ ] Milestones from Section 2 column 3 checked off?
- [ ] Evidence from the quarter filed into
  `docs/compliance/evidence-binder/YYYY-QN/`?
- [ ] ISMS manual, SoA, risk register, corrective-action log current?
- [ ] KPIs measured against ISMS objectives?
- [ ] Any risks in Section 4 triggered — escalation needed?
- [ ] Jira ticket status reflects reality (no stalls > 1 quarter)?

## 4. Risk log

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Consultant engagement slips past 2026-07-01 | Med | High (pushes cert by 1 quarter) | Shortlist 3 consultants in Q2 so one can fill in. |
| SOC 2 Type II exceptions drag into Q1 2027 remediation | Med | Med | Day-90 self-assessment (SCRUM-959) catches early. |
| Internal audit #1 surfaces major nonconformity | Low-Med | High | Mgmt review fast-track; time-boxed 30-day remediation SLA. |
| Certification body changes pricing or availability | Low | Med | Shortlist BSI + A-LIGN + Schellman; decision Q1 2027. |
| 27701 privacy extension scope creep (SCRUM-967) | Low | Low | 27701 handled as a separate certification; only overlap is the ISMS. |
| Key personnel departure mid-roadmap | Low | High | Consultant relationship preserved so knowledge isn't solely in-house. |

## 5. Budget (18-month total)

| Line item | Budget |
|-----------|--------|
| ISO consultant (Q3 2026 sprint + ad-hoc) | $15,000 |
| Stage 1 audit (documentation) | $12,000 |
| Stage 2 audit (implementation) | $20,000 |
| Annual surveillance audits (years 2 + 3) | $10,000/yr |
| CISO time (30% of role × 18 months) | ~$90,000 opportunity cost |
| Drata / evidence automation | Shared with TRUST-06 |
| **Year-1 all-in external spend** | **~$47,000** |

Funding: split across Year-1 and Year-2 TRUST budget lines.

## 6. KPIs

Baseline at 2026-06-01; re-measured quarterly.

| KPI | Baseline | Target at Stage 2 |
|-----|----------|--------------------|
| % of Annex A controls with evidence | 85% (via SOC 2) | 100% |
| Internal audit findings closed within SLA | — | ≥ 90% |
| Management review cadence adherence | — | 100% (quarterly) |
| Security training completion | 100% at SOC 2 close | Maintain 100% |
| Exception remediation median days | — | < 30 days |

## 7. Escalation + reporting

- **Carson (CEO)**: monthly update; quarterly KPI dashboard.
- **Board**: quarterly ISMS review (required by ISO).
- **External auditor**: communication via secure portal; minimum
  monthly status during fieldwork.

## 8. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial roadmap (SCRUM-966 TRUST-09). |
