# integrations/clio/src/agents.md

Clio integration source code (INT-06).

## Files
- **`connector.ts`** — `ClioConnector`: OAuth2 client for Clio API v4 (documents, contacts, matters). Handles token refresh.
- **`sidebar-widget.ts`** — `ClioSidebarWidget`: one-click document anchoring from the Clio sidebar. Client-side SHA-256 hashing.
- **`cle-compliance.ts`** — CLE compliance tab: bar number lookup, CLE hour tracking, jurisdiction requirements lookup.
- **`webhook-handler.ts`** — processes Clio webhook events for automatic verification.
- **`types.ts`** — TypeScript interfaces: `ClioConfig`, `ClioDocument`, `ClioContact`, `CleStatus`, etc.
- **`index.ts`** — barrel export.

## Conventions
- OAuth tokens must be refreshed before expiry; `ClioConnector` handles this internally.
- CLE requirements are per-jurisdiction (CA, NY, TX, etc.) and defined as constants.
