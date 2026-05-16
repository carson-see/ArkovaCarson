# integrations/zapier/agents.md

Zapier integration for Arkova (INT-05). Enables no-code automation of document anchoring and verification.

## Structure
- **`src/`** — Zapier app definition: authentication, actions, triggers, constants.
- **`test/`** — integration tests.
- **`vitest.config.ts`** — test runner config.
- **`package.json`** — standalone package; targets Zapier platform v18.6.0.

## Conventions
- Auth: API key (`ak_*`) validated via `GET /api/v1/health`.
- Triggers use REST hooks (webhook subscribe/unsubscribe); not polling.
- Never call real Arkova APIs in tests.
