# tests/infra/agents.md

Infrastructure integration tests. Verify operational scripts, edge workers, and security configurations.

## Files
- **`healthcheck.test.ts`** — tests for the healthcheck runner (SCRUM-1056): result ordering, timing, error capture.
- **`batch-queue.test.ts`** — tests for batch queue processing infrastructure.
- **`crawler.test.ts`** — tests for web crawler/indexing behavior.
- **`dlp-verification.test.ts`** — tests for DLP (Data Loss Prevention) policy enforcement.
- **`llms-txt.test.ts`** — tests for `llms.txt` AI crawler discovery file.
- **`mcp-server.test.ts`** — tests for the MCP server edge deployment.
- **`r2-report.test.ts`** — tests for Cloudflare R2 report storage.
- **`secret-audit.test.ts`** — tests for secret rotation audit compliance.
- **`security-headers.test.ts`** — tests for HTTP security headers on all endpoints.

## Conventions
- These tests verify infrastructure behavior, not application logic.
- External services are mocked; no real GCP/Cloudflare calls in tests.
