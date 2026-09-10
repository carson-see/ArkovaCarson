# integrations/clio/test/agents.md

Tests for the Clio legal practice management integration (INT-06).

## Files
- **`clio.test.ts`** — integration tests for the Clio connector, sidebar widget, CLE compliance, and webhook handler.

## Conventions
- All external API calls (Clio API v4, Arkova API) must be mocked.
- Run via `vitest` from the `integrations/clio/` package root.

## 2026-09-05 — webhook tests now go through the authenticated entry point (PR #2589 review)

The four `ClioWebhookHandler` tests called `handler.handleEvent(event)` with a parsed event and no
auth material. That method is gone (it is now `private processEvent`, reachable only after the
signature verifies — see `../src/agents.md`); all four now call
`handler.handleWebhook(rawBody, signature)` with a real HMAC.

Two conventions for anything added here:

- **Sign fixtures, never hardcode a digest.** The `signBody(rawBody, secret?)` helper at the top of
  `clio.test.ts` recomputes the same HMAC-SHA256 hex digest the handler checks. A hardcoded digest
  would keep passing after an algorithm change; a computed one fails loudly.
- **Sign the exact bytes.** `body(event)` serializes once and both the signature and the request use
  that same string. Signing one serialization and sending another is the mistake the production
  integration will make, so the tests must not model it away.

The suite is 29 tests (was 15). The new
`describe('ClioWebhookHandler — inbound signature auth')` block covers valid/missing/empty/tampered
signature, tampered body with the original signature, wrong secret, unset-secret fail-closed, "an
unauthenticated document.created never anchors and never calls fetch", non-JSON body,
`validateSignature` directly (including a length mismatch not throwing), and the two
construction-warning cases.
