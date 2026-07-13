# S3.3 — 429 Limiter Map (five-bucket attribution)

**Story:** L2-S0 (Sprint 3.3, Lane 2) · **Binding source:** CTO memo R2 (2026-07-10) — exit criterion 3 STRUCK, replaced by 3a/3b/3c. · **Verified against:** `origin/main` @ `ad1d2487` on 2026-07-10 — every `file:line` below was re-verified in-tree by the author (not inherited from the plan; the plan's "four 429 sources" claim was falsified in both directions).
**Drift lint:** `scripts/ci/check-429-limiter-map.test.ts` re-asserts every row of the [Claims ledger](#claims-ledger-drift-linted) and both dead-code claims on every CI run. If that test fails, the tree moved — update this map, then re-check the attribution spec.

> Internal engineering note (CLAUDE.md §0-4): the audited spec lives on the SCRUM-2670 Confluence pages; this file exists so CI can lint the claims against the tree.

---

## 1. Complete 429 emitter inventory

Every path in `services/worker/` that can return HTTP 429, with what it limits, how it keys, and whether it is live on the S3.3 AI A/B soak path (`/api/v1/ai/*`, JWT-only).

### 1a. Generic `rateLimit()` instances (identical response bodies — see §3)

| Emitter | Defined | Limit / key | Mounted | Live on AI A/B path? |
|---|---|---|---|---|
| `anonRateLimiter` | `services/worker/src/api/v1/router.ts:156` | 100 req/min per IP | Router-wide dispatch `router.ts:167-173` (requests WITHOUT an API key) | **YES — the harness-suicide bucket.** A single-IP driver at 5k/hr (~83/min avg) bursts past 100/min/IP and 429s ITSELF before `aiRateLimiter` is ever consulted, regardless of JWT sharding. |
| `keyedRateLimiter` | `router.ts:161` | 1,000 req/min per API key (`req.apiKey?.keyId ?? req.ip`) | Same dispatch, requests WITH an API key | Not on `/ai/*` (JWT-only per `requireAuth` `router.ts:182-186`, which rejects `Bearer ak_`), but live on every API-key surface the soak's tier-mix lane exercises. |
| `aiRateLimiter` | `router.ts:263` | 30 req/min per user, key `ai:${authUserId ?? ip}` (`router.ts:266`) | All `/ai/*` mounts `router.ts:276-323`; also `/nessie/query` `router.ts:438`, key-inventory `router.ts:449`, regulatory alerts `router.ts:461`, compliance score/gap/cross-ref/trends `router.ts:452-468` | **YES** — the intended per-user AI limiter; requires ≥4 JWT shards at 5k/hr. |
| `batchRateLimiter` | `router.ts:206` | 10 req/min | `/verify/batch` `router.ts:222`, `/webhooks` `router.ts:371`, `/audit/batch-verify` `router.ts:457` | No (not an `/ai/*` mount). |
| `creditsRateLimiter` | `router.ts:255` | 10 req/min per user, key `credits:` | `/credits` `router.ts:260` | No. |

### 1b. Quota / bespoke emitters (non-`rateLimit()` bodies)

| Emitter | 429 at | Limit / key | Live on AI A/B path? |
|---|---|---|---|
| `usageTracking()` monthly quota | `services/worker/src/middleware/usageTracking.ts:171` (`FREE_TIER_MONTHLY_QUOTA = 10_000` at `:18`) | 10k requests/month for `rate_limit_tier='free'` API keys | Mounted router-wide (`router.ts:179`) but **API-key callers only** — `/ai/*` is JWT-only, so it cannot fire on the A/B arms. It CAN fire on the tier-mix lane's free API key (~2h to trip at 5k/hr). |
| Rules manual-run slot | `services/worker/src/api/rules-crud.ts:394` | per-org manual-run slot (`takeManualRunSlot(orgId)`) | No. |
| Account data export | `services/worker/src/api/account-export.ts:86` | one export per user per 24h (RPC-enforced; fixed 24h `Retry-After`) | No. |

### 1c. Dead code (bugs filed — see §5)

| Emitter | Evidence | Status |
|---|---|---|
| `perOrgRateLimit.ts` / `requireOrgQuota()` | `services/worker/src/middleware/perOrgRateLimit.ts:106` (middleware), `TIER_QUOTAS` `:32`, 429 at `:161` | **NEVER MOUNTED.** Zero non-test consumers in the tree (drift-linted). `organizations.tier` FREE/PAID/ENTERPRISE quotas are enforced nowhere. SCALE-01 / SCRUM-1023 half-landed. Any attribution bucket for it reads zero because it is **unreachable, not because load is well-behaved** — report as `structurally_zero (unmounted)`. |
| x402 payer rate limiter | `services/worker/src/middleware/x402PayerRateLimit.ts:37` (`createPayerRateLimiter`) | **ORPHAN.** Zero non-test consumers (drift-linted). The x402 payment path (`/nessie/query`, `router.ts:438`) runs with `aiRateLimiter` only — no payer-scoped limit. |

### 1d. Upstream model 429s (received, not emitted — and misclassified)

| Path | Where | Behavior |
|---|---|---|
| Tuned model (Vertex endpoint) | `services/worker/src/ai/gemini.ts:777-783` | On non-OK response: structured log `gemini.ts:779-782` (`'Vertex AI tuned model error'` with `{ status, errBody, tunedModel }`), then `gemini.ts:783` throws `new Error(\`Vertex AI tuned model error (${response.status})\`)` — **an Error with NO `.status` property**. |
| Embeddings (single / batch) | `gemini.ts:548` / `gemini.ts:615` | Same pattern: status only inside the message string. |
| Retry wrapper | `gemini.ts:827-859`, `MAX_RETRIES = 3` at `:52` | `withRetry` copies only `message` + `name` onto a fresh Error (LEAK-4 memory guard) — any status property is stripped even if one existed. |
| **Misclassification (real worker bug — filed)** | `services/worker/src/ai/fallback-chain.ts:57` and `:79` check `error.status` → sees `undefined`; message fallbacks `:68` / `:83` match only `'rate limit'` / `'quota exceeded'` — `"Vertex AI tuned model error (429)"` matches neither | **An upstream 429 is classified `provider_error`, NOT `rate_limit`.** Per CTO R2: the fix rides the next worker train; S3.3 does NOT patch the classifier mid-sprint — the soak measures the upstream bucket **from structured worker logs only** (`gemini.ts:779-782` and the embedding equivalents), never from `fallback_reason`. |

## 2. Why the response body cannot attribute (client-blind)

Every generic `rateLimit()` 429 returns the **identical body** `{ error: 'Too many requests', retry_after }` (`services/worker/src/utils/rateLimit.ts:139-142`). The client-visible and server-visible discriminators are:

- **`X-RateLimit-Limit` header value** (`rateLimit.ts:135`; also set on non-429 responses at `:153` per §1.10): `100` → anon-IP, `1000` → keyed, `30` → aiRateLimiter, `10` → batch/credits (disambiguate by path).
- **Server log key prefix** (`rateLimit.ts:129-132` logs `{ key, count, maxRequests }` at warn): `ai:` → aiRateLimiter, `credits:` → credits, raw keyId → keyed, raw IP → anon.
- Quota/bespoke emitters have distinct bodies (`usageTracking.ts:171` includes `limit: 10000`; `account-export.ts:86` prose; `rules-crud.ts:394` `code: 'rate_limited'`).

Attribution is therefore a **header + log join**, per-request: harness records `(timestamp, request-id/label, status, X-RateLimit-Limit, path)`; worker logs supply the key prefix; upstream events come from the `gemini.ts` structured logs.

## 3. Five-bucket attribution spec (exit criterion 3a, CTO R2 — BINDING)

Buckets, evaluated on BOTH A/B arms, **never summed** (they measure different populations at different layers — a total is meaningless and R2 bans it):

| Bucket | Source of truth | Notes |
|---|---|---|
| 1. `anon-IP` | 429 + `X-RateLimit-Limit: 100` (+ log key = IP) | Must be **ZERO self-inflicted** (exit criterion 3b) — nonzero means the harness polluted its own arms; pace per-source <100/min/IP or go multi-IP. |
| 2. `keyed` | 429 + `X-RateLimit-Limit: 1000` (+ log key = keyId) | API-key surfaces only (tier-mix lane). |
| 3. `aiRateLimiter` | 429 + `X-RateLimit-Limit: 30` (+ log key prefix `ai:`) | The only per-user AI limit that exists today. |
| 4. `usageTracking-monthly` | 429 body with `limit: 10000` (`usageTracking.ts:171`) | API-key callers only; monthly window — a per-window count, not a rate. |
| 5. `upstream-model` | **Structured worker logs ONLY** (`gemini.ts:779-782`, `:548`, `:615` blocks with `status: 429`) — never `fallback_reason` (misclassified, §1d) | Tag by API surface: **Developer-API** (public `gemini-2.5-flash` key surface) vs **Vertex-regional** (tuned endpoint) — the two arms sit on different quota pools and R2 requires the distinction. |
| — `perOrgRateLimit` | Reported as **`structurally_zero (unmounted)`** with the bug link, NOT as a measured zero | Drift-linted; if it gets mounted mid-sprint the lint fails and this spec must be revised. |

Mechanism honesty (exit criterion 3c, R-7): the rc-manifest states that 429 mitigation comes from **rate-limiter architecture + traffic smoothing + surface choice + provisioned throughput**, NOT from tuning (a tuned model shares the base-model quota pool, cannot use the global endpoint, and is plausibly MORE exposed). "≥90% cut" language is **banned**.

## 4. Exit-criterion-3a bucket list (amended, verbatim for the rc-manifest)

```
buckets:
  - anon-IP              # X-RateLimit-Limit=100 header + IP log key; must be 0 self-inflicted
  - keyed                # X-RateLimit-Limit=1000 + keyId log key
  - aiRateLimiter        # X-RateLimit-Limit=30 + "ai:" log key prefix
  - usageTracking-monthly # body limit:10000; API-key surfaces only
  - upstream-model       # worker structured logs only; tagged Developer-API vs Vertex-regional
reported_not_measured:
  - perOrgRateLimit: structurally_zero (unmounted; SCALE-01/SCRUM-1023 half-landed — bug filed)
rules:
  - buckets are never summed
  - attribution = X-RateLimit-Limit header + server-log key-prefix join
  - upstream bucket never sourced from fallback_reason (misclassified provider_error — bug filed)
```

## 5. Bugs surfaced by this map (tracker: Confluence 88768514)

1. **perOrgRateLimit never mounted** — SCALE-01/SCRUM-1023 half-landed; tier quotas (`TIER_QUOTAS`, `perOrgRateLimit.ts:32`) enforced nowhere.
2. **x402 payer rate limiter orphaned** — `createPayerRateLimiter` (`x402PayerRateLimit.ts:37`) has zero non-test consumers; the paid `/nessie/query` surface has no payer-scoped limit.
3. **Upstream Vertex/Gemini 429 misclassified as `provider_error`** — `gemini.ts:783` throws without `.status`; `withRetry` strips to message; `fallback-chain.ts:57/:79/:68/:83` cannot see the 429. Breaks fallback telemetry AND retriability classification.
4. (Context, already tracked as provision Step-4 defects — L2-S2a-FIX / PR #1492.)

## Claims ledger (drift-linted)

Machine-readable; parsed by `scripts/ci/check-429-limiter-map.test.ts`. Each row asserts: FILE's LINE contains TEXT (pipes escaped as `\|`).

<!-- claims:begin -->
| # | File | Line | Must contain |
|---|---|---|---|
| 1 | services/worker/src/api/v1/router.ts | 156 | const anonRateLimiter = rateLimit({ |
| 2 | services/worker/src/api/v1/router.ts | 161 | const keyedRateLimiter = rateLimit({ |
| 3 | services/worker/src/api/v1/router.ts | 167 | router.use((req: Request, res: Response, next: NextFunction) => { |
| 4 | services/worker/src/api/v1/router.ts | 179 | router.use(usageTracking()); |
| 5 | services/worker/src/api/v1/router.ts | 182 | async function requireAuth(req: Request, res: Response, next: NextFunction) { |
| 6 | services/worker/src/api/v1/router.ts | 206 | const batchRateLimiter = rateLimit({ |
| 7 | services/worker/src/api/v1/router.ts | 222 | router.use('/verify/batch', requireScope('verify:batch'), batchRateLimiter, batchRouter); |
| 8 | services/worker/src/api/v1/router.ts | 255 | const creditsRateLimiter = rateLimit({ |
| 9 | services/worker/src/api/v1/router.ts | 260 | router.use('/credits', requireAuth, creditsRateLimiter, creditsRouter); |
| 10 | services/worker/src/api/v1/router.ts | 263 | const aiRateLimiter = rateLimit({ |
| 11 | services/worker/src/api/v1/router.ts | 266 | keyGenerator: (req) => `ai:${req.authUserId ?? req.ip ?? 'unknown'}`, |
| 12 | services/worker/src/api/v1/router.ts | 371 | router.use('/webhooks', batchRateLimiter, webhooksRouter); |
| 13 | services/worker/src/api/v1/router.ts | 438 | router.use('/nessie/query', x402PaymentGate('/api/v1/nessie/query'), aiRateLimiter, nessieQueryRouter); |
| 14 | services/worker/src/middleware/usageTracking.ts | 18 | const FREE_TIER_MONTHLY_QUOTA = 10_000; |
| 15 | services/worker/src/middleware/usageTracking.ts | 171 | res.status(429).json({ |
| 16 | services/worker/src/api/rules-crud.ts | 394 | res.status(429).json({ |
| 17 | services/worker/src/api/account-export.ts | 86 | res.status(429).json({ |
| 18 | services/worker/src/middleware/perOrgRateLimit.ts | 32 | export const TIER_QUOTAS |
| 19 | services/worker/src/middleware/perOrgRateLimit.ts | 106 | export function requireOrgQuota |
| 20 | services/worker/src/middleware/perOrgRateLimit.ts | 161 | res.status(429).json({ |
| 21 | services/worker/src/middleware/x402PayerRateLimit.ts | 37 | export function createPayerRateLimiter |
| 22 | services/worker/src/ai/gemini.ts | 52 | const MAX_RETRIES = 3; |
| 23 | services/worker/src/ai/gemini.ts | 781 | 'Vertex AI tuned model error', |
| 24 | services/worker/src/ai/gemini.ts | 783 | throw new Error(`Vertex AI tuned model error (${response.status})`); |
| 25 | services/worker/src/ai/gemini.ts | 548 | throw new Error(`Embedding generation failed (status ${response.status})`); |
| 26 | services/worker/src/ai/gemini.ts | 615 | throw new Error(`Batch embedding generation failed (status ${response.status})`); |
| 27 | services/worker/src/ai/fallback-chain.ts | 57 | if (status === 429 \|\| status === 503 \|\| status === 502 \|\| status === 504) { |
| 28 | services/worker/src/ai/fallback-chain.ts | 68 | if (msg.includes('rate limit') \|\| msg.includes('quota exceeded')) { |
| 29 | services/worker/src/ai/fallback-chain.ts | 79 | if (status === 429) return 'rate_limit'; |
| 30 | services/worker/src/ai/fallback-chain.ts | 83 | if (msg.includes('rate limit') \|\| msg.includes('quota exceeded')) return 'rate_limit'; |
| 31 | services/worker/src/utils/rateLimit.ts | 129 | logger.warn( |
| 32 | services/worker/src/utils/rateLimit.ts | 135 | res.setHeader('X-RateLimit-Limit', maxRequests.toString()); |
| 33 | services/worker/src/utils/rateLimit.ts | 139 | res.status(429).json({ |
<!-- claims:end -->
