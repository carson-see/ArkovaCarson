# agents.md — tests/edge
_Last updated: 2026-05-16_

## What This Folder Contains

Vitest tests for Cloudflare edge worker security helpers. These run in `@vitest-environment node` because the edge worker lacks its own test harness and the helpers use standard Node 20+ crypto APIs.

## Key Files
- `mcp-jwt-verify.test.ts` — tests `verifySupabaseJwt` local JWT verification (SCRUM-926 / MCP-SEC-07): forged signatures, expired tokens, wrong aud/iss, missing claims
- `mcp-security.test.ts` — tests HMAC validation, rate-limiting, and security helpers for the edge MCP proxy (SCRUM-923/919/924/920)

## Do / Don't Rules
- DO: Declare CF Worker types (`KVNamespace`, `R2Bucket`, etc.) locally in the test file — importing `@cloudflare/workers-types` globally breaks frontend type resolution
- DON'T: Import these tests from the edge worker build — they live here because the edge worker has no vitest config
