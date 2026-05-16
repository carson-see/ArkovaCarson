# services/worker/scripts/intelligence-dataset/scenarios/fcra

FCRA training scenarios organized by compliance category. Each file exports typed `IntelligenceScenario[]` arrays with canonical citations from `sources/fcra-sources.ts`.

## Files

- `permissible-purpose.ts` — s604(a) enumerated purposes, s604(f) impermissible use, s615(c) prescreen, resale, FBI/NSL access, state overlays.
- `pre-adverse-action.ts` — s604(b)(3) pre-adverse action notice requirements.
- `adverse-action-notices.ts` — s615(a) adverse-action notice obligations.
- `disputes-and-reporting-limits.ts` — s611/s623 disputes and reinvestigation.
- `state-variations.ts` — State overlays: CA Fair Chance/ICRAA/CCRAA, NY Article 23-A, IL JOQAA/HRA, TX BCC, MA CORI, etc.
- `risk-patterns.ts` — ID fraud, diploma mills, sanctions detection patterns.
- `credential-specific.ts` — Credential-type-specific FCRA scenarios.
- `v27-3-adverse-expansion.ts` — v27.3 adverse-action scenario expansion.
- `v27-3-risk-patterns-expansion.ts` — v27.3 risk-pattern scenario expansion.
- `v27-4-multi-reg-expansion.ts` — v27.4 multi-regulation scenario expansion.
- `adversarial/` — NVI-10 adversarial + humility scenarios (should_refuse, escalation_trigger).
- `document-grounded/` — NVI-09 document-grounded scenarios paired with corpus entries.
- `multi-turn/` — NVI-08 multi-turn conversation scenarios across 10 archetypes.

## Constraints

- All citations must use canonical IDs from `sources/fcra-sources.ts`. Add new sources there first.
