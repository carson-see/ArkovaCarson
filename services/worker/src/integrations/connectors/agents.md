# agents.md — services/worker/src/integrations/connectors/

_Last updated: 2026-07-01 (PI-0 S2 Lane 3: DRIVE-01/02/03/06 verified-only connect + watch-state bootstrap + dedupe + channel renewal)._

## What This Folder Contains

Vendor connector services and canonical event adapters. Each connector owns OAuth coordination, watch channel management, and document-fetch contracts. Adapters are pure functions that normalize vendor payloads into rules-engine events.

| File | Purpose |
|------|---------|
| `schemas.ts` | Zod schemas for all vendor webhook payloads (Drive, DocuSign, Adobe, Checkr, Veremark) |
| `adapters.ts` | Pure-function adapters: vendor payload -> canonical `TriggerEvent` for rules engine |
| `googleDrive.ts` | Google Drive connector — OAuth, Secret Manager tokens, 7-day watch channels, event shaping |
| `docusign.ts` | DocuSign connector — retryable signed-document fetch, account token resolution |
| `docusign-token-store.ts` | DocuSign refresh-token Secret Manager store — org + member-level naming (SCRUM-2044) |
| `drive-changes-processor.ts` | Drive changes feed processor — paginated, deduped, folder-matched event emission |
| `drive-changes-runner.ts` | Webhook-to-processor glue — token refresh, watched-folder-id resolution |
| `drive-folder-resolver.ts` | Drive parent-chain folder path resolver (20-level depth cap, 15-min TTL cache) |
| `drive-connect-eligibility.ts` | **DRIVE-01 (SCRUM-2366)**: verified-only Google Drive connect gate. Org-admin / paid-verified-individual paths, resolved via the canonical owner-inclusive resolver (`api/_org-auth.ts`), never `org_members` alone. Re-evaluated at start AND callback so an existing/stale token can't bypass a lapsed entitlement. Fail-closed to `lookup_failed`. |
| `drive-watch-bootstrap.ts` | **DRIVE-02 (SCRUM-2367)**: folder-watch bootstrap → persists initial page token, channel id/expiry, owner scope (my_drive vs shared_drive), status into `drive_watch_state` (mig 0351) via `upsert_drive_watch_state`. Folder-permission failures → `status='permission_denied'` (no throw); folder id mismatch → `failed`. `folder_path`/`owner_email` are sensitive — persisted to the RLS row ONLY, never logged. |
| `drive-change-dedupe.ts` | **DRIVE-03 (SCRUM-2368)**: pure change classifier + revision dedupe key + bounded/PII-scrubbed audit projection. Ignores removed/trashed/unsupported-MIME; each `(file_id, revision)` queues once (backed by `drive_revision_ledger` UNIQUE). Companion to `drive-changes-processor.ts`. |
| `drive-channel-renewal.ts` | **DRIVE-06 (SCRUM-2371)**: pure channel-renewal sweep — renews before expiry, alerts + marks `degraded` on failure, recovers expired channels idempotently, STOPS a watch whose org lost entitlement. **NO cron** — cadence is a HANDOFF to Lane 2's Cloud Scheduler → HTTP `/jobs/*` (node-cron does not fire on throttled Cloud Run). |

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
