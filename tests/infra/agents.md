# tests/infra/agents.md

Infrastructure integration tests. Verify operational scripts, edge workers, and security configurations.

## Files
- **`healthcheck.test.ts`** — tests for the healthcheck runner (SCRUM-1056): result ordering, timing, error capture.
- **`batch-queue.test.ts`** — tests for batch queue processing infrastructure.
- **`crawler.test.ts`** — tests for web crawler/indexing behavior.
- **`cross-tenant-assertions.test.ts`** — DEG-4 (SOAK-PREMORTEM-SOC2-2026-08-11 §4): pins the hardened blocked/positive-access semantics of `e2e/helpers/cross-tenant-assertions.ts`. A /login redirect must evaluate NOT-blocked (the old spec's hollow-pass), record content rendering is a leak not a block, and precondition failures carry the distinct `precondition: <label> session not authenticated` message. This is the local RED proof that an expired accessor session makes `e2e/cross-tenant.spec.ts` fail.
- **`dlp-verification.test.ts`** — tests for DLP (Data Loss Prevention) policy enforcement.
- **`llms-txt.test.ts`** — tests for `llms.txt` AI crawler discovery file.
- **`mcp-claim-parity.test.ts`** — BUG-026 guard, run against the LIVE surfaces. Runs `scripts/ci/check-mcp-claim-parity.ts` over the five published MCP claim surfaces and asserts zero unbaselined violations, plus baseline hygiene (no duplicate keys, every entry owned, no `reference-coverage` exceptions). The rule logic is unit-tested on synthetic fixtures next to the script; this file is the live assertion so `npm test` catches drift without waiting for CI. Complements `mcp-manifest-parity.test.ts`, which pins names/schemas and explicitly does NOT compare description text.
- **`mcp-server.test.ts`** — tests for the MCP server edge deployment.
- **`r2-report.test.ts`** — tests for Cloudflare R2 report storage.
- **`secret-audit.test.ts`** — tests for secret rotation audit compliance.
- **`security-headers.test.ts`** — tests for HTTP security headers on all endpoints.

## Conventions
- These tests verify infrastructure behavior, not application logic.
- External services are mocked; no real GCP/Cloudflare calls in tests.
