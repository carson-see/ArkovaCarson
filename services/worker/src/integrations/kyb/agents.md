# agents.md — services/worker/src/integrations/kyb/

_Last updated: 2026-05-16_

## What This Folder Contains

Know Your Business (KYB) verification via Middesk.

| File | Purpose |
|------|---------|
| `middesk.ts` | HTTP client for Middesk Business Verification API v1 — business submission + webhook signature verification |
| `middesk.test.ts` | Tests for Middesk client (submission, signature verify, sandbox/prod routing) |

## Do / Don't Rules

- **DO** use `MIDDESK_SANDBOX=true` (default) for non-production environments
- **DO NOT** log request/response bodies (may contain EIN, business addresses)
- Missing `MIDDESK_API_KEY` surfaces as 503 at the route layer, never silent success
