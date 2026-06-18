# S0-E7 — External-Gate Tracker (kickoff)

> **Sprint-0 deliverable S0-E7 / Story 7.1.** Status: **TRACKER DRAFTED — every kickoff ACTION (outreach, key moves) is GATED to Carson.** Retires risk **R-6** (external-gate slip).
> Facts sourced from the read-only Drive+Gmail sweep (S0-E2), 2026-06-17. This belongs on Confluence as the live tracker — propose creating it there on Carson's OK (Drive/Confluence writes are gated).

## The five long-lead gates

| Gate | Owner | Target / clock | Status (2026-06-17) | Next kickoff action (GATED) | Evidence |
|---|---|---|---|---|---|
| **CE key + sandbox** (Q1.9 / SCRUM-1867) | L3 + Biz (Carson ↔ Jeanne Kitchens / Jeff Grann) | **~Sept 2026** (trial-key expiry — the hard PI-1 clock) | Trial agreement **eSigned 2026-06-09**; **temporary keys LIVE**; permanent key + sandbox **PENDING** | (a) Move CE key → **Secret Manager** + rotation + named owner (S0-7.2); (b) request **permanent key + sandbox** from CE; (c) claims-review: no "listed in the Registry" claim | Jeanne email 2026-06-10 (`19eb16eb9378a212`); eSign complete (`19eac3785c69de8a`) |
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
- All kickoff actions above are **GATED** — this tracker arms the T-30 alarm (the L2 key-expiry dashboard, S0-5.1/VIS-01, will mechanize the CE-clock alert). Nothing was sent/moved this session.
