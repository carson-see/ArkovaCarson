# agents.md — components/connectors

_Last updated: 2026-09-21 (`DriveConnectorCard.tsx`: unconnected-state prompt moved to `copy.ts`'s `DRIVE_CONNECT_PROMPT`, wording corrected for the drive.readonly cutover — SCRUM-5287/SCRUM-2903/SCRUM-2330)_
_Last updated: 2026-09-14 (status row deduplicated against `components/integrations/ConnectorCardStatusRow.tsx`)_

## 2026-09-14 — `DriveConnectorCard.tsx` / `DocusignConnectorCard.tsx` now use the shared status row

Both cards' status-icon / badge / Connect-Disconnect block is gone from this folder — it now
renders `components/integrations/ConnectorCardStatusRow.tsx` (see that folder's agents.md), the
same component PR #2934 extracted from `AdobeSignConnectorCard.tsx` /
`MemberDocusignConnectorCard.tsx`. That block was the SonarCloud new-code duplication finding
(~4.2% vs the 3% gate) — four near-identical copies across two folders. Card-specific detail
(account label, subscription/last-synced lines, the DS-01 entitlement-denied notice) stays in each
card as `children` passed to the shared row; only the chrome moved. Button copy changed from each
card's own wording to the shared generic `CONNECTIONS_LABELS.CONNECT_BUTTON` /
`DISCONNECT_BUTTON`; `DriveConnectorCard.test.tsx` was updated to match (was asserting the literal
`Connect Drive` string).

## What This Folder Contains

The Connectors page's building blocks — `src/pages/ConnectorsPage.tsx` composes these, it does not
live here itself. One rule engine, zero new semantics: everything here writes exactly one
`organization_rules` row per connector per org through the EXISTING `/api/rules` CRUD.

## Key Files

- `DriveConnectorCard.tsx` / `DriveConnectorCard.test.tsx` — **MOVED here from
  `src/components/integrations/`** (was mounted directly on `OrgProfilePage`'s Settings tab; now
  composed by `ConnectorsPage`, and Settings shows a link row instead — PM-11). Unchanged otherwise:
  connect/disconnect only, tokens never touch the browser, `org_integrations` select stays
  column-pinned (no `account_label`/`encrypted_tokens`/`token_kms_key_id` — the GH #1836 lesson,
  still pinned by this card's own test).
- `DocusignConnectorCard.tsx` / `DocusignConnectorCard.test.tsx` — **MOVED here** for the same
  reason. Its two shared dependencies (`useSignatureConnection`, `signatureOAuthResponse`) were
  **NOT** moved — `AdobeSignConnectorCard` (staying in `components/integrations/`, §1.2) also depends
  on `useSignatureConnection`. This card imports them via `../integrations/...`.
- `useConnectorRule.ts` / `.test.ts` — load/adopt/create/patch a connector's `organization_rules`
  row (D4/D5). Counts the org's ENABLED rules matching the connector's `trigger_type`: 0 → next Save
  creates; 1 → next Save adopts (PATCH) that rule; 2+ → the page renders read-only "Managed in
  Rules" and this hook is not asked to save. Every write pairs `action_type` with `action_config` in
  the SAME request — D4 exists precisely because the worker's `UpdateOrgRuleInput` silently drops an
  unpaired `action_type`. On a `409 rule_exists` from the worker's server-side race guard (the
  DocuSign auto-seeder can land between this hook's load and its create), it adopts the winning
  rule instead of surfacing a raw error.
- `ConnectorActionChoice.tsx` / `.test.tsx` — the two-option radio group (D1): "Secure it
  immediately" → `INSTANT_SECURE`, "Add it to the secure queue" → `AUTO_ANCHOR`. Deliberately NOT
  three options — `QUEUE_FOR_REVIEW` ("Hold for my review") is named and deferred in the spec (§9),
  not hidden. Stacked always, never side-by-side (mobile).
- `DriveFolderPicker.tsx` / `.test.tsx` — the folder picker dialog. My Drive only (D2 — no
  `drive=` param, `includeItemsFromAllDrives=false` on the worker side); renders every folder as
  expandable (`hasChildren` is always `null` from the API — Drive has no cheap "has subfolders"
  signal); 20-folder cap enforced client-side to match the worker's Zod `.max(20)`; every failure
  `code` in the worker's response table (§2.2) maps to specific copy, an unmapped code falls back to
  the generic `CONNECTOR_LOAD_FAILED`, and `insufficient_drive_scope` / `reconnect_required` render
  a **Reconnect** control instead of Retry.

## Do / Don't Rules

- DO write `action_type` and `action_config` together in every PATCH — never one without the other
  (`useConnectorRule.save`already does this; do not add a call site that patches only `action_type`).
- DO persist folder **names** (`drive_folders[].folder_name`, capped at 120 chars client-side) but
  NEVER folder **paths** — `folder_path` is not in the write shape. See
  `services/worker/src/rules/schemas.ts`'s `organization_rules_trigger_config_size` 16 KB budget;
  20 folders × a 2000-char path would blow it.
- DO treat `action_config.tag` (`connector-<provider>`) as a display/reconciliation marker only —
  never as an authorization signal. It is caller-supplied.
- DON'T call the folder-picker endpoint on mount — only when the picker dialog opens
  (`DriveFolderPicker` fetches lazily inside its own `open` effect).
- DON'T add a third action option here. If `QUEUE_FOR_REVIEW` ships, it is a new radio value plus
  copy stating plainly that nothing is secured until a human approves it (§9) — not a relabeling of
  the existing two.
- DON'T duplicate `DriveConnectorCard/DocusignConnectorCard` back onto `OrgProfilePage` — they were
  MOVED, not copied (PM-11). If a third surface needs one of these cards, import it from here.

## Dependencies

- `@/lib/workerClient` (`workerFetch`) — `/api/rules` (existing CRUD) and the new
  `/api/v1/integrations/google_drive/folders` (session-authenticated, org-admin only).
- `@/lib/supabase` — read-only `org_integrations` connection-status probes (column-pinned).
- `@/components/ui/dialog`, `@/components/ui/checkbox` — no new UI primitive dependency added for
  the picker; there is no `radio-group` or `sheet` component in this repo yet, so
  `ConnectorActionChoice` uses plain `<input type="radio">` and `DriveFolderPicker` uses `Dialog`
  styled full-width/full-height below `sm` rather than a separate sheet component.
