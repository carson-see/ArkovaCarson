# agents.md — services/worker/src/integrations/credential-sources/credly/

_Last updated: 2026-06-01 (SCRUM-1612 CSI-04B)_

## What This Folder Contains

Credly-specific integration for the SCRUM-1596 Credential Source Import epic. Per researcher findings (2026-05-28, cited on [SCRUM-1600](https://arkova.atlassian.net/browse/SCRUM-1600)), Credly does NOT offer consumer OAuth — they only offer an OAuth 2.0 `client_credentials` grant that is provisioned per issuer organisation. This code uses that grant.

| File | Purpose |
|------|---------|
| `client.ts` | HTTP client. Mints + caches `client_credentials` access tokens (2h TTL, no refresh). Lists issued badges from `/v1/organizations/{org_id}/badges` with `recipient_email` filtering and pagination. |
| `client.test.ts` | Unit tests with `fetch`-shaped fake + deterministic clock. No real HTTP. |
| `adapter.ts` | Transforms a `CredlyIssuedBadge` into the `credential_evidence_v1` shape that the existing CSI-01 module (`services/worker/src/lib/credential-evidence.ts`) anchors. |
| `adapter.test.ts` | Tests with inline OB3-shaped fixtures (plain + signed). Pins the v1.0 trust-gap behaviour: even when a `proof` block is present, verification_level stays `account_linked`. |

## V1.0 Trust Boundary (don't blur it)

- **`verification_level` is `account_linked`** (issuer-API confirmed), **NEVER `source_signed`**, even when Credly returns an OB3 badge with a top-level `proof` block.
- Per PRD §13, cryptographic verification of W3C VC / OB3 proofs is **deferred to v1.1**.
- The adapter exposes `proofDetected` so a future v1.1 verification job can scan historical rows and upgrade them once `@digitalbazaar/vc` + `@digitalbazaar/eddsa-rdfc-2022-cryptosuite` are wired in. **Until that lands, do not promote v1.0 rows.**

## Do / Don't Rules

- **DO** persist the raw Credly payload bytes alongside the evidence package — v1.1 verification needs them. The adapter expects `payloadHash` to be computed over the exact bytes received.
- **DO** hash recipient email + credential id; **do not** copy raw PII into the evidence package. The adapter enforces this.
- **DO NOT** log `client_secret` or the bearer access token (Constitution §1.4). The error messages in `client.ts` deliberately exclude both.
- **DO NOT** add any Credly-API call that does not flow through this client — it is the single point of `client_credentials` token caching, and is the intended single chokepoint for rate-limit handling when that lands (see follow-up below).
- **DO NOT** promote `verification_level` to `source_signed` from this module. That belongs in the future v1.1 cryptographic verification pass, never here.

## Follow-up: rate-limit handling not yet implemented

`client.ts` currently does **not** implement 429 / `Retry-After` / exponential-backoff retry — Credly's published rate limits are unconfirmed (open question on SCRUM-2131). The single-chokepoint design above exists so this can be added in one place later; until then, callers should treat a Credly 429 as a normal transient HTTP error and let the surrounding job-queue retry. Add real backoff here (not at call sites) once limits are confirmed.

## Related References

- Token storage: `../token-store.ts` (`storeIssuerCredentials` / `readIssuerCredentials`)
- KMS module: `../../oauth/crypto.ts` (SCRUM-1168)
- Evidence package schema: `../../../lib/credential-evidence.ts` (SCRUM-1597)
- Jira: [SCRUM-1612](https://arkova.atlassian.net/browse/SCRUM-1612) / parent [SCRUM-1600](https://arkova.atlassian.net/browse/SCRUM-1600) / epic [SCRUM-1596](https://arkova.atlassian.net/browse/SCRUM-1596)
- PRD: <https://docs.google.com/document/d/1F0V2OHbfS--UFs79bKJ9dJKmKewP1VaEgBDZ-uJ0-zY> (§6.2 Phase 2, §13 v1.1 deferral)
- Researcher findings (citations): comment on SCRUM-1600 (2026-05-28)
