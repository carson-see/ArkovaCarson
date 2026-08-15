# agents.md — services/worker/src/integrations/connectors/

_Last updated: 2026-08-03 (PR #1944 review rounds 2-3: create-then-stop CRITICAL fix, PII scrub, concurrency bound, account_label parser convergence)._

## 2026-08-03 — PR #1944 review rounds 2-3 on top of the Lane 3 bug blitz

Multiple adversarial review passes on PR #1944 (after the round-1 fix below already landed) found real issues in this folder specifically:

- **CRITICAL — create-then-stop reordering (`drive-subscription-renewal.ts`):** `renewDriveSubscriptions()` used to call `tryStop()` on the OLD channel BEFORE attempting `client.createChannel()` for the new one. A `createChannel` failure (a realistic pre-`WORKER_PUBLIC_URL` state, or any transient Google 5xx) left the org with ZERO live channels while the DB still claimed the old one was active — i.e. the fix for #1835 could itself CAUSE #1835's exact silent-outage symptom, on a previously healthy connection. Reordered: stop the old channel ONLY after `createChannel` AND the `updateConnection` DB write both succeed. If `createChannel` throws, or succeeds but the DB write fails, the old channel is left running (orphaning the new one is harmless — it just expires unused) and the row still points at the old, still-live channel. Covered by `describe('create-then-stop ordering (CRITICAL, PR #1944 review)')` in the test file — asserts `stopChannel` is never called on either failure path, and asserts the exact call order (`createChannel` → `updateConnection` → `stopChannel`) plus that `stopChannel` is invoked with the OLD channel id, not the new one, on the success path.
- **PII scrub (`drive-subscription-renewal.ts`):** the renewal job's error-reason builder (`boundedReason()`) capped length only — never PII-scrubbed — even though the result is persisted to `org_integrations.last_renewal_error` AND sent to Sentry via the `alert` callback. Now routes through the canonical `boundedErrorDetail()` (`utils/byte-safety.ts`), which bounds AND byte-redacts AND PII-scrubs (email/UUID/JWT/etc via `utils/pii-scrub.ts`). Covered by `describe('PII scrub on persisted/alerted failure reasons (boundedErrorDetail)')`, including the `getAccessToken`-throw path, not just the `createChannel`-throw path.
- **Bounded concurrency (FINDING 2, `drive-subscription-renewal.ts`):** the main loop processed connections strictly one at a time — a large org roster made one hourly sweep take proportionally longer with no benefit, since each connection's Google calls are independent. Bounded to chunks of `RENEWAL_CONCURRENCY = 5` via `Promise.all` over `rows.slice(i, i+concurrency)`, matching `workspace-subscription-renewal.ts`'s own precedent. Each `processOne(conn)` has its own outer try/catch so one connection's rejection can't fail its whole chunk. `renewDriveSubscriptions()` gained an optional `concurrency?: number` param for test injection. Covered by `describe('bounded concurrency (FINDING 2)')` — concurrent-not-sequential proof (release-gate pattern), a hard concurrency-bound proof (inFlight/maxInFlight counters), per-connection error isolation under concurrency, and multi-chunk sequencing.
- **Account_label parser convergence:** 4 near-duplicate inline `JSON.parse(account_label)` implementations (across `drive-oauth.ts`, `webhooks/drive.ts`, `drive-subscription-renewal.ts`, `api/connector-health.ts` — disagreeing on null/invalid-JSON handling) consolidated into one new file, `drive-account-label.ts` (this folder) — see its table entry below.

Full cross-cutting index (all touched folders) lives in `services/worker/src/agents.md`.

## 2026-08-03 — Lane 3 bug blitz: GH #1835 (no renewal), #1836 (weak channel token), #1837 (folder_path hardcoded null)

Founder-priority ("where is my fucking google drive connection") — the Drive connector was effectively dead in prod. Three bugs, all on the LIVE `org_integrations`-based code path (`drive-oauth.ts` + `webhooks/drive.ts` + `drive-changes-runner.ts` — see the "two parallel watch systems" note below, this is NOT the `drive-watch-bootstrap.ts`/`drive-channel-renewal.ts` DRIVE-02/06 system):

- **#1836 (SECURITY, pen-test scope):** `drive-oauth.ts` registered every `changes.watch` channel with the org's own UUID as the auth token — not a secret. Fixed in `api/v1/integrations/agents.md`'s entry (random `generateChannelToken()`); the webhook's accept-legacy-but-warn deprecation path is in `api/v1/webhooks/agents.md`; the `connector-health.ts` dashboard leak of the same token is in `api/agents.md`.
- **#1835:** nothing renewed a Drive push channel before it expired (~7 days) — every connection went silent within a week with zero error/alert. New `drive-subscription-renewal.ts` (this folder) + `jobs/drive-subscription-renewal-deps.ts` (real wiring) + `POST /jobs/drive-subscription-renewal` cron route (hourly, see `routes/agents.md` + `scripts/gcp-setup/agents.md`).
- **#1837:** `drive-changes-runner.ts`'s `enqueueRuleEvent` RPC call hardcoded `p_folder_path: null`, so any `folder_path_starts_with` rule could never fire. `drive-folder-resolver.ts` already existed and was tested but was never wired in. Now wired through `drive-changes-processor.ts`'s new `resolveFolderPath` dep (called ONLY for a change that already matched a watched folder — never wasted on a mismatch) and a new `createFolderPathCache` Postgres adapter over `drive_folder_path_cache` (this folder's `drive-changes-runner.ts`).

### Two parallel Drive watch-tracking systems — do not conflate them

`org_integrations.subscription_id` / `subscription_expires_at` / `account_label.channel_token` (written by `drive-oauth.ts`, read by `webhooks/drive.ts`) is the system that has ALWAYS carried live prod traffic — one watch per connection, no folder scoping. `drive_watch_state` (migration 0351, DRIVE-02/06, `drive-watch-bootstrap.ts` + `drive-channel-renewal.ts`) is a fully-built, fully-tested, folder-scoped watch bootstrap + renewal pipeline with **zero production callers** — nothing ever calls `bootstrapDriveWatch`, so the table has never had a row in prod. `drive-subscription-renewal.ts` (GH #1835, new) deliberately targets the FIRST system, because that's the one with live data to renew. Reconciling the two into one system is real architecture debt, tracked as follow-up, not solved here — see this module's own doc comment for the full reasoning.

| File | Purpose |
|------|---------|
| `drive-subscription-renewal.ts` | **GH #1835**: pure orchestrator that renews `org_integrations` google_drive rows before their `changes.watch` channel expires (or registers one for a never-bootstrapped connection). NEVER touches `last_page_token` — see its own doc comment for why (a renewal that reset the cursor would silently drop unprocessed changes). Every successful renewal mints a fresh random `channel_token` (GH #1836 rotation). No cron here — see `jobs/drive-subscription-renewal-deps.ts` + `routes/cron.ts`. **PR #1944 review rounds 2-3** (see the entry above for full detail): create-then-stop channel ordering (CRITICAL), `boundedReason()` routes through canonical `boundedErrorDetail()` (PII scrub), bounded chunked concurrency (`RENEWAL_CONCURRENCY = 5`), account_label parse routes through `drive-account-label.ts`, and a `recordSetback()` inner closure consolidating what were 3 copy-pasted failure-recording blocks. |
| `drive-account-label.ts` | **NEW (PR #1944 review round 3 addendum)**: canonical `parseDriveAccountLabel(raw: string \| null \| undefined): DriveAccountLabel \| null` + `stringifyDriveAccountLabel(label)`. Returns `null` for null/empty/invalid-JSON/non-object input — covers both a Drive row with no label yet and a plain non-JSON display string (the shape other connectors' `account_label` columns use). Consolidates 4 near-duplicate inline `JSON.parse` call sites that disagreed on edge-case handling: `drive-oauth.ts` (disconnect flow), `webhooks/drive.ts` (`resolveDriveChannel`), `drive-subscription-renewal.ts` (this folder), and `api/connector-health.ts` (`sanitizeAccountLabel`). Any new Drive code reading or writing `account_label` MUST go through this file, not another inline `JSON.parse`/`JSON.stringify`. |

## What This Folder Contains

Vendor connector services and canonical event adapters. Each connector owns OAuth coordination, watch channel management, and document-fetch contracts. Adapters are pure functions that normalize vendor payloads into rules-engine events.

| File | Purpose |
|------|---------|
| `schemas.ts` | Zod schemas for all vendor webhook payloads (Drive, DocuSign, Adobe, Checkr, Veremark) |
| `adapters.ts` | Pure-function adapters: vendor payload -> canonical `TriggerEvent` for rules engine |
| `googleDrive.ts` | Google Drive connector — OAuth, Secret Manager tokens, 7-day watch channels, event shaping |
| `docusign.ts` | DocuSign connector — retryable signed-document fetch, account token resolution. DS-04: `DocusignResolvedConnection` + the `enqueueSignedDocument` sink now carry `scope` (`'org'`/`'member'`) + `ownerUserId` for personal-queue routing |
| `docusign-connection-resolver.ts` | Sub-org connection resolution (SCRUM-2045). DS-04 (SCRUM-2364): resolves `scope`/`ownerUserId` — a `member_integrations` row's `owner_user_id` ⇒ `scope='member'` (personal queue); org-owned / inherited connections ⇒ `scope='org'` |
| `docusign-token-store.ts` | DocuSign refresh-token Secret Manager store — org + member-level naming (SCRUM-2044) |
| `docusign-rule-seed.ts` | **SCRUM-3027**: auto-seed the "DocuSign Completion" rule (`ESIGN_COMPLETED` → `AUTO_ANCHOR`, queue-mode, **enabled**) on a successful org DocuSign connect. `seedDocusignCompletionRule()` is idempotent + **non-stomping** — if the org already has ANY `ESIGN_COMPLETED` rule (any action) it seeds nothing, never overriding an admin's choice. NEVER throws (failure-isolated: loud `logger.error` + Sentry, PII-safe = orgId only; fails CLOSED on an ambiguous lookup error). Config shapes are Zod-validated (`TriggerConfigEsignCompleted` / `ActionConfigAutoAnchor`); row is built from the canonical `rule-templates-data.ts` `docusign-completion` template. WIRED into `api/v1/integrations/docusign-oauth.ts` callback (fire-and-forget, after the integration upsert) — surfaces `docusign_completion_rule_seeded` / `_seed_failed` `integration_events`. `enabled=true` is intentional (explicit human connect action, no NL-authoring surface — distinct from the SEC-02 `enabled=false` CRUD path) |
| `drive-changes-processor.ts` | Drive changes feed processor — paginated, deduped, folder-matched event emission. **GH #1837**: `DriveProcessorDeps.resolveFolderPath` (optional) is called for a MATCHING change only, and its result threads into `enqueueRuleEvent`'s new required `folder_path: string \| null` field — a resolver failure/throw is swallowed to `null`, never aborts the page. **PR #1944 review round 3, FINDING 1 (perf)**: folder-path resolution used to happen inline, sequentially, per matching change — a 20-file burst in one webhook drain could add ~20 sequential resolver round-trips of latency. Restructured the per-page loop into 3 phases: (1) `classifyPage()` — pure sync classification, no I/O; (2) `resolveFolderPathsForPage()` — bounded-concurrent (`FOLDER_PATH_RESOLUTION_CONCURRENCY = 8`), deduped-by-`fileId` resolution for matching descriptors only, for the WHOLE page before any commits; (3) the original strictly-sequential ledger-insert/enqueue/compensation loop, unchanged in its ordering guarantees, now reading precomputed results from a `folderPaths` Map instead of awaiting per-change. All counters and compensation/throw semantics preserved exactly — only the I/O shape of the folder-path lookups changed. Covered by `describe('FINDING 1: concurrent folder-path resolution across a page')` — concurrent-not-sequential proof, a hard concurrency-bound proof (20 files, `maxInFlight <= 8`), dedup-by-fileId proof (2 revisions of the same file → resolver called once), per-fileId error isolation, and a phase-ordering proof (all resolution happens before the first `insertRevisionLedger` call). |
| `drive-changes-runner.ts` | Webhook-to-processor glue — token refresh, watched-folder-id resolution. **SCRUM-2903 GD-PROD (wired 2026-07-28, #1654):** `createProcessorDbAdapter().enqueueFileChangedJob` submits the `google_drive.file_changed` job (`submitJob`, Drive twin of the DocuSign webhook's `enqueueFetchJob`) immediately after `enqueueRuleEvent` succeeds — no bytes cross this call, only connector-native ids + a mime/timestamp hint, validated against the SAME `DriveFileChangedJobPayload` Zod schema `jobs/drive-file-changed.ts` parses on the consumer side (imported from `drive-artifact-producer.ts`, not redefined). **GH #1837 (2026-08-03):** `enqueueRuleEvent`'s RPC call now passes `p_folder_path: validated.folder_path ?? null` (was hardcoded `null`) — `?? null`, never `?? ''`, because an empty string would make `folder_path_starts_with` match every rule. `createFolderPathCache()` (exported, tested) is a thin Postgres adapter over `drive_folder_path_cache` (PK `(org_id, file_id)`); `runDriveChanges` binds it + `resolveDriveFolderPath` (`drive-folder-resolver.ts`) into the `resolveFolderPath` dep passed to `processDriveChanges`. |
| `drive-artifact-producer.ts` | **SCRUM-2903 GD-PROD**: the producer bridge that gives Drive documents an anchor path. `processDriveFileChangedJob` (Drive twin of `processDocusignEnvelopeCompletedJob`): parse (Zod, ids-only payload — NO actor_email/PII field exists) → resolve access token → `fetchDriveFileBytes` → sink. Pure orchestrator (token resolver / fetch / sink all injected). The payload schema deliberately carries only connector-native ids so actor email cannot ride into the artifact. Byte handling is confined to the sink (`jobs/drive-file-changed.ts`). Also owns `DRIVE_FILE_CHANGED_JOB_TYPE` (`'google_drive.file_changed'`) as the single source of truth — `jobs/drive-file-changed.ts` re-exports it rather than duplicating the literal, and `drive-changes-runner.ts` imports it directly (this file has no reverse dependency on either, so no import cycle). **End-to-end wiring landed 2026-07-28 (#1654):** `drive-changes-runner.ts` now enqueues the job; the drain is registered at `POST /jobs/drive-file-changed` in `routes/cron.ts` (prod, Cloud Scheduler) and as an in-process dev/test backup in `routes/scheduled.ts`, both gated by `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` (still default OFF — founder-gated flip post-soak, per CTO ruling R3 in the 2026-07-28 sprint plan). |
| `drive-folder-resolver.ts` | Drive parent-chain folder path resolver (20-level depth cap, 15-min TTL cache). **GH #1837 (2026-08-03)**: wired into the live pipeline via `drive-changes-runner.ts`'s `resolveFolderPath` dep — it already had the right contract (unresolvable → `null`, never `''`), it simply had no caller. **PR #1944 review follow-up**: `resolveDriveFolderPath` now takes an optional `deps.logger` (`{warn, error}`) — every failure was previously swallowed to `null` with ZERO signal (the caller's own try/catch in `drive-changes-processor.ts` had nothing to actually catch, since this function never threw). A `DriveApiError` (expected: permission loss, deleted parent) logs at `warn` with the HTTP status; anything else logs at `error`. `drive-changes-runner.ts`'s production wiring always passes `deps.logger` through. |
| `drive-connect-eligibility.ts` | **DRIVE-01 (SCRUM-2366)**: verified-only Google Drive connect gate. Org-admin / paid-verified-individual paths, resolved via the canonical owner-inclusive resolver (`api/_org-auth.ts`), never `org_members` alone. Re-evaluated at start AND callback so an existing/stale token can't bypass a lapsed entitlement. Fail-closed to `lookup_failed`. **WIRED into `api/v1/integrations/drive-oauth.ts`** (`start` + `callback`) via `assertDriveConnectAllowed` + a `makeEligibilityDb` adapter — do NOT leave it importer-less again. |
| `drive-watch-bootstrap.ts` | **DRIVE-02 (SCRUM-2367)**: folder-watch bootstrap → persists initial page token, channel id/expiry, owner scope (my_drive vs shared_drive), status, `last_renewal_error` into `drive_watch_state` (mig 0351) via `upsert_drive_watch_state`. `persist()` forwards `p_last_renewal_error` — the RPC MUST declare that param (fixed in 0351: `p_last_renewal_error text DEFAULT NULL`, written on INSERT + ON CONFLICT UPDATE). Folder-permission failures → `status='permission_denied'` (no throw); folder id mismatch → `failed`. `folder_path`/`owner_email` are sensitive — persisted to the RLS row ONLY, never logged. |
| `drive-change-dedupe.ts` | **DRIVE-03 (SCRUM-2368)**: pure change classifier + revision dedupe key + bounded/PII-scrubbed audit projection. Ignores removed/trashed/unsupported-MIME; each `(file_id, revision)` queues once (backed by `drive_revision_ledger` UNIQUE). Companion to `drive-changes-processor.ts`. |
| `drive-channel-renewal.ts` | **DRIVE-06 (SCRUM-2371)**: pure channel-renewal sweep — renews before expiry, alerts + marks `degraded` on failure (token-revoked + renewal-failed paths), recovers expired channels idempotently, STOPS a watch whose org lost entitlement. **NO cron** — cadence is a HANDOFF to Lane 2's Cloud Scheduler → HTTP `/jobs/*` (node-cron does not fire on throttled Cloud Run). Status vocabulary the sweep + bootstrap write MUST all be permitted by the 0351 `drive_watch_state_status_check` CHECK: `active \| permission_denied \| expired \| stopped \| degraded \| failed` (`degraded` added 2026-07-01 — it was previously omitted and the first renewal failure would have violated the constraint). `drive-watch-state-rpc.test.ts` is the SQL-contract guard that keeps code↔CHECK vocabulary from drifting (mock-DB renewal tests can't catch a real constraint mismatch). |

## Do / Don't Rules

- **DO** keep adapters as pure functions (no I/O, no DB) for testability
- **DO** route every org-eligibility / admin check through `api/_org-auth.ts`
  (`getCallerOrgId*` / `isCallerOrgAdmin*`) — never re-resolve org from
  `org_members` alone (the #1325/#1326 owner-resolution-drift class).
- **DO** use the injected `db` and `fetch` for all I/O in connector services
- **DO NOT** persist raw OAuth tokens — connector services must use KMS encryption

### Connector document-byte safety (§1.6A / SCRUM-2492)

Connector-fetched documents (DocuSign / Google Drive) MAY be fingerprinted
server-side, but the raw bytes are radioactive: fetch → SHA-256 in memory →
discard. They must NEVER touch a logger, Sentry, an Error, `job_queue.last_error`,
a temp file, or Postgres. An ESLint rule (`arkova/no-connector-bytes-to-sink`,
ERROR on this tree + the `docusign-*` job files) enforces this at build time.

- **DON'T** log/throw/persist `documentBytes` (or any `Buffer`/`Uint8Array`/`*.bytes`).
  Pass only the fingerprint or `documentBytes.byteLength`. The canonical sink
  `enqueueSignedDocument` (`jobs/docusign-envelope-completed.ts`) persists only
  `byte_length` — keep it that way.
- **DON'T** give a connector error a `body`/raw-response field. `DocusignApiError`
  and `DriveApiError` are byte-safe BY CONSTRUCTION (`{ message, status }`, no
  body). On the document-fetch path, never read `response.body`/`arrayBuffer()`
  into an error — status + message only.
- **DON'T** rely solely on the lint. The runtime defences are: byte-safe error
  types, pino binary redaction (`utils/logger.ts` `redactBinaryValues`), type-based
  Sentry scrub (`utils/sentry.ts` `scrubBinaryValues`), and the `last_error`
  sanitizer (`utils/jobQueue.ts` `sanitizeLastError`). The multi-MB leak test is
  `jobs/connector-byte-safety.test.ts`.
- **DO** remember the lint is AST-only — a spread (`{ ...obj }`), cross-file flow,
  or a helper-return can hide bytes from it. The runtime guards above are the
  backstop; do not defeat them.

## SCRUM-3014 — Connect listener provisioning health (`docusign-connect-health.ts`)

- `provisionConnectListener()` is fire-and-forget from both DocuSign OAuth
  callbacks. It MUST stay non-fatal — but it must not be silent. Use
  `reportConnectProvisionFailure()` on every failure path: it logs the real
  DocuSign HTTP status + bounded `detail`, captures to Sentry, and flips
  `connector_alert_state` to `degraded` (the queue digest surfaces that as a
  failed connector).
- **DO** persist `docusign_status` / `docusign_detail` on the
  `*_connect_listener_failed` `integration_events` row. A bare `error.message`
  is what made the prod failures undiagnosable in the first place.
- **DO** call `markDocusignConnectorConnected()` on every success path — the
  degraded state is sticky by design (see `jobs/connector-health-alert.ts`) and
  nothing else clears it.
- **DO NOT** let anything in this module throw into the OAuth callback; every
  write is best-effort and logs on failure.
- **DO** settle the provisioning promise through `settleConnectProvisioning()`
  rather than hand-rolling a `.then(...).catch(...)` chain per router. Both
  callbacks and the reprovision endpoint differ only in their event-type names
  and `flow` tag; duplicating the chain drifted the two flows apart and tripped
  the Sonar new-code duplication gate. A throw from the SUCCESS-path event write
  deliberately falls through to the failure path — that is the behaviour of the
  chain it replaced, not an accident.


## 2026-08-01 DRIVE B1 — the changes cursor is seeded at CONNECT time, and only there

`last_page_token` on `org_integrations` is the Drive changes cursor. It has exactly **two** writers:

1. `createDriveOAuthRouter`'s callback (`api/v1/integrations/drive-oauth.ts`) — seeds it from the `startPageToken` that `createChangesWatch()` returns.
2. `advancePageToken` — only reachable from `processDriveChanges`, which **refuses to run without a token** (`drive-changes-runner.ts` skips with `no_page_token`).

So (2) can never run until (1) has happened. The callback used to type its local `subscription` as `{ resourceId; expiration }`, silently discarding the `startPageToken` the client already returned — which made the entire Drive changes pipeline unreachable by construction: a freshly connected org skipped forever, with no error anywhere. **Never drop `startPageToken` from that call site.**

The write is deliberately **conditional** (`...(subscription ? { last_page_token } : {})`), not `?? null`. This is an upsert: unconditionally writing null on a *failed re-watch* would wipe a working org's cursor, and nothing else can re-seed it, so every change from then on would be skipped silently. Omitting the column preserves the existing cursor. Both behaviours are pinned by tests in `drive-oauth.test.ts`.

## 2026-08-15 — FD-15: `(org_id, integration_id)` are shape-checked, not RFC-checked

`drive-changes-runner.ts`'s three adapter-boundary schemas, `drive-artifact-producer.ts`'s job
payload, and `docusign.ts`'s envelope-completed payload all validate `org_id` / `integration_id` /
`rule_event_id`. Every one of those values is read out of `org_integrations` (or returned by the
`enqueue_rule_event` RPC) before it reaches these schemas — none is Drive- or DocuSign-supplied.

Zod 4.x's `z.string().uuid()` is strict RFC 9562 and rejects UUIDs that Postgres `uuid` happily
stores, so validating our own stored ids more harshly than the column storing them can only
false-reject. These now use `dbUuid()` from `../../utils/db-row-validation.ts`. See
BUG-2026-08-12-003 / FD-15.

Two boundaries in this folder deliberately did NOT move:

- **`schemas.ts` `MicrosoftGraphChange.tenantId` stays strict** — it is parsed straight off the
  Microsoft Graph webhook notification body (`api/v1/webhooks/microsoft-graph.ts`). That is external
  input; strict validation is correct there.
- **Drive-supplied ids were never UUID-validated and still are not.** File / revision / parent ids
  are `z.string().min(1)` because Drive ids are not UUIDs — unchanged by this work.
