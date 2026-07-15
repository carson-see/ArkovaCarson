# S3.3 — 429 Limiter Map (five-bucket attribution)

**Story:** Sprint 3.3 Lane 2; SCRUM-2703 / SCRUM-2705 / SCRUM-2707 / SCRUM-2793 · **Binding source:** CTO memo R2 (2026-07-10), [Wave 2 final alignment](https://arkova.atlassian.net/wiki/spaces/A/pages/104202241) (2026-07-15), and the Wave 3 CTO repository-truth ruling. · **Verified against:** Wave 3 branch based on frozen PR #1550 head `f424ce77912659f137d5256bbb08d97aa5d76cc7` on 2026-07-15.
**Drift lint:** `scripts/ci/check-429-limiter-map.test.ts` re-asserts every row of the [Claims ledger](#claims-ledger-drift-linted) and the exact mounted/excluded consumers on every CI run. If that test fails, the tree moved — update this map, then re-check the attribution spec.

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

### 1c. Mounted quota limiters excluded from the five headline buckets

| Emitter | Evidence | Status |
|---|---|---|
| `perOrgRateLimit.ts` / `requireOrgQuota()` | Mounted after trusted identity on schema-valid `POST /api/v1/anchor`, `/anchor/submit`, `/anchor/bulk`, persisted-rule `POST /api/rules`, and connector registration `POST /api/v1/webhooks` | **LIVE, but outside the five-bucket A/B headline soak.** Daily anchor cardinality uses the atomic usage RPC; rule and connector creation use authoritative current row counts. Canonical headers are `X-Org-Quota-{Anchors,Rule-Drafts,Rules,Connectors}-*`; the Anchors-Created and Connector-Webhooks aliases remain for one compatibility cycle. The providerless rule-draft module remains unmounted, so `rule_drafts` is explicitly not claimed as enforced. Report `mounted_excluded (write-surfaces-outside-headline-soak)`, never a sixth bucket. |
| x402 verified-payer limiter | `x402PaymentGate` derives an opaque HMAC key from the verified USDC Transfer sender; `/nessie/query` order is payment gate → payer limiter → AI limiter → handler | **LIVE only on paid Nessie.** API-key and disabled-payment paths carry explicit bypass context; missing verified identity fails closed. The bounded process-local store never receives raw wallet addresses. Report `mounted_excluded (nessie-only-outside-headline-soak)`, never a sixth bucket. |

### 1d. Upstream model 429s (received, preserved, and safely classified)

| Path | Where | Behavior |
|---|---|---|
| Developer API generation | `services/worker/src/ai/gemini.ts:294-349` | SDK failures are normalized before tracing. Numeric HTTP status and `Retry-After` are retained in `AIProviderHttpError`; the current attempt and per-invocation server UUID are supplied by `withRetry()`. Raw SDK messages, bodies, request context, headers, and credentials are not retained. |
| Developer API embeddings (single / batch) | `gemini.ts:895-903` / `:964-972` | Non-OK responses become `AIProviderHttpError` through `upstreamResponseError()`. The provider body is drained and discarded; the structured event records only bounded attribution metadata, request-instance UUID, and retry-loop attempt. |
| Tuned model (Vertex regional endpoint) | `gemini.ts:1136-1151` | Non-OK responses preserve status, parsed `Retry-After`, exact model resource, region, v6 prompt flag, schema state, MIME type, API surface, request-instance UUID, and retry-loop attempt. The body is never logged, thrown, or traced. |
| Retry wrapper | `gemini.ts:1195-1237`, `MAX_RETRIES = 3` near `:54` | `withRetry()` generates one server-side UUID per provider invocation and supplies that same ID plus attempt identity (`1..3`) to every upstream HTTP-error logging path. `cloneSafeRetryError()` preserves only allowlisted status/attribution fields. Auth/validation statuses 400/401/403/422 do not retry; 429 and transient availability failures remain eligible for retry/fallback. |
| Fallback classification | `services/worker/src/ai/fallback-chain.ts:51-98` | Validated status `429` classifies as `rate_limit`; 502/503/504 classify as `provider_unavailable`. Fallback metrics retain only the bounded classification, never a raw provider error string. |

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
| 4. `usageTracking-monthly` | 429 body with `limit: 10000` (`usageTracking.ts:171`) plus `X-RateLimit-Limit: 1000` | API-key callers only and downstream of `keyedRateLimiter`; missing or contradictory keyed-header metadata rejects the artifact. Monthly window — a per-window count, not a rate. |
| 5. `upstream-model` | Structured `event=ai_upstream_http_error` worker logs (`gemini.ts:242-264`) with status `429`; `fallback_reason=rate_limit` is corroborating classification, not the evidence source of truth | Tag by API surface: **Developer-API** (public `gemini-2.5-flash` key surface) vs **Vertex-regional** (tuned endpoint) — the two arms sit on different quota pools and R2 requires the distinction. Exact model, region, v6 prompt flag, response-schema state, MIME type, server-generated request-instance UUID, client correlation ID, retry-loop attempt, and `Retry-After` must match the arm declaration. Logs coalesce only by request-instance UUID; attempts are unique, strictly increasing, and bounded at 3. Sparse 429 attempts are valid because intervening non-429 attempts are intentionally absent. Client correlation reuse cannot collapse distinct invocations, and timestamps never create identity. |
| — `perOrgRateLimit` | Reported as **`mounted_excluded (write-surfaces-outside-headline-soak)`**, NOT as a sixth bucket | Covers the ratified write surfaces. `rule_drafts` remains non-applicable until a real provider-backed route exists. |
| — `x402PayerRateLimit` | Reported as **`mounted_excluded (nessie-only-outside-headline-soak)`**, NOT as a sixth bucket | Applies only after verified x402 payment on Nessie; API-key/disabled paths bypass explicitly. |

Mechanism honesty (exit criterion 3c, R-7): the rc-manifest states that 429 mitigation comes from **rate-limiter architecture + traffic smoothing + surface choice + provisioned throughput**, NOT from tuning (a tuned model shares the base-model quota pool, cannot use the global endpoint, and is plausibly MORE exposed). "≥90% cut" language is **banned**.

## 4. Exit-criterion-3a bucket list (amended, verbatim for the rc-manifest)

```
buckets:
  - anon-IP              # X-RateLimit-Limit=100 header + IP log key; must be 0 self-inflicted
  - keyed                # X-RateLimit-Limit=1000 + keyId log key
  - aiRateLimiter        # X-RateLimit-Limit=30 + "ai:" log key prefix
  - usageTracking-monthly # body limit:10000 + keyed X-RateLimit-Limit=1000
  - upstream-model       # worker structured logs only; tagged Developer-API vs Vertex-regional
reported_not_measured:
  - perOrgRateLimit: mounted_excluded (write-surfaces-outside-headline-soak)
  - x402PayerRateLimit: mounted_excluded (nessie-only-outside-headline-soak)
rules:
  - buckets are never summed
  - attribution = X-RateLimit-Limit header + server-log key-prefix join
  - upstream bucket comes from event=ai_upstream_http_error; fallback_reason is corroborating only
  - upstream request identity comes only from worker requestInstanceId UUID; never client correlation/timestamps
  - upstream 429 attempts are unique, strictly increasing, and bounded to 1..3 per requestInstanceId; sparse sets are valid
  - every observed 429 carries a valid Retry-After value
  - public arm = Developer-API/global/production prompt/no tuned model/schema unset
  - tuned arm = Vertex-regional/exact tuned model/v6 prompt/schema unset
```

`scripts/staging/s33-429-attribution.ts` enforces this packet fail-closed: strict metadata-only schemas, client request-target canonicalization to pathname only (query and fragment suffixes are stripped), exact generic-limiter correlation joins with at most 60 seconds of skew, keyed-header `1000` on monthly quota rows, request-level coalescing only by a required worker-generated UUID, unique/strictly-increasing/bounded attempts per UUID, run-to-upstream provenance matching, the five separate buckets with no total field, and both newly live limiters marked `mounted_excluded`. Sparse 429 attempt sets are accepted because non-429 attempts are not inputs; duplicate/out-of-sequence/out-of-range attempts or one server UUID spanning client correlations reject the artifact. Client correlation IDs and timestamps are context fields, never grouping identity. Unknown fields are rejected so raw bodies, raw limiter keys, prompts, fingerprints, PII, JWTs, and API keys cannot enter the evidence record.

## 5. Remediation state and explicit gap

1. **Per-org quotas mounted by SCRUM-2703.** Anchors use validated request cardinality; persisted rules and registered connectors use authoritative capacity. Trusted org context is mandatory and lookup failures fail closed.
2. **Verified-payer limiter mounted by SCRUM-2705.** Paid Nessie derives its key from the verified on-chain transfer sender, HMACs it, and enforces the payer window before `aiRateLimiter`.
3. **Explicit non-applicable gap:** `rules-draft.ts` has no production provider or route. Per the CTO ruling, this change does not invent one and does not double-meter persisted disabled rules as draft-generation requests.
4. **Upstream Vertex/Gemini 429 misclassification remains fixed by L2-A.** `AIProviderHttpError` preserves bounded status/`Retry-After`/arm metadata through retry cloning.

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
| 13 | services/worker/src/api/v1/router.ts | 488 | router.use('/nessie/query', x402PaymentGate('/api/v1/nessie/query'), x402PayerRateLimit, aiRateLimiter, nessieQueryRouter); |
| 14 | services/worker/src/middleware/usageTracking.ts | 18 | const FREE_TIER_MONTHLY_QUOTA = 10_000; |
| 15 | services/worker/src/middleware/usageTracking.ts | 171 | res.status(429).json({ |
| 16 | services/worker/src/api/rules-crud.ts | 394 | res.status(429).json({ |
| 17 | services/worker/src/api/account-export.ts | 86 | res.status(429).json({ |
| 18 | services/worker/src/middleware/perOrgRateLimit.ts | 32 | export const TIER_QUOTAS |
| 19 | services/worker/src/middleware/perOrgRateLimit.ts | 106 | export function requireOrgQuota |
| 20 | services/worker/src/middleware/perOrgRateLimit.ts | 161 | res.status(429).json({ |
| 21 | services/worker/src/middleware/x402PayerRateLimit.ts | 37 | export function createPayerRateLimiter |
| 22 | services/worker/src/ai/gemini.ts | 53 | const MAX_RETRIES = 3; |
| 23 | services/worker/src/ai/gemini.ts | 118 | export class AIProviderHttpError extends Error implements AIProviderHttpErrorMetadata { |
| 24 | services/worker/src/ai/gemini.ts | 249 | event: 'ai_upstream_http_error', |
| 25 | services/worker/src/ai/gemini.ts | 879 | `Embedding generation failed (status ${response.status})`, |
| 26 | services/worker/src/ai/gemini.ts | 947 | `Batch embedding generation failed (status ${response.status})`, |
| 27 | services/worker/src/ai/fallback-chain.ts | 67 | if (status === 429 \|\| status === 503 \|\| status === 502 \|\| status === 504) { |
| 28 | services/worker/src/ai/fallback-chain.ts | 78 | if (msg.includes('rate limit') \|\| msg.includes('quota exceeded')) { |
| 29 | services/worker/src/ai/fallback-chain.ts | 89 | if (status === 429) return 'rate_limit'; |
| 30 | services/worker/src/ai/fallback-chain.ts | 90 | if (status === 502 \|\| status === 503 \|\| status === 504) return 'provider_unavailable'; |
| 31 | services/worker/src/utils/rateLimit.ts | 129 | logger.warn( |
| 32 | services/worker/src/utils/rateLimit.ts | 135 | res.setHeader('X-RateLimit-Limit', maxRequests.toString()); |
| 33 | services/worker/src/utils/rateLimit.ts | 139 | res.status(429).json({ |
| 34 | services/worker/src/ai/gemini.ts | 1191 | lastError = cloneSafeRetryError(err); |
| 35 | scripts/staging/s33-429-attribution.ts | 15 | export const S33_429_BUCKETS = [ |
| 36 | scripts/staging/s33-429-attribution.ts | 260 | export function buildS33429AttributionEvidence(input: unknown): S33429AttributionEvidence { |
| 37 | services/worker/src/ai/gemini.ts | 1196 | fn: (attempt: AIProviderRetryAttempt, requestInstanceId: string) => Promise<T>, |
| 38 | services/worker/src/api/v1/anchor-submit.ts | 246 | const anchorCreateQuota = requireOrgQuota({ |
| 39 | services/worker/src/api/v1/anchor-bulk.ts | 106 | const bulkAnchorQuota = requireOrgQuota({ |
| 40 | services/worker/src/api/v1/webhooks.ts | 229 | const connectorCapacityQuota = requireOrgQuota({ |
| 41 | services/worker/src/routes/admin.ts | 427 | const ruleCapacityQuota = requireOrgQuota({ |
<!-- claims:end -->
