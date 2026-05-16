# agents.md — services/worker/src/ai/prompts/

_Last updated: 2026-05-16_

## What This Folder Contains

System prompts and few-shot examples for all AI provider tasks. Prompts receive only PII-stripped text (Constitution 4A).

| File | Purpose |
|------|---------|
| `extraction.ts` | v5 extraction system prompt + `buildExtractionPrompt()` with per-type few-shots |
| `extraction-v6.ts` | Gemini Golden v6 prompt — MUST match the systemInstruction used at training time |
| `intelligence.ts` | Nessie compliance intelligence prompts (QA, risk analysis, summary, recommendation) |
| `reasoning-fewshots.ts` | 80+ OBSERVE-IDENTIFY-CLASSIFY-VERIFY-ASSESS reasoning examples for extraction |
| `nessie-condensed.ts` | 1.5K char condensed prompt for Nessie fine-tuned models (full prompt causes 0% F1) |
| `template-reconstruction.ts` | Prompts for generating human-readable credential templates from extracted metadata |

## Do / Don't Rules

- **DO** keep v6 inference prompt exactly matching the training prompt (drift causes regression)
- **DO** use `nessie-condensed.ts` for all fine-tuned Nessie models (not the full prompt)
- **DO NOT** add raw PII examples to few-shot prompts — use synthetic PII-stripped text only
