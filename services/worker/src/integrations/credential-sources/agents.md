# agents.md — services/worker/src/integrations/credential-sources/

_Last updated: 2026-06-01 (SCRUM-1613 CSI-04C; CSI-04B SCRUM-1612; foundation SCRUM-1611 CSI-04A)_

## What This Folder Contains

Issuer-partnership credential ingestion for the SCRUM-1596 epic. Stores tokens/keys for credential-source provider accounts in the polymorphic `member_integrations` table, encrypted via GCP KMS.

| File / Folder | Purpose |
|------|---------|
| `token-store.ts` | KMS-backed token storage. Supports three credential shapes: end-user OAuth refresh tokens (`OAuthTokens`), client_credentials issuer secrets (`IssuerCredentials`, Credly), and static API-key issuer secrets (`ApiKeyCredentials`, Accredible). Records `kek_version` for safe KMS key rotation. |
| `token-store.test.ts` | Unit tests using a fake `KmsClient` and an in-memory row store. No real KMS or Postgres traffic. |
| `credly/` | **SCRUM-1612 CSI-04B**: Credly HTTP client (client_credentials grant + `issued_badges` API) and badge-to-evidence adapter. Verification stays at `account_linked`; OB3 proof verification deferred to v1.1 per PRD §13. |
| `accredible/` | **SCRUM-1613 CSI-04C**: Accredible HTTP client (static API-key auth: `Authorization: Token token=<KEY>`) and credential-to-evidence adapter. Same v1.0 trust boundary as Credly. |
| `types.ts` | Shared HTTP-client types (`FetchLike`) used by every provider client so no provider module depends on another. |

## V1.0 Provider Coverage and Honest Positioning

| Provider | v1.0 path | Notes |
|---|---|---|
| **Credly** | Issuer partnership via `client_credentials` OAuth → API → adapter | SCRUM-1612 / CSI-04B |
| **Accredible** | Issuer partnership via static API key → API → adapter | SCRUM-1613 / CSI-04C |
| **Udemy** | **Deferred to a future enterprise SKU** | No public consumer API exists. Udemy Affiliate API was discontinued 2025-01-01; only Udemy Business xAPI (enterprise-tenant-scoped) is available. We do not ship a Udemy adapter in v1.0 because there is no real-world API access to validate against — `member_integrations.provider = 'udemy'` is permitted by migration `0329` so an enterprise customer can be onboarded later without a schema change. |
| **Individual users on any provider** | URL-paste import (CSI-02, already shipped) | Per researcher findings, none of these 3 providers expose consumer OAuth, so consumers continue to use the existing paste-a-link flow. This is the documented consumer fallback for all credential-source providers. |

## Why This Folder Exists Separately From `oauth/`

`oauth/crypto.ts` is the generic KMS encrypt/decrypt module (SCRUM-1168). This folder is the **credential-source-specific** layer that adds:

- Provider whitelisting (`'credly' | 'accredible' | 'udemy'`) — matches the widened `member_integrations.provider` CHECK constraint from migration `0329`.
- Three credential-shape variants (`OAuthTokens`, `IssuerCredentials`, `ApiKeyCredentials`) discriminated by `provider`.
- Member-integration row shape — `(user_id, org_id, provider, account_id)` lookup keys plus `kek_version` tracking.

Sprint 1 follow-up (CSI-04D) adds the Issuer Partners admin UI.

## Do / Don't Rules

- **DO** use this module (not raw `oauth/crypto.ts`) for every credential-source provider token write/read — it enforces the provider enum and records `kek_version`.
- **DO** inject a fake `KmsClient` and `MemberIntegrationRowDeps` in tests. Never call real KMS or Postgres from a unit test (CLAUDE.md §1.7).
- **DO NOT** persist cleartext tokens to Postgres, ever (Constitution §1.4). If you find yourself reaching for `JSON.stringify(tokens)` outside of `encryptTokens()`, stop.
- **DO NOT** branch on `provider` to swap KMS keys per-provider — one key, one rotation cadence, one `kek_version` column. Adding a per-provider key complicates the audit story for negligible gain.

## Related References

- Migration: `supabase/migrations/0329_member_integrations_credential_providers.sql`
- KMS module: `services/worker/src/integrations/oauth/crypto.ts` (SCRUM-1168)
- DocuSign precedent: same `member_integrations` table established by `0320_member_integrations.sql` (SCRUM-2044)
- Jira: [SCRUM-1611](https://arkova.atlassian.net/browse/SCRUM-1611) / parent [SCRUM-1600](https://arkova.atlassian.net/browse/SCRUM-1600) / epic [SCRUM-1596](https://arkova.atlassian.net/browse/SCRUM-1596)

## SSRF (SCRUM-2483)

- Provider clients (`accredible/client.ts`, `credly/client.ts`) take an injectable `fetch: FetchLike`. **Production callers MUST inject `createSafeProviderFetch()`** (`safe-provider-fetch.ts`) — the IP-pinned SSRF-guarded fetch — never the raw `fetch` global, so a rebinding provider host cannot reach a private/metadata address. Tests inject a stub. These clients are greenfield (no production instantiation wired yet); wire the safe fetch when the connector job that constructs them lands.
- **SCRUM-2484:** the accredible/credly adapters take `recipientPepper` in their deps and produce the recipient identifier via `hashRecipientEmail` (keyed HMAC) — never a bare `sha256(email)`. When no pepper is passed, the recipient hash is omitted entirely. `sha256Hex(credentialId)` is unchanged (a credential ID is not the enumerable-PII target).
