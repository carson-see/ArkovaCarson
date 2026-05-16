# integrations/bullhorn/agents.md

Bullhorn ATS integration (INT-07). Syncs candidate credential verification status between Arkova and Bullhorn.

## Structure
- **`src/`** — connector, webhook handler, candidate tab, types.
- **`test/`** — integration tests.
- **`vitest.config.ts`** — test runner config.
- **`package.json`** — standalone package with its own dependencies.

## Conventions
- Never call real Bullhorn or Arkova APIs in tests; mock all external calls.
- Auth uses `BhRestToken` header for Bullhorn REST API access.
