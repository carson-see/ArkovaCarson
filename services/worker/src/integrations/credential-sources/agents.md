# agents.md — services/worker/src/integrations/credential-sources/

_Last updated: 2026-06-01 (SCRUM-1611 CSI-04A)_

## What This Folder Contains

Issuer-partnership credential ingestion for the SCRUM-1596 epic. Stores tokens/keys for Credly / Accredible / Udemy issuer accounts in the polymorphic `member_integrations` table, encrypted via GCP KMS.

| File | Purpose |
|------|---------|
| `token-store.ts` | Thin wrapper around `../oauth/crypto.ts` that encrypts credential-source provider tokens and persists `member_integrations` rows. Records `kek_version` for safe KMS key rotation. |
| `token-store.test.ts` | Unit tests using a fake `KmsClient` and an in-memory row store. No real KMS or Postgres traffic. |

## Why This Folder Exists Separately From `oauth/`

`oauth/crypto.ts` is the generic KMS encrypt/decrypt module (SCRUM-1168). This folder is the **credential-source-specific** layer that adds:

- Provider whitelisting (`'credly' | 'accredible' | 'udemy'`) — matches the widened `member_integrations.provider` CHECK constraint from migration `0327`.
- Member-integration row shape — `(user_id, org_id, provider, account_id)` lookup keys plus `kek_version` tracking.

Sprint 1 follow-ups (CSI-04B, CSI-04C, CSI-04D) will add provider-specific issuer adapters on top of this foundation.

## Do / Don't Rules

- **DO** use this module (not raw `oauth/crypto.ts`) for every credential-source provider token write/read — it enforces the provider enum and records `kek_version`.
- **DO** inject a fake `KmsClient` and `MemberIntegrationRowDeps` in tests. Never call real KMS or Postgres from a unit test (CLAUDE.md §1.7).
- **DO NOT** persist cleartext tokens to Postgres, ever (Constitution §1.4). If you find yourself reaching for `JSON.stringify(tokens)` outside of `encryptTokens()`, stop.
- **DO NOT** branch on `provider` to swap KMS keys per-provider — one key, one rotation cadence, one `kek_version` column. Adding a per-provider key complicates the audit story for negligible gain.

## Related References

- Migration: `supabase/migrations/0327_member_integrations_credential_providers.sql`
- KMS module: `services/worker/src/integrations/oauth/crypto.ts` (SCRUM-1168)
- DocuSign precedent: same `member_integrations` table established by `0320_member_integrations.sql` (SCRUM-2044)
- Jira: [SCRUM-1611](https://arkova.atlassian.net/browse/SCRUM-1611) / parent [SCRUM-1600](https://arkova.atlassian.net/browse/SCRUM-1600) / epic [SCRUM-1596](https://arkova.atlassian.net/browse/SCRUM-1596)
