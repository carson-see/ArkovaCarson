---
name: nvi-lawyer-scope
description: FCRA / NVI lawyer gate is narrow — it blocks only the attorney-reviewed FCRA gold benchmark + scenario sign-off. It does NOT block the rest of NVI engineering or any of the non-FCRA epics (NTF/NDD/KAU/NCX/CONT/FEDCONT/GME3/4/10/11). Past blanket-blocks were wrong.
type: feedback
---

The FCRA-NVI lawyer gate (SCRUM-804) is narrowly scoped. Treat it as a gate on **two specific deliverables only**:

1. The professional FCRA gold-standard benchmark (50 attorney-reviewed questions).
2. The attorney sign-off on flagged training scenarios.

Everything else under SCRUM-804 — statute / case-law / agency-bulletin / state-statute validators, chain-of-thought retrofit, Claude Opus distillation, multi-turn / doc-grounded / adversarial scenario authoring, LLM-as-judge benchmark runner, production canary, HIPAA + FERPA audit/quarantine — is engineering/ML work that does **not** need a lawyer.

**Why:** Reading SCRUM-804's description carefully, the only AC items that involve external counsel are the gold benchmark creation ($1k–2k) and scenario review ($2k–5k). The rest of the work uses public primary sources (Cornell LII, DoJ USCode, CFR eCFR, CourtListener, state legislatures, regulator docket sites) and standard ML practice. None of those need a lawyer to *do*; they only need a lawyer to *bless the FCRA benchmark output*.

**How to apply:**
- The 10 epics SCRUM-770 / 769 / 734 / 732 / 875 / 874 / 866 / 858 / 821 / 820 do NOT touch FCRA (they cover privacy law, federal contracting, contract law, financial services, legal credentials). They were Blocked under a broad reading of the NVI gate that was wrong. They were transitioned Blocked → To Do on 2026-04-27.
- Of the 12 NDD sub-versions (v17–v28), only v22 (Employment / Background Check / FCRA) genuinely needs the FCRA gate. v17–v21 and v23–v28 ship without it.
- When picking up NVI work, if it isn't the gold benchmark or scenario sign-off, it is unblocked. Don't re-apply a generic "Blocked by SCRUM-804" link.
- The lawyer-only piece should be carved into its own sibling story (suggested: `NVI-LEGAL: FCRA professional benchmark + scenario sign-off`) so future filters can find it cleanly. The original NDD v22 sub-story can carry an explicit `is blocked by` link to that one sibling and nothing else.
- If a future agent says "this is blocked on FCRA counsel" without naming the deliverable as one of those two, push back — the gate has been over-applied historically, and that's how half the board got falsely Blocked for weeks.

**Reason (incident):** On 2026-04-27 the user (carson) flagged that 10 epics across NVI / NTF / NDD / KAU / NCX / CONT / FEDCONT / GME3 / 4 / 10 / 11 were sitting in Blocked under a "needs FCRA counsel" tag that none of them actually needed. The lawyer dependency had been inherited from the parent NVI epic and applied to every downstream work item without anyone re-reading the actual scope. After the rescope: only the two deliverables above remain gated.

**Cost reality:** $3k–$7k total external counsel cost for the legitimate lawyer pieces — not the multi-week productivity stall the broad block was costing.
