# HANDOFF.md — Arkova Phase 3/4 Living State

> **Initialized:** 2026-03-14
> **Purpose:** Track exact project state through Phase 3 (Go-Live) and Phase 4 (Verification API). Replaces MEMORY.md as the active state file. Historical context preserved in `ARCHIVE_memory.md`.
> **Update frequency:** After every significant session or decision.

---

## Current State

### Active Phase: Phase 3 — Go-Live (Production Launch) + P8 AI Intelligence (in progress)

**Goal:** Production launch of Phase 1 credentialing MVP + AI infrastructure foundation
**Methodology:** TDD (Red-Green-Refactor) + Architecture-first (sequential-thinking) + Security self-review + Playwright UI verification

### Open Blockers

| ID | Issue | Severity | Status | Next Action |
|----|-------|----------|--------|-------------|
| CRIT-2 | Bitcoin chain client — operational items | **HIGH** | CODE COMPLETE | AWS KMS key provisioning, mainnet treasury funding |
| CRIT-3 | Stripe plan change/downgrade | **HIGH** | PARTIAL | Implement upgrade/downgrade/cancellation flows (→ MVP-11) |

### MVP Launch Gap Stories (testnet launch blockers)

| Story | Priority | Description | Status |
|-------|----------|-------------|--------|
| MVP-01 | CRITICAL | Worker production deployment (GCP Cloud Run) | NOT STARTED |
| MVP-02 | HIGH | Global toast/notification system (Sonner) | PARTIAL — Sonner wired, toast calls not in hooks |
| MVP-03 | HIGH | Legal pages (Privacy, Terms, Contact) | RESOLVED (uncommitted) |
| MVP-04 | HIGH | Brand assets (logo, favicon, OG meta tags) | COMPLETE (PR #30) |
| MVP-05 | HIGH | Error boundary + 404 page | NOT STARTED |
| MVP-11 | HIGH | Stripe plan change/downgrade (CRIT-3 remaining) | NOT STARTED |

### P8 AI Intelligence (in progress)

| Story | Description | Status |
|-------|-------------|--------|
| P8-S17 | AI Provider Abstraction (IAIProvider + factory + fallback) | **COMPLETE** — 16 tests |
| P8-S13 | Batch AI Processing (Cloudflare Queues) | **COMPLETE** — 4 tests |
| P8-S15 | R2 Report Storage (zero-egress signed URLs) | **COMPLETE** — 4 tests |
| P8-S7 | Cloudflare Crawler (university ingestion) | **COMPLETE** — 5 tests |

### Sentry Integration

| Component | Status |
|-----------|--------|
| Worker (`@sentry/node` + profiling) | **COMPLETE** — PII scrubbing, 21 tests |
| Frontend (`@sentry/react` + replay) | **COMPLETE** — PII scrubbing, 9 tests |
| ErrorBoundary wired to Sentry | **COMPLETE** |

### Cloudflare Infrastructure

| Component | Status |
|-----------|--------|
| DLP policy (SSN/Tax ID block) | **COMPLETE** — script + 12 verification tests |
| Load Balancer (health checks) | **COMPLETE** — script ready |
| Edge worker bindings (R2, Queues, AI) | **COMPLETE** — wrangler.toml uncommented |

### AI Documentation & MCP Server (Phase 4)

| Component | Status |
|-----------|--------|
| `public/llms.txt` | **COMPLETE** — 12 validation tests |
| `public/AGENTS.md` | **COMPLETE** — tool docs + OAuth instructions |
| MCP Server (P8-S19) | **COMPLETE** — verify + search tools, OAuth/API key auth, 8 tests |
| MCP tools module | **COMPLETE** — shared logic for verify_credential + search_credentials |

### What's Production-Ready

- Database layer (51 migrations, RLS on all tables, audit trail immutable)
- Auth flow (Supabase auth, Google OAuth, AuthGuard + RouteGuard)
- Org admin credential issuance + individual anchor creation
- Public verification portal (5-section display, verification event logging)
- CI/CD pipeline (typecheck, lint, test, copy-lint, build-check, E2E)
- Worker test coverage (492 tests across 24 files, 80%+ on all critical paths)
- Webhook delivery engine + settings UI
- Stripe webhook handlers + billing UI
- PDF + JSON proof downloads
- CSV bulk upload
- Onboarding flow
- Bitcoin chain client (code complete, operational items remain)
- Sentry error tracking with PII scrubbing (frontend + worker)
- AI provider abstraction (IAIProvider interface, factory, mock, CF fallback)
- Edge worker infrastructure (batch queue, report storage, crawler, AI fallback)
- AI documentation (llms.txt + AGENTS.md for agent discovery)
- Remote MCP server (Cloudflare Worker, Streamable HTTP, OAuth + API key auth)

---

## Session Log

### Session: 2026-03-14 — Phase 5 Bitcoin Anchor Verification

**Verification endpoint:**
- `POST /api/verify-anchor` — accepts a `fingerprint` (64-char hex SHA-256, NOT a file) and returns frozen verification schema result
- Constitution 1.6 compliant: documents never leave the device; only the hash is sent
- Wired into Express worker with CORS + rate limiting
- DB lookup via `anchors` table (fingerprint → status, chain_tx_id, block height, public_id)

**Verification module:**
- `services/worker/src/api/verify-anchor.ts` — pure function with injectable DB lookup for testability
- Input validation (rejects non-hex, wrong length, empty)
- Maps internal statuses (SECURED→ACTIVE), omits jurisdiction when null (frozen schema)
- Returns: verified, status, network_receipt_id, anchor_timestamp, record_uri

**Tests (10):**
- Full E2E: dummy PDF → SHA-256 → mock Bitcoin receipt → verification match
- Tampered document fails verification (different hash = not found)
- PENDING, REVOKED, and SECURED status handling
- Invalid/empty fingerprint rejection
- Jurisdiction omission when null

**Constitution compliance notes:**
- Server-side document hashing was NOT implemented (violates Constitution 1.6)
- OpenTimestamps was NOT used (Decision Log: "Direct OP_RETURN only")
- Existing infrastructure leveraged: `fileHasher.ts` (client), `BitcoinChainClient` (worker), `anchor_chain_index` (DB)

**Test results:** 866 total tests (502 worker + 364 frontend/infra), 0 type errors, 0 failures

### Session: 2026-03-14 — Phase 4 Agentic Upsell & Documentation

**AI Documentation:**
- `public/llms.txt` — API docs optimized for LLM consumption (frozen schema, endpoints, auth, rate limits)
- `public/AGENTS.md` — Agent integration guide (MCP connection, tool schemas, usage examples)
- 12 validation tests: heading hierarchy, required sections, frozen fields, banned terms, size limit

**MCP Server (P8-S19):**
- `services/edge/src/mcp-server.ts` — Cloudflare Worker MCP server using `McpServer` + `WebStandardStreamableHTTPServerTransport`
- `services/edge/src/mcp-tools.ts` — Shared tool definitions + handlers for `verify_credential` and `search_credentials`
- OAuth 2.0 + API key auth via `validateAuth()` (checks X-API-Key header or Bearer token against Supabase)
- Edge worker routed at `/mcp` with CORS support
- 8 tests: tool definitions, verify input validation, search with limits

**Test results:** 856 total tests (364 frontend/infra + 492 worker), 0 type errors, 0 failures

### Session: 2026-03-14 — Phase 2 Compliance + Phase 3 AI Intelligence

**Phase 2 Compliance & Resiliency:**
- Sentry integration: worker (`@sentry/node` + profiling) and frontend (`@sentry/react` + replay)
- PII scrubbing: emails, SHA-256 fingerprints, SSNs, API keys, JWTs, auth headers, request bodies
- ErrorBoundary wired to `Sentry.captureException()`
- Cloudflare DLP: SSN/EIN/ITIN block script (`infra/cloudflare/dlp-policy.ts`)
- Cloudflare LB: health check script (`infra/cloudflare/load-balancer.ts`)

**Phase 3 AI Intelligence:**
- P8-S17: `IAIProvider` interface + `createAIProvider()` factory + `CloudflareFallbackProvider` + `MockAIProvider`
- P8-S13: Batch queue consumer with throttling (5 concurrent, 200ms delay) + progress tracking
- P8-S15: R2 report storage with path-traversal-safe keys + zero-egress signed URLs
- P8-S7: Cloudflare crawler with SSRF protection, HTML parsing, embedding generation, Supabase insertion
- Edge worker entry point updated with `/crawl` route
- Wrangler config: R2, Queues, Workers AI bindings all uncommented and active

**Test results:** 836 total tests (492 worker + 344 frontend/infra), 0 type errors, 0 failures

### Session: 2026-03-14 — Methodology Upgrade
- Upgraded CLAUDE.md with 4 mandatory methodology rules (Architect, TDD, Security, Tooling mandates)
- Renamed MEMORY.md → ARCHIVE_memory.md (historical context preserved)
- Initialized this HANDOFF.md file

---

## Decision Log (Phase 3/4)

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-14 | Methodology upgrade: TDD + Architecture-first + Security self-review + Playwright verification | Systematic quality gates before every code change |
| 2026-03-14 | MEMORY.md archived, HANDOFF.md replaces it | Clean state tracking for Phase 3/4 without legacy clutter |
| 2026-03-14 | IAIProvider as single abstraction for all AI providers | Vendor independence; hot-swap via AI_PROVIDER env var |
| 2026-03-14 | Cloudflare fallback in degraded mode (heuristic) when no Workers AI binding | Express worker can still provide basic extraction without edge deployment |
| 2026-03-14 | SSRF protection in crawler via domain allowlist pattern | Prevent internal network scanning via crawl endpoint |
| 2026-03-14 | Batch queue throttle: 5 concurrent, 200ms delay | Prevent Gemini API rate limit exhaustion |
| 2026-03-14 | MCP server uses WebStandardStreamableHTTPServerTransport (stateful mode) | Native Cloudflare Workers compat; session management via crypto.randomUUID() |
| 2026-03-14 | MCP auth: dual-mode (API key + OAuth Bearer) | API keys for machine-to-machine; OAuth for enterprise SSO |
| 2026-03-14 | llms.txt + AGENTS.md in public/ for agent discovery | Cloudflare AI Tooling style guide compliance |

---

## Phase 4 Readiness (Verification API — Post-Launch)

**Status:** 0/13 P4.5 stories (deferred). P8-S19 (Agentic Verification) **COMPLETE** via MCP server.
**Prerequisite:** Phase 3 production launch complete.
**Build order:** See CLAUDE.md Section 10.

---

## Files Changed This Session

### Phase 2 Compliance
| File | Action |
|------|--------|
| `services/worker/src/utils/sentry.ts` | NEW — Worker Sentry init + PII scrubbing |
| `services/worker/src/utils/sentry.test.ts` | NEW — 16 tests |
| `services/worker/src/utils/sentry-verification.test.ts` | NEW — 5 verification tests |
| `services/worker/src/index.ts` | MODIFIED — Sentry init + error handler |
| `src/lib/sentry.ts` | NEW — Frontend Sentry init + PII scrubbing |
| `src/lib/sentry.test.ts` | NEW — 9 tests |
| `src/main.tsx` | MODIFIED — initSentry() call |
| `src/components/layout/ErrorBoundary.tsx` | MODIFIED — Sentry.captureException |
| `infra/cloudflare/dlp-policy.ts` | NEW — DLP SSN/Tax ID block script |
| `infra/cloudflare/load-balancer.ts` | NEW — LB health check script |
| `tests/infra/dlp-verification.test.ts` | NEW — 12 DLP tests |

### Phase 3 AI Intelligence
| File | Action |
|------|--------|
| `services/worker/src/ai/types.ts` | NEW — IAIProvider interface |
| `services/worker/src/ai/types.test.ts` | NEW — 4 tests |
| `services/worker/src/ai/factory.ts` | NEW — Provider factory |
| `services/worker/src/ai/factory.test.ts` | NEW — 8 tests |
| `services/worker/src/ai/cloudflare-fallback.ts` | NEW — CF Workers AI fallback |
| `services/worker/src/ai/cloudflare-fallback.test.ts` | NEW — 4 tests |
| `services/worker/src/ai/mock.ts` | NEW — Mock provider for tests |
| `services/edge/src/env.ts` | NEW — Typed CF environment bindings |
| `services/edge/src/batch-queue.ts` | REWRITTEN — Real queue consumer |
| `services/edge/src/batch-queue-logic.ts` | NEW — Throttled batch processing |
| `services/edge/src/report-generator.ts` | REWRITTEN — R2 storage + signed URLs |
| `services/edge/src/report-logic.ts` | NEW — Report generation + R2 keys |
| `services/edge/src/ai-fallback.ts` | REWRITTEN — Nemotron endpoints |
| `services/edge/src/cloudflare-crawler.ts` | NEW — University directory ingestion |
| `services/edge/src/crawler-logic.ts` | NEW — HTML parsing + ground truth records |
| `services/edge/src/index.ts` | MODIFIED — Added /crawl route |
| `services/edge/wrangler.toml` | MODIFIED — All bindings uncommented |
| `tests/infra/batch-queue.test.ts` | NEW — 4 tests |
| `tests/infra/r2-report.test.ts` | NEW — 4 tests |
| `tests/infra/crawler.test.ts` | NEW — 5 tests |

### Phase 4 Agentic Upsell & Documentation
| File | Action |
|------|--------|
| `public/llms.txt` | NEW — LLM-optimized API documentation |
| `public/AGENTS.md` | NEW — Agent integration guide with MCP tools |
| `services/edge/src/mcp-server.ts` | NEW — Cloudflare MCP server (Streamable HTTP + OAuth) |
| `services/edge/src/mcp-tools.ts` | NEW — Tool definitions + handlers (verify + search) |
| `services/edge/src/index.ts` | MODIFIED — Added /mcp route |
| `tests/infra/llms-txt.test.ts` | NEW — 12 validation tests |
| `tests/infra/mcp-server.test.ts` | NEW — 8 tool + handler tests |

---

## Bug Tracker

| ID | Date | Summary | Severity | Status | Detail |
|----|------|---------|----------|--------|--------|
| BUG-AUDIT-01 | 2026-03-12 | No global toast system | HIGH | PARTIAL | Sonner wired, toast calls not in hooks yet |
| BUG-AUDIT-02 | 2026-03-12 | Dead footer links | HIGH | RESOLVED | Pages created + routed (uncommitted) |
| BUG-AUDIT-03 | 2026-03-12 | No favicon/logo/OG tags | HIGH | COMPLETE | PR #30 merged |

---

## Verification Pending

**MCP Server verification:** After `wrangler deploy`, test with MCP Inspector:
```bash
npx @modelcontextprotocol/inspector https://arkova-edge.<account>.workers.dev/mcp
```
Then call `verify_credential` with `{ "public_id": "ARK-2026-001" }` and `search_credentials` with `{ "query": "University of Michigan" }`.

**llms.txt validation:** Verify at `https://arkova-edge.<account>.workers.dev/llms.txt` — should return valid markdown under 5KB with all required sections.

**Crawl test on live university domain:** Requires deployed edge worker with Workers AI binding. Run:
```bash
# After wrangler deploy:
curl -X POST https://arkova-edge.<account>.workers.dev/crawl \
  -H 'Content-Type: application/json' \
  -d '{"domains":["umich.edu"]}'
```
Then verify in Supabase:
```sql
SELECT institution_name, domain, source, confidence_score,
       embedding IS NOT NULL as has_embedding
FROM institution_ground_truth
WHERE source = 'cloudflare_crawl';
```
