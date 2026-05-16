# agents.md — services/worker/src/ai/canary/

_Last updated: 2026-05-16_

## What This Folder Contains

Production canary and feedback loop logic for AI model promotion (NVI-13 / SCRUM-817). Pure decision functions with no I/O — all model-calling glue stays external.

| File | Purpose |
|------|---------|
| `canary.ts` | `routeToCanary()` routing, `promotionDecision()` gate, `captureFailureAsScenario()` for DPO training |
| `canary.test.ts` | Tests for canary routing, shadow logging, and promotion decisions |

## Do / Don't Rules

- **DO** keep this module pure-function (no I/O, no DB) for deterministic testing
- **DO NOT** import model-calling code here — the HybridProvider elsewhere handles I/O
