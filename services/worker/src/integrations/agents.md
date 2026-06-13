# agents.md — services/worker/src/integrations/

_Last updated: 2026-06-01 (SCRUM-1611)_

## What This Folder Contains

Third-party integration service layer — connectors (Drive, DocuSign), GRC platform sync (Vanta, Drata, Anecdotes), KYB verification (Middesk), OAuth helpers, credential-source providers (Credly/Accredible/Udemy), and IndexNow SEO pings.

| File / Folder | Purpose |
|------|---------|
| `connectors/` | Vendor-specific connector services (Google Drive, DocuSign) and canonical event adapters |
| `credential-sources/` | **SCRUM-1611+**: Credly / Accredible / Udemy issuer-partnership token storage and adapters. Reuses `oauth/crypto.ts` for KMS encryption; persists into `member_integrations`. |
| `grc/` | GRC platform integration — evidence push to Vanta, Drata, Anecdotes on anchor SECURED |
| `kyb/` | Know Your Business verification (Middesk API client) |
| `oauth/` | Shared OAuth helpers — KMS token encryption (`crypto.ts`), HMAC verification, vendor-specific clients |
| `indexnow.ts` | IndexNow protocol pings to Bing/Yandex for new public content |

## Do / Don't Rules

- **DO** encrypt OAuth tokens via KMS before storage (Constitution 1.4)
- **DO NOT** persist raw webhook payloads or cleartext tokens in Postgres
