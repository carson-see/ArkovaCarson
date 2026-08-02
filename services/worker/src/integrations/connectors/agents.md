# agents.md — services/worker/src/integrations/connectors/

_Last updated: 2026-07-01 (PI-0 S2 Lane 3: DRIVE-01/02/03/06 verified-only connect + watch-state bootstrap + dedupe + channel renewal)._

## What This Folder Contains

Vendor connector services and canonical event adapters. Each connector owns OAuth coordination, watch channel management, and document-fetch contracts. Adapters are pure functions that normalize vendor payloads into rules-engine events.

| File | Purpose |
|------|---------|
| `schemas.ts` | Zod schemas for all vendor webhook payloads (Drive, DocuSign, Adobe, Checkr, Veremark) |
| `adapters.ts` | Pure-function adapters: vendor payload -> canonical `TriggerEvent` for rules engine |
| `googleDrive.ts` | Google Drive connector — OAuth, Secret Manager tokens, 7-day watch channels, event shaping |
| `docusign.ts` | DocuSign connector — retryable signed-document fetch, account token resolution. DS-04: `DocusignResolvedConnection` + the `enqueueSignedDocument` sink now carry `scope` (`'org'`/`'member'`) + `ownerUserId` for personal-queue routing |
| `docusign-connection-resolver.ts` | Sub-org connection resolution (SCRUM-2045). DS-04 (SCRUM-2364): resolves `scope`/`ownerUserId` — a `member_integrations` row's `owner_user_id` ⇒ `scope='member'` (personal queue); org-owned / inherited connections ⇒ `scope='org'` |
| `docusign-token-store.ts` | DocuSign refresh-token Secret Manager store — org + member-level naming (SCRUM-2044) |
| `docusign-rule-seed.ts` | **SCRUM-3027**: auto-seed the "DocuSign Completion" rule (`ESIGN_COMPLETED` → `AUTO_ANCHOR`, queue-mode, **enabled**) on a successful org DocuSign connect. `seedDocusignCompletionRule()` is idempotent + **non-stomping** — if the org already has ANY `ESIGN_COMPLETED` rule (any action) it seeds nothing, never overriding an admin's choice. NEVER throws (failure-isolated: loud `logger.error` + Sentry, PII-safe = orgId only; fails CLOSED on an ambiguous lookup error). Config shapes are Zod-validated (`TriggerConfigEsignCompleted` / `ActionConfigAutoAnchor`); row is built from the canonical `rule-templates-data.ts` `docusign-completion` template. WIRED into `api/v1/integrations/docusign-oauth.ts` callback (fire-and-forget, after the integration upsert) — surfaces `docusign_completion_rule_seeded` / `_seed_failed` `integration_events`. `enabled=true` is intentional (explicit human connect action, no NL-authoring surface — distinct from the SEC-02 `enabled=false` CRUD path) |
| `drive-changes-processor.ts` | Drive changes feed processor — paginated, deduped, folder-matched event emission |
| `drive-changes-runner.ts` | Webhook-to-processor glue — token refresh, watched-folder-id resolution |
| `drive-folder-resolver.ts` | Drive parent-chain folder path resolver (20-level depth cap, 15-min TTL cache) |
| `drive-connect-eligibility.ts` | **DRIVE-01 (SCRUM-2366)**: verified-only Google Drive connect gate. Org-admin / paid-verified-individual paths, resolved via the canonical owner-inclusive resolver (`api/_org-auth.ts`), never `org_members` alone. Re-evaluated at start AND callback so an existing/stale token can't bypass a lapsed entitlement. Fail-closed to `lookup_failed`. **WIRED into `api/v1/integrations/drive-oauth.ts`** (`start` + `callback`) via `assertDriveConnectAllowed` + a `makeEligibilityDb` adapter — do NOT leave it importer-less again. |
| `drive-watch-bootstrap.ts` | **DRIVE-02 (SCRUM-2367)**: folder-watch bootstrap → persists initial page token, channel id/expiry, owner scope (my_drive vs shared_drive), status, `last_renewal_error` into `drive_watch_state` (mig 0351) via `upsert_drive_watch_state`. `persist()` forwards `p_last_renewal_error` — the RPC MUST declare that param (fixed in 0351: `p_last_renewal_error text DEFAULT NULL`, written on INSERT + ON CONFLICT UPDATE). Folder-permission failures → `status='permission_denied'` (no throw); folder id mismatch → `failed`. `folder_path`/`owner_email` are sensitive — persisted to the RLS row ONLY, never logged. |
| `drive-change-dedupe.ts` | **DRIVE-03 (SCRUM-2368)**: pure change classifier + revision dedupe key + bounded/PII-scrubbed audit projection. Ignores removed/trashed/unsupported-MIME; each `(file_id, revision)` queues once (backed by `drive_revision_ledger` UNIQUE). Companion to `drive-changes-processor.ts`. |
| `drive-channel-renewal.ts` | **DRIVE-06 (SCRUM-2371)**: pure channel-renewal sweep — renews before expiry, alerts + marks `degraded` on failure (token-revoked + renewal-failed paths), recovers expired channels idempotently, STOPS a watch whose org lost entitlement. **NO cron** — cadence is a HANDOFF to Lane 2's Cloud Scheduler → HTTP `/jobs/*` (node-cron does not fire on throttled Cloud Run). Status vocabulary the sweep + bootstrap write MUST all be permitted by the 0351 `drive_watch_state_status_check` CHECK: `active \| permission_denied \| expired \| stopped \| degraded \| failed` (`degraded` added 2026-07-01 — it was previously omitted and the first renewal failure would have violated the constraint). `drive-watch-state-rpc.test.ts` is the SQL-contract guard that keeps code↔CHECK vocabulary from drifting (mock-DB renewal tests can't catch a real constraint mismatch). |

## Do / Don't Rules

- **DO** keep adapters as pure functions (no I/O, no DB) for testability
- **DO** route every org-eligibility / admin check through `api/_org-auth.ts`
  (`getCallerOrgId*` / `isCallerOrgAdmin*`) — never re-resolve org from
  `org_members` alone (the #1325/#1326 owner-resolution-drift class).
- **DO** use the injected `db` and `fetch` for all I/O in connector services
- **DO NOT** persist raw OAuth tokens — connector services must use KMS encryption

### Connector document-byte safety (§1.6A / SCRUM-2492)

Connector-fetched documents (DocuSign / Google Drive) MAY be fingerprinted
server-side, but the raw bytes are radioactive: fetch → SHA-256 in memory →
discard. They must NEVER touch a logger, Sentry, an Error, `job_queue.last_error`,
a temp file, or Postgres. An ESLint rule (`arkova/no-connector-bytes-to-sink`,
ERROR on this tree + the `docusign-*` job files) enforces this at build time.

- **DON'T** log/throw/persist `documentBytes` (or any `Buffer`/`Uint8Array`/`*.bytes`).
  Pass only the fingerprint or `documentBytes.byteLength`. The canonical sink
  `enqueueSignedDocument` (`jobs/docusign-envelope-completed.ts`) persists only
  `byte_length` — keep it that way.
- **DON'T** give a connector error a `body`/raw-response field. `DocusignApiError`
  and `DriveApiError` are byte-safe BY CONSTRUCTION (`{ message, status }`, no
  body). On the document-fetch path, never read `response.body`/`arrayBuffer()`
  into an error — status + message only.
- **DON'T** rely solely on the lint. The runtime defences are: byte-safe error
  types, pino binary redaction (`utils/logger.ts` `redactBinaryValues`), type-based
  Sentry scrub (`utils/sentry.ts` `scrubBinaryValues`), and the `last_error`
  sanitizer (`utils/jobQueue.ts` `sanitizeLastError`). The multi-MB leak test is
  `jobs/connector-byte-safety.test.ts`.
- **DO** remember the lint is AST-only — a spread (`{ ...obj }`), cross-file flow,
  or a helper-return can hide bytes from it. The runtime guards above are the
  backstop; do not defeat them.

## SCRUM-3014 — Connect listener provisioning health (`docusign-connect-health.ts`)

- `provisionConnectListener()` is fire-and-forget from both DocuSign OAuth
  callbacks. It MUST stay non-fatal — but it must not be silent. Use
  `reportConnectProvisionFailure()` on every failure path: it logs the real
  DocuSign HTTP status + bounded `detail`, captures to Sentry, and flips
  `connector_alert_state` to `degraded` (the queue digest surfaces that as a
  failed connector).
- **DO** persist `docusign_status` / `docusign_detail` on the
  `*_connect_listener_failed` `integration_events` row. A bare `error.message`
  is what made the prod failures undiagnosable in the first place.
- **DO** call `markDocusignConnectorConnected()` on every success path — the
  degraded state is sticky by design (see `jobs/connector-health-alert.ts`) and
  nothing else clears it.
- **DO NOT** let anything in this module throw into the OAuth callback; every
  write is best-effort and logs on failure.
- **DO** settle the provisioning promise through `settleConnectProvisioning()`
  rather than hand-rolling a `.then(...).catch(...)` chain per router. Both
  callbacks and the reprovision endpoint differ only in their event-type names
  and `flow` tag; duplicating the chain drifted the two flows apart and tripped
  the Sonar new-code duplication gate. A throw from the SUCCESS-path event write
  deliberately falls through to the failure path — that is the behaviour of the
  chain it replaced, not an accident.


## 2026-08-01 DRIVE B1 — the changes cursor is seeded at CONNECT time, and only there

`last_page_token` on `org_integrations` is the Drive changes cursor. It has exactly **two** writers:

1. `createDriveOAuthRouter`'s callback (`api/v1/integrations/drive-oauth.ts`) — seeds it from the `startPageToken` that `createChangesWatch()` returns.
2. `advancePageToken` — only reachable from `processDriveChanges`, which **refuses to run without a token** (`drive-changes-runner.ts` skips with `no_page_token`).

So (2) can never run until (1) has happened. The callback used to type its local `subscription` as `{ resourceId; expiration }`, silently discarding the `startPageToken` the client already returned — which made the entire Drive changes pipeline unreachable by construction: a freshly connected org skipped forever, with no error anywhere. **Never drop `startPageToken` from that call site.**

The write is deliberately **conditional** (`...(subscription ? { last_page_token } : {})`), not `?? null`. This is an upsert: unconditionally writing null on a *failed re-watch* would wipe a working org's cursor, and nothing else can re-seed it, so every change from then on would be skipped silently. Omitting the column preserves the existing cursor. Both behaviours are pinned by tests in `drive-oauth.test.ts`.
