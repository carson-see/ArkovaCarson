# Changelog

All notable changes to the `arkova-mcp-server` npm package (the stdio MCP
server). This file starts at 3.2.0; for anything earlier, see
`git log -- sdks/mcp-server/`. Versions are released independently from the
`arkova` TypeScript SDK and the `arkova` Python package.

## 3.2.0

Additive. No tool is renamed or removed.

- Add the `arkova_import_rows` tool: import 1–100 already-fingerprinted
  spreadsheet rows through the canonical queue or instant submission path.
  Never accepts document bytes. The tool is spelled identically on the hosted
  edge server, so this name does not drift.
- `arkova_import_rows` reports two per-row statuses that mean the anchor
  committed and only the recipient link failed — `created_recipient_failed`
  and `skipped_recipient_failed`. An agent reading either **must not re-import
  the row**: the record already exists, and re-importing it is a duplicate
  submission that can consume credit on a capped organization. The tool
  description states this so the constraint reaches the agent at discovery
  time.
- The import response carries an additive `recipient_link_failed` counter.
  Those rows are already counted in `created`/`skipped` and never in `failed`.

## 3.1.0

Adds `arkova_manage_folders` for nested personal and organization record
folders, connector destination binding, and bounded bulk moves.

## 3.0.0 — breaking

Three tools renamed away from the word "credential", which in an agent tool
namespace reads as *authentication secrets* rather than *verified records*:
`arkova_verify_credential` → `arkova_verify_anchor`, `arkova_credential_status`
→ `arkova_anchor_status`, `arkova_search_credentials` → `arkova_search_anchors`.
The four `nessie_`-prefixed tools were removed outright. No aliases.
