# integrations/zapier/src/triggers/agents.md

Zapier trigger definitions for Arkova (INT-05). REST hook based (subscribe/unsubscribe).

## Files
- **`anchorSecured.ts`** — fires when a document reaches `SECURED` status (Bitcoin-confirmed). Uses `anchor.secured` webhook event.
- **`anchorRevoked.ts`** — fires when an anchor is revoked. Uses `anchor.revoked` webhook event.

## Conventions
- Triggers auto-manage webhook lifecycle: Zapier calls subscribe on Zap enable, unsubscribe on disable.
- Sample data is embedded for Zapier's UI preview.
