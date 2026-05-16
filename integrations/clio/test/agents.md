# integrations/clio/test/agents.md

Tests for the Clio legal practice management integration (INT-06).

## Files
- **`clio.test.ts`** — integration tests for the Clio connector, sidebar widget, CLE compliance, and webhook handler.

## Conventions
- All external API calls (Clio API v4, Arkova API) must be mocked.
- Run via `vitest` from the `integrations/clio/` package root.
