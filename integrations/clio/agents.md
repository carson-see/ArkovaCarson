# integrations/clio/agents.md

Clio legal practice management integration (INT-06). OAuth2 connector for document verification and CLE compliance tracking.

## Structure
- **`src/`** — connector, sidebar widget, CLE compliance, types.
- **`test/`** — integration tests.
- **`vitest.config.ts`** — test runner config.
- **`package.json`** — standalone package with its own dependencies.

## Conventions
- Uses OAuth2 authorization code flow with Clio API v4.
- Client-side SHA-256 hashing; documents never leave the law firm's network.
- Never call real Clio or Arkova APIs in tests.
