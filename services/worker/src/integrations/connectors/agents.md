# agents.md — services/worker/src/integrations/connectors/

_Last updated: 2026-09-13 (`drive-subscription-renewal.ts` — null-cursor bootstrap; the invariant is now "never OVERWRITE", not "never touch")._

## 2026-09-13 — a NULL `last_page_token` is now bootstrapped at renewal (BUG 2026-09-13, prod: zero Drive artifacts since April)

**What was wrong.** Two modules held contradictory beliefs about who repairs a null changes cursor,
and the intersection was "nobody".

- `drive-changes-runner.ts`'s bootstrap guard skipped any integration with `last_page_token = null`
  (`{ skipped: 'no_page_token' }`) and its comment deferred recovery to "the watch-renewal monitor
  will re-bootstrap on next renewal pass per `createChangesWatch()`".
- `drive-subscription-renewal.ts` — that monitor — stated the opposite in its own doc comment
  ("renewal NEVER touches `last_page_token`") and its deps adapter deliberately DISCARDED the
  `startPageToken` that `createChangesWatch()` returns, with a test pinning the discard as a feature.

So a connection whose cursor was null was never bootstrapped by anything, forever. Verified on prod
(read-only) on 2026-09-13 by the CTO: the Arkova org's `google_drive` row
(`org_integrations.id = 2b47529f-e3d6-4d35-a902-2c8c9731b64b`, connected 2026-04-25) has its push
channel renewed hourly with zero failures and received 63 Google change notifications in 36h — every
one of which ended in `drive webhook: changes processed {result:{skipped:'no_page_token'}}`, because
`last_page_token` has been NULL since April. `drive_watch_state` has 0 rows and no Drive artifact has
ever been produced in production.

**The refined invariant (this is the rule now — the old absolute one was over-broad).** Renewal never
OVERWRITES a POPULATED cursor; it BOOTSTRAPS a null one. The original reasoning — persisting a fresh
`startPageToken` silently drops every change between the last advance and the renewal — is only true
of a cursor that exists. A null cursor has nothing to drop and everything to gain.

**What changed (red-first; `drive-subscription-renewal.test.ts` → `describe('null-cursor bootstrap (BUG 2026-09-13)')`):**

- `DriveSubscriptionRow` gains `last_page_token: string | null`, and the DB adapter's `select` list is
  pinned by a test — if the column falls out of the select, the null check reads `undefined`,
  indistinguishable from NULL, and the sweep would clobber a LIVE cursor on every pass.
- `createChannel` on the client interface now returns an optional `startPageToken`, and
  `jobs/drive-subscription-renewal-deps.ts` threads it through from `createChangesWatch()`. Optional
  by design: its absence degrades to "no bootstrap", never to a failed renewal.
- On the successful-renewal path ONLY, when the row's cursor is null/empty AND a `startPageToken` came
  back, `last_page_token` + `last_token_advanced_at` ride along in the SAME `updateConnection` call as
  the channel swap — atomic, so the cursor and the channel feeding it can never disagree. `now` is the
  one already sampled for that write (one clock per decision).
- A POPULATED cursor is still absent from the update **as a key**, not re-sent unchanged — a test
  asserts `'last_page_token' in update === false`, because a key that is present at all is one
  refactor away from carrying the wrong value.
- Empty string counts as null. A bootstrap is logged (`info`, `{integrationId, orgId, bootstrapped:true}`)
  only AFTER the write actually landed — a bootstrap that was not persisted is not a bootstrap — and a
  null cursor whose watch returned no `startPageToken` is logged at **error** level with the reason
  (not a silent skip: that connection stays unprocessable until a later sweep). Neither line carries a
  token value, an account email, or anything out of `account_label`; a test greps the serialized log
  calls for all three.
- The logger is an injected optional interface (`DriveSubscriptionRenewalLogger`), never an import —
  this module stays a pure orchestrator, and logging absence never changes what gets written.

**Not changed, deliberately.** `drive-watch-bootstrap.ts` (DRIVE-02) is still not wired — it is the
second, folder-scoped watch system with zero prod callers (see the "two parallel watch systems" note
below), and wiring it is the architecture-debt reconciliation, not this fix. The changes
processor/runner logic, `jobs/connector-artifact-drain.ts`, the webhooks and the migrations are
untouched; only the runner's stale recovery COMMENT was corrected. Blast radius is exactly the rows
with a null cursor — one in prod today.

_Last updated: 2026-08-30 (`adobe-sign-token-store.ts` added for the Adobe Sign connect flow)._


## 2026-09-12 — SCRUM-4507: the Drive link-back mapping lives in the PRODUCER, not the drain

`connector-artifact-drain.ts` spreads a `connector_artifact` row's own `metadata` onto
`anchors.metadata` wholesale. That makes the drain look like the natural place to add Drive
provenance keys — and it is the wrong place. The drain is T3 (`check-staging-evidence.ts`
"anchor-creating feeder / anchor pipeline", SCRUM-3802): a change there needs a 24h isolated
soak and puts every connector's anchor creation in the blast radius, to add four keys that only
one connector produces. The mapping therefore lands where the raw Drive change is actually in
hand, and every later hop just carries the values:

| Hop | File | What it gained |
|---|---|---|
| 1. classify | `drive-changes-processor.ts` | `ChangeDescriptor` gained `sharedDriveId` / `folderId` / `revisionKind`; `resolveRevisionId` became `resolveRevision`, returning the id AND which fallback produced it |
| 2. enqueue | `drive-changes-processor.ts` | `enqueueFileChangedJob` payload gained `shared_drive_id` / `folder_id` / `folder_path` / `revision_kind` |
| 3. adapt | `drive-changes-runner.ts` | the four fields cross the `null` -> `undefined` boundary with the existing ones |
| 4. schema | `drive-artifact-producer.ts` | the four as `.optional()`, plus the `DRIVE_REVISION_KINDS` vocabulary |
| 5. write | `jobs/drive-file-changed.ts` | `p_metadata` gained `_drive_shared_drive_id` / `_drive_folder_id` / `_drive_folder_path` / `_drive_revision_kind` |

**`shared_drive_id` was already on the wire.** `listChanges`' field mask has always requested
`driveId` and the Zod entry has always parsed it — nothing read it. No new Drive API call, no new
scope, no extra round-trip: `folder_path` reuses the value PHASE 2 already resolved for that file.

**Why `revision_kind` exists.** `revision_id` is not always a Drive revision. Workspace-native
files expose no `headRevisionId`, so `resolveRevision` falls back to `mtime:<modifiedTime>`, and a
change with neither falls back again to `evt:<time>:<fileId>`. Those prefixes are part of the 0343
`connector_artifact` dedupe key and MUST NOT change — altering them re-anchors every Doc. But a
surface that renders the value has to know which of the three it holds, or it labels a modification
time as a document revision (§1.5). Downstream must switch on `_drive_revision_kind`, never parse
the id's prefix.

**The four fields are `.optional()` and that is load-bearing.** Jobs enqueued before this change are
already in `job_queue` without them; a required field would fail `parse` on every one of those rows'
next attempt and stall the pipeline behind a backlog it could never drain.

**Never add an owner or account label.** Drive's `account_label` IS the connected Google account's
email (`drive-account-label.ts`), and the change's `actor_email` is the last modifying user's. Neither
exists on `DriveFileChangedJobPayload`, and `drive-artifact-producer.test.ts` pins the whole payload
key set as a ratchet so a new field has to be added deliberately.

## 2026-08-30 — `adobe-sign-token-store.ts` reuses the DocuSign Secret Manager client on purpose

Adobe Sign uses the same token split as DocuSign: short-lived ACCESS token KMS-encrypted into
`org_integrations.encrypted_tokens`, long-lived REFRESH token in GCP Secret Manager with only the
resource name in `token_secret_name`.

The Secret Manager CLIENT is provider-agnostic — it takes a resource name and does
GET/addVersion/DELETE — so `adobe-sign-token-store.ts` **imports it from `docusign-token-store.ts`**
rather than forking ~150 lines of plumbing. Only the NAME derivation is provider-specific. A
DocuSign-flavoured filename on the shared half is worth more than two implementations drifting
apart, and a fork would also fail the Sonar new-code duplication gate. If that shared client ever
needs to move to a neutral module, move it — do not copy it.

**Why the provider segment in the name matters:** both builders hash the account id, so without
`arkova-adobe-sign-` vs `arkova-docusign-` an org that connected the same-numbered account on both
providers would collide onto ONE secret and each connect would clobber the other's refresh token.
`adobe-sign-token-store.test.ts` asserts the two names differ for identical `(org, account)` inputs
rather than merely asserting the Adobe name matches a regex.
_Last updated: 2026-08-03 (PR #1944 review rounds 2-3: create-then-stop CRITICAL fix, PII scrub, concurrency bound, account_label parser convergence)._
_Last updated: 2026-09-07 (`docusign-token-store.ts` version retention — BUG 2026-09-05 Secret Manager version churn)._

## 2026-09-07 — `docusign-token-store.ts` now prunes superseded Secret Manager versions (BUG 2026-09-05, infra-cost / security-hygiene)

**What was wrong.** `put()` only ever appended a version. DocuSign rotates the refresh token on every refresh, and two hourly Cloud Scheduler jobs each refresh the grant through `jobs/docusign-reconciliation-deps.ts`'s shared `getAccessToken` (`docusign-connect-failures-poll` at `:00`, `docusign-listener-drift` at `:15` — confirmed from the Secret Manager audit log: `AddSecretVersion` by the compute SA at 13:00:16Z and 13:15:12Z on 2026-09-07, matching the worker request log). So the prod org secret `arkova-docusign-40383eb2-…-d0d00bc8…-refresh-token` gained 2 versions/hour from 2026-08-03 and reached **1,645 ENABLED versions on 2026-09-05** (1,731 by 2026-09-07T13:15Z). Every one held a distinct payload (SHA-256 of v1728–v1731 all differ) — the existing `result.refresh_token !== refreshToken` guards in the callers were correct and never the problem. Secret Manager bills every ENABLED/DISABLED version, so that was ~$99/month, growing ~$6/month per day, for versions nothing can read (`get()` only ever calls `versions/latest:access`).

**What changed (red-first; `docusign-token-store.test.ts` "version retention" block):**

- **Compare-before-write.** `put()` reads `versions/latest:access` and skips `:addVersion` when the payload is byte-identical (`timingSafeEqual`). A 404 (fresh secret) or any read failure still writes — losing a rotated token severs the integration, one extra version costs cents.
- **Prune after write.** After a successful `:addVersion`, `put()` lists `state:ENABLED` versions (500/page, hard cap 20 pages) and `:destroy`s everything older than the newest `keepVersions` (**2**), oldest first, at most `maxDestroyPerPut` (**10**) per call. Both knobs are `deps.retention`; defaults are `DEFAULT_DOCUSIGN_REFRESH_TOKEN_RETENTION`. `selectSupersededVersions()` is the exported pure selector — it sorts **numerically** (`10` > `9`; the API returns names) and reports `remaining` so the log line is honest about backlog.
- **Prune never throws.** The token is already stored by then; any list/destroy failure is a `warn` with counts (`destroyed`, `failed`, `remainingSuperseded`) and the next rotation retries. Failed destroys count as still-superseded.
- **Never logs a payload.** Log lines carry `secretId` and counts only; the test suite asserts the serialized log never contains a token value. `deps.logger` is injectable (`DocusignRefreshTokenStoreLogger`) so tests capture it; default is `utils/logger.js`.
- **Why destroy, not disable.** Disabled versions are still billed. Two enabled versions stay so a `get` that raced a `put` still sees a valid value.
- **Why no server-side TTL.** Secret Manager's `versionDestroyTtl` is a *delay* on destroy (the version sits DISABLED — still billed — until the TTL elapses), and `expireTime`/`ttl` destroy the whole secret; neither expires individual versions. So the guarantee against a crashed-run backlog is the prune being **self-healing on every write** plus the two ops scripts below, not a server-side field.

**Steady state after the backlog is cleared:** 2 enabled versions per secret, one destroy per rotation. **Backlog** (1,729 versions on the prod org secret) is the ops script's job — the worker deliberately drains only 10 per rotation so a cron run never spends minutes on Secret Manager.

**Ops tooling (root `scripts/ops/`, see that folder's `agents.md`):** `prune-docusign-refresh-token-versions.ts` (dry-run by default; `--apply` needs `CONFIRM_DESTROY_SECRET_VERSIONS=<exact secret id>`; refuses any id outside the `arkova-docusign-[member-]<owner>-<32 hex>-refresh-token` pattern) and `audit-secret-version-counts.ts` (flags any secret in the project with >20 enabled versions; wired into the `infra-hygiene-sweep` skill). **Do not run `--apply` without Carson's explicit approval — version destruction is irreversible.**

**Permission note.** The worker's runtime SA (`270018525501-compute@…`) can `:destroy` because it currently holds `roles/owner` on `arkova1` (a known, separately tracked over-grant — verified with `gcloud projects get-iam-policy arkova1` on 2026-09-07). When that role is finally reduced, the store needs `secretmanager.versions.destroy` + `secretmanager.versions.list` on these secrets (both are in `roles/secretmanager.admin`; `secretAccessor` alone is NOT enough) — the prune would degrade to a `warn` per rotation, not a failure, but the backlog would resume growing.

_Last updated: 2026-08-29 (docusign-bilateral PR-2: `DocusignCapturedSigner` schema + job-payload `_signers`/`docusignEnv` threading)._

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
| `drive-subscription-renewal.ts` | **GH #1835**: pure orchestrator that renews `org_integrations` google_drive rows before their `changes.watch` channel expires (or registers one for a never-bootstrapped connection). Never OVERWRITES a populated `last_page_token` — a renewal that reset a live cursor would silently drop unprocessed changes — but since BUG 2026-09-13 it DOES bootstrap a null one from the new watch's `startPageToken`, in the same write as the channel swap; see its own doc comment and the 2026-09-13 entry above. Every successful renewal mints a fresh random `channel_token` (GH #1836 rotation). No cron here — see `jobs/drive-subscription-renewal-deps.ts` + `routes/cron.ts`. **PR #1944 review rounds 2-3** (see the entry above for full detail): create-then-stop channel ordering (CRITICAL), `boundedReason()` routes through canonical `boundedErrorDetail()` (PII scrub), bounded chunked concurrency (`RENEWAL_CONCURRENCY = 5`), account_label parse routes through `drive-account-label.ts`, and a `recordSetback()` inner closure consolidating what were 3 copy-pasted failure-recording blocks. |
| `drive-account-label.ts` | **NEW (PR #1944 review round 3 addendum)**: canonical `parseDriveAccountLabel(raw: string \| null \| undefined): DriveAccountLabel \| null` + `stringifyDriveAccountLabel(label)`. Returns `null` for null/empty/invalid-JSON/non-object input — covers both a Drive row with no label yet and a plain non-JSON display string (the shape other connectors' `account_label` columns use). Consolidates 4 near-duplicate inline `JSON.parse` call sites that disagreed on edge-case handling: `drive-oauth.ts` (disconnect flow), `webhooks/drive.ts` (`resolveDriveChannel`), `drive-subscription-renewal.ts` (this folder), and `api/connector-health.ts` (`sanitizeAccountLabel`). Any new Drive code reading or writing `account_label` MUST go through this file, not another inline `JSON.parse`/`JSON.stringify`. |

## What This Folder Contains

Vendor connector services and canonical event adapters. Each connector owns OAuth coordination, watch channel management, and document-fetch contracts. Adapters are pure functions that normalize vendor payloads into rules-engine events.

| File | Purpose |
|------|---------|
| `schemas.ts` | Zod schemas for all vendor webhook payloads (Drive, DocuSign, Adobe, Checkr, Veremark). **2026-08-29 (R6):** `DocusignCapturedSigner` — pseudonymous-only signer shape (`recipient_id_guid`, `user_id?`, `status`, `signed_at?`); non-`.passthrough()` object mode strips name/email by construction. `MAX_CAPTURED_DOCUSIGN_SIGNERS = 20`. **2026-08-31 (signer-backfill review, dedup):** `captureDocusignSigners(signers)` — the ONE shared per-recipient mapping algorithm (cap/dedupe-by-`recipient_id_guid`/GUID-shape-validate/trim) behind BOTH `extractSigners` (`api/v1/webhooks/docusign.ts`, the live Connect webhook) and `extractCapturedSigners` (`integrations/oauth/docusign.ts`, the signer backfill's `/recipients` REST fetch) — previously two independently-maintained copies of the same algorithm that differed only in helper names and where they found the raw array; factored here so the two call sites cannot drift. |
| `adapters.ts` | Pure-function adapters: vendor payload -> canonical `TriggerEvent` for rules engine |
| `googleDrive.ts` | Google Drive connector — OAuth, Secret Manager tokens, 7-day watch channels, event shaping |
| `docusign.ts` | DocuSign connector — retryable signed-document fetch, account token resolution. DS-04: `DocusignResolvedConnection` + the `enqueueSignedDocument` sink now carry `scope` (`'org'`/`'member'`) + `ownerUserId` for personal-queue routing. **2026-08-29 (R6/R7):** `DocusignEnvelopeCompletedJobPayload` gained optional `_signers`; `processDocusignEnvelopeCompletedJob` derives `docusignEnv` (`resolveDocusignEnvironment(connection.baseUri)`) and threads both into `enqueueSignedDocument`'s input — see `jobs/agents.md` for the metadata-write side |
| `docusign-connection-resolver.ts` | Sub-org connection resolution (SCRUM-2045). DS-04 (SCRUM-2364): resolves `scope`/`ownerUserId` — a `member_integrations` row's `owner_user_id` ⇒ `scope='member'` (personal queue); org-owned / inherited connections ⇒ `scope='org'` |
| `docusign-token-store.ts` | DocuSign refresh-token Secret Manager store — org + member-level naming (SCRUM-2044) |
| `docusign-rule-seed.ts` | **SCRUM-3027**: auto-seed the "DocuSign Completion" rule (`ESIGN_COMPLETED` → `AUTO_ANCHOR`, queue-mode, **enabled**) on a successful org DocuSign connect. `seedDocusignCompletionRule()` is idempotent + **non-stomping** — if the org already has ANY `ESIGN_COMPLETED` rule (any action) it seeds nothing, never overriding an admin's choice. NEVER throws (failure-isolated: loud `logger.error` + Sentry, PII-safe = orgId only; fails CLOSED on an ambiguous lookup error). Config shapes are Zod-validated (`TriggerConfigEsignCompleted` / `ActionConfigAutoAnchor`); row is built from the canonical `rule-templates-data.ts` `docusign-completion` template. WIRED into `api/v1/integrations/docusign-oauth.ts` callback (fire-and-forget, after the integration upsert) — surfaces `docusign_completion_rule_seeded` / `_seed_failed` `integration_events`. `enabled=true` is intentional (explicit human connect action, no NL-authoring surface — distinct from the SEC-02 `enabled=false` CRUD path) |
| `drive-changes-processor.ts` | Drive changes feed processor — paginated, deduped, folder-matched event emission. **GH #1837**: `DriveProcessorDeps.resolveFolderPath` (optional) is called for a MATCHING change only, and its result threads into `enqueueRuleEvent`'s new required `folder_path: string \| null` field — a resolver failure/throw is swallowed to `null`, never aborts the page. **PR #1944 review round 3, FINDING 1 (perf)**: folder-path resolution used to happen inline, sequentially, per matching change — a 20-file burst in one webhook drain could add ~20 sequential resolver round-trips of latency. Restructured the per-page loop into 3 phases: (1) `classifyPage()` — pure sync classification, no I/O; (2) `resolveFolderPathsForPage()` — bounded-concurrent (`FOLDER_PATH_RESOLUTION_CONCURRENCY = 8`), deduped-by-`fileId` resolution for matching descriptors only, for the WHOLE page before any commits; (3) the original strictly-sequential ledger-insert/enqueue/compensation loop, unchanged in its ordering guarantees, now reading precomputed results from a `folderPaths` Map instead of awaiting per-change. All counters and compensation/throw semantics preserved exactly — only the I/O shape of the folder-path lookups changed. Covered by `describe('FINDING 1: concurrent folder-path resolution across a page')` — concurrent-not-sequential proof, a hard concurrency-bound proof (20 files, `maxInFlight <= 8`), dedup-by-fileId proof (2 revisions of the same file → resolver called once), per-fileId error isolation, and a phase-ordering proof (all resolution happens before the first `insertRevisionLedger` call). |
| `drive-changes-runner.ts` | Webhook-to-processor glue — token refresh, watched-folder-id resolution. **SCRUM-2903 GD-PROD (wired 2026-07-28, #1654):** `createProcessorDbAdapter().enqueueFileChangedJob` submits the `google_drive.file_changed` job (`submitJob`, Drive twin of the DocuSign webhook's `enqueueFetchJob`) immediately after `enqueueRuleEvent` succeeds — no bytes cross this call, only connector-native ids + a mime/timestamp hint, validated against the SAME `DriveFileChangedJobPayload` Zod schema `jobs/drive-file-changed.ts` parses on the consumer side (imported from `drive-artifact-producer.ts`, not redefined). **GH #1837 (2026-08-03):** `enqueueRuleEvent`'s RPC call now passes `p_folder_path: validated.folder_path ?? null` (was hardcoded `null`) — `?? null`, never `?? ''`, because an empty string would make `folder_path_starts_with` match every rule. `createFolderPathCache()` (exported, tested) is a thin Postgres adapter over `drive_folder_path_cache` (PK `(org_id, file_id)`); `runDriveChanges` binds it + `resolveDriveFolderPath` (`drive-folder-resolver.ts`) into the `resolveFolderPath` dep passed to `processDriveChanges`. |
| `drive-artifact-producer.ts` | **SCRUM-2903 GD-PROD**: the producer bridge that gives Drive documents an anchor path. `processDriveFileChangedJob` (Drive twin of `processDocusignEnvelopeCompletedJob`): parse (Zod, ids-only payload — NO actor_email/PII field exists) → resolve access token → `fetchDriveFileBytes` → sink. Pure orchestrator (token resolver / fetch / sink all injected). The payload schema deliberately carries only connector-native ids so actor email cannot ride into the artifact. Byte handling is confined to the sink (`jobs/drive-file-changed.ts`). Also owns `DRIVE_FILE_CHANGED_JOB_TYPE` (`'google_drive.file_changed'`) as the single source of truth — `jobs/drive-file-changed.ts` re-exports it rather than duplicating the literal, and `drive-changes-runner.ts` imports it directly (this file has no reverse dependency on either, so no import cycle). **End-to-end wiring landed 2026-07-28 (#1654):** `drive-changes-runner.ts` now enqueues the job; the drain is registered at `POST /jobs/drive-file-changed` in `routes/cron.ts` (prod, Cloud Scheduler) and as an in-process dev/test backup in `routes/scheduled.ts`, both gated by `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` (still default OFF — founder-gated flip post-soak, per CTO ruling R3 in the 2026-07-28 sprint plan). |
| `drive-folder-resolver.ts` | Drive parent-chain folder path resolver (20-level depth cap, 15-min TTL cache). **GH #1837 (2026-08-03)**: wired into the live pipeline via `drive-changes-runner.ts`'s `resolveFolderPath` dep — it already had the right contract (unresolvable → `null`, never `''`), it simply had no caller. **PR #1944 review follow-up**: `resolveDriveFolderPath` now takes an optional `deps.logger` (`{warn, error}`) — every failure was previously swallowed to `null` with ZERO signal (the caller's own try/catch in `drive-changes-processor.ts` had nothing to actually catch, since this function never threw). A `DriveApiError` (expected: permission loss, deleted parent) logs at `warn` with the HTTP status; anything else logs at `error`. `drive-changes-runner.ts`'s production wiring always passes `deps.logger` through. |
| `drive-connect-eligibility.ts` | **DRIVE-01 (SCRUM-2366)**: verified-only Google Drive connect gate. Org-admin / paid-verified-individual paths, resolved via the canonical owner-inclusive resolver (`api/_org-auth.ts`), never `org_members` alone. Re-evaluated at start AND callback so an existing/stale token can't bypass a lapsed entitlement. Fail-closed to `lookup_failed`. **WIRED into `api/v1/integrations/drive-oauth.ts`** (`start` + `callback`) via `assertDriveConnectAllowed` + a `makeEligibilityDb` adapter — do NOT leave it importer-less again. **Keep this module logger-free** — importing the logger pulls in `config.ts`, whose Zod boot validation would force a full env fixture into every consumer's unit test; denials are logged by the route's `logConnectDenial`. |

### FD-D3 (2026-08-13, connector side-rig) — `not_admin` was two different denials

An org OWNER got `403 not_authorized` from `/oauth/start`. The admin check was never the cause: `resolveIndividualPath` returns a denial when the caller HAS an org but omitted `org_id`, and that denial reused **`not_admin`** — the same reason the ORG path returns for a genuine non-admin, mapping to the same HTTP code, with **no log on either**. From outside, "you're not an admin" and "you called the wrong scope" were byte-identical. Diagnosing it cost a live founder Google consent.

Proven by differential, not by reading: same user, same fixtures, one request with `org_id` and one without → `org_unverified` vs `not_authorized`. A deny reason that varies with an argument the check never reads is the tell.

Two rules out of it:
- **A deny reason names ONE condition.** `org_scope_required` is now distinct from `not_admin`. Denials that differ in remedy must differ in reason — the client can retry a scope mistake, it cannot retry not being an admin.
- **Every eligibility denial logs.** A gate that denies silently is only debuggable by reproducing it in production, against a real user.

This branch also had **no test** — the only branch in the module without one, and the one that shipped the defect. Both are covered now.
| `drive-watch-bootstrap.ts` | **DRIVE-02 (SCRUM-2367)**: folder-watch bootstrap → persists initial page token, channel id/expiry, owner scope (my_drive vs shared_drive), status, `last_renewal_error` into `drive_watch_state` (mig 0351) via `upsert_drive_watch_state`. `persist()` forwards `p_last_renewal_error` — the RPC MUST declare that param (fixed in 0351: `p_last_renewal_error text DEFAULT NULL`, written on INSERT + ON CONFLICT UPDATE). Folder-permission failures → `status='permission_denied'` (no throw); folder id mismatch → `failed`. `folder_path`/`owner_email` are sensitive — persisted to the RLS row ONLY, never logged. |
| `drive-change-dedupe.ts` | **DRIVE-03 (SCRUM-2368)**: pure change classifier + revision dedupe key + bounded/PII-scrubbed audit projection. Ignores removed/trashed/unsupported-MIME; each `(file_id, revision)` queues once (backed by `drive_revision_ledger` UNIQUE). Companion to `drive-changes-processor.ts`. |
| `drive-channel-renewal.ts` | **DRIVE-06 (SCRUM-2371)**: pure channel-renewal sweep — renews before expiry, alerts + marks `degraded` on failure (token-revoked + renewal-failed paths), recovers expired channels idempotently, STOPS a watch whose org lost entitlement. **NO cron** — cadence is a HANDOFF to Lane 2's Cloud Scheduler → HTTP `/jobs/*` (the trigger with retries and an attempt deadline; SCRUM-3384). Status vocabulary the sweep + bootstrap write MUST all be permitted by the 0351 `drive_watch_state_status_check` CHECK: `active \| permission_denied \| expired \| stopped \| degraded \| failed` (`degraded` added 2026-07-01 — it was previously omitted and the first renewal failure would have violated the constraint). `drive-watch-state-rpc.test.ts` is the SQL-contract guard that keeps code↔CHECK vocabulary from drifting (mock-DB renewal tests can't catch a real constraint mismatch). |

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
## 2026-08-15 FD-D1 — `drive-connect-eligibility.ts` no longer admits individual scope

**There is exactly one allowed shape now: `{ allowed: true, scope: 'org', orgId }`.** The
`{ scope: 'individual' }` variant is **deleted from the union**, not merely made unreachable — so
re-admitting individual scope without also building the personal-connect storage path is a type
error, not a silent regression. That is the whole point of removing it from the type rather than
adding an early return.

Why: the gate admitted a paid, identity-verified solo user, and `drive-oauth.ts`'s callback then
refused that exact case because `org_integrations.org_id` is NOT NULL. The user granted Google
access to their entire Drive and silently got nothing. The consent was real; the capability was not.
CTO ruling FD-D1 (2026-08-12): drop the scope, do not build personal-connect storage.

The personal path still runs the org lookup, and that is deliberate — **which** denial the caller
gets is the deliverable:

- `org_scope_required` (FD-D3) — caller HAS an org, omitted `org_id`. Actionable: retry naming it.
- `individual_scope_unsupported` (FD-D1) — caller has NO org. They have no `org_id` to resend, so
  handing them the first message sends them hunting for something that does not exist.

`needs_paid_plan` and `individual_not_verified` are **gone**. Both were upsells for something
unbuildable. `getProfileEntitlement` is no longer called (a test asserts it is not — a
`needs_paid_plan` denial here would have been a false promise that paying unlocks the path), though
it stays on `DriveEligibilityDb` for the org-scoped consumers.

The module remains **logger-free on purpose** (see the FD-D3 note in `drive-oauth.ts`): importing the
logger pulls in `config.ts`, whose Zod boot validation would force a full env fixture into every
consumer's unit test. Denials are logged by the route via `logConnectDenial`, on both legs.
## 2026-08-15 Drive OAuth scope minimality (FULLSOAK finding)

`buildGoogleDriveAuthorizationUrl` inherits its scope set + URL params from `oauth/drive.ts` `buildAuthorizationUrl`. That URL no longer sends `include_granted_scopes` (it let a connect inherit a 33-scope grant from the shared OAuth client) and the scope set is the exact three-scope allowlist in `DRIVE_DEFAULT_SCOPES`. Pinned in `googleDrive.test.ts`; do not loosen either assertion.

## 2026-09-07 Refresh-token version retention — the newest version is never destroyable (Batch-J review)

`docusign-token-store.ts` prunes superseded Secret Manager versions after every `put`. Two rules are
load-bearing and both are pinned by tests; do not relax either:

1. **`selectSupersededVersions` floors `keepVersions` at 1 and re-asserts before returning.**
   `keepVersions` arrives from a caller-supplied `deps.retention`. `0` — or any non-finite value,
   which `Array.prototype.slice` coerces to `0` — used to put the newest ENABLED version in the
   destroy list. That version is the one `versions/latest` resolves to and the only one any reader
   ever uses, so destroying it severs the DocuSign grant with no recovery path. `normalizeKeepVersions`
   is the floor; the `throw` on `destroy.includes(newest)` is the defense in depth, mirroring the
   guard the ops script (`scripts/ops/prune-docusign-refresh-token-versions.ts`) already had.
2. **The prune runs on the compare-before-write SKIP path too**, not only after a successful
   `:addVersion`. It is the self-healing mechanism for a backlog left by crashed runs; reachable only
   through a value *change*, it would never drain if the provider ever returned the same token twice.

Nothing in the worker ever reads a pinned secret version — every read is `versions/latest:access`,
and `connector_integrations.token_secret_name` names the SECRET, not a version. That is why no
integration row can reference a version the prune destroys.

A prune failure is a `warn`, never a throw: the token is already stored by then. When the LIST call
is what failed, the log reports `remainingSuperseded: 'unknown'` — reporting `0` there read as
"backlog drained" while the real secret still held 1,729 superseded versions.

## PR #2474 release review — 2026-09-05

Signer status values are restricted to documented DocuSign recipient status codes; signed_at accepts only numeric ISO datetimes, including fractional seconds, offsets and timezone-less vendor values. This closes PII persistence through correctly named status/timestamp fields. Regression tests reject email/name text in both fields. Recipient status reference: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/recipients/status-codes/

## 2026-09-14 — PR #2937 shared Drive folder-binding contract

The side-effect-free drive-folder-bindings.ts extracts non-empty legacy folder_id and drive_folders[].folder_id values. Both loadWatchedFolderIds and connector-health use it, so an enabled rule with no actual folder cannot create a cursor-stale warning while the runner intentionally skips processing. The runtime runner keeps the same org-wide rule selection and returned folder union; health separately performs a bounded complete inventory scan and reports503 when it cannot complete.
