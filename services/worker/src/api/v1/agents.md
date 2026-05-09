# services/worker/src/api/v1/agents.md

Public v1 API surface — frozen contract per CLAUDE.md §1.8. Additive nullable fields only; breaking changes require `v2+` prefix and 12-month deprecation.

## Files
- `router.ts` — mounts every v1 endpoint with its `requireScope(...)` gate. Anonymous-GET allow on `/verify` is intentional (Constitution §1.10 zero-friction public verification, rate-limited 100/min).
- **`anchor-submit.ts`** — `POST /api/v1/anchor`. Frozen Zod request shape. Idempotent on duplicate fingerprint (returns existing public_id with HTTP 200). Now wired (SCRUM-1740 commit 9fdaed23) to `ensureAnchorQuotaAvailable` → 402 problem+json `quota_exhausted` for sandbox orgs over their `anchor_quota`. Gate runs AFTER dedup so re-anchoring an existing fingerprint doesn't burn quota.
- `verify.ts` — `GET /api/v1/verify/:public_id`. Anonymous-allowed.
- `anchor-bulk.ts`, `attestations.ts`, `oracle.ts`, `cle-verify.ts`, etc. — additional v1 surfaces.

## Scope mapping (verified 2026-05-08)
| Endpoint | Scope |
|---|---|
| `POST /api/v1/anchor` | `anchor:write` |
| `GET /api/v1/verify/<id>` | anonymous OR `verify` |
| `POST /api/v1/batch-verify` | `verify:batch` |
| `GET /api/v1/usage` | `usage:read` |
| `/api/v1/anchor/bulk`, `/api/v1/contracts` | `anchor:write` |

## Conventions
- Request validation: Zod `safeParse` with structured `details: [{path, code, message}]` 400 response.
- Response shape: never include `id`, `org_id`, `user_id`, `fingerprint`, `agent_id`, `key_id` (CLAUDE.md §6 banned-field list — enforced runtime in `services/worker/src/api/v2/mcpParity.ts`).
- 402 problem+json shape: `{type, title, status, error, message}` plus per-error context.

## Open work
- SCRUM-1740 (PR #738) — quota gate awaits Carson merge + Mon deploy.
