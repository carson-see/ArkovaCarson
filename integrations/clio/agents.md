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

## 2026-09-02 — signature check wired (SCRUM-3901 / epic SCRUM-3894)

`ClioWebhookHandler.validateSignature()` existed but was never called from `handleEvent()`; it is
now enforced (fail closed on missing/invalid signature) and the compare is constant-time. Found by
the 2026-09-02 integrations audit.
