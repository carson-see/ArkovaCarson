# agents.md — docs/partners/

Internal engineering notes for partner-facing initiatives. Per CLAUDE.md §4,
these are NOT the canonical documentation record — Confluence is. Files here
are historical/internal context only; if an initiative moves to an active
partner conversation, its durable spec belongs on a Confluence page.

## Files

- `ce-noncredit-anchoring-poc.md` — L3-A6 (2026-07-28). CE Noncredit Data
  Taxonomy 3.0 anchoring POC: the thesis (noncredit students lack a
  registrar/transcript substrate), the research (NDT-3.0 → CTDL benchmark
  model classes, sourced + cited), the technical finding (Arkova's CTDL
  credential-class filter silently dropped `ceterms:LearningProgram` records
  before this PR — see `services/worker/src/ctdl/agents.md`), what the POC
  demonstrates end-to-end, and an explicit §1.5/R-7 measured-vs-asserted-vs-
  NOT-asserted section. Read before any CE/Jeanne Kitchens conversation
  references this POC.
