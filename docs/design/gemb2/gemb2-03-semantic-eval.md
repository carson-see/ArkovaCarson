# GEMB2-03 — Gemini Golden eval harness: semantic cosine-similarity scoring

**Jira:** [SCRUM-1052](https://arkova.atlassian.net/browse/SCRUM-1052)
**Parent:** [SCRUM-1040](https://arkova.atlassian.net/browse/SCRUM-1040)
**Blocks:** all future Gemini Golden regression iterations.
**Depends on:** GEMB2-01 spike benchmark.
**Status:** Design complete, implementation blocked on benchmark go/no-go.

---

## Problem

The current Gemini Golden eval harness uses exact-string matching. Under this rule:

```
expected: "Robert Smith"
got:      "Bob Smith"
verdict:  ❌ FAIL
```

The model got the right person — the nickname just differs. Every name/title/institution field suffers this class of false-failures. We land new fixtures by hand to work around it, inflating the golden corpus and slowing iteration.

## Solution

Replace exact match with cosine-similarity scoring via Gemini Embedding 2. Threshold: `cosine ≥ 0.85` counts as correct for string-typed fields. Existing numeric + enum + boolean fields keep exact scoring.

```
scoreField(fieldName, expected, got):
  if field.type === 'string':
    if exact(expected, got): return 1.0
    cos = cosine(embed(expected, QUERY), embed(got, DOCUMENT))
    return cos ≥ 0.85 ? 1.0 : 0.0
  else:
    return exact(expected, got) ? 1.0 : 0.0
```

## Affected modules

| File | Change |
|---|---|
| `services/worker/src/ai/eval/scorer.ts` | New. `scoreExact` + `scoreSemantic` + router by field type. |
| `services/worker/src/ai/eval/scorer.test.ts` | New. Pins semantic threshold + exact pass-through + embedding cache. |
| `services/worker/src/ai/eval/harness.ts` | Add `scoringMode: 'exact' | 'semantic'` option; default remains `exact` until CI flips. |
| `services/worker/src/ai/gemini-embedding-eval.test.ts` | Retain as regression against embedding-space drift. |
| `.github/workflows/ai-eval-regression.yml` | Add `scoringMode: semantic` job alongside existing `exact`. |

## Embedding cache

Re-embedding ~1,900 golden entries × every field on every eval run is wasteful. Cache strategy:

- Key: `sha256(text || '|' || taskType || '|' || dim)`.
- Store: `services/worker/src/ai/eval/cache/embeddings.sqlite` (gitignored). Local-only; CI re-warms per run.
- TTL: none — cache invalidates on model ID change (the key embeds the `@001` suffix implicitly via the client).

## Threshold calibration plan

1. Pick 200 entries from the golden corpus at random.
2. A human labels each `(expected, got)` pair as PASS/FAIL.
3. Sweep cosine thresholds `0.70 → 0.95` in 0.05 steps; compute human-agreement rate.
4. Pick the threshold where agreement ≥ 90% AND false-pass rate ≤ 2%.
5. Document the chosen threshold + agreement table in Confluence "GEMB2-03 — Gemini Golden semantic scoring".

## Acceptance criteria (pasted from Jira)

- New scoring mode `semantic` alongside existing `exact` (configurable per eval run).
- All current golden entries re-scored; delta report committed to `docs/design/gemb2/gemb2-03-delta-report.md`.
- Threshold calibrated against human-judged subset (≥ 90% agreement).
- CI eval gate updated to use semantic scoring for string-typed fields.

## Rollback

Single config flag `AI_EVAL_SCORING_MODE` — if semantic scoring starts producing regressions we can't explain, flip back to `exact` and investigate.

## Open questions

- **Per-field override**: some string fields (e.g. ID numbers) must use exact. The scorer takes a per-field policy from `fieldType.semantic = false`.
- **Embedding hygiene**: normalize case, strip leading/trailing whitespace, and strip common honorifics ("Dr.", "Mr.") before embedding — keeps the cosine signal on the semantic content, not on presentation.
