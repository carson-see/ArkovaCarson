# agents.md — services/worker/src/api/v1/integrations/

_Last updated: 2026-05-16_

## What This Folder Contains

User-facing OAuth flow endpoints for third-party integrations. Each integration provides start, callback, and disconnect routes.

| File | Purpose |
|------|---------|
| `docusign-oauth.ts` | DocuSign OAuth start/callback/disconnect routes (SCRUM-1101) |
| `docusign-oauth.test.ts` | Tests for DocuSign OAuth flows |
| `drive-oauth.ts` | Google Drive OAuth start/callback/disconnect routes (SCRUM-1168) |
| `drive-oauth.test.ts` | Tests for Drive OAuth flows |
| `drive-oauth-webhook-url.test.ts` | Tests for Drive webhook URL construction |

## Do / Don't Rules

- **DO** encrypt tokens with the OAuth crypto helper before storage (cleartext never in Postgres)
- **DO** use timing-safe comparison for HMAC state parameters
- **DO NOT** log cleartext access/refresh tokens
