# agents.md — services/worker/src/integrations/

_Last updated: 2026-05-16_

## What This Folder Contains

Third-party integration service layer — connectors (Drive, DocuSign), GRC platform sync (Vanta, Drata, Anecdotes), KYB verification (Middesk), OAuth helpers, and IndexNow SEO pings.

| File / Folder | Purpose |
|------|---------|
| `connectors/` | Vendor-specific connector services (Google Drive, DocuSign) and canonical event adapters |
| `grc/` | GRC platform integration — evidence push to Vanta, Drata, Anecdotes on anchor SECURED |
| `kyb/` | Know Your Business verification (Middesk API client) |
| `oauth/` | Shared OAuth helpers — KMS token encryption, HMAC verification, vendor-specific clients |
| `indexnow.ts` | IndexNow protocol pings to Bing/Yandex for new public content |

## Do / Don't Rules

- **DO** encrypt OAuth tokens via KMS before storage (Constitution 1.4)
- **DO NOT** persist raw webhook payloads or cleartext tokens in Postgres
