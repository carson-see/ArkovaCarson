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

## SSRF egress primitive (SCRUM-2483)

- **safe-fetch.ts** — the single IP-pinned egress primitive. `safeFetch(url, init, deps, opts)` resolves the host ONCE, rejects if ANY resolved IP is private/link-local/loopback/CGNAT/metadata, then CONNECTs to the **pinned** resolved IP so resolve-time IP === connect-time IP (defeats DNS-rebind/TOCTOU). Re-validates EVERY redirect hop; scheme allow-list (http/https only); response-size cap + total deadline. `resolve`/`dispatch` are injected (`SafeFetchDeps`) so tests drive the rebind adversary with no real network; `defaultSafeFetchDeps()` pins via an undici `Agent` connect-lookup override + `globalThis.fetch` (so `vi.stubGlobal('fetch')` still intercepts in tests). `safeFetchSingleHop` + `createSafeFetchImpl` serve callers running their OWN manual-redirect loop (credential-source-import). **Do NOT** reintroduce a bare `fetch()` on a user/partner-supplied URL — route it through here (enforced WARN-first by `scripts/ci/ban-raw-fetch-worker.ts`).
- **ssrf-guard.ts** — shared private-IP/hostname classifier + `resolveHostToIps`, lifted **byte-identically** from `webhooks/delivery.ts` (INJ-02/ARK-SEC-002). `delivery.ts` now re-exports these — the webhook guard body is unchanged (no soak delta). One source of truth for the blocklist; edit here, not in two places.

## Recipient identity — keyed HMAC + possession-proof (SCRUM-2484)

- **recipient-identity.ts** — `hashRecipientEmail(email, pepper)` = keyed HMAC-SHA256(pepper, normalized_email) so the recipient identifier cannot be precomputed / enumerated offline (the old bare `sha256(email)` let anyone `sha256(known_email)` and correlate). Returns undefined for a blank email; THROWS `RecipientPepperUnavailableError` on an empty pepper — callers that must degrade gracefully guard on the pepper first and omit the hash (NEVER fall back to bare sha256). `verifyRecipientPossession` REJECTS hash-equality as proof of possession and accepts only a `signed_challenge` possession token (`mintPossessionToken`), constant-time compared. Pepper VALUE = `config.recipientIdentifierPepper` (env `RECIPIENT_IDENTIFIER_PEPPER`), Carson/RTE-provisioned. The DB-side half (get_public_anchor.recipient_identifier) uses the `app.recipient_pepper` GUC (migration 0356).
- **credential-source-import.ts** `hashRecipientIdentifier(value, pepper)` now delegates to the keyed HMAC and threads `deps.recipientPepper` through the extraction chain; `recipient_identifier_hash` is NO LONGER emitted into `toPublicSafeCredentialEvidenceMetadata` (credential-evidence.ts) — it was spread into stored anchors.metadata → get_public_anchor → anon callers, so it is dropped from public output entirely and lives only in `anchor_recipients`. `buildSelfImportRecipientHash` is intentionally left as a plain namespaced sha256 of the internal userId (not an email; not the enumeration target; changing it would need a data backfill).
