# services/worker/scripts/distillation

NVI-07 (SCRUM-811) Opus teacher distillation pipeline. Expands FCRA query templates into variations, calls Claude Opus for expert answers, validates against the verified-source registry, and writes accepted Q&A pairs to training JSONL.

## Files

- `fcra-opus-distill.ts` — Main driver. Supports `--dry-run` (no API calls) and `--limit N` (budget cap). Estimated ~$0.04/pair at Opus pricing.
- `opus-teacher.ts` — Claude Opus teacher adapter. Loads system prompt from `opus-system-prompt-fcra.md`. Do NOT import in tests.
- `fcra-templates.ts` — 18 seed FCRA query templates with slot placeholders. Expands to ~280 variations via cartesian product.
- `variation-generator.ts` — Deterministic cartesian-product expansion of query templates into concrete scenarios.
- `validation-pipeline.ts` — Validates teacher responses: structural validity, citation anchoring against verified-source registry, minimum evidence. Pure function.
- `types.ts` — Shared types: QueryTemplate, VariationQuery, TeacherModel.
- `opus-system-prompt-fcra.md` — System prompt fed to the Opus teacher model.
- `distillation.test.ts` — Tests using MockTeacher. Never makes real API calls.

## Constraints

- `ANTHROPIC_API_KEY` required for live runs.
- All citations must anchor to entries in the verified-source registry (NVI-01..04).
- Tests must use MockTeacher, never real Opus calls.
