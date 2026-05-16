# services/worker/scripts/common

Shared utilities for offline scripts. Imported by benchmark, distillation, and dataset-building modules.

## Files

- `anthropic.ts` — Fetch-based Anthropic Messages API client (no SDK dependency). Used by Opus teacher (NVI-07) and Opus judge (NVI-12).
- `anthropic.test.ts` — Tests for the Anthropic client.
- `p-limit.ts` — Minimal bounded-concurrency helper (no external dependency). Rate-limits outbound LLM calls during distillation/benchmark runs.
- `p-limit.test.ts` — Tests for p-limit.
- `together.ts` — Together chat-completions row builder. Produces canonical 3-turn training rows (system + user + assistant JSON) using the shared Nessie intelligence prompt.

## Constraints

- These are script-only utilities — never import from `services/worker/src/`.
- `ANTHROPIC_API_KEY` required at runtime for `anthropic.ts`.
