# Story Group 38 — Nessie Verification Infrastructure (NVI)

> **Created:** 2026-04-16 | **Jira Epic:** SCRUM-804 | **Release:** R-NVI-01
> **Priority:** Highest — **gates all further Nessie regulation training**
> **Cost estimate:** ~$3,300–$7,300 (mostly external attorney review) | **Timeline:** 3–4 weeks

---

## Why this epic exists

2026-04-16 afternoon A/B/C test showed Nessie FCRA citation accuracy improved **0% → 57% across six deployments** via two levers:

1. Canonical-ID naming convention (+30.5pp at v27.2)
2. Hand-crafted scenario expansion (+14pp at v27.3)

Both wins were real. But the underlying question — **"is the training data accurate?"** — has no answer. Citations, quotes, case numbers, agency bulletin references, and state statute cites in the FCRA source registry (89 sources) and 277 training scenarios were hand-written from working knowledge. Fabricated case numbers, paraphrased-from-memory statute quotes, and unchecked agency bulletin references almost certainly exist.

A Nessie deployed to production on unverified data is not just inaccurate — it's **professionally dangerous**. A compliance officer citing a fabricated case in a client memo because Nessie said so is real legal harm.

---

## What this epic builds

Infrastructure that enforces verifiability — every source, quote, and citation in Nessie training data is traceable to authoritative primary sources.

### Phase 1 — FCRA source verification pipeline

| Story | Summary | Effort |
|---|---|---|
| NVI-01 | **Statute-quote validator** — diff every FCRA source quote against 15 U.S.C. authoritative text (Cornell LII, DoJ USCode, CFR eCFR). Fail any quote with >10% character divergence. | Medium |
| NVI-02 | **Case-law citation validator** — resolve every case cite to a real published opinion via Google Scholar Case Law API + PACER. | Medium |
| NVI-03 | **Agency-bulletin validator** — verify every CFPB / FTC / HHS OCR / DoE action against the authoritative docket. | Medium |
| NVI-04 | **State-statute validator** — check state-specific cites against state legislature databases. | Medium |
| NVI-05 | **FCRA source registry audit + quarantine** — run all three validators across 89 sources, quarantine failures, document provenance for every source. | Small |

### Phase 2 — Chain-of-thought + distillation + benchmark

| Story | Summary | Effort |
|---|---|---|
| NVI-06 | **Chain-of-thought retrofit** — every scenario gets explicit reasoning steps (classify → statutes → exceptions → state overlays → risks → recommendations → confidence → escalation). | Medium (AI-assisted) |
| NVI-07 | **Claude Opus distillation** — 5,000+ verified FCRA Q&A generated with Opus as teacher; human review of 5% random sample. | Medium (~$200 API) |
| NVI-08 | **Multi-turn + document-grounded scenarios** — 100+ conversational scenarios over real documents. | Medium |
| NVI-09 | **Adversarial + "I don't know" training** — trick questions, ambiguous facts, conflicts; "consult counsel" as valid response. | Medium |
| NVI-10 | **Professional gold-standard benchmark** — 50-question FCRA test reviewed by an external FCRA compliance attorney. | Large ($2–5K) |
| NVI-11 | **Production canary** — 5% of FCRA queries route to Nessie with human-review pipeline for failures. | Medium |
| NVI-12 / SCRUM-816 | **LLM-as-judge benchmark runner** — Claude / GPT-4o / Gemini 2.5 Pro score Nessie against the 50-question benchmark. | Medium |

---

## Definition of Done (epic-level)

- [ ] All FCRA source quotes verified against authoritative text (or quarantined)
- [ ] All FCRA case cites resolved to real published opinions
- [ ] All agency bulletin references verified
- [ ] All training scenarios retrofitted with chain-of-thought reasoning
- [ ] 5,000+ Claude-Opus-distilled verified FCRA Q&A in training set
- [ ] 100+ multi-turn scenarios, 50+ document-grounded, 50+ adversarial / "I don't know"
- [ ] 50-question attorney-reviewed gold-standard benchmark exists
- [ ] Nessie scores ≥ base Gemini 2.5 Pro on FCRA gold-standard benchmark
- [ ] Production canary at 5% live with feedback-loop pipeline
- [ ] v28 HIPAA + v29 FERPA audited under the same framework (quarantine or pass)
- [ ] NTF epic (SCRUM-769) superseded or closed; NDD (SCRUM-770) / NSS (SCRUM-771) explicitly paused until FCRA gate passes

---

## Decree — what this epic pauses

Until FCRA passes the NVI gate, **do NOT**:

1. **Expand HIPAA or FERPA datasets.** Current v28/v29 continue serving but are quarantined for review.
2. **Start new regulation training** (SOX, GDPR, state-specific privacy laws, Kenya DPA Deep, Australian Privacy Act, etc.).
3. **Pick up NDD / NSS / NTF children.** These epics are paused.

If asked to pick up a paused story, decline with a pointer to NVI status and offer equivalent non-Nessie work (API richness, NCA product UI, v7 Gemini).

---

## What this epic does NOT do

- **Does NOT** expand HIPAA or FERPA datasets.
- **Does NOT** add new regulations.
- **Does NOT** touch Gemini Golden v6/v7 (separate track: SCRUM-772 GME2).
- **Does NOT** replace existing Nessie code paths. Adds verification layer on top.

---

## References

- Strategy reset: `docs/plans/nessie-strategy-reset-2026-04-15.md`
- Full-day summary: `services/worker/docs/eval/eval-intelligence-full-day-summary-2026-04-16.md`
- Constrained-decoding proof: `services/worker/docs/eval/eval-constrained-fcra-2026-04-16T17-20-06.md`
- Confluence AI Training: [2026-04-16 page](https://arkova.atlassian.net/wiki/spaces/A/pages/11894785)
- Superseded: SCRUM-769 NTF | Paused: SCRUM-770 NDD, SCRUM-771 NSS
