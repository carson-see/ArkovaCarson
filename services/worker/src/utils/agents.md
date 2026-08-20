# services/worker/src/utils/agents.md

Shared utilities consumed across the worker. Each file is small and single-purpose. Test colocated as `<name>.test.ts`.

## 2026-08-17 — `sentry.ts`: `event.extra` is now walked recursively (§1.1 hole)

**The gap.** `scrubPiiFromEvent` ran `scrubString` over exception values, the message, the
transaction name, tags and `request.url` — but for `event.extra` it did something else entirely: it
replaced *exact top-level keys* from `SENSITIVE_EXTRA_KEYS` with `[FILTERED]` and stopped. So:

1. Any **other** top-level key's string value was emitted verbatim. `{ notes: 'escalated to
   x@y.com' }` shipped the address.
2. **Nested** extras were never key-filtered at all — `{ ctx: { email: … } }` passed straight
   through, because `'email' in event.extra` is false.

`captureCreditRpcFailureAlert` spreads caller-supplied `...args.extra` into that bag, so every call
site handing it a nested object was a live path for an email / document fingerprint / API key into
Sentry. §1.1 forbids all three outright.

**The fix.** `scrubExtraValue()` walks `event.extra` recursively, applying **both** the key filter
and `scrubString` at every level. It runs *after* `scrubBinaryValues`, so the SCRUM-2492 type-based
binary drop still happens first and the `[REDACTED_BYTES]` tokens it leaves are inert to the string
pass.

**Depth is a bound, not a bypass.** Past `MAX_SCRUB_DEPTH` the walk returns `REDACTED_DEPTH_TOKEN`
rather than the subtree — "we could not check this" must never render as "this is fine", the same
reasoning as `orgFieldPolicy`'s truncated-payload rejection. Two consequences worth knowing: it also
terminates a cyclic `extra`, and it closes the matching depth hole in `scrubBinaryValues` (which
returns deep values verbatim) for anything riding on `extra`. Strings are handled *before* the depth
guard, so a deep string is redacted rather than dropped.

**One existing contract was deliberately NARROWED — read this before you "fix" the test.**
SCRUM-2900's scheduler-pause dead-man wants `actor_principal` in `extra` to survive, and the old test
demonstrated that with a **human** email (`carson@arkova.ai`). It survived only because `extra` was
never walked — i.e. by the same defect. The surviving exemption is now anchored to the GCP
service-account shape (`/^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*\.iam\.gserviceaccount\.com$/`), which
is what the production caller actually passes. A human email in that field is scrubbed to `[EMAIL]`;
§1.1 has no person-shaped exemption. The pattern is anchored end-to-end so nothing can ride alongside
a principal. Attribution degrades rather than disappears — the Cloud Scheduler audit log still holds
the identity.

**Known trade-off, accepted.** `scrubString`'s regexes cannot distinguish a 64-hex Bitcoin txid from
a 64-hex document fingerprint, or a 10-digit id string from a phone number, so operational strings of
those shapes inside `extra` now redact too. That is the cost of §1.1 being absolute about
fingerprints. Routing and triage key on Sentry **tags**, not extras, and the tag pass is unchanged.
Prefer numbers over numeric strings in new `extra` payloads.

Tests: `sentry-extra-scrub.test.ts` (15 cases, red-first) plus the narrowed + added
`captureSchedulerPauseAlert` cases in `sentry.test.ts`. T2 (worker behavior).

## 2026-08-10 — new `orgFieldPolicy.ts`: org-scoped request-field rejection (DPA Schedule 1 / clause 4.6)

The first per-org *request shape* control in the worker. `switchboard_flags` is global (no `org_id`)
and the only pre-existing per-org write gate was whole-org suspension, so there was no way to say
"this one organisation may not send field X". A DPA can oblige Arkova to reject a prohibited field
**independently of the counterparty agreeing to stop sending it**, which is a control, not a promise —
`enforceOrgFieldPolicy` reads `public.organization_field_policies` (migration `0405`) and 400s the
request. Wired into `api/v1/anchor-submit.ts`, `api/v1/anchor-bulk.ts`, and therefore also the
dashboard `anchor-bulk-self-service.ts` fall-through.

Four decisions worth not re-litigating:

- **It walks the RAW body, not the Zod output.** Both anchor schemas are `.strict()` today, so an
  unknown top-level key already 400s — but that is a property of a schema someone can relax, not a
  guarantee, and `metadata` is `z.record(..., z.unknown())`, which passes a nested `description`
  through untouched. Walking the raw body makes the control independent of another module's
  strictness and catches `metadata.description` and `anchors[3].description` as well as top-level.
- **Rejects on key PRESENCE, whatever the value.** `description: null` still sends a field the
  agreement does not permit.
- **`truncated` is a rejection, not a pass.** A payload past the depth/node budget is one we could
  not certify; "we could not check" must never render as "it is fine".
- **Failure semantics are asymmetric on purpose.** Table missing ⇒ `0405` is not deployed ⇒ no org
  can have a policy ⇒ permissive (same shape as `professionalEducationSchemaGate`). Read fails with
  a recent cached answer ⇒ serve the stale one, so a DB blip cannot switch a contractual control
  off. Read fails cold ⇒ **fail closed** with 503, matching `anchor-bulk.ts`'s own
  `duplicate_check_unavailable` precedent on the same route; the read hits the same Postgres as the
  insert that would follow, so the availability cost is close to zero. `DISABLE_ORG_FIELD_POLICY=true`
  is the break-glass for that path and logs at error level every time it suppresses a check.

Policy is cached per org for 60s (negative results too, so orgs without a policy cost ~1 read/min).
`clearOrgFieldPolicyCache()` is exported for tests — a test that configures a policy for an org an
earlier test already resolved must call it, or it reads the earlier answer.

## 2026-08-03 — new `mempool-url.ts` (SCRUM-3016); `sentry.ts` gains two new fingerprinted alerts (SCRUM-3021, SCRUM-3017) (PR #1965)

- **`mempool-url.ts` (new).** `normalizeMempoolHostUrl` / `resolveMempoolApiBase` / `resolveMempoolHostBase`
  — the single place that resolves an operator-set `MEMPOOL_API_URL` for BOTH conventions this repo's
  chain/queue code uses (some callers want the base WITH `/api`, some append `/api/...` themselves and
  want the bare host). Full incident writeup in the module docstring and `chain/agents.md`. Pure
  functions, no I/O — `mempool-url.test.ts` covers both resolvers directly.
- **`sentry.ts`** gains `captureConfirmationTipHeightUnavailable` (own fingerprint
  `CONFIRMATION_TIP_HEIGHT_FINGERPRINT`) for SCRUM-3021 (`jobs/check-confirmations.ts`'s chain-tip-height
  fetch failing from both mempool.space and blockstream.info) and `captureStuckSubmittedAlert` (own
  fingerprint `STUCK_SUBMITTED_FINGERPRINT`, mirrors the existing `captureStuckAnchorAlert` shape exactly)
  for SCRUM-3017 (`jobs/stuck-anchor-monitor.ts`'s new SUBMITTED-stage watchdog). Both follow the
  established pattern in this file: a stable fingerprint so repeated cron re-fires of the SAME condition
  collapse into one Sentry issue instead of flooding the inbox. See `jobs/agents.md` for the full writeup
  of both fixes, including the honest caveat that a Sentry `captureMessage` is an issue, not a page —
  delivery depends on project-level alert rules/notification channels this session did not touch or
  re-verify.

## Files
- **`merkle.ts` / `merkle-verify.ts` (S3-P0)** — `buildMerkleTree` now documents the leaf-ordering contract (caller-ordered; the batch producer sorts by fingerprint asc, id asc), the Bitcoin double-SHA256 node rule and odd-node duplication, and returns `proofsByIndex` (positional branches — correct for duplicate fingerprints, which the legacy fingerprint-keyed `proofs` map interleaves into one unusable entry). Known-vector tests pin 2/3/4/5-leaf roots. Verify side unchanged (CVE-2012-2459 structural guard).
- `db.ts` — Supabase service-role client. Lazy-initialized; throws if env not set. Passes `realtime: { transport: ws }` for Node 20 compat (supabase-js ≥2.105.4 requires explicit WebSocket implementation on Node <22).
- `logger.ts` — pino logger with PII scrubbing (CLAUDE.md §1 Sentry rule). SCRUM-2492: a type-based `formatters.log` hook recursively redacts any binary value (Buffer/TypedArray/ArrayBuffer/serialized-Buffer shape) regardless of key, so connector document bytes never reach the logs. **SCRUM-3050 (silent-failure hardening):** that redaction hook rebuilt every logged object with `Object.keys()`, and it runs BEFORE the `error`/`err` serializers — so an `Error` (whose `message`/`stack` are NON-enumerable) was reduced to `{}` before any serializer could see it. Every `logger.error`/`logger.warn` in the worker emitted `"error": {}`, and a plain PostgREST error object came out as `{message, stack: "", type: "Object"}` with `code`/`details`/`hint` dropped — which is why root-causing the 70h anchoring outage needed database archaeology. `redactBinaryValues` is now Error-aware (converts via `serializeErrorValue`, preserving `type`/`message`/`stack` at any nesting depth, then redacts), and the serializer no longer runs pino's `err` serializer over non-Errors (it was fabricating the fake `stack: ""`). `buildLoggerOptions()` is exported so `logger.error-serializer.test.ts` can assert the REAL emitted JSON line — `logger.test.ts` mocks pino wholesale and was structurally blind to this class of bug. Do not reintroduce an `Object.keys()` clone over unknown values without an Error branch.
- **`jobPostcondition.ts` (SCRUM-3050)** — `evaluateJobPostcondition()` / `assertJobPostcondition()`. A cron handler that CLAIMED N units of work and COMPLETED ZERO must not answer HTTP 200: the 70h anchoring outage was a handler that logged every chunk's `400 Bad Request`, `continue`d, produced nothing, and reported success. Throwing turns the silence into a Cloud Scheduler `AttemptFinished` ERROR entry, which is exactly what the SCRUM-3050 GCP alert policy watches — the postcondition MAKES the failure observable, the alert policy ROUTES it. Deliberate non-goals: `attempted === 0` is fine (an idle queue is legitimate; feeder death is SCRUM-2900's job), and partial failure stays a 200 marked `degraded` (retrying would redo the units that succeeded). Applied narrowly so far — only `jobs/monthly-allocation-rollover.ts`. Not a framework; see the SCRUM-3050 handoff for the audited list of remaining log-and-continue sites.
- **`byte-safety.ts` (SCRUM-2492 / §1.6A)** — single source of truth for "does this look like raw document bytes?" detection: `isBinaryValue` (Buffer/TypedArray/DataView/ArrayBuffer), `isSerializedBufferShape`, `looksLikeRawBytes` (control-run + repeat-run heuristics), `SERIALIZED_BUFFER_RE`, `REDACTED_BYTES_TOKEN`. `jobQueue.ts`'s `sanitizeLastError` re-imports these (no duplicate copy). Also exports **`boundedErrorDetail(body)`** — builds the bounded (~500 char), byte-redacted, PII-scrubbed `detail` for `DocusignApiError`/`DriveApiError` on NON-document paths. NEVER feed it a raw document-fetch body.
- **`pii-scrub.ts` (SCRUM-2492)** — extracted from `sentry.ts`: the email/UUID/JWT/SSN/API-key/phone/IP/Supabase-ref regexes + `scrubString` / `scrubUrl` + `URL_TOKEN_REGEX`. Dependency-free (no `@sentry/node`) so `byte-safety.ts` (and thus `jobQueue.ts`) can reuse the PII scrub without dragging the Sentry SDK into the job-queue import graph. `sentry.ts` re-exports `scrubString`/`scrubUrl` for back-compat.
- `rpc.ts` — typed `callRpc()` wrapper over `db.rpc()` with consistent error logging.
- **`anchor-stats.ts`** — `fetchAnchorStats()` shared by treasury-cache cron and treasury status API. SCRUM-1786: reads per-status counts from `pipeline_dashboard_cache` (refreshed every 2 min via `pg_class.reltuples`) instead of the `get_anchor_status_counts_fast` RPC (1s timeouts on 2.9M-row anchors table). Sentinel -1 convention preserved for callers.
- **`anchorProofs.ts` (FIX-1 / PROOF-02 + PROOF-03 + S3-P0)** — Merkle-proof persistence outside the hot `anchors` table. `upsertAnchorProofs()` writes the app-tree branch + integer `merkle_index`; PROOF-03 `block_header`/`block_hash` are emitted only when supplied (never clobber a populated header with null). S3-P0 adds `opReturnPayload` (→ `op_return_payload` bytea via the same `\x`-prefix contract, omit-when-undefined) — the batch producer persists the verbatim committed `"ARKV"+root` payload pre-broadcast, and `rawResponse` carries the `broadcast_intent` record (signed tx hex, public data once broadcast) on the merkle_index-0 row. Round-tripped against REAL local PG in `jobs/proof-pg-roundtrip.local.test.ts`. `updateAnchorConfirmationProofs()` does a per-anchor UPDATE of ONLY the bitcoin-tree columns (`block_header`/`block_hash`, never app-tree). **MED-2 (PR #1320):** that UPDATE now requests affected rows via `.eq('anchor_id', …).select('anchor_id')` and branches on `data?.length` — the prior code read `count` without `{ count: 'exact' }`, so `count` was always null, every row counted as `updated`, and `anchorsMissing` (the "no anchor_proofs row" warn) was permanently 0/unreachable. Pattern mirrors `jobs/anchorExpirySweep.ts` (`.select('id')` → `data.length`).
- `apiKeys.ts` — HMAC-SHA256 hash of raw API keys. Keep in sync with `services/edge/` and the `validate_api_key` RPC (migration 0299) which uses the same secret.
- `orgCredits.ts` — `deductOrgCredit()` wraps the `deduct_org_credit` RPC. Returns `{allowed, error?, balance?, required?, idempotent?}`; SCRUM-1649 FAST_TRACK retries use `idempotent=true` to detect a reused credit deduction. G4 (PR #1614): `ENABLE_ORG_CREDIT_ENFORCEMENT` now also has a default-OFF `switchboard_flags` row (migration 0363) — **AUDIT MIRROR ONLY, never read by the worker** (runtime gate = the env var in deploy-worker.yml; key is in flagRegistry `ENV_FLAG_GETTERS`, not `DB_FLAGS`; R-5 config-drift pins it false so a pre-G3 env flip fails CI). `orgCreditEnforcementFlag.test.ts` pins the semantics — flag absent/false ⇒ NOT enforcing (short-circuit `allowed:true feature_disabled`, anchor path never hard-blocked for non-credit orgs), flag ON + RPC failure ⇒ per-request 503 `credit_check_unavailable` (no silent free anchoring). Do not enable before HakiChain funding (G3).
- `anchorCreditGate.ts` (SCRUM-1631 PR #680; SCRUM-2970) — shared 402/503 response helper around `deductOrgCredit`. Returns `false` when a response has been written; caller early-returns AND compensates (hard-deletes the just-inserted row). `ensureAnchorCreditAvailable` REQUIRES a `referenceId` (BUG-2026-07-17-012: passing none bypassed the 0326 idempotency ledger → retry double-deducts). Callers insert the PENDING anchor row FIRST and pass the new row's id — a fresh uuid per anchoring event. Do NOT derive the reference from request content (fingerprint): permanent ledger row + soft-delete-aware dedup = free re-anchor after soft-delete (independent-review HIGH on PR #1570).
- **`anchorQuotaGate.ts` (SCRUM-1740, PR #738)** — sandbox quota gate. Reads `org_credits.{is_test, anchor_quota}` and counts non-deleted anchors for the org. Returns 402 problem+json (`type=https://arkova.ai/errors/quota-exhausted`) when at/over cap. No-op for prod orgs (anchor_quota IS NULL). **Fails OPEN** on transient DB read errors — sandbox quota is a soft cap, not a security boundary; 8 unit tests cover every branch including fail-open.
- `professionalEducationSchemaGate.ts` — PR #841 containment helper. Centralizes the default-off schema-readiness flag and shared 503 body for CPE/CLE runtime paths while prod lacks the #841 schema.
- `orgSuspensionGuard.ts` (SCRUM-1667) — sub-org suspension check.
- `sentry.ts` — Sentry init + mandatory PII scrubbing. SCRUM-2249: scrubbers collapse UUID identifiers → `[UUID]` (incl. `event.transaction` + `event.request.url`) and Supabase project-ref → `[SUPABASE_PROJECT]`. SCRUM-2492: the PII regexes + `scrubString`/`scrubUrl` now live in `pii-scrub.ts` (re-exported here); a type-based `scrubBinaryValues` pass drops document bytes from the whole event before the key-name PII passes. `release` = real `BUILD_SHA` (same value `/health` exposes), `serverName` = typed config Cloud Run `K_REVISION`/`K_SERVICE`. `IGNORED_ERROR_PATTERNS` drops GoTrue Navigator-lock + AbortError noise. `captureStuckAnchorAlert()` + `STUCK_ANCHOR_FINGERPRINT` are the stable seam PR #1055 (SCRUM-2234 stuck-anchor monitor) wires into so hourly re-fires collapse to one issue while preserving the caller's warning/error severity.
- **`db.ts`** — the service-role Supabase client + DB circuit breaker + `withDbTimeout`. **WH-1 (SCRUM-2899 / ARKOVA-WORKER-C):** the client is created with a custom `global.fetch` built from a dedicated bounded `undici.Agent` (short `keepAliveTimeout`) via `createResilientFetch()`, which retries ONCE on a connection-level failure (`isTransientConnectionError` — `fetch failed`/`ECONNRESET`/`UND_ERR_*`/nested `cause`). This ends the "TypeError: fetch failed" webhook drops caused by rotten keep-alive sockets on throttled Cloud Run — it fixes EVERY PostgREST/RPC caller, not just webhooks. Do NOT remove the custom fetch or widen the retry to HTTP-response errors (only transport failures are safe to retry). **WH-2:** `SUPABASE_POOLER_URL` is accepted as the REST base ONLY when its scheme is `http(s)`; a `postgres://`/`postgresql://` connection string is logged + ignored (falls back to `config.supabaseUrl`) so it can't silently become the REST base and 500 every call.
- `sentry.ts` — Sentry init + mandatory PII scrubbing. SCRUM-2249: scrubbers collapse UUID identifiers → `[UUID]` (incl. `event.transaction` + `event.request.url`) and Supabase project-ref → `[SUPABASE_PROJECT]`. SCRUM-2492: the PII regexes + `scrubString`/`scrubUrl` now live in `pii-scrub.ts` (re-exported here); a type-based `scrubBinaryValues` pass drops document bytes from the whole event before the key-name PII passes. `release` = real `BUILD_SHA` (same value `/health` exposes), `serverName` = typed config Cloud Run `K_REVISION`/`K_SERVICE`. `IGNORED_ERROR_PATTERNS` drops GoTrue Navigator-lock + AbortError noise. `captureStuckAnchorAlert()` + `STUCK_ANCHOR_FINGERPRINT` are the stable seam PR #1055 (SCRUM-2234 stuck-anchor monitor) wires into so hourly re-fires collapse to one issue while preserving the caller's warning/error severity. `capturePipelineThroughputAlert()` + `PIPELINE_THROUGHPUT_FINGERPRINT` (SCRUM-2901) are the same pattern for the pipeline-throughput dead-man (`jobs/pipelineThroughputMonitor.ts`). **SCRUM-3050 changed it in two ways.** (1) It now emits real Sentry **TAGS** (`source`/`story`/`alert_type`/`sustained_bucket`), not just `extra` — Sentry issue-alert rules filter on `TaggedEventFilter`, so the previous extra-only version could never have been matched by any rule even once someone created one. (2) The fingerprint takes an optional duration-bucket suffix so a sustained condition opens a genuinely NEW issue at each escalation boundary instead of aging silently in one; level rises `error` → `fatal` past 72h. Passing no third argument preserves the pre-SCRUM-3050 fingerprint exactly. When adding a new fingerprinted alert helper here, emit tags, not extras.
- `sentry.ts` — Sentry init + mandatory PII scrubbing. SCRUM-2249: scrubbers collapse UUID identifiers → `[UUID]` (incl. `event.transaction` + `event.request.url`) and Supabase project-ref → `[SUPABASE_PROJECT]`. SCRUM-2492: the PII regexes + `scrubString`/`scrubUrl` now live in `pii-scrub.ts` (re-exported here); a type-based `scrubBinaryValues` pass drops document bytes from the whole event before the key-name PII passes. `release` = real `BUILD_SHA` (same value `/health` exposes), `serverName` = typed config Cloud Run `K_REVISION`/`K_SERVICE`. `IGNORED_ERROR_PATTERNS` drops GoTrue Navigator-lock + AbortError noise. `captureStuckAnchorAlert()` + `STUCK_ANCHOR_FINGERPRINT` are the stable seam PR #1055 (SCRUM-2234 stuck-anchor monitor) wires into so hourly re-fires collapse to one issue while preserving the caller's warning/error severity. `capturePipelineThroughputAlert()` + `PIPELINE_THROUGHPUT_FINGERPRINT` (SCRUM-2901) are the same pattern for the pipeline-throughput dead-man (`jobs/pipelineThroughputMonitor.ts`) — always `error` level (no severity param; both fire conditions are page-worthy), aggregate-count context only.
- **`sentry.ts` (fix/sentry-cron-checkins-prod-only, CTO directive 2026-08):** `withCronMonitoring()`'s Sentry Crons check-in reporting (`Sentry.captureCheckIn`) is now gated to the real prod service ONLY, via the single choke point `shouldSendCronCheckIns()` — every soak rig runs the same worker cron jobs (`webhook-retries`, `check-confirmations`, `process-revocations`, `grace-expiry-sweep`) and each one was reporting check-ins tagged with its own `K_SERVICE`, auto-creating a permanent Sentry monitor environment that starts paging "missed check-in" the moment the rig is torn down (5 dead rig envs × 4 cron monitors = 16 zombie env/monitor pairs, ~93k events as of 2026-08). Gate logic: fires when `K_SERVICE === PROD_SERVICE_NAME` (`'arkova-worker'`, the same constant `resolveSentryEnvironment` above pins) OR the escape hatch `ENABLE_SENTRY_CRON_CHECKINS=true` is set (for a rig where cron observability via Sentry Crons is deliberately wanted); suppressed otherwise, including local dev (no `K_SERVICE` at all). **The gate NEVER touches whether the wrapped cron job runs** — only whether Sentry hears about it; a suppressed check-in still executes `fn()` and still propagates its result/error normally. Fail-safe direction is deliberate: if the gate ever breaks and suppresses PROD check-ins too, the prod monitor's own missed-check-in alert fires loudly within one missed interval — never a silent failure for the surface that matters. Tests: `shouldSendCronCheckIns` describe block pins `PROD_SERVICE_NAME` + covers prod/rig/escape-hatch/no-K_SERVICE/non-'true'-value branches; the `withCronMonitoring` integration describe block covers the same four cases end-to-end (job still runs, check-in fires or doesn't).
- **`verifyCache.ts` (PERF-12)** — Upstash Redis cache for `GET /api/v1/verify/:publicId`, 5-minute TTL. **`KEY_PREFIX` must be bumped on any change to what the cached body CONTAINS, not only on shape changes.** `verify:v2:` → `verify:v3:` (2026-08-02) for the outbound PII gate on `buildVerificationResult`: the gate runs before `setCachedVerification`, so new writes were safe either way, but entries written by the pre-fix build carried a raw `description` and would have kept serving it to anonymous callers for the rest of the TTL after deploy. A new prefix orphans them instantly; old keys age out on their own. Treat a redaction/suppression change as a cache-invalidating change.
- **`postgrest-filter.ts` (2026-08-01)** — PostgREST request-line limits and the ONLY supported way to build an `.in()` filter over a caller-sized list. Owns `POSTGREST_ROW_LIMIT` / `POSTGREST_URL_FILTER_BUDGET_BYTES` / `POSTGREST_IN_FILTER_CHUNK`, `wireLength` / `inFilterValueWireLength`, `chunkForInFilter`, and `assertNotAllChunksFailed`. `chunkForInFilter` takes **no size parameter** (both production defects in this class were a call site picking the wrong constant), accepts **`string[]` only** (so the values chunked are provably the values sent), and bounds each chunk by **encoded wire bytes as well as count** — measured with `URLSearchParams`, which is what postgrest-js uses, and including the double quotes it adds around values containing `,`, `(` or `)`. Do NOT measure with `encodeURIComponent`: it is a different encoder, and 200 docket-shaped ids that measure 6,402 bytes under it are 9,206 on the wire. `assertNotAllChunksFailed` is the other half — a chunked loop that logs-and-continues returns `[]` when every chunk 400s, which downstream cannot tell from "no rows"; that silent success is what hid a 70-hour outage. Callers that must not throw (a revert inside another failure path) opt out explicitly. Full context: `jobs/agents.md`, 2026-08-01 entry.
- **`chunkedRead.ts` (2026-08-02)** — `readInChunks(label, values, fetchChunk)`, the second half of the
  `.in()` defect class factored once. Twelve enrichment lookups shared one shape: take ids off a page
  of rows, look up display names / emails / counts / quotas, and write `const { data } = await …`,
  discarding the error. postgrest-js RESOLVES a failure as `{ data: null, error }`, so the enrichment
  came back empty and the response looked **complete** — every org name `null`, every member count
  `0`, every quota absent. An admin cannot tell that from an org that genuinely has no members, and on
  the anchor-count / quota surfaces that is a number someone makes a decision on. One width guarantee
  (`chunkForInFilter`) and one error policy: per-chunk failures log and return a partial (an
  enrichment miss degrades to the same "unknown" the row already renders), an ALL-chunks-failed read
  throws — a different claim — and every caller sits in a handler `try/catch` that turns it into a 500.
  Filter values are never logged (they are ids, §1.4). Mutation-verified in `chunkedRead.test.ts`.
- **`profilePublicIds.ts` (2026-08-02)** — `fetchProfilePublicIdsByActorIds(db, actorIds, label)`, the
  single actor-id -> profile `public_id` lookup for legal-evidence artifacts. `anchor-evidence.ts` and
  `anchor-lifecycle.ts` each had a byte-identical private copy, and BOTH carried both halves of the
  `.in()` defect class: an unbounded id filter over actor ids from an unlimited `audit_events` select,
  and `const { data } = ...` discarding the error. A 400 resolved to an empty map and both endpoints
  answered 200 with every lifecycle entry silently unattributed — for a court-facing artifact that is
  worse than failing, because it reads as "no actor recorded" rather than "we could not tell you".
  Deduped so a fix cannot again land at one site and miss the other (how #1795 shipped 2-of-3).
  Error policy: **partial results are deliberate** (a missing actor already renders as unattributed,
  the same shape a system actor produces), but an ALL-chunks-failed read is a different claim —
  "this credential has no recorded actors" — so it throws via `assertNotAllChunksFailed` and each
  router's existing `try/catch` turns it into a 500. Actor ids are never logged (they are user ids,
  §1.4). Covered by `profilePublicIds.test.ts`; mutation-verified (unchunking fails 2, removing the
  guard fails 1).
- **`pipeline.ts`** — shared helpers for the public-record fetchers (`computeContentHash`, `delay`, `isIngestionEnabled`, `isIngestionFailureStatus`, `batchUpsertRecords`, `getExistingSourceIds`). **2026-08-15 (BUG-020):** added `INGESTION_FAILURE_STATUSES` + `isIngestionFailureStatus()` — the set of result `status` literals that mean a run failed *even when its `errors` counter is 0*. `routes/ingestionResponse.ts` and `jobs/openStatesFetcher.ts`'s fan-out aggregate both read it; keep it here rather than in `routes/` so `jobs/` can import it without a routes→jobs cycle. **`isIngestionEnabled` is still a `get_flag` read and therefore still cannot distinguish "flag row absent" from "flag explicitly false"** — that is fine for a fetcher's own belt-and-braces gate, but the route-level gate that has to tell those apart reads `switchboard_flags` directly (see `routes/agents.md`). **2026-08-01:** `getExistingSourceIds` carried both halves of the PostgREST id-filter defect that killed public-record anchoring for 70 hours, but **only one half was live — do not repeat this as a second outage.** (a) The UNCHUNKED `.in('source_id', …)` was LATENT: `getExistingSourceIds` has exactly ONE caller today (`jobs/jurisdictionFetcher.ts` `ingestStatutes`) and it passes section ids from module-constant `StatuteDefinition[]` arrays — tens of ids, a few dozen bytes, never close to the limit. It is fixed as a trap for the next fetcher to adopt this module per its own "new fetchers import from here" contract. (b) The DISCARDED error (`const { data } = …`) WAS live: any PostgREST failure returned an empty dedup Set, so dedup could be dead while every caller reported success. It now builds its filter with `chunkForInFilter` (`postgrest-filter.ts` — bounded by real encoded wire bytes, which matters here because `source_id` is an arbitrary upstream identifier, not a UUID), logs each failed chunk, and calls the shared `assertNotAllChunksFailed` so an all-chunks-failed run throws rather than reporting an empty set as success (same guard as `jobs/publicRecordAnchor.ts`'s `fetchAnchorRows`; the two had been hand-copied and had already diverged on the `attempted > 0` check). A partial result is still returned deliberately: `batchUpsertRecords` upserts with `ignoreDuplicates`, so a missed duplicate costs a redundant write, never a wrong row. **Behaviour change to know about:** the throw propagates out of `ingestStatutes`, which `fetchJurisdictionCompliance` runs BEFORE `fetchCaseLaw`, so a total dedup failure now also skips case-law ingestion for that jurisdiction (previously it degraded to re-upserting everything). Intended: an all-chunks-failed result means PostgREST is unavailable for that table anyway, and a cron 500 gets a Scheduler retry. Covered by `pipeline.test.ts`.
- Various: `telemetry.ts`, `correlationId.ts`, `cors.ts`, `rateLimit.ts` (legacy v1), `validation.ts`, `urls.ts`, etc.
- **`captureCreditRpcFailureAlert()` (sentry.ts, silent-fail pre-mortem)** — the single choke point for the six credit-mutating RPCs (`deduct_ai_credits`, `deduct_unified_credits`, `allocate_monthly_credits`, `roll_over_monthly_allocation`, `batch_insert_anchors`, `submit_batch_anchors`) that previously failed with only `logger.error`, no Sentry alert. Caller passes `failMode: 'open' | 'closed' | 'retried'` — `'open'` (proceeds anyway: free AI extraction, falls through to Stripe billing) is always `fatal` level + a `credit_rpc_fail_mode:open` tag so it's impossible to miss/grep for a revenue leak; `'closed'`/`'retried'` are `error` level. Behavior (fail-open vs fail-closed) is intentionally UNCHANGED by this helper — it only adds observability. Call sites: `api/v1/ai-extract.ts`, `middleware/paymentTierRouter.ts`, `api/v1/credits.ts`, `jobs/credit-expiry.ts`, `jobs/monthly-allocation-rollover.ts`, `jobs/publicRecordAnchor.ts`, `jobs/batch-anchor.ts` (3 sites). PII: org_id/user_id UUIDs + aggregate metadata (amounts, counts, tx ids) only — never emails/fingerprints/API keys, enforced by the same `beforeSend` scrubber as every other Sentry path.

## Conventions
- Every utility that touches the DB takes the `SupabaseClient` as a parameter (not imported) so tests don't need to `vi.mock('./db.js')` on every file.
- Fail-closed for security gates (auth, scope). Fail-open for soft business gates (sandbox quota, soft rate limits) with loud logging.
- Zod validation at the helper boundary so callers don't need to repeat schema parsing.

## Open work
- SCRUM-1740 (PR #738) — quota gate awaits merge.

## 2026-08-02 `scanAllPages` — the read-side twin of `chunkForInFilter` (PR #1865)

`postgrest-filter.ts` gains `scanAllPages` / `PageScan` / `PageScanError`. Use it for ANY
read that must return every row a filter matches. Do not hand-roll the loop.

Same argument as `chunkForInFilter`, on the other half of the same `db-max-rows` ambiguity —
and the more dangerous half: a too-wide `.in()` takes a 400 and is loud, while a scan that
stops early returns a plausible short answer at HTTP 200.

Three rules a call site can no longer opt out of:

1. **An empty page is the only end-of-data signal.** A SHORT page is not. PostgREST's
   `db-max-rows` is a server setting the worker cannot see and may be below
   `POSTGREST_ROW_LIMIT`, so `if (page.length < requested) break` stops after page one. Costs
   one extra request per scan; buys back a whole class of silent truncation.
2. **Advance by rows RETURNED, never by the width requested** — otherwise a short page skips
   every row it withheld.
3. **A hard `maxPages` ceiling**, so the loop cannot hang when the other two exits depend on a
   misbehaving server. Exhausting it yields `page_budget_exhausted`, never a complete read.

`status` is the whole point: `complete` is the ONLY value meaning "these are all the rows".
A caller that ignores it and presents `rows` as a full set has re-created the bug.

**Known offender, NOT fixed here:** `jobs/publicRecordAnchor.ts:488` and `:514`
(`fetchRecordsForSource` / `fetchNonPriorityRecords`) both still use `if (chunk.length <
chunkSize) break`. `chunkSize` there is `config.batchAnchorMaxSize`, which can reach 1000, so
on any deployment with `db-max-rows` below that they under-read and stop early. Consequence is
milder than in the audit endpoint (each run re-queries from offset 0, so it degrades to reduced
per-run throughput rather than a permanent undercount), but it is the same wrong assumption.
Left alone deliberately: that file is being edited by PR #1853, this PR's base. Migrate it to
`scanAllPages` in a follow-up rather than conflicting with an in-flight anchoring change.
## 2026-08-01 SCRUM-2227 — `complianceMapping.ts` claims discipline

- `COMPLIANCE_CONTROLS_NOTE` is the single informational-not-attestation string for `compliance_controls`. Rendered **verbatim** by `/api/v1/verify`, the AI accountability report, and the audit export (PDF + CSV). It states what is measured vs asserted vs NOT asserted (§1.5) and explicitly disclaims eIDAS qualified status. Do not paraphrase per-surface — one string, one meaning. **Not yet counsel-reviewed** (drafted against the approved `JURISDICTION_INFORMATIONAL_DISCLAIMER` in `services/worker/src/exports/cle-log-export.ts`).
- This file is a **mirror of `src/lib/complianceMapping.ts`** — control IDs must match. It drifted for two months after SCRUM-2283 removed `DPF-NOTICE`/`DPF-ACCOUNTABILITY` from the frontend only, so the worker kept writing a certification Arkova does not hold onto every SECURED anchor. When you change either file, change both, and add the removed ID to `RETIRED_CONTROL_IDS` so `sanitizeStoredComplianceControls()` stops serving it from history.

## 2026-08-01 `complianceMapping.ts` — `controlsApplyForStatus()`

- Single gate for "do compliance controls still describe something true about this credential?" — `SECURED` / `ACTIVE` only, fails closed on unknown, empty, and null. Consumed by `api/v1/verify.ts`, `api/v1/audit-export.ts`, `api/v1/ai-accountability-report.ts`, and `integrations/grc/syncService.ts`.
- Added for BUG-2026-06-24-007's worker half: the frontend stopped rendering controls for REVOKED/SUPERSEDED/EXPIRED on 2026-06-24 and that fix was frontend-only, so the API, the audit export, and the GRC push kept serving them.
- Keep it in ONE place. Four surfaces answering "is this credential current?" with four predicates is how the frontend and worker drifted in the first place.

## SILENT-WRITE CLASS — audit events (2026-08-02, PR #1808 follow-on)

`recordAuditEvent()` in `auditEvent.ts` is the ONLY sanctioned way to write `audit_events`.

supabase-js query builders are lazy PromiseLikes — `PostgrestBuilder.then()` is where the HTTP
request is issued — so `void db.from('audit_events').insert({...});` builds a query, discards it,
and sends **nothing**: no request, no error, no row, no signal. Eight call sites shipped that way
(`api/v1/verify.ts`, `keys.ts` (the `logAuditEvent` helper, i.e. every API-key admin event),
`oracle.ts`, `key-inventory.ts`, and four in `agents.ts`).

**Verified against prod 2026-08-02, not inferred:** `audit_events` held ZERO rows for every event
type those sites emit (`VERIFICATION_QUERIED`, the API-key lifecycle events, the agent events)
while unrelated writers had 381k+ rows — the table was fine; only these writes vanished. Same
empirical method as PR #1808's `api_keys.last_used_at` finding (0 of 19 rows non-null).

Rules:
- Never `void db.from('audit_events')...` — call `recordAuditEvent(row)`.
- A `mockReturnThis()` or resolved-Promise test double CANNOT catch this bug: it never distinguishes
  "builder constructed" from "request issued". Use `test-utils/lazy-supabase-builder.ts`'s
  `createLazyBuilderRecorder`, which records only on `.then()`. `auditEvent.test.ts` reproduces the
  defect against that recorder before asserting the fix.
- Failures log at **error**, not warn: a lost audit row is a compliance event. `recordAuditEvent`
  never rejects, so a floating call cannot become an unhandled rejection.
- Fire-and-forget is deliberate (an audit write must not fail an anonymous public verify request),
  but the returned promise is awaitable. Whether API-key lifecycle events should be awaited — so a
  key is never reported created without its audit row — is an open decision, not an oversight.

## `mempool-url.ts` — one answer per network (BUG-2026-08-11)

SCRUM-3016 unified the `/api` **convention** across mempool.space consumers but left each one
owning its own **default**. `chain/utxo-provider.ts` picked its default per-network from a private
`MEMPOOL_URLS` map; `jobs/treasury-cache.ts` hardcoded the mainnet entry. On signet the treasury
job therefore queried the mainnet explorer for a signet address, got `HTTP 400`, and silently
recorded a zero balance — driving continuous false low-balance alerts.

`MEMPOOL_API_BASES` + `mempoolApiBaseForNetwork()` now live here so "which base for this network"
has exactly one answer.

Rules:
- New consumers select their default through `mempoolApiBaseForNetwork(config.bitcoinNetwork)` —
  never a hardcoded base literal. A per-file default is what drifted.
- **`/v1/prices` is the exception.** BTC/USD is a single global market quote and the non-mainnet
  explorers answer it with HTTP 200 + a `-1` sentinel, not a 404. Pin it to
  `MEMPOOL_API_BASES.mainnet` and validate the value; selecting it per-network replaces a
  zero-balance bug with a negative-price one that looks like a real reading.
- `mempool-url.test.ts` carries a **parity ratchet**: for every network it drives the real
  `createUtxoProvider` **and the real `createFeeEstimator`** and asserts the URL each actually
  requests matches `mempoolApiBaseForNetwork()`. If either side's map changes alone, that test
  fails. A human census of "who builds a mempool URL" is what missed this bug for the life of the
  job — and it missed it twice: the fee estimator was still resolving against a private mainnet
  literal after the UTXO provider had already been made per-network (BUG-2026-08-11, second half).
  Add a ratchet case here for every new consumer.

### Still-duplicated: the *host*-convention explorer map (open follow-up)

`MEMPOOL_API_BASES` covers the **`/api` convention** only. A second, distinct per-network map — the
bare-host form used to build human-facing explorer links (`https://mempool.space/signet` +
`/tx/{txid}`) — is currently copy-pasted across at least eight sites: `api/v1/verify.ts`,
`api/v1/attestations.ts` (twice), `api/v1/anchor-evidence.ts`, `api/v1/verify/attestation.ts`,
`api/v1/audit-export.ts`, `api/v1/nessie-query.ts`, `jobs/chain-maintenance.ts`,
`jobs/check-confirmations.ts`. Two of those additionally default to **signet** on an unknown
network while others default to mainnet.

Not collapsed here deliberately: it is a different convention (no `/api`), it is link-rendering
rather than request-routing, and folding `api/v1/**` into a chain-tier PR would widen the blast
radius. It is the same latent bug class though — worth a dedicated `MEMPOOL_EXPLORER_BASES` pass.
  `createUtxoProvider` and asserts the URL it actually requests matches
  `mempoolApiBaseForNetwork()`. If either side's map changes alone, that test fails. A human
  census of "who builds a mempool URL" is what missed this bug for the life of the job.

## 2026-08-11 — SCRUM-3188 `supplementaryProof.ts`

Pure core for the supplementary proof anchor. `orderSupplementaryLeaves` (deterministic `(fingerprint asc, anchorId asc)` — the same rule as the live producer's `sortAnchorsForBatch`), `planSupplementaryBatch` (order + tree, keeping the order that produced the root), `buildVerifiedSupplementaryProofRows`, `assessSupplementarySpend`, `estimateSupplementaryRun`.

`buildVerifiedSupplementaryProofRows` is the ONLY way to construct a supplementary proof row, and it throws `UnverifiedSupplementaryProofError` unless (1) the planned root is byte-equal to the root the CHAIN committed and (2) EVERY emitted branch independently re-verifies via `verifyMerkleProof` against that root. No best-effort mode, no skip flag — same invariant PR #2130 established for reconstruction. It additionally refuses any row that cannot name the original attestation it supplements, and any row whose supplementary txid equals that attestation.

`SUPPLEMENTARY_TX_VSIZE = 156.25` is measured from a real prod anchoring tx (`c86c3927…`, block 961,982), not estimated.
## proofReconstruction.ts (SCRUM-3187)

- **The one rule: never emit a proof that has not been verified against the on-chain root.** `reconstructBatch` is the ONLY constructor of proof rows in this module, and it builds them solely after (a) the rebuilt root is byte-equal to the OP_RETURN-committed root and (b) every branch independently re-verifies via `verifyMerkleProof`. There is no best-effort mode and no skip flag — the check is inside the constructor precisely so no caller can forget it. A proof that does not verify is a false integrity claim; returning nothing is always correct, returning something plausible never is.
- **Trying candidate leaf orderings is not guessing.** The chain is the judge: an ordering either reproduces the committed root or it does not, and passing falsely would require a second-preimage on double-SHA256. The search only recovers what the chain already pins down. Adding an ordering strategy is therefore safe; removing the verification is not.
- **Batch-of-1 is NOT exempt.** The degenerate case (`root == fingerprint`, empty branch) is where fabrication is easiest, so it goes through the same chain check. `reconstructBatch([solo], wrongRoot)` must fail, and a test pins it.
- **`storedBranch` (legacy `anchors.metadata.merkle_proof`) is UNTRUSTED INPUT.** It is a claim about a branch, not evidence of one. Prod batch `8f62259b…` (2026-03-26) carries stored branches whose root matches the chain but which fail verification under as-is, position-flipped, level-reversed, and reversed-and-flipped readings. ~29% of sampled March anchors carry this field. Copying it into `anchor_proofs` unchecked would have manufactured false proofs at scale — that exact prod branch is pinned as a regression test. One bad branch rejects the WHOLE batch: a partially-true batch is not something we can honestly serve.
- **Leaf ORDER, not leaf SET, is what was lost.** Prod has zero soft-deleted anchors with a `chain_tx_id`, so no batch has a hole; for backlog tx `606b7eec…` exactly 1 of 720 permutations reproduces the real on-chain root, which proves the set is exact. The March/April producer took rows straight from `claim_pending_anchors` (`UPDATE … RETURNING`, no ordering guarantee), so the committed order is a query-plan artifact. `id asc`, `fingerprint asc`, `created_at asc/desc`, and `ctid` order are all empirically ruled out against real chain roots.
- **`MAX_PERMUTATION_SEARCH_LEAVES = 8` is a cost bound, not a safety bound.** Raising it trades CPU for coverage and changes no safety property. It is why ~2.97M records in >8-leaf batches are honestly `unreconstructible_order` rather than silently "pending".
- **`merkle.ts:55-59` documents an ordering contract prod contradicts** — it claims `(fingerprint asc, id asc)`, but 2026-08 batches reconstruct under `id asc`. `sortAnchorsForBatch` only landed 2026-07-06. Do not treat that docstring as the historical contract.

## 2026-08-11 — SCRUM-3128 `btc-price.ts`

The only sanctioned way for a REQUEST-PATH caller to get a BTC/USD figure. There is exactly one
oracle call in this service and `jobs/treasury-cache.ts` owns it (every 10 min →
`treasury_cache.btc_price_usd`); everything else reads the cached value through here.

- **Never issues an HTTP request, and a test pins that.** Its first consumer is
  `middleware/x402PaymentGate.ts`, mounted on 6+ `/api/v1` routes — a per-request oracle fetch would
  rate-limit us out of our own pricing under load.
- **Returns `null`, never a default.** This value multiplies a charge. Absent row, `-1` non-mainnet
  sentinel, zero, non-finite, unparseable/absent `updated_at`, stale beyond
  `BTC_PRICE_MAX_AGE_MS`, DB error, DB throw — all null, so the caller degrades to a price it can
  defend. A default here would recreate the exact defect this module was written to remove
  (`const btcPriceUsd = 60000`).
- **`normalizeBtcPrice` lives here now, moved out of `jobs/treasury-cache.ts`.** One definition on
  purpose: the write side validates on the way in, this validates on the way out, so a row written
  before the guard existed cannot poison a charge. A second copy of a money-validation predicate is
  the thing that drifts. Note `api/treasury.ts` and `jobs/treasury-alert.ts` still carry their own
  inline equivalents — folding those in is a separate, wider change.
- **`BTC_PRICE_MAX_AGE_MS` (6 h) is a money bound, not a cache bound.** The cron refreshes every
  10 min, so 6 h is ~36 consecutive failures — past "a blip", into "the cron is dead". Beyond it the
  quote could be arbitrarily far from spot.
- **`BTC_PRICE_MEMO_TTL_MS` (60 s) must stay well under the cron's 10-minute period**, or the memo
  becomes staler than the row it caches. Failures memoize too, and concurrent callers share one
  in-flight read — an outage must not turn every gated request into a DB round trip.

## 2026-08-17 — surrogate-safe truncation sweep (follow-up to `utf16-truncate.ts`)

> Placed at EOF deliberately: PR #2266 introduces `utf16-truncate.ts` and inserts its section near
> the top of this file; this sweep lands as a sibling PR carrying byte-identical copies of that
> util + its test (add/add-identical merges cleanly in either order), so this note must not overlap
> that hunk.

`sanitizeLastError` now bounds via `truncateUtf16Safe(text, 1000)` instead of a bare `.slice` —
`job_queue.last_error` is failure bookkeeping, and a poisoned error message used to make `failJob`'s
own PostgREST body invalid JSON (PGRST102): the job's failure handling itself failed. The same sweep
migrated `webhooks/delivery.ts` (`response_body` ×3 + `error_message` — endpoint-controlled bytes),
`credentials-ctdl-registry-anchor.ts` (filename/label/description), `compliance-audit.ts`
(`error_message`), `credential-source-import.ts` (`cleanText` + filename), the two test-ping
`response_body` echoes, and `nessie-query.ts` citation excerpts. CI ratchet:
`scripts/ci/feedback-rules/surrogate-safe-truncate.ts` (baseline burn-down in
`surrogate-truncate-baseline.json`; merge-time gate is its colocated `.test.ts` in `Tests`).
