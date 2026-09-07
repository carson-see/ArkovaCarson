# agents.md — docs/partners/

Internal engineering notes for partner-facing initiatives. Per CLAUDE.md §4,
these are NOT the canonical documentation record — Confluence is. Files here
are historical/internal context only; if an initiative moves to an active
partner conversation, its durable spec belongs on a Confluence page.

## Files

- `computeid-integration-guide.md` — (2026-09-07, SCRUM-4496). ComputeID /
  CortexOS partner guide: both directions (CortexOS anchoring with Arkova;
  ComputeID AgentPassport admission + revocation webhook), the offline receipt
  verification contract, error codes, contract quotas, and a §1.5 measured /
  asserted / NOT-asserted section. Direction B is flag-gated until
  SCRUM-4495. Uses the UNSCOPED published package names (`arkova`,
  `arkova-mcp-server`); note that `hakichain-integration-guide.md` still says
  `@carsonarkova/sdk`, which is stale — log + fix separately, not here.
- `hakichain-demo-runbook.md` — (2026-08-20). Pilot demo readiness + runbook:
  live prod verification of HakiChain's org/anchors/credit-quota state,
  forward-path (KPI-2/3) SUBMITTED→SECURED tracing with realistic
  time-to-SECURED and the org-scoped forced-flush fallback, a live-bundle
  check of the Kenya transfer-basis fix (deployed but NOT yet merged to
  `main` — see the doc's Finding 1), the actual demo script, and a §1.5
  claims-discipline section. Read before scheduling or running the demo.
- `ce-noncredit-anchoring-poc.md` — L3-A6 (2026-07-28). CE Noncredit Data
  Taxonomy 3.0 anchoring POC: the thesis (noncredit students lack a
  registrar/transcript substrate), the research (NDT-3.0 → CTDL benchmark
  model classes, sourced + cited), the technical finding (Arkova's CTDL
  credential-class filter silently dropped `ceterms:LearningProgram` records
  before this PR — see `services/worker/src/ctdl/agents.md`), what the POC
  demonstrates end-to-end, and an explicit §1.5/R-7 measured-vs-asserted-vs-
  NOT-asserted section. Read before any CE/Jeanne Kitchens conversation
  references this POC.
