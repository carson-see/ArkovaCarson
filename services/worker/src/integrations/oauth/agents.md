# agents.md — services/worker/src/integrations/oauth/

_Last updated: 2026-05-16_

## What This Folder Contains

Shared OAuth infrastructure — token encryption, HMAC webhook verification, and vendor-specific OAuth/API clients.

| File | Purpose |
|------|---------|
| `crypto.ts` | GCP KMS-based OAuth token encryption/decryption — cleartext never lands in Postgres |
| `hmac.ts` | Shared HMAC-SHA256 webhook verifier (timing-safe, supports base64 and hex encoding) |
| `drive.ts` | Google Drive OAuth client — token exchange, refresh, changes.watch, files.get, channels.stop |
| `docusign.ts` | DocuSign OAuth client — consent URLs, token refresh, UserInfo discovery, envelope document fetch, Connect HMAC |
| `adobe-sign.ts` | Adobe Sign webhook HMAC verification helpers |

## Do / Don't Rules

- **DO** use `crypto.ts` for all token storage — dedicated symmetric KMS key, not the Bitcoin signing key
- **DO** use `hmac.ts` centralized verifier for all webhook signatures (prevents drift on timing-safe path)
- **DO NOT** log response bodies from OAuth token exchanges (contain cleartext tokens)
- **DO NOT** reuse the Bitcoin asymmetric signing key for OAuth token encryption
