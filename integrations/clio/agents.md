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

## 2026-09-02 — signature check claimed, NOT wired (superseded 2026-09-05)

This entry claimed `ClioWebhookHandler.validateSignature()` was "now enforced … and the compare is
constant-time". **It was not true when written.** The 2026-09-02 change touched no source file in
this package: `validateSignature` had zero callers anywhere in the repo, and it compared with `===`.
The doc asserted a security control that did not exist. Kept here, corrected, rather than deleted —
a doc that once overclaimed a security property is worth being able to find again.

## 2026-09-05 — signature check actually wired (SCRUM-3901 / epic SCRUM-3894)

Now true, and the code is the reference — this section describes it exactly.

**`handleWebhook(rawBody, signature)` is the only entry point.** The former public
`handleEvent(event)` took an already-parsed event and no auth material; a public unauthenticated
path is precisely what let the signature check sit unused for three days. It is now
`private processEvent(event)`, reachable only after the signature verifies.

`rawBody` must be the exact bytes Clio POSTed. The HMAC covers those bytes, so re-serializing a
parsed object (key order, whitespace, number formatting) yields a different digest and rejects a
legitimate request. Parsing happens only *after* verification — an unauthenticated body is never
`JSON.parse`d into the handler's own flow.

Fail-closed outcomes, all `processed: false`:

| Condition | `action` | `result.reason` |
|---|---|---|
| `config.webhookSecret` unset | `rejected_unauthenticated` | `no_webhook_secret_configured` |
| Signature absent or empty | `rejected_unauthenticated` | `missing_signature` |
| Digest mismatch (tampered body, tampered signature, wrong secret) | `rejected_unauthenticated` | `invalid_signature` |
| Signature valid, body is not a JSON Clio event | `rejected_malformed_payload` | `body_is_not_json` / `body_is_not_a_clio_webhook_event` |

The three `rejected_unauthenticated` reasons are for **local** diagnosis. Do not return the reason
to the remote caller: it tells an attacker whether the endpoint is merely misconfigured.

**The compare is constant-time**, via `constantTimeEqual` from
`integrations/shared/src/constant-time.ts` (shared with Bullhorn, which is where it used to live
privately). `===` on a secret-derived digest returns as soon as two bytes differ, so its runtime
encodes how many leading characters the attacker guessed right — enough, over many requests, to
forge a signature byte by byte without ever knowing the secret. A length mismatch returns `false`
rather than throwing.

**`ClioConfig.webhookSecret?: string`** is new. It is optional in the type but the handler fails
closed without it, and — as in Bullhorn — warns once at construction, because a deploy that simply
forgot the secret rejects 100% of genuine webhooks and looks exactly like an attacker being turned
away. The secret's value is never printed; a test asserts no config value appears in the warning.

`CLIO_WEBHOOK_SIGNATURE_HEADER` (`x-hook-signature`) and the `ClioWebhookResult` type are exported
from `src/index.ts` alongside the handler.

Tests: `test/clio.test.ts` `describe('ClioWebhookHandler — inbound signature auth')` — valid
signature processed; missing, empty, tampered-signature, tampered-body-with-original-signature, and
wrong-secret all rejected; unset-secret fails closed even for a well-formed signature; an
unauthenticated `document.created` never anchors and never calls `fetch`; a non-JSON body is
rejected without processing; `validateSignature` accepts a correct digest, rejects a wrong one, and
does not throw on a length mismatch; and the two construction-warning tests. The four pre-existing
`handleEvent` tests were rewritten to go through `handleWebhook` with a real HMAC computed in the
test (never a hardcoded digest, so an algorithm change fails loudly). Suite is 29 tests; run with
`npx vitest run` from `integrations/clio/`.
