# S0-E7 — External-Gate Tracker (kickoff)

> **Sprint-0 deliverable S0-E7 / Story 7.1.** Historical tracker reconciled 2026-07-13. External partner sends and the HakiChain LOI signature are founder-reserved; technical decisions route to the CTO, and live changes require an approved operator. This tracker authorizes none of them. Retires risk **R-6** (external-gate slip).
> Original facts came from the read-only Drive+Gmail sweep (S0-E2), 2026-06-17; the CE row was reconciled against the 2026-06-24 response on 2026-07-13. Confluence remains canonical, but no Drive or Confluence write occurred in this reconciliation.

## The five long-lead gates

| Gate | Owner | Target / clock | Status / last evidence | Next kickoff action (GATED) | Evidence |
|---|---|---|---|---|---|
| **CE evaluation continuation** (Q1.9 / SCRUM-1867) | L3 technical owner + Biz partner contact (Jeanne Kitchens / Jeff Grann) | **2026-09-09** (date confirmed; exact expiry instant/timezone unknown) | Trial agreement completed **2026-06-09**. CE replied **2026-06-24**: sandbox copy/invite sent; Developer Agreement + annual support tier is the continuation path. Invite receipt/acceptance, usable sandbox access, selected tier, activation lead time, and exact expiry instant remain unverified. | Prepare the new **UNSENT** continuation packet; confirm agreement/tier decision deadline, activation lead time, exact expiry timestamp, and July follow-up. Do not repeat the answered sandbox/date request. Keep “listed in the Registry” and live-publishing claims prohibited. | CE shared notes Google Doc `17IxHYJ6zvDm0vWGkP6swTYRajo-2Ycrltlo52P-oRSA`; current draft `docs/lane3/s33-ce-escalation-send-packet-draft.md` |
| **Google CASA** | CTO + L3 | before drive.readonly GA (Q3.4) | **NOT STARTED** — zero outreach found | Scope CASA assessor + book the security assessment (gates Drive restricted-scope GA) | none (empty Gmail search) |
| **SOC 2 Type II auditor** (Q2.1 / SCRUM-1043) | CTO + L1 | observation window start S6/S7 | Readiness-only — advisor **Matthew Webster (Cyvergence)** doing architecture/BIA; **auditor NOT engaged** | Solicit 2–3 auditor quotes; pick a firm; set observation-window start date | Webster threads (`19e7493e…`, `19e427cb…`) |
| **FCRA counsel** (SCRUM-883, gates Q4.1 NVI) | CPO (Carson) | before any NVI/background-screening feature | **Needs Human** — Foley & Lardner **privacy** intro held 2026-06-02/03 (Peter Stockburger), **not FCRA-specific** | Confirm FCRA scope with counsel (or engage FCRA-specialist) | Foley thread (`19e8572e…`), notes doc `11T8N1U…` |
| **Kenya / EAC counsel** (Q1.10 / SCRUM-1010) | L3 + Biz | before Kenya GA references | **NOT engaged Arkova-side** — cross-border flag raised to HakiChain (their DPO to review their side) | Retain Kenya counsel for cross-border/DPA (Supabase us-east-2 + GCP us-central1 → SCC + transfer-impact vs Kenya DPA/ODPC) | HakiChain Legal/Ops thread (`19e8972a…`, 2026-06-04) |

## Lane-1 technical contact (the input S0-E7 needs from Lane 1)

Lane 1 supplies the **chain/security technical contact** for the gates that touch its surfaces:

- **SOC 2 (Q2.1)** + **Security hardening (Q2.2)** + **Secret-Manager/IAM**: Lane-1 **Bitcoin Dev / Architect / Security** persona. Provides: the chain key-custody story (WIF in Secret Manager is the active signer; KMS path exists), RLS/`FORCE ROW LEVEL SECURITY` posture (prod 107/107 verified), SECURITY DEFINER `search_path` hygiene, and the §1.6 client-side-processing privacy boundary as a control narrative.
- **CE key → Secret Manager (S0-7.2)**: Lane 1 owns the broader Secret-Manager/IAM hardening; the CE key entry is **coordinated via handoff** — Lane 3 owns the CE relationship, Lane 1 advises on the Secret-Manager custody pattern + rotation.

## Notes

- **Adjacent (not one of the five):** AUDD grant (Australian fintech) application in progress — track separately, not a launch gate.
- **CSA STAR L1** (separate from CASA/SOC2): 197-control CAIQ pack, prod 107/107 RLS verified, awaiting CEO review → submit (v2 sheets regenerated 2026-06-17). CSA STAR **L2** is the Q2.6 roadmap epic (SCRUM-712).
- The CE date is known, but the time/timezone is not. Any T-30 alert must preserve that uncertainty until CE supplies an exact expiry instant.
- External partner sends and the HakiChain LOI signature are founder-reserved. Technical/claims decisions route to the CTO; this tracker does not make or delegate live changes.
- Nothing was sent, signed, moved, or changed in partner/live systems by the 2026-07-13 documentation reconciliation.
