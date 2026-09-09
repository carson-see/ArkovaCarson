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

## 2026-09-02 — inbound auth (SCRUM-3901 / epic SCRUM-3894)

`BullhornWebhookHandler.handleEvents(event, presentedSecret)` now REQUIRES the shared secret
(`BullhornConfig.webhookSecret`, presented via `x-arkova-webhook-secret`). Missing config, missing
header, or mismatch → every event returns `rejected_unauthenticated` (fail closed). Comparison is
`constantTimeEqual` (byte-wise XOR fold; length mismatch short-circuits, same leak profile as
`timingSafeEqual`). Found by the 2026-09-02 integrations audit: the handler previously trusted any
POST shaped like a Bullhorn subscription event. Not imported by anything deployed; fixed as hygiene
before it is.
