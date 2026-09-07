# agents.md — services/worker/src/api/v1/webhooks/

_Last updated: 2026-09-07 (SCRUM-4493: ComputeID AgentPassport revocation receiver)_

## 2026-09-07 — SCRUM-4493: `computeid.ts` — ComputeID AgentPassport revocation receiver (flag-gated dark)

Forked from `checkr.ts`. Three things are deliberately different and are the first places to look when this handler behaves unlike its siblings:

1. **One Arkova-global registration, not per-org.** ComputeID signs every delivery with the single secret we handed them at `POST /v1/webhooks/register`; the org is resolved from the passport → agent binding (`agents.metadata.computeid.passport_id`, jsonb `@>` lookup), not from an account header. `COMPUTEID_WEBHOOK_SECRET` may be a comma-separated list (current,next) because ComputeID has **no deregister/rotate endpoint** (verified live 2026-09-07) — rotation is register-new → ask the partner to retire old.
2. **No nonce table.** A per-provider nonce table needs a migration, which is PR-B (SCRUM-4497). Replay safety comes from the ordering FLOOR on the SIGNED payload timestamp in `integrations/computeid/binding.ts` (last applied event, else the admitting receipt's `issued_at`, else `bound_at`): older events and exact replays are no-ops, a late `passport.reinstated` can never undo a later `passport.revoked`, a pre-admission replay cannot revoke a fresh agent, and `revoked` is terminal. Do not "fix" a duplicate delivery by adding a nonce here.
4. **Keys first, then a compare-and-set.** The auth path reads only `api_keys.is_active`, so keys are deactivated BEFORE the row flips (and reactivated after, only the ones we suspended); the `agents` update is a CAS on `(status, metadata->computeid->>last_event_at)` with `.select('id')`, and zero rows → `409 conflict_retry` + DLQ. `passport.reinstated` lifts only a suspension carrying `suspended_by: 'computeid'`.
5. **Its own limiter bucket, content-type-agnostic raw parsing, real 413.** `rateLimiters.computeidWebhook` (not the shared Stripe bucket); `express.raw({ type: () => true, limit })` because the HMAC is the authentication and a `text/plain` default must not become a 500; body-parser's `entity.too.large` is mapped to `413 payload_too_large` at the mount (it is not an `AppError`, so the global handler would have returned 500). `middleware/computeidGate.ts` runs first at the mount.
3. **Ack semantics.** `test` and unknown event names → `200 ignored`. Unbound passport → `200 orphaned` + `webhook_dlq` row (reason `unbound_passport`). A DB failure mid-apply → `500` + DLQ so the partner can retry — but their delivery is `node-fetch` fire-and-forget with undocumented retry, so treat every 5xx as a probable loss until SCRUM-4497's re-verify cron exists.

Signature contract verified against a real delivery (`integrations/computeid/__fixtures__/golden-test-delivery.json`): `X-ComputeID-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`, no timestamp header. The `sha256=` prefix is required; a bare hex digest is rejected. Body cap 64 KiB, checked before signature verification. The partner-supplied free-text `reason` is never logged, never written to `audit_events.details`, never written to the DLQ — `computeid.test.ts` pins that with a serialized-args assertion.


## 2026-08-23 — SCRUM-3479 (AUDIT-0424-10): `checkr.ts` and `ats.ts` now release the replay nonce on post-nonce 5xx

Both handlers committed their replay nonce BEFORE the downstream write and never compensated it, so the "DO release the nonce before returning any post-nonce 5xx" rule below was documented but unenforced in two of the four nonce-using handlers. `middesk.ts` was the only correct implementation.

**`checkr.ts`** was the live defect: the `checkr_webhook_nonces` insert ran before `enqueue_rule_event`, and the enqueue-failure branch returned `500` without deleting it. One transient Postgres blip therefore dropped a `report.completed` **permanently** — Checkr's retry hit the `(report_id, payload_hash)` UNIQUE violation and got `200 {duplicate:true}`, so the background check was lost *and* the vendor was told it succeeded. Both post-nonce 5xx paths (enqueue failure + the catch-all) now call `releaseNonce`.

**`ats.ts`** carried the same defect on its catch-all path: the nonce is committed before the attestation lookup, so a throw there permanently lost the verification response the webhook exists to produce.

**The `webhook_dlq` row is not a mitigation.** Nothing under `services/worker/src/jobs/` reads that table — `webhook_dlq` is written by three handlers (`checkr.ts`, `docusign.ts`, `adobe-sign.ts` — verified with `grep -rn "from('webhook_dlq')" services/worker/src`) and drained by nobody. Treat a DLQ insert as a record of the loss, never as a recovery path, and do not let its presence justify skipping the nonce release.

**Residual risk you are accepting when you copy this (review addition).** The release is an at-least-once trade, not a free win. If the downstream call *throws* after Postgres committed it, "did it happen" is unknowable, and releasing the nonce lets the retry enqueue a second time. Nothing de-dupes that: `enqueue_rule_event` is a bare INSERT with no `ON CONFLICT`, and the executions idempotency index is `UNIQUE(rule_id, trigger_event_id)` where `trigger_event_id` is the per-enqueue rule-event id — two enqueues are two distinct keys, not one. A rare duplicate execution is the right trade against guaranteed silent loss, but state it rather than implying the delete is consequence-free. Closing the window properly needs an idempotency key threaded into `enqueue_rule_event`; that is a separate change.

**Guard that matters when copying this pattern:** release ONLY a nonce the current delivery actually committed (`checkr.ts` uses a `nonceCommitted` flag, `ats.ts` a `committedNonce` claim object). Both handlers wrap work that runs *before* the insert in the same `try`, and `checkr.ts` additionally fails open on a non-23505 insert error — in those cases a row matching the key belongs to an EARLIER delivery, and deleting it would silently re-open that delivery to replay. Filter on every column of the UNIQUE key for the same reason (`checkr`: `report_id` + `payload_hash`; `ats`: `provider` + `integration_id` + `signature`). The release is best-effort and swallows its own throw so it can never mask the original failure. Tests: `describe('SCRUM-3479: ...')` in `checkr.test.ts` and `ats.test.ts` pin the release, the no-release-on-success case, and the never-delete-an-uncommitted-nonce case.

**Third instance, NOT fixed here — `adobe-sign.ts` (verified by review).** It has the same defect: the `adobe_sign_webhook_nonces` insert runs before `enqueueRuleEvent`, and the catch-all returns `500` with no release, so a transient failure permanently drops the agreement event behind a `200 {duplicate:true}`. Its UNIQUE key is `(agreement_id, payload_hash)`, so a release must filter on both. Deliberately left out of this change rather than silently widening a T2 package to a third handler — it needs its own ticket and its own soak coverage.

**Known gap, NOT fixed here (needs a migration, so it is out of this change's tier):** `checkr_webhook_nonces` and `kyb_webhook_nonces` are absent from both `jobs/nonce-sweep.ts`'s `NONCE_TABLES` and the `sweep_webhook_nonces` RPC allowlist in migration `0316`. Both table comments promise a 14-day sweep that never runs, so their rows accumulate forever. Adding the table name to `NONCE_TABLES` alone would fail at runtime — the RPC raises `table "%" not in allowlist` — so this needs a compensating migration alongside the code change.

## 2026-08-03 — GH #1836 (SECURITY, pen-test scope): legacy org-id Drive channel token — accept-with-warning by default, code-flagged hard cutoff available

`drive.ts` already did the correct thing on the auth side: constant-time compare `X-Goog-Channel-Token` against the STORED token (never the org id directly), fail-closed 401 on mismatch or missing-stored-token. The vulnerability was upstream — that stored value USED TO BE the org's own UUID (fixed in `api/v1/integrations/agents.md`'s GH #1836 entry) — not a flaw in this comparison itself.

Added: when `lookup.channel_token === lookup.org_id` (the row is definitionally still on the pre-fix scheme — a real random token would essentially never collide with the org's own UUID), the webhook by default still ACCEPTS the request (backward compat is required — existing channels must keep delivering until GH #1835's renewal sweep rotates them to a real secret) but logs a bounded `logger.warn` naming the channel/org so ops can track deprecation progress. **Never logs the token value itself** — the check compares the ALREADY-VERIFIED stored token against the org id, no secret material touches the log line. Tests: `drive.test.ts` `describe('GH #1836: legacy org-id channel-token deprecation window')` — asserts the warning fires for a legacy token and does NOT fire for a modern random one, and that `"channel_token"` never appears in any `logger.warn` call's serialized arguments.

**Round-3 correction: the 7-day Drive channel expiry does NOT bound this vulnerability.** This check authenticates against the STORED token only — it never asks Google whether the channel is still live — so a forged POST carrying a known/guessed org UUID keeps authenticating regardless of Drive-side expiry, indefinitely, if the renewal cron is never deployed. See `api/v1/integrations/agents.md`'s corrected "Live-window honesty" note for the full writeup.

**Backstop**: `config.enableDriveLegacyChannelTokenRejection` (default off). When true, the branch above REJECTS (401 `legacy_channel_token_rejected`) instead of accept-and-warn — a hard cutoff for the case where the renewal cron was never deployed and legacy-token exposure would otherwise persist indefinitely. Tests: `describe('enableDriveLegacyChannelTokenRejection backstop (default OFF)')` — rejects when on, still accepts a MODERN random token when on (only the legacy scheme is cut off), and confirms default-off behavior is unchanged.

**Parser convergence**: `resolveDriveChannel`'s `account_label` parse now routes through the canonical `parseDriveAccountLabel()` (`integrations/connectors/drive-account-label.ts`) instead of its own inline `JSON.parse` — see that file's doc comment for the other 3 sites it replaced.

## What This Folder Contains

Inbound webhook handlers for third-party integrations. Each handler verifies HMAC signatures, normalizes payloads via canonical adapters, and enqueues sanitized events for the rules engine. Raw payloads are never persisted.

| File | Purpose |
|------|---------|
| `adobe-sign.ts` | Adobe Sign `AGREEMENT_WORKFLOW_COMPLETED` handler — HMAC-SHA256 base64, `adaptAdobeSign` normalization |
| `docusign.ts` | DocuSign Connect `envelope-completed` handler — lookup-first HMAC verify (SCRUM-2043), HMAC verified for unknown accounts too (env-var key), dual-table lookup: org_integrations then member_integrations (SCRUM-2044), sanitized event + document-fetch job + SCRUM-1872 notarization detection. SCRUM-1649: carries single-document SHA-256 into rule-event payloads via `document_hashes` / `document_sha256` for downstream post-signing anchor materialization. SCRUM-2362 (DS-02): invalid sig → 401 fail-closed; duplicate signed event → 200 with no duplicate queue materialization (nonce table); orphan → 200 bounded + DLQ-audited; raw-payload PII (sender/notary email, doc fingerprint) never reaches logger/Sentry/Error — pinned by the `no raw-payload PII leak` test suite |
| `docusign-hmac-helpers.ts` | SCRUM-2043: resolves HMAC keys from per-org `hmac_keys` JSONB or env-var fallback |
| `docusign-hmac-rotation.test.ts` | Tests for multi-key HMAC verification flow and key resolution |
| `drive.ts` | Google Drive push notification handler — headers-only signal, channel-token verification |
| `ats.ts` | ATS webhook handler (Greenhouse, Lever) — HMAC verify, attestation verification response. SCRUM-3479: releases the nonce on the catch-all 5xx path |
| `computeid.ts` | ComputeID AgentPassport `passport.revoked` / `.suspended` / `.reinstated` receiver — HMAC-SHA256 hex with `sha256=` prefix, comma-separated secrets for rotation, ordering floor instead of a nonce table (SCRUM-4493), keys deactivated BEFORE the row flips (suspend and revoke), compare-and-set on the agent row (409 on a lost race), ownership-aware reinstate, DLQ on orphan/failure. Gated by `ENABLE_COMPUTEID_INTEGRATION` via `computeidGate` |
| `checkr.ts` | Checkr `report.completed` handler — HMAC-SHA256 hex, nonce replay protection, DLQ on failure. SCRUM-3479: releases the nonce on both post-nonce 5xx paths so a transient enqueue failure stays retryable |
| `middesk.ts` | Middesk KYB handler — `business.updated/verified/rejected` events, org verification status transitions |
| `microsoft-graph.ts` | Microsoft Graph change-notifications — `clientState` verification, validation handshake echo |
| `veremark.ts` | Veremark stub — gated behind `ENABLE_VEREMARK_WEBHOOK`, returns 503 until vendor docs confirmed |

## Do / Don't Rules

- **DO** verify HMAC signatures before processing any webhook payload
- **DO** use nonce/idempotency tables to prevent replay attacks
- **DO** release the nonce before returning any post-nonce 5xx (AUDIT-0424-10). The nonce is committed before the downstream writes, so an un-compensated failure is unrecoverable, not retryable: the provider re-presents the same event id, hits the UNIQUE violation, and is answered `200 {duplicate:true}` — the event is dropped *and* the provider is told it succeeded. `middesk.ts::releaseNonce` is the reference implementation (mirrors the `webhook_event_claims` compensating delete in `stripe/handlers.ts`). Never release on the success path.
- **DO** keep the set of status literals a handler writes in parity with the DB CHECK constraint that admits them. `middesk.ts` wrote `'REJECTED'`/`'REQUIRES_INPUT'` into `organizations.verification_status` for months while the constraint admitted only `UNVERIFIED/PENDING/VERIFIED`, so every KYB rejection raised SQLSTATE 23514 and was silently lost. Mocked-DB unit tests cannot catch this — `middesk.test.ts` carries a parity test that reads the migration set directly.
- **DO NOT** persist raw webhook payloads — only sanitized canonical events reach the database
- **DO NOT** log webhook bodies that may contain PII (EIN, addresses, etc.)

## Conventions

- Signature/channel validation happens before any DB write.
- Unknown external accounts are acknowledged without cross-tenant data leakage.
- Ambiguous account-to-org mappings fail closed.
- Sanitized rule-event payloads may include provider IDs needed for idempotency, but not raw documents or raw webhook bodies.
- Connector payloads that carry PII must hash values before storing long-lived operational metadata. PII scrubbing is mandatory; do not persist emails, document fingerprints, or API keys.
