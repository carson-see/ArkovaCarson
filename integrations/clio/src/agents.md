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

## 2026-09-21 — ARKOVA_DEFAULT_URL de-duplicated onto integrations/shared (SCRUM-3888)

`sidebar-widget.ts` and `cle-compliance.ts` each declared their own private
`ARKOVA_DEFAULT_URL` copy (raw Cloud Run host — no Cloudflare origin guard in
front of it, and SCRUM-3888 will 403 it). Both now import
`ARKOVA_DEFAULT_URL` from `../../shared/src/constants` instead — same
`../../shared/src/constant-time` cross-package relative-import pattern
`webhook-handler.ts` already used (see that file's agents.md note: this
package's `noEmit: true` tsconfig means nothing lands outside `rootDir`, so
the import resolves cleanly under both `tsc --noEmit` and vitest without a
`package.json` dependency on `integrations/shared`, which has none). One
fewer place for the same literal to drift stale next time it moves.
`integrations/zapier` could NOT take the same fix — verified empirically:
zapier's tsconfig sets `noEmit: false` + explicit `rootDir: "src"` (it
actually emits via `tsc` for the Zapier platform build), so a relative
import reaching `../../shared/` fails with TS6059 (`not under rootDir`) —
its own `ARKOVA_DEFAULT_URL`-equivalent (`BASE_URL`) stays a local copy.
