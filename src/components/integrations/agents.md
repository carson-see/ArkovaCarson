# agents.md — components/integrations
_Last updated: 2026-07-28 (SCRUM-2903 GD-PROD, PR #1654 Lane 3 B1: DriveConnectorCard last-synced + documents-secured-count)_

## What This Folder Contains
Third-party integration connector cards for org admins and members to manage OAuth connections.

## Key Files
- `DocusignConnectorCard.tsx` — Org-level DocuSign OAuth connector: connect/disconnect, tokens never touch the browser (worker returns auth URL only). Queries `org_integrations`. SCRUM-2361 (DS-01): the *connect* action is gated on the shipped verified-org signal via `useCanIssueCredential` (SCRUM-1755) — denied orgs see `CONNECTIONS_LABELS.DOCUSIGN_NOT_VERIFIED` with a disabled Connect button (`data-testid="docusign-gate-denied"`); the worker `/oauth/start` is the authoritative gate, this is UX defense-in-depth. Disconnect is never gated. Mounted in `src/pages/OrgProfilePage.tsx` Settings tab. NOTE (2026-07-28): does NOT show a last-synced timestamp or a DocuSign-sourced-anchor count — same gap DriveConnectorCard closed below; a symmetric follow-up for DocuSign is a candidate but out of scope for SCRUM-2903.
- `MemberDocusignConnectorCard.tsx` — Member-level DocuSign OAuth connector (SCRUM-2044): same pattern as org-level but queries `member_integrations` and uses `/api/v1/integrations/docusign/member/*` endpoints. `data-testid="member-docusign-card"`.
- `DriveConnectorCard.tsx` — Google Drive OAuth connector: same pattern as DocuSign, tokens handled server-side only. Mounted alongside the DocuSign cards in `src/pages/OrgProfilePage.tsx` Settings tab — this is the only reachable UI surface for Drive connector status. **SCRUM-2903 GD-PROD (2026-07-28, #1654):** now also renders "Last synced `<timestamp>`" (from `org_integrations.last_token_advanced_at` — the changes-feed runner's page-token-advance watermark; falls back to "Not yet synced") and "`N` document(s) secured via Drive" (a `head:true` count query against `anchors` filtered on `metadata->>connector_source = 'google_drive'`, the field `connector-artifact-drain.ts` stamps on every Drive-materialized anchor). Both are additive reads on the existing connected-state branch — no new query fires while disconnected.

## Dependencies
- `@/lib/workerClient` (workerFetch) — server-side OAuth URL generation
- `@/lib/supabase` — connection status reads

## Do / Don't Rules
- DO: Keep OAuth tokens server-side only — browser never sees or stores tokens
- DO: Use `workerFetch` for all OAuth URL generation
- DO: Gate the org connect button on `useCanIssueCredential` (the verified-org entitlement), but treat it as UX only — the worker is the real gate. Never gate disconnect.
