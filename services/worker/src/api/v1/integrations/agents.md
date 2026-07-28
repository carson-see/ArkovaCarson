# agents.md — services/worker/src/api/v1/integrations/

_Last updated: 2026-06-24_

## What This Folder Contains

User-facing OAuth flow endpoints for third-party integrations. Each integration provides start, callback, and disconnect routes.

| File | Purpose |
|------|---------|
| `docusign-oauth.ts` | DocuSign OAuth start/callback/disconnect routes plus org-admin Connect listener reprovisioning (SCRUM-1101/SCRUM-2069). SCRUM-2361 (DS-01): `start` + `callback` gate on `organizations.verification_status = 'VERIFIED'` via `requireVerifiedOrg` — unverified/pending orgs are denied (403 `org_unverified` on start, `docusign_error=org_unverified` redirect on callback); disconnect is never gated. `// TODO(PAY-01)` marks the not-yet-shipped paid-individual (Stripe Identity) entitlement. **SCRUM-3027**: on a successful org connect (after the integration upsert), the callback fires `seedDocusignCompletionRule()` (`integrations/connectors/docusign-rule-seed.ts`) — idempotent, non-stomping, failure-isolated auto-seed of the DocuSign Completion rule (default-on so contracts flow with zero further clicks). Fire-and-forget like `settleConnectProvisioning`; surfaces `docusign_completion_rule_seeded` / `_seed_failed` events |
| `docusign-oauth.test.ts` | Tests for DocuSign OAuth flows |
| `drive-oauth.ts` | Google Drive OAuth start/callback/disconnect routes (SCRUM-1168). DRIVE-01 (SCRUM-2366): `start` + `callback` gate on `assertDriveConnectAllowed` (`integrations/connectors/drive-connect-eligibility.ts`) via the `makeEligibilityDb` adapter — org path = owner-inclusive admin of a VERIFIED, non-suspended org; personal path (no `org_id`) = paid + identity-verified individual. Denials → 403 `code` on start / `drive_error=<code>` redirect on callback; `lookup_failed` → 500/retry. Gate is RE-EVALUATED on callback so a stale-but-valid `state` token can't bypass a lapsed entitlement. Personal-Drive persistence is not yet representable (`org_integrations.org_id` is NOT NULL) → callback denies with `personal_connect_unavailable`. Disconnect keeps `requireOrgAdmin` (never gated on entitlement) |
| `drive-oauth.test.ts` | Tests for Drive OAuth flows + DRIVE-01 gate (org-admin allowed, unverified-org denied, paid-verified-individual allowed, free denied, callback token-reuse re-check) |
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
- **DO** gate Google Drive connect through `assertDriveConnectAllowed` (DRIVE-01 / SCRUM-2366) at BOTH `start` and `callback`, NOT `org_members.role` alone. Org admin/membership must resolve through the canonical owner-inclusive resolver (`api/_org-auth.ts`) inside the eligibility module — owners are linked via `profiles.org_id`, not guaranteed an `org_members` row (the #1325/#1326 drift class). Re-check on callback so a stale token can't bypass a lapsed entitlement. `lookup_failed` is a transient fault (500/retry), not a "get verified" dead-end.
- **DO NOT** select secret-bearing columns (`encrypted_tokens`, `token_kms_key_id`) in any list/read endpoint that returns to a client — list responses are summaries only.
- **DO** settle the fire-and-forget `provisionConnectListener()` promise with the shared `settleConnectProvisioning()` helper (SCRUM-3014) instead of an inline `.then(...).catch(...)` per router — the org and member callbacks differ only in event-type names and `flow`, and the duplicated chain both drifted and failed the Sonar new-code duplication gate.
- **DO** report DocuSign Connect listener provisioning failures through `reportConnectProvisionFailure()` (SCRUM-3014, `integrations/connectors/docusign-connect-health.ts`) and persist `docusign_status` / `docusign_detail` on the `connect_listener_failed` / `member_connect_listener_failed` event. Keep it non-fatal — the OAuth callback has already redirected — but never swallow it to a bare `error.message`: prod ran for weeks on `{"error":"DocuSign Connect create failed"}` with no status and an org UI that still said "Connected".
- **DO** remember there are TWO DocuSign redirect URIs (`/api/v1/integrations/docusign/oauth/callback` and `/api/v1/integrations/docusign/member/oauth/callback`), both request-host derived. Any new host fronting the worker needs both registered on the DocuSign app (SCRUM-3015, `docs/runbooks/integrations/docusign.md`).
