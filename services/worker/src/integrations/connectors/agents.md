# agents.md — services/worker/src/integrations/connectors/

_Last updated: 2026-06-16 (SCRUM-2492 connector-byte-safety Do/Don't)._

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
| `drive-changes-processor.ts` | Drive changes feed processor — paginated, deduped, folder-matched event emission |
| `drive-changes-runner.ts` | Webhook-to-processor glue — token refresh, watched-folder-id resolution |
| `drive-folder-resolver.ts` | Drive parent-chain folder path resolver (20-level depth cap, 15-min TTL cache) |

## Do / Don't Rules

- **DO** keep adapters as pure functions (no I/O, no DB) for testability
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
