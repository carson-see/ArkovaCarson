# agents.md — tests/edge
_Last updated: 2026-08-15_

## What This Folder Contains

Vitest tests for Cloudflare edge worker security helpers. These run in `@vitest-environment node` because the helpers use standard Node 20+ crypto APIs, and they live in the ROOT suite because of the CF-type constraint in Do/Don't below.

**Correction (2026-08-15):** this file previously said these tests live here "because the edge worker lacks its own test harness" / "has no vitest config". That stopped being true when Story D PR-1 (2026-06-05) added `services/edge/vitest.config.ts` + `npm test`. The real and still-current reason is the CF-type rule below, NOT the absence of a runner.

## Which Suite Runs What

Two independent runners, both CI-gated as of 2026-08-15:

| Suite | Config | Env | CI step |
|---|---|---|---|
| Root (this folder) | `vitest.config.ts` (repo root) | `jsdom` | `Tests` → "Run tests with coverage" |
| Edge (`services/edge/src/*.test.ts`) | `services/edge/vitest.config.ts` | `node` | `Tests` → "Run edge worker tests" |

Root vitest globs only `tests/**`, `src/**`, `scripts/**` **from the repo root**, so nothing under `services/edge/` is ever collected by the root run — and vice versa. A test is gated by exactly one of these two runners; putting it in neither means it gates nothing (that was true of the whole edge suite until 2026-08-15).

## Key Files
- `mcp-jwt-verify.test.ts` — tests `verifySupabaseJwt` local JWT verification (SCRUM-926 / MCP-SEC-07): forged signatures, expired tokens, wrong aud/iss, missing claims
- `mcp-security.test.ts` — tests HMAC validation, rate-limiting, and security helpers for the edge MCP proxy (SCRUM-923/919/924/920)

## Do / Don't Rules
- DO: Declare CF Worker types (`KVNamespace`, `R2Bucket`, etc.) locally in the test file — importing `@cloudflare/workers-types` globally breaks frontend type resolution
- DON'T: Import these tests from the edge worker build — they live here for the CF-type reason above, which is a real constraint (the edge worker DOES have its own vitest config; see the correction at the top)
- DON'T: assume a new edge test belongs here. If it exercises a module that needs the ambient CF globals (`Ai`, `KVNamespace`, …) — e.g. `services/edge/src/mcp-tools.ts`, which annotates `_ai?: Ai` — it belongs in the edge suite, because the root tsconfig deliberately omits `@cloudflare/workers-types` from global `types`. Only put it here when the code under test is small enough to cover with LOCAL ambient declarations
