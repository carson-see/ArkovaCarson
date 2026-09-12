# agents.md — services/worker/src/integrations/computeid/

_Last updated: 2026-09-07 (SCRUM-4493 / SCRUM-4494 — PR-A of the ComputeID AgentPassport integration, epic SCRUM-4492)_

## What This Folder Contains

Partner integration with ComputeID (Praveen Gajjala, CEO; `https://api.aicomputeid.com`). Two surfaces consume it: `api/v1/webhooks/computeid.ts` (inbound revocation events) and `api/v1/agents-computeid.ts` (passport admission). Everything here is pure `node:crypto` + Zod — no logger, no config import — because `config.ts` imports `ca-cert.ts` for boot validation.

| File | Purpose |
|------|---------|
| `schemas.ts` | Zod wire shapes: webhook envelope + `passport.*` events (lenient `.passthrough()`), `verification_receipt`, admission request |
| `ca-cert.ts` | Pinned CA loader (X.509 cert PEM in prod, bare SPKI public-key PEM in tests/staging) + `key_id` derivation `sha256(SPKI PEM)[:16]` |
| `receipt-verifier.ts` | Offline RSA-SHA256 verification of `verification_receipt` over the exact `receipt_payload` bytes; the signed payload is the only trusted source |
| `binding.ts` | v1 binding in `agents.metadata.computeid`; forward-only transitions, ordering **floor** (last applied event → admitting receipt's `issued_at` → `bound_at`), exact-replay detection, `suspended_by` ownership, and the key-enforcement output the handler applies |
| `secrets.ts` | `parseSecretList` — the ONE parser for `COMPUTEID_WEBHOOK_SECRET`, shared by the boot check and the verifier |
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

- **DO** verify the receipt signature over `Buffer.from(receipt_payload, 'utf8')` exactly as delivered. **DO NOT** parse-then-re-stringify.
- **DO** read `passport_id` / `status` / `expires_at` / `signature_valid` from the parsed *signed* payload. Outer copies must agree (`payload_field_mismatch`); a signed `signature_valid:false` or `pq_signature_valid:false` is `passport_signature_invalid` whatever `status` says.
- **DO** check the pin's validity window per verification (`ca_not_valid`), not only at load — a long-lived instance must stop trusting an expired CA. Production refuses a bare SPKI pin at boot (`config.ts`).
- **DO NOT** fetch `/v1/ca/cert` at runtime. Pin from `COMPUTEID_CA_CERT_PEM`; rotation = partner notice → secret update → redeploy.
- **DO NOT** persist or log the partner's free-text `reason` (any shape is tolerated; only its length is recorded).
- **Ordering (no nonce table until PR-B):** an event is stale if OLDER than the floor (`last_event_at`, else `receipt_issued_at`, else `bound_at`), or if it is an exact replay (same timestamp AND same event). A different event at the same timestamp is applied. `revoked` is terminal. Every non-stale event for a bound agent advances the clock (a metadata write even when status is unchanged) so a late replay can never slip in behind it.
- **Ownership:** `passport.suspended` sets `suspended_by: 'computeid'`; `passport.reinstated` lifts a suspension ONLY when that marker is present — an org admin's own suspension (PATCH /agents/:id) is never undone by a partner event.
- **Keys are the enforcement point** (`apiKeyAuth` reads only `api_keys.is_active`): the handler deactivates keys BEFORE flipping the row to revoked/suspended, reactivates them AFTER the row is active (only keys with `revocation_reason = 'computeid:passport.suspended'`), and re-asserts the target key state on repeat events so a partial failure heals on retry.
- **Compare-and-set:** the `agents` update carries `.eq('status', <snapshot>)` and the snapshot's `last_event_at` (`is null` / `eq`), then `.select('id')`; zero rows → 409 `conflict_retry` + DLQ so the sender redelivers against fresh state.
- Both handlers read the flag, secrets and CA pin through the typed `config` export — never `process.env` (SCRUM-1258 ratchet). `middleware/computeidGate.ts` answers 503 at BOTH mounts before any parsing/auth work; the handlers keep their own check as defense in depth.
- Binding lookups use `.contains('metadata', { computeid: { passport_id } })` (jsonb `@>`); passport ids are lowercased at the Zod boundary so stored bindings and lookups always agree. `agents` is not in the tenant-isolation lint list, but every write re-scopes by `org_id`.

## Known gaps (tracked, not hidden)

- **No real receipt has ever been verified.** Flag flip (SCRUM-4495) is gated on a golden test against a receipt from a passport ComputeID issued to us. Needs the partner API key (SCRUM-4498).
- **Lost deliveries have no safety net** until the scheduled `/verify` re-check lands (SCRUM-4497). A `webhook_dlq` row records the loss.
- **The binding lives in org-admin-writable JSONB** (`agents.metadata`, RLS `agents_update_admin`, `CreateAgentSchema` passthrough): a tenant can strip, forge or future-date its OWN binding and dodge partner revocation of its own agents (self-harm, not cross-tenant). Durable fix = service-role-only binding columns + unique index + expression index for the `@>` lookup (SCRUM-4497).
- **No uniqueness on the binding** — concurrent admits of one passport into one org can both succeed; unique index is SCRUM-4497.
- `anchors` carries no agent attribution, so "every record names the acting agent" is not yet true (SCRUM-4497). The partner guide says so.
- Pre-existing, reported not fixed here: `PATCH /api/v1/agents/:agentId {status:'suspended'}` records a suspension without deactivating keys (the same decorative-suspension class); the revoked-is-terminal guard on that route IS in this PR.

## 2026-09-10 — Atomic enforcement correction (SCRUM-4535 / SCRUM-4536)

The old separate-write retry claim above was disproved by signed HTTP and concurrent PostgreSQL tests: a committed event clock could hide a failed key restore; a delayed restore could undo a later revoke. The pure `applyPassportEvent` decisions remain unchanged. The receiver now passes their agent update and key-enforcement output to migration `0448` in one locked transaction, with a full metadata/status snapshot comparison. Exact replay is safe after both writes commit. See `machines/agentPassportAtomic.machine.ts` and `scripts/ops/repro-computeid-agent-key-atomic.py`; these checks do not resolve the partner receipt/delivery gaps or authorize enabling the flag.


## 2026-09-10 — ComputeID historical review closure

The historical review repair normalizes UUID comparison after real Zod parsing (SCRUM-4568), accepts CR/LF-wrapped signature encoding without changing signed bytes, and enforces an explicit Arkova admission policy of at most 24 hours plus five-minute issue-time skew. This is not an asserted ComputeID contract; actual partner compatibility remains an activation gate. Revocation is terminal across organizations; a fresh receipt cannot reverse it. Equal-time reinstatement cannot relax suspension.

## 2026-09-12 — SCRUM-4495: the "no real receipt" gap is CLOSED, and a second event producer exists

**The headline gap above is closed.** `receipt-verifier.golden.test.ts` verifies the two REAL, partner-signed receipts captured 2026-09-07T18:54Z (`__fixtures__/real-verify-receipts.json` — both `GET /v1/agents/{id}/verify` bodies, public material only) against the committed real CA, with the production verifier. Real receipts live **five minutes**, so the test injects a fixed `now` inside each receipt's own signed window; nothing about the expiry rule was loosened, and two negative cases on those same bytes prove it (`expired` exactly at `expires_at`, `invalid_signature` on a one-character tamper). Flag activation still requires the operator steps in `docs/partners/computeid-activation-runbook.md` — a green golden test is a gate, not an activation.

| New file | Purpose |
|---|---|
| `passport-transition.ts` | The ONE way a passport event changes an agent: `findBoundAgents`, `applyPassportEventToAgent`, `recordPassportRevocationAuthority`, `recordPassportFailure`. Moved verbatim out of `api/v1/webhooks/computeid.ts`, which now only maps outcomes to HTTP |
| `verify-client.ts` | The ONLY outbound ComputeID call — `GET /v1/agents/{id}/verify`, used by the scheduled re-check alone. Origin from `config.computeidApiBaseUrl`; the sole caller-supplied component is a UUID-checked passport id; `redirect: 'error'`; abort timeout; size cap; no partner bytes in any error |
| `__fixtures__/real-verify-receipts.json` | The two real partner-signed `/verify` responses |

**Folder purity rule, stated precisely.** The "no logger, no config import" property belongs to the files `config.ts` imports at boot — `ca-cert.ts`, `secrets.ts`, `schemas.ts` — not to the folder. `passport-transition.ts` and `verify-client.ts` are outside that set and use `db` / `logger` / `config` normally. Do not add a `config` or `db` import to the first three.

**`readSignedReceiptStatus` vs `verifyComputeIdReceipt` (receipt-verifier.ts).** `verifyComputeIdReceipt` is the ADMISSION decision and refuses anything that is not `active` — correct for minting a key, useless for noticing a revocation. `readSignedReceiptStatus` returns the SIGNED status whatever it is, through the identical pin → signature → payload → field-agreement → passport-id sequence, and still enforces expiry. Admission-only policy (status must be `active`, issue-time skew, the 24-hour Arkova ceiling) stays in `verifyComputeIdReceipt` and was deliberately NOT refactored underneath it: its failure-reason ORDER is pinned by existing tests, and `expired` sits after `status_not_active` there. There is exactly one signature implementation; both entry points call it.

**Evidence asymmetry (the security-relevant decision in `jobs/computeid-passport-recheck.ts`).** Reinstating REACTIVATES API keys, so it is done only on a signature-verified receipt whose `passportSignatureValid` is not `false`. Revoking or suspending is the fail-safe direction and is also accepted on the unsigned `status` / `revoked_at` of a TLS + API-key authenticated response when the partner returns no receipt — otherwise the job would miss the exact revocation it exists to catch. A receipt that is PRESENT but fails verification is `unresolved`, never downgraded to the unsigned status; laundering a forged receipt into a weaker trust level is the failure this rule prevents.
