# agents.md — services/worker/src/api/v1/integrations/

_Last updated: 2026-06-24_

## What This Folder Contains

User-facing OAuth flow endpoints for third-party integrations. Each integration provides start, callback, and disconnect routes.

| File | Purpose |
|------|---------|
| `docusign-oauth.ts` | DocuSign OAuth start/callback/disconnect routes plus org-admin Connect listener reprovisioning (SCRUM-1101/SCRUM-2069). SCRUM-2361 (DS-01): `start` + `callback` gate on `organizations.verification_status = 'VERIFIED'` via `requireVerifiedOrg` — unverified/pending orgs are denied (403 `org_unverified` on start, `docusign_error=org_unverified` redirect on callback); disconnect is never gated. `// TODO(PAY-01)` marks the not-yet-shipped paid-individual (Stripe Identity) entitlement |
| `docusign-oauth.test.ts` | Tests for DocuSign OAuth flows |
| `drive-oauth.ts` | Google Drive OAuth start/callback/disconnect routes (SCRUM-1168) |
| `drive-oauth.test.ts` | Tests for Drive OAuth flows |
| `drive-oauth-webhook-url.test.ts` | Tests for Drive webhook URL construction |
| `docusign-member-oauth.ts` | SCRUM-2044: Member-level DocuSign OAuth start/callback/disconnect routes |
| `docusign-member-oauth.test.ts` | Tests for member-level DocuSign OAuth flows |
| `docusign-hmac-rotation.ts` | SCRUM-2043: pure rotate/retire functions for HMAC key lifecycle (DI pattern) |
| `docusign-hmac-rotation.test.ts` | Tests for HMAC key rotation and retirement |
| `issuer-partnerships.ts` | SCRUM-2082 CSI-04D: admin-gated GET/POST/DELETE for issuer partnerships (Credly/Accredible/Udemy) backing the Connected Issuers UI. Reuses CSI-04A/C token-store primitives — no new crypto |
| `issuer-partnerships.test.ts` | Tests for issuer-partnership list/connect/disconnect (auth, org-admin gate, secret-leak guard, idempotent revoke, UUID guard) |

## Do / Don't Rules

- **DO** encrypt tokens with the OAuth crypto helper before storage (cleartext never in Postgres)
- **DO** use timing-safe comparison for HMAC state parameters
- **DO** sign the OAuth `state` HMAC with the dedicated `INTEGRATION_STATE_HMAC_SECRET` via `resolveStateSecret()`, resolved at router construction. Fail closed if it is unset — audit finding H1 (Drive SCRUM-1236, DocuSign org + member). The eager router exports are lazy wrappers so importing a module without the env var doesn't throw at import time.
- **DO** write to `audit_events` (event_category `SECURITY`) on disconnect, not just `integration_events` — SOC 2 CC7.2 requires audit trail for all integration lifecycle events (SCRUM-2039)
- **DO NOT** log cleartext access/refresh tokens
- **DO NOT** fall back to `config.supabaseJwtSecret` / `config.supabaseServiceKey` for state signing — that collapses the user-auth and OAuth-CSRF trust boundaries (the H1 finding)
- **DO** type `member_integrations` (and any other table missing from the generated `database.types.ts`) via a narrow hand-written DB facade with `from(table)` overloads + `.select<Row>()`, cast once at the real-client seam — see `docusign-member-oauth.ts` and `issuer-partnerships.ts`. Do **not** scatter `as unknown as never` casts to silence the checker.
- **DO** call pino as `logger.error(obj, msg)` / `logger.warn(obj, msg)` (object first) so the configured error serializer + redaction apply; never `logger.error('msg', { error })` (reversed args bypass redaction).
- **DO** gate the *org-level* DocuSign connect on org KYB verification (`requireVerifiedOrg`), not just admin role (SCRUM-2361). Re-check on the callback too — a signed `state` is replayable inside its TTL and verification can be revoked between start and callback. Never gate disconnect.
- **DO NOT** select secret-bearing columns (`encrypted_tokens`, `token_kms_key_id`) in any list/read endpoint that returns to a client — list responses are summaries only.
