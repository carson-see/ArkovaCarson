# Changelog

All notable changes to the `arkova` TypeScript SDK. This file starts at 3.2.0;
for anything earlier, see `git log -- packages/sdk/`. Versions are released
independently from the `arkova-mcp-server` npm package and the `arkova` Python
package.

## 3.3.0

- Add typed generic agent registration, list, detail, update, revoke and one-time key creation, plus ComputeID passport admission.
- Validate outbound agent scopes, callbacks and signed receipt shape before sending. Lifecycle mutations never retry automatically.
- Preserve safe nested API error codes and fields while dropping unknown secret-bearing error data. Malformed successful responses fail as `unexpected_response` rather than manufacturing unusable one-time keys.
- Preserve complete single-leaf proof bundles. An empty Merkle branch is
  accepted only when `leaf_count=1`, `merkle_index=0`, and the fingerprint
  equals the root; incoherent empty branches still fail closed to `null`.

## 3.2.0

Additive. No existing method changes shape.

- Add `anchorImport(rows, options)` for canonical 1–100 row spreadsheet
  imports through `POST /api/v1/anchor/import`. Rows carry fingerprints and
  metadata only — never document bytes. Write responses are never
  automatically retried, because a lost response may contain durable per-row
  receipts.
- `AnchorImportResultRow.status` includes `created_recipient_failed` and
  `skipped_recipient_failed`. Both mean the anchor committed and only the
  recipient link failed: **the record exists, so do not re-submit the row.**
- `AnchorImportResponse.recipientLinkFailed` counts those rows. It is additive:
  they are already counted in `created`/`skipped` and never in `failed`, so
  `created + skipped + failed` still equals `total`. A worker that predates the
  field reads as `0`.

## 3.1.0

Adds the canonical nested folder management client (`Folder`,
`CreateFolderInput`, `BulkFolderMoveResult`) without changing existing methods.

## 3.0.0 — breaking

Key-hygiene release. `apiKey` / `x402Config` moved to ECMAScript `#`-private
fields: a TypeScript `private` field is still enumerable and was leaking the raw
key through `JSON.stringify` / `Object.keys`. Retry safety changed observable
behaviour for non-idempotent methods on 429/5xx.
