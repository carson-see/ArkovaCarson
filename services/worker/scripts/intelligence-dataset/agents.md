# intelligence-dataset — Agents Guide

> Read before editing anything in `services/worker/scripts/intelligence-dataset/`.
> This folder is the dataset factory for every Nessie compliance-intelligence model
> (v27.x FCRA, v28.x HIPAA, v29.x FERPA, future regulations).

## Canonical rules (do not break)

1. **Every citation anchors to a source.** Scenarios reference `IntelligenceSource.id` only. If you add a citation to a scenario, confirm the id exists in the matching `sources/<regulation>-sources.ts`. Add the source first, then the scenario.
2. **Every scenario has non-empty `risks` + `recommendations`.** Validator fails the build otherwise.
3. **Confidence lives in 0.55–0.99.** Values below 0.55 belong on should_refuse scenarios only (NVI-10).
4. **Category-balanced splits.** When you add scenarios, update the `targetCount` in the regulation's `categories` array in `build-dataset.ts` and run the category-coverage check.
5. **NVI-10 humility contract.** A scenario with `should_refuse: true` must satisfy `confidence ≤ 0.70`, `escalation_trigger: true`, and at least one recommendation that points to counsel / expert consultation. Enforced by `validateAdversarialAnswer()`.
6. **Relative imports use `.js` extensions.** This folder runs under `--moduleResolution nodenext` so `import { x } from './foo'` fails typecheck. Always `./foo.js`.

## Sub-folder map

- `sources/` — anchored citation registries (one file per regulation). Add a source before citing it.
- `scenarios/<regulation>/` — hand-crafted Q&A scenarios. One file per category.
- `evals/` — 50-entry eval datasets per regulation (fcra, hipaa, ferpa). Separate from training scenarios; leakage-free.
- `benchmark/` — NVI-11 gold-standard held-out benchmark scenarios.
- `documents/` — document corpora for NVI-09 grounded scenarios.
- `validators/` — verification registry + CI guards.
- `nph/` — NPH-14 v8 retrain eval-gate module (2026-04-18 Sprint Batch 4, SCRUM-711).
- `kau/` — Kenya + Australia credential taxonomy (KAU-05) + NDB sources (KAU-06). Added 2026-04-18 Sprint Batch 4 (SCRUM-753, 754).
- `ntf/` — NTF-01..07 reasoning/compliance/cross-ref/portability/conflict/audit modules. Added 2026-04-18 Sprint Batch 4 (SCRUM-773..779). All NVI-gated — no tuning jobs until FCRA NVI gate closes.

## Contract for `build-dataset.ts`

- `buildFcraDataset` / `buildHipaaDataset` / `buildFerpaDataset` each return `RegulationDataset` with scenarios + categories. Add your new scenario array to the appropriate builder + update the category target count.
- `scenarioToTogetherRow` is the single path from scenario → training JSONL. Keep it pure.
- Validation order: base validation → adversarial contract (NVI-10) → benchmark held-out guard (NVI-11, FCRA only).

## NVI posture (2026-04-18)

- **FCRA v27.3** is in prod but UNDER_REVIEW per NVI-15.
- **HIPAA v28, FERPA v29** are QUARANTINED.
- **All NTF/NDD/NSS training is PAUSED** until FCRA NVI gate closes (CLAUDE.md §0).
- Scaffolding (taxonomies, eval harnesses, scorers) is explicitly allowed during the pause — just no tuning job submissions.

## When you add a new module

1. Write the module + test file under the matching sub-folder (`nph/`, `kau/`, `ntf/`, or a new one).
2. Imports use `.js` extensions (nodenext).
3. Tests under `vitest`, mirror structure of `cot-scaffold.test.ts`.
4. Update this file's sub-folder map with a one-line entry.
5. If your module is referenced from `build-dataset.ts` (e.g. a new scenario array), also update the appropriate `build<Regulation>Dataset` function and run `npx tsx build-dataset.ts --regulation <reg> --version <v>` locally to confirm the validation passes.
