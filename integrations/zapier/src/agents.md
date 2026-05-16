# integrations/zapier/src/agents.md

Zapier app source code (INT-05).

## Files
- **`index.ts`** — Zapier app entry point: registers authentication, triggers, and actions.
- **`authentication.ts`** — API key auth: user provides `ak_*` key, validated via health endpoint.
- **`constants.ts`** — `BASE_URL`, `DEFAULT_EVENTS`, `VALID_WEBHOOK_EVENTS`, `BATCH_SYNC_LIMIT`.
- **`makecom.json`** — Make.com (Integromat) integration manifest.
- **`actions/`** — Zapier action definitions (anchorDocument, verifyCredential, batchVerify).
- **`triggers/`** — Zapier trigger definitions (anchorSecured, anchorRevoked).

## Conventions
- All actions hit the `/api/v1/` endpoints with `X-API-Key` header.
- Batch verify is capped at `BATCH_SYNC_LIMIT` (20) credentials per request.
- `credential.*` webhook events require explicit opt-in (SCRUM-1743).
