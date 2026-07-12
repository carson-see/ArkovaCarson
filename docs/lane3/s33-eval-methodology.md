# L3-S2 — Eval Methodology Design (Sprint 3.3) — DESIGN ONLY

> **Status:** design document (2026-07-10). NO eval-file edits in this PR — `services/worker/src/ai/eval/*` and `scripts/staging/ai-eval/*` are frozen while PR #1413 soaks (head `7c54a4ff`, ~02:37Z). §5 maps where each piece lands once #1413 merges. Internal engineering notes; audited spec in Confluence (96894977).
> **Bindings:** CTO R5 (corpus + gates approved as modified), R6 (fairness), R2 (429 attribution is L2 surface — out of scope here).

## 1. Statistical comparison: paired bootstrap on per-entry weighted-F1 deltas

Per-type gates at n=12–15 are noise (13/15 correct has a 95% Wilson CI of roughly 62%–96%, i.e. ±25pp). All promotion decisions therefore aggregate at **domain** level (~600–750 samples/domain → CI ±3–4pp); per-type numbers are diagnostics only.

**Procedure (per domain):**

1. For each held-out entry `i`, compute per-entry weighted F1 under both arms on the same entry: `d_i = F1_tuned(i) − F1_public(i)`. Pairing is per-entry — both arms score the identical document, so document difficulty cancels.
2. Bootstrap the mean of `{d_i}`: **B ≥ 2,000 resamples** (research floor is 10k for publication-grade; 2,000 is the CI-stability floor we adopt for gate runtime — the implementation takes B as a parameter, default 2,000, and the rc-manifest records the B actually used).
3. **Deterministic seed**: fixed integer recorded in the evidence JSONL (proposal: `20260710`), single seeded PRNG (mulberry32, already the repo's deterministic-PRNG convention) — identical inputs must reproduce identical CIs bit-for-bit across runs and machines.
4. Report per domain: `ΔF1 mean`, **95% percentile CI [lo, hi]**, and the bootstrap p-value (fraction of resamples ≤ 0). A gate PASSES on the CI, not the point estimate: **promotion requires CI_lo > 0 AND ΔF1 ≥ +5pp** at the domain aggregate.
5. With ~2,500–3,000 total docs, domain deltas under ~2–3pp will generally not be significant — that is the intended behavior, not a bug (research brief §4).

## 2. No-covered-type-regresses hard floor

**Gate: no covered type may regress by more than 5pp weighted F1** (tuned vs public, point estimate on the held-out set), regardless of how good the domain aggregate looks.

Rationale — this floor **would have caught v7**: macro F1 moved +1.2pp while FINANCIAL collapsed −21.2pp and BUSINESS_ENTITY −18.8pp (`eval-gemini-golden-v7-vs-v6-2026-04-16.md`). A domain-aggregate-only gate averages exactly this failure away.

- "Covered type" = any type with ≥12 real held-out entries (datasheet-marked; synthetic-only types are N/A and excluded — R-7 forbids claims about them anyway).
- The floor is a point-estimate tripwire, deliberately not CI-gated: at n=12–15 a CI-gated floor would never fire. A floor hit blocks promotion and demands a per-type investigation (confusion matrix, §3) before any override; overrides are Carson-approved residual-risk exceptions only.

## 3. Confusion matrices

Emitted into the evidence JSONL per eval round:

1. **Per-domain confusion matrix** over `credentialType` (predicted × actual), counts not percentages (n is small; percentages mislead).
2. **Top-20 confused pairs** globally, ranked by count, each row: `(actual, predicted, count, example entry ids)`.
3. **Cross-domain confusions** reported as their own block — a LICENSE→FINANCIAL confusion is a worse product failure than LICENSE→CERTIFICATE, and it is invisible inside per-domain blocks.

## 4. Abstention scoring

Forced 200-way classification inflates accuracy and produces confident garbage on novel documents — and the AU/KE slice guarantees novel documents.

- **Unknown class**: a prediction of `OTHER` *plus* the emission of `suggestedType` is scored as an explicit **abstain**, not as a miss against the true type. `OTHER` without `suggestedType` on a non-OTHER ground truth stays a plain miss.
- Report per arm, per domain: **abstain-rate**, **precision-at-abstain** (how often the abstained entries were genuinely out-of-taxonomy or would have been misclassified), and the **coverage–accuracy curve** (accuracy over the retained set as coverage sweeps from 100% down, ranked by confidence).
- Launch question this answers: is the model safer *because* it abstains, or just lazier?

### The `computeWeightedF1` missing_both caveat

Current scorer behavior (`services/worker/src/ai/eval/scoring.ts:140-144`, mirrored in `scripts/staging/ai-eval/scoring.ts`): a field absent from **both** ground truth and prediction is `matchType: 'missing_both'` and **counted as correct** (`eval-gates.ts:194` passes it through the correct branch). Consequence: entries with sparse ground truth inflate F1 — a model that omits fields scores agreement-by-omission credit on every field the ground truth never had. Two design responses:

1. **Corpus side (binding on L3-S1/L4):** every held-out entry carries ≥5 non-null ground-truth fields, which bounds the missing_both share per entry.
2. **Report side:** the evidence JSONL must report, per domain, the **missing_both fraction of scored field-pairs** and a companion **coverage-adjusted F1** computed over pairs where at least one side is present. Headline deltas (§1) remain on the standard scorer for comparability with historical runs, but the coverage-adjusted number rides beside it so an omission-heavy model cannot hide.

## 5. Where each piece lands after #1413 merges (tomorrow's files)

| Piece | Target file(s) | Kind |
|---|---|---|
| Paired bootstrap (B, seed, CI) | NEW `services/worker/src/ai/eval/paired-bootstrap.ts` (+ `.test.ts`) — pure function over per-entry score arrays | net-new module |
| Domain aggregation + ≥5pp CI gate | extend `services/worker/src/ai/eval/eval-gates.ts` (new gateIds alongside SCRUM-2382) | extend post-merge |
| No-covered-type-regresses floor | same `eval-gates.ts` gate family; covered-type list read from the datasheet | extend post-merge |
| Confusion matrices + top-20 pairs | NEW `services/worker/src/ai/eval/confusion-matrix.ts` (+ `.test.ts`); wired into evidence emission in `scripts/staging/ai-eval/ai-eval-gate-runner.ts` | net-new + extend |
| Abstention scoring + coverage-accuracy curve | NEW `services/worker/src/ai/eval/abstention.ts`; scorer hook in `scoring.ts` (post-merge, coordinated so it does not collide with #1413's `run-pe-gates.ts --dataset s3` path) | net-new + extend |
| missing_both reporting / coverage-adjusted F1 | extend `services/worker/src/ai/eval/scoring.ts` + `scripts/staging/ai-eval/scoring.ts` (keep the two scorers behavior-identical — they are siblings by design) | extend post-merge |
| Held-out leakage manifest extension (new corpus roots, generators, tuning JSONL export) | extend #1413's `heldout-leakage.ts` scan roots | extend post-merge |
| Per-round provenance assertions (flags, provider, prompt) | extends merged `ai-eval-gate-runner.ts` patterns (#1460 already refuses mock/fallback-served rounds) | extend post-merge |

TDD order per CLAUDE.md §0: bootstrap and confusion modules are pure functions — failing tests first, then implementation; gate wiring follows.
