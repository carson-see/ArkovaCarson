# agents.md — services/worker/src/ai/__tests__/

_Last updated: 2026-05-16_

## What This Folder Contains

Standalone test suites for AI subsystems that are complex enough to warrant their own test file outside the co-located `*.test.ts` pattern.

| File | Purpose |
|------|---------|
| `adversarial.test.ts` | Prompt injection, Unicode homoglyph, long-input, and nested-JSON defense tests |
| `ensembleConfidence.test.ts` | Tests for multi-prompt ensemble confidence scoring |
| `grounding.test.ts` | Tests for hallucination detection / field-source cross-checking |
| `modelTargets.test.ts` | Tests for dual-model (server 8B / browser 3B) target configuration |
| `scriptModelRefs.test.ts` | CI guard — verifies no script hardcodes model names (must use `gemini-config.ts`) |
| `trainingMetrics.test.ts` | Tests for training data quality metrics tracking |

## Do / Don't Rules

- **DO** mock the logger (`vi.mock('../../utils/logger.js')`) to avoid config dependency
- **DO NOT** call real AI APIs — use `MockAIProvider` or vi.mock stubs
