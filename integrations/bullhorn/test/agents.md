# integrations/bullhorn/test/agents.md

Tests for the Bullhorn ATS integration (INT-07).

## Files
- **`bullhorn.test.ts`** — integration tests for the Bullhorn connector, candidate tab, and webhook handler.

## Conventions
- All external API calls (Bullhorn REST, Arkova API) must be mocked.
- Run via `vitest` from the `integrations/bullhorn/` package root.
