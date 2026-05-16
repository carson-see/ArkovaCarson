# agents.md — components/integrations
_Last updated: 2026-05-16_

## What This Folder Contains
Third-party integration connector cards for org admins to manage OAuth connections.

## Key Files
- `DocusignConnectorCard.tsx` — DocuSign OAuth connector: connect/disconnect, tokens never touch the browser (worker returns auth URL only)
- `DriveConnectorCard.tsx` — Google Drive OAuth connector: same pattern as DocuSign, tokens handled server-side only

## Dependencies
- `@/lib/workerClient` (workerFetch) — server-side OAuth URL generation
- `@/lib/supabase` — connection status reads

## Do / Don't Rules
- DO: Keep OAuth tokens server-side only — browser never sees or stores tokens
- DO: Use `workerFetch` for all OAuth URL generation
