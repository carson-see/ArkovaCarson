# agents.md — services/worker/src/integrations/connectors/

_Last updated: 2026-05-16_

## What This Folder Contains

Vendor connector services and canonical event adapters. Each connector owns OAuth coordination, watch channel management, and document-fetch contracts. Adapters are pure functions that normalize vendor payloads into rules-engine events.

| File | Purpose |
|------|---------|
| `schemas.ts` | Zod schemas for all vendor webhook payloads (Drive, DocuSign, Adobe, Checkr, Veremark) |
| `adapters.ts` | Pure-function adapters: vendor payload -> canonical `TriggerEvent` for rules engine |
| `googleDrive.ts` | Google Drive connector — OAuth, Secret Manager tokens, 7-day watch channels, event shaping |
| `docusign.ts` | DocuSign connector — retryable signed-document fetch, account token resolution |
| `drive-changes-processor.ts` | Drive changes feed processor — paginated, deduped, folder-matched event emission |
| `drive-changes-runner.ts` | Webhook-to-processor glue — token refresh, watched-folder-id resolution |
| `drive-folder-resolver.ts` | Drive parent-chain folder path resolver (20-level depth cap, 15-min TTL cache) |

## Do / Don't Rules

- **DO** keep adapters as pure functions (no I/O, no DB) for testability
- **DO** use the injected `db` and `fetch` for all I/O in connector services
- **DO NOT** persist raw OAuth tokens — connector services must use KMS encryption
