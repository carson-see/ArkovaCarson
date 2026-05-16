# integrations/shared/src/agents.md

Shared utilities used across all Arkova integrations (Bullhorn, Clio, Zapier).

## Files
- **`constants.ts`** — `ARKOVA_DEFAULT_URL`: default Arkova API base URL for all integrations.
- **`fingerprint.ts`** — `computeFingerprint(data)`: SHA-256 fingerprint via Web Crypto API. Identical algorithm to `@arkova/sdk`. Works in browsers and Node.js 16+.

## Conventions
- Keep this package dependency-free (Web Crypto only).
- Fingerprint algorithm must stay in sync with `@arkova/sdk` and the frontend `generateFingerprint`.
