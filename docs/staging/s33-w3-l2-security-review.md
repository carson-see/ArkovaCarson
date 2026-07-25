# S3.3 Wave 3 Lane 2 changed-file security review

Date: 2026-07-15
Branch: `codex/s33-w3-l2-2703-2705`
Frozen base: PR #1550 head `f424ce77912659f137d5256bbb08d97aa5d76cc7`
Stories: SCRUM-2703, SCRUM-2705

## Result

No open Critical or High changed-file security finding was identified. The
implementation fails closed when trusted identity, organization lookup,
capacity lookup, payment validation, replay lookup, payer identity, or bounded
payer tracking is unavailable.

This is a code and offline-test review. It is not staging, soak, production, or
release evidence. Post-Wave-3 staging smoke remains `DEFERRED_POST_WAVE3`.

## Review basis

- Reviewed every changed production, test, CI-attribution, and documentation
  file against the repository rules and the Express/Node security checklist.
- Rechecked the current official Supabase authentication guidance and changelog
  before changing JWT-backed authorization. Authorization never uses
  user-editable metadata: the verified JWT yields only the user id, and the
  organization is then resolved from the authoritative `profiles` row.
- Confirmed package manifests and lockfiles are unchanged. The worker production
  dependency audit reports zero vulnerabilities. The root audit's existing
  findings are recorded separately and were not introduced by this diff.

## Control review

| Surface | Security result |
| --- | --- |
| Anchor quotas | Organization identity comes only from `req.apiKey.orgId`. Strict Zod validation bounds single and bulk cardinality; invalid bodies reach the existing 400 without consuming quota. Daily increments use the atomic `increment_org_usage` RPC with the exact validated delta. |
| Persisted rule capacity | A server-verified JWT is converted to a user id, then to the authoritative profile organization. Body organization fields are ignored. Lookup errors and rejections return 503. Capacity reads are scoped by trusted `org_id`. |
| Connector capacity | API-key authentication and the explicit organization-admin guard run before quota evaluation. Capacity reads and inserts use the trusted API-key organization. Existing DNS-resolved private-address blocking, manual redirect handling, and outbound timeouts remain in place. |
| x402 identity | The payment gate validates the receipt through the configured Base RPC, plus the USDC contract/event topics, amount, and recipient. The payer comes only from the verified Transfer sender, is normalized, then HMAC-derived before entering request context or limiter state. Header-supplied payer values are ignored. |
| x402 abuse resistance | The payer store is process-local and hard-bounded. Exhaustion returns 503 instead of evicting identities or bypassing enforcement. Missing verified context fails closed. API-key and payments-disabled contexts bypass without consuming payer state. |
| Middleware ordering | Nessie is wired in the ratified order: payment gate, verified/bypass context, payer limiter, existing AI limiter, handler. Invalid or absent payment cannot reach payer limiting or the handler. |
| Headers and CORS | Canonical quota/payer headers and one-cycle compatibility aliases expose only limit metadata. Browser exposure remains origin-allowlisted in production. Every new 429 emits an integer `Retry-After`. |
| Logs and secrets | No raw payer address enters limiter state, request payer context, or new logs. On-chain fetch failures log only a coarse error class so a credential-bearing RPC URL cannot be serialized. No secrets or credentials were added. Database builders remain parameterized; dynamic capacity table selection is constrained to a code-owned two-entry map. |
| Headline attribution | The five existing headline 429 buckets are unchanged. Per-org and payer limiters are explicitly mounted-but-excluded and are not represented as a sixth bucket. |

## Residual risks and non-applicable scope

1. **Medium — capacity enforcement is authoritative but not atomic across
   concurrent worker instances.** `rules_total` and `connectors_total` read the
   current database count before the existing handler insert. Two simultaneous
   creates can both observe remaining capacity and temporarily exceed the plan
   cap. A hard cross-instance cap requires a database-side transaction,
   constraint, or create RPC. No schema/RPC expansion was ratified for this
   patch, so this remains explicit Lane 1/CTO review input rather than being
   hidden as closed.
2. **Low — payer limiting is intentionally process-local.** Limits are per
   worker process and reset on restart. This matches the ratified backend; a
   globally coordinated limit requires a later shared store.
3. **Non-applicable — no providerless rule-draft route exists.** The repository
   does not mount `POST /api/rules/draft`, so `rule_drafts` is not attached to a
   fabricated endpoint. `rules_total` is mounted once on the real persisted
   `POST /api/rules` route, per CTO Option A.

## Files reviewed

- `services/worker/src/middleware/{perOrgRateLimit,x402PaymentGate,x402PayerRateLimit}.ts`
- `services/worker/src/api/v1/{anchor-submit,anchor-bulk,webhooks,router}.ts`
- `services/worker/src/routes/{admin,middleware}.ts`
- `services/worker/src/types/express.d.ts`
- All directly changed/new tests for those files.
- `scripts/ci/check-429-limiter-map.test.ts`
- `scripts/staging/s33-429-attribution.ts` and its test.
- `docs/staging/429-limiter-map-s33.md` and this review.
