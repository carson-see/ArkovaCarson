# agents.md — services/worker/src/integrations/computeid/

_Last updated: 2026-09-07 (SCRUM-4493 / SCRUM-4494 — PR-A of the ComputeID AgentPassport integration, epic SCRUM-4492)_

## What This Folder Contains

Partner integration with ComputeID (Praveen Gajjala, CEO; `https://api.aicomputeid.com`). Two surfaces consume it: `api/v1/webhooks/computeid.ts` (inbound revocation events) and `api/v1/agents-computeid.ts` (passport admission). Everything here is pure `node:crypto` + Zod — no logger, no config import — because `config.ts` imports `ca-cert.ts` for boot validation.

| File | Purpose |
|------|---------|
| `schemas.ts` | Zod wire shapes: webhook envelope + `passport.*` events (lenient `.passthrough()`), `verification_receipt`, admission request |
| `ca-cert.ts` | Pinned CA loader (X.509 cert PEM in prod, bare SPKI public-key PEM in tests/staging) + `key_id` derivation `sha256(SPKI PEM)[:16]` |
| `receipt-verifier.ts` | Offline RSA-SHA256 verification of `verification_receipt` over the exact `receipt_payload` bytes; the signed payload is the only trusted source |
| `binding.ts` | v1 binding in `agents.metadata.computeid`; forward-only transition decision with an ordering guard on the signed event timestamp |
| `__fixtures__/computeid-ca.pem` | The REAL public CA served by `/v1/ca/cert` on 2026-09-07 (RSA-2048, CN=ComputeID-CA, C=CY, valid to 2036-08-13). Public material |
| `__fixtures__/golden-test-delivery.json` | A REAL `POST /v1/webhooks/test` delivery captured 2026-09-07 (body, header, throwaway secret) — pins byte-compatibility with ComputeID's signer |

## Facts verified live on 2026-09-07 — do not re-derive these from the partner's emails

- Webhook signature: `X-ComputeID-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`. No timestamp header, no event id. Verified end-to-end against a scratch receiver.
- `key_id` published with the CA (`ebb276c2f18ed34f`) = first 16 hex of `sha256` over the SPKI **PEM text** (not DER). `ca-cert.test.ts` pins it.
- The CA publishes **RSA only** (`pq: null`). "ML-DSA-65 offline against our CA" as described in the Aug 13 emails is not something their API offers; the offline-verifiable artifact is the RSA `verification_receipt`. The passport's own `pq_signature` is over `signed_payload` with the agent's embedded key — not a CA issuance proof.
- `POST /v1/agents/register` **requires `X-API-Key`** (401) although their OpenAPI marks it public. Arkova holds no ComputeID key yet; no real passport/receipt has been captured. The admission path is therefore tested only against receipts we sign ourselves — see "Known gaps".
- `POST /v1/webhooks/register` has **no auth, no URL validation, no DELETE**. `POST /v1/webhooks/test` sends `{"event":"test","timestamp":…}` only.
- Delivery user-agent is `node-fetch/1.0`; retry semantics undocumented. Assume a 5xx from us is a lost event until the partner says otherwise.
- Two hosts appear in the emails (`hostman-api.` / `api.`); both resolve to one IP. Pin `api.aicomputeid.com`.

## Do / Don't Rules

- **DO** verify the receipt signature over `Buffer.from(receipt_payload, 'utf8')` exactly as delivered. **DO NOT** parse-then-re-stringify; whitespace/key-order differences flip the signature silently.
- **DO** read `passport_id` / `status` / `expires_at` from the parsed *signed* payload. The outer receipt fields are unsigned copies — `verifyComputeIdReceipt` rejects any disagreement (`payload_field_mismatch`) rather than picking one.
- **DO NOT** fetch `/v1/ca/cert` at runtime. The pin comes from `COMPUTEID_CA_CERT_PEM`; rotation is the partner's promised 30-day notice → secret update → redeploy. Fetching would reintroduce the uptime dependency the offline path exists to remove.
- **DO NOT** persist or log the partner's free-text `reason` (it may carry PII). Audit rows record only its length.
- **DO NOT** add a nonce table here without a migration — that is PR-B (SCRUM-4497). Replay safety in v1 is the ordering guard on the signed timestamp (`decidePassportEvent`): an event at or before `last_event_at` is a no-op, `revoked` is terminal, `already_in_state` still advances the clock.
- RSA padding is PKCS#1 v1.5 (Node's default for `crypto.sign('sha256', …)`). If the first REAL receipt fails with `invalid_signature`, suspect PSS and confirm with the partner — do not loosen the verifier to try both.
- Both handlers read the flag, secret and CA pin through the typed `config` export — never `process.env` (SCRUM-1258 ratchet, enforced by `check-worker-env-adhoc`). Tests mock `config.js` with a hoisted mutable object.
- Binding lookups use `.contains('metadata', { computeid: { passport_id } })` (jsonb `@>`). `agents` is not in the tenant-isolation lint list, but every write re-scopes by `org_id` anyway.

## Known gaps (tracked, not hidden)

- **No real receipt has ever been verified.** Flag flip (SCRUM-4495) is gated on a golden test against a receipt from a passport ComputeID issued to us. Needs the partner API key (SCRUM-4498).
- **Lost deliveries have no safety net** until the scheduled `/verify` re-check lands (SCRUM-4497). Until then a `webhook_dlq` row is a record of the loss, not a recovery.
- **No uniqueness on the binding** — two concurrent admits of one passport into one org can both succeed. App-level check only; unique index is SCRUM-4497.
- `anchors` carries no agent attribution, so "every record names the acting agent" is not yet true (SCRUM-4497).
