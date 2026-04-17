# Nessie Distillation Methodology (NVI-07 / SCRUM-811)

_Last updated: 2026-04-17_

## Purpose

Hand-crafting scenarios gets Nessie to ~57% citation accuracy / 47%
faithfulness on the FCRA 50-entry eval. Production compliance AI
standards are ≥85% on both. The gap is reasoning depth and coverage
— it cannot be closed by writing more hand-crafted scenarios.

Distillation addresses this: a strong teacher (Claude Opus 4.7) answers
FCRA questions we pose, we validate every answer against the NVI-01..04
verified source registry, and the student (Nessie on Llama 3.1 8B)
trains on the survivors. The student inherits the teacher's reasoning
at its own latency and unit cost.

## Pipeline

```
 query templates → variation generator → teacher (Claude Opus)
                                          ↓
                                   validation pipeline  → reject / keep
                                          ↓
                                  training JSONL  → Together fine-tune → Nessie student
```

### Stage 1 — query templates

`scripts/distillation/fcra-templates.ts` holds seed templates, one per
FCRA category. Each template defines:

- `template` — a string with `{slot}` placeholders.
- `slots` — a map from slot name to allowed values.
- `expectedSources` — the verified-source record_ids the teacher should
  anchor its answer to.

### Stage 2 — variation generation

`variation-generator.ts::expandTemplate()` does a deterministic
cartesian product over the slot values, producing one `VariationQuery`
per combination. Determinism matters: re-running the generator with the
same templates + slots produces byte-identical output, so we can diff
training-data changes.

### Stage 3 — teacher inference

`opus-teacher.ts::createOpusTeacher()` wraps the Anthropic Messages API
(via `fetch` — no SDK dependency). Inputs: the canonical FCRA system
prompt (`opus-system-prompt-fcra.md`) and the RAG context block built
from `FCRA_SOURCES` for the template's `expectedSources`. Output: a
parsed `IntelligenceAnswer`.

Tests never invoke this module. The `TeacherModel` interface is the
seam — use a mock in tests, `createOpusTeacher()` in production.

### Stage 4 — validation

`validation-pipeline.ts::validateTeacherAnswer()` enforces:

1. **Structural validity** — non-empty `analysis`, `risks`,
   `recommendations`, `citations`; `confidence` in [0.55, 0.99];
   `jurisdiction` + `applicable_law` present.
2. **Citation anchoring** — every `citations[i].record_id` exists in
   the verified-source registry AND that registry entry has
   `overallPassed=true`.
3. **Minimum evidence** — no naked answers. Every accepted row cites
   at least one verified source.

Rejections bucket by reason in the report so we can see whether the
teacher is drifting ("unverified citations" = RAG misuse, "confidence
out of range" = prompt tuning, etc.).

### Stage 5 — training JSONL

Accepted variations become Together-format chat rows with the standard
`NESSIE_INTELLIGENCE_PROMPT_V2` system prompt. Output is
`training-output/nessie-v28-fcra-distilled-train.jsonl`.

## Budget

Conservative per-Q&A estimate at Opus 4.7 list pricing:

| Component | Tokens | Cost (approx.) |
|-----------|--------|----------------|
| System prompt | ~400 in | $0.003 |
| RAG context | ~800 in | $0.006 |
| Answer | ~1,200 out | $0.024 |
| **Total per Q&A** | | **~$0.033** |

5,000 accepted Q&A pairs ≈ **$165 budget**. With ~15% rejection rate on
validation, plan for ~6,000 teacher calls = **~$200 total**. Add
contingency for retries + any LLM-as-judge second-pass validation
(another ~$50).

## Running locally

Dry-run (no API cost, validates wiring):

```bash
npx tsx scripts/distillation/fcra-opus-distill.ts \
  --dry-run \
  --limit 20 \
  --out /tmp/distill-dryrun.jsonl
```

Live run (budget-gated):

```bash
ANTHROPIC_API_KEY=... \
npx tsx scripts/distillation/fcra-opus-distill.ts \
  --out training-output/nessie-v28-fcra-distilled-train.jsonl \
  --limit 100
```

The `--limit` guardrail exists explicitly to prevent accidental
large-budget runs — lift it intentionally once a small batch has been
eyeball-reviewed.

## DoD gating

NVI-07 is not "done" until:

- [ ] ≥5,000 validated Q&A pairs in the distilled JSONL.
- [ ] Validation acceptance rate ≥85% (rejection-reason histogram
      reviewed for systemic issues).
- [ ] Sample 50 distilled pairs reviewed for quality (no vague risks,
      no uncalibrated confidence, statutory refs accurate).
- [ ] Together fine-tune submitted, evaluated vs v27.3 on the 50-entry
      FCRA eval.

This doc + the shipped pipeline satisfies the "methodology + working
code" half. The actual run is budget- and time-gated.

## Related

- `services/worker/scripts/distillation/` — pipeline code.
- `services/worker/scripts/intelligence-dataset/validators/` — NVI-01..04 verifiers the validation pipeline consults.
- `docs/plans/nessie-attorney-review-process.md` — NVI-05 tier-3 review (applied to any distilled pairs that slip through with judgement-call issues).
- CLAUDE.md §0 NVI Gate — no new regulation distillation until FCRA passes.
