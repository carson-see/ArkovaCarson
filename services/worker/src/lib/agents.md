# services/worker/src/lib/

Shared domain libraries used across the worker. Pure logic modules with minimal I/O.

## Files

- **credential-evidence.ts** — Credential evidence package schema, Zod validation, and canonical hash helpers for anchoring. Defines the signed/captured evidence envelope Arkova hashes before on-chain anchoring.
- **credential-evidence.fixtures.ts** — Test fixtures for credential evidence packages.
- **credential-evidence.test.ts** — Tests for evidence package building, hashing, and validation.
- **credential-source-import.ts** — Fetches and parses credential sources (HTML, JSON-LD, Open Badges) from issuer URLs. Extracts metadata with size/redirect/timeout limits. Uses cheerio for HTML parsing.
- **credential-source-import.test.ts** — Tests for source import fetching and parsing.
- **urls.ts** — Centralized URL builders (`buildVerifyUrl`, etc.). Single source of truth for user-facing URLs — eliminates `${config.frontendUrl}/...` template drift across ~20 call sites.
- **urls.test.ts** — Tests for URL builder output.

## Rules

- `credential-evidence.ts` does not fetch provider pages or submit credentials — it only defines the envelope shape and hashing.
- URL builders derive from `config.frontendUrl` — frontend route changes are a one-line refactor here.
