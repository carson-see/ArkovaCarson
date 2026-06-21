# agents.md — services/worker/src/integrations/credential-sources/accredible/

_Last updated: 2026-06-01 (SCRUM-1613 CSI-04C)_

## What This Folder Contains

Accredible-specific integration for the SCRUM-1596 Credential Source Import epic. Per researcher findings (2026-05-28, cited on [SCRUM-1600](https://arkova.atlassian.net/browse/SCRUM-1600)), Accredible does NOT offer OAuth — they use a static API-key auth model (`Authorization: Token token=<KEY>`). One key per issuer organisation.

| File | Purpose |
|------|---------|
| `client.ts` | HTTP client. GET `/v1/credentials` with `recipient.email` filter + pagination. No real HTTP in unit tests — `fetch` is injected. |
| `client.test.ts` | Unit tests with `fetch`-shaped fake. Pins the Token-token Authorization header shape and the non-leaky error path. |
| `adapter.ts` | Transforms an `AccredibleCredential` into the `credential_evidence_v1` shape that the existing CSI-01 module anchors. |
| `adapter.test.ts` | Tests with inline fixtures (plain + signed). Pins the v1.0 trust-gap behaviour: even when a `proof` or `credential_data` envelope is present, `verification_level` stays `account_linked`. |

## V1.0 Trust Boundary (same as Credly)

- `verification_level` is **`account_linked`** (issuer-API confirmed), **NEVER `source_signed`**, even when Accredible returns a credential with a `proof` block or OB3-shaped `credential_data` envelope.
- Per PRD §13, cryptographic VC/OB3 proof verification is deferred to v1.1.
- The adapter exposes `proofDetected` so a future v1.1 verification job can scan historical rows and promote them once `@digitalbazaar/vc` + `@digitalbazaar/eddsa-rdfc-2022-cryptosuite` are wired in.

## Partnership-Time Open Questions

These need answers in writing from Accredible's API team before the auto-import cron (SCRUM-1601 / Sprint 2) is wired:

- **Webhook HMAC spec** — Accredible's webhook signing algorithm + header name are not in the public docs. We'll need their team to confirm.
- **Rate limits** — not published. Conservative assumption: 100 req/min per key; revisit when documented.
- **Test vs production base URL** — partnership-time may require a sandbox endpoint; the client supports `apiBase` override.

These are tracked in Sprint 0 task [SCRUM-2131](https://arkova.atlassian.net/browse/SCRUM-2131).

## Do / Don't Rules

- **DO** persist the raw Accredible payload bytes alongside the evidence package — v1.1 verification needs them.
- **DO** hash recipient email + credential id; do not copy raw PII into the evidence package.
- **DO NOT** log `api_key` or include it in any error message. The error path in `client.ts` is verified by test to omit the key.
- **DO NOT** promote `verification_level` to `source_signed` from this module. That belongs in the future v1.1 cryptographic verification pass.

## Related References

- Token storage: `../token-store.ts` (`storeApiKeyCredentials` / `readApiKeyCredentials`)
- Credly precedent: `../credly/` (SCRUM-1612) — same shape, different auth model
- Evidence package schema: `../../../lib/credential-evidence.ts` (SCRUM-1597)
- Jira: [SCRUM-1613](https://arkova.atlassian.net/browse/SCRUM-1613) / parent [SCRUM-1600](https://arkova.atlassian.net/browse/SCRUM-1600) / epic [SCRUM-1596](https://arkova.atlassian.net/browse/SCRUM-1596)
- PRD: <https://docs.google.com/document/d/1F0V2OHbfS--UFs79bKJ9dJKmKewP1VaEgBDZ-uJ0-zY> (§6.2 in scope; §13 deferral honoured)
