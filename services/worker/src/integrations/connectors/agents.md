# agents.md — services/worker/src/integrations/connectors/

_Last updated: 2026-09-26 (`drive-folder-mirror.ts` — `loadActiveDriveConnection` distinguishes a retryable DB error from a legitimate "no connection"; the caller (`rules-crud.ts`) awaits the mirror instead of firing it after the response — review P2 follow-up on PR #3086)._
_Last updated: 2026-09-25 (`drive-folder-mirror.ts` — per-folder isolation in `mirrorConnectedDriveFolders`'s loop; header comment corrected to match the real `idx_folders_connector_destination_unique` shape — review follow-up on PR #3086)._
_Last updated: 2026-09-21 (`drive-changes-processor.ts` 410/404 cursor re-bootstrap + `drive-changes-runner.ts` per-integration single-flight lease — SCRUM-2903/3661/5094/2330 fields-mask incident follow-up)._
_Last updated: 2026-09-13 (`drive-subscription-renewal.ts` — null-cursor bootstrap; the invariant is now "never OVERWRITE", not "never touch")._

## 2026-09-26 — `drive-folder-mirror.ts`: retryable connection-lookup error vs legitimate "no connection" (PR #3086 review P2)

A second independent review found `loadActiveDriveConnection` collapsed two
different states into one `null`: a genuine DB error on the `org_integrations`
lookup (transient — a network blip, a dropped connection) and "this org has
never connected Drive" (legitimate — nothing to retry until it does). Both
produced `outcome: 'skipped_no_connection'`, which is wrong for the first
case: a caller (or a future durable-retry path) has no way to tell "try again
next time" from "there is nothing to try." `loadActiveDriveConnection` now
returns a 3-way `{kind: 'found'|'none'|'error'}` result;
`mirrorConnectedDriveFolders` maps `'error'` to `outcome: 'error'` (same shape
`upsertOne` already uses for its own DB-layer failures) and only `'none'` to
`'skipped_no_connection'`. Regression test: `drive-folder-mirror.test.ts` ›
"a DB error loading the active connection is retryable ('error'), NOT the
same as no connection ('skipped_no_connection')" — confirmed failing
(asserted `'error'`, got `'skipped_no_connection'`) before the fix.

The companion P2 on this same review pass — the caller (`rules-crud.ts`)
firing this module fire-and-forget AFTER already sending its response,
so a restart or transient failure mid-mirror left no trace and no retry —
is fixed in `rules-crud.ts`, not here; see `api/agents.md`'s matching
2026-09-26 entry. This module's own contract (idempotent, per-folder
isolated, never throws) did not need to change for that fix — the caller
now simply awaits it and reports its already-honest result.

## 2026-09-25 — `drive-folder-mirror.ts`: per-folder isolation + index-comment fix (PR #3086 review follow-up)

An independent review of `feat/mirror-connected-drive-folders` (PR #3086, T2)
returned SHIP-WITH-FOLLOWUP with two P2s, both applied here:

1. **One folder's exception no longer aborts mirroring for every later
   folder.** `mirrorConnectedDriveFolders`'s `for` loop now wraps each
   `upsertOne` call in its own try/catch. `upsertOne` already converted
   DB-layer `{data,error}` failures into a returned `outcome: 'error'` — but
   a genuine JS exception (a dropped connection, a client-library throw, not
   a Supabase error return) is a different failure mode the loop had no
   protection against: it unwound the whole loop, so every folder after the
   one that threw was silently never attempted, surfaced only as one generic
   `'drive-folder-mirror wiring failed'` warning in `rules-crud.ts` with no
   per-folder detail. Each iteration is now isolated and logs its own
   `driveFolderId` on exception. This is a diagnosability/completeness fix,
   not a data-integrity one — migration 0462's lazy mirror path is the
   backstop for any folder that still has no mirror row, and re-saving the
   rule re-runs this whole function, so a partial mirror always self-repairs
   on the next save. Regression test:
   `drive-folder-mirror.test.ts` › "a genuine exception on one folder does
   not suppress mirroring of later folders in the same rule save" — confirmed
   failing against the unfixed loop (uncaught throw propagated out of
   `mirrorConnectedDriveFolders`) before the fix landed.
2. **Header comment corrected.** It previously described
   `idx_folders_connector_destination_unique` (migration 0462) as filtered on
   `owner_scope='ORG'`. Reading that migration directly: the index is NOT
   scoped to `owner_scope='ORG'` (it also covers USER-scoped rows via
   `coalesce(user_id, ...)`) and it DOES include `context_org_id` in its key,
   neither of which the comment said. Functionally harmless today — this
   module only ever writes `owner_scope='ORG'` rows and never sets
   `context_org_id`, so its own dedupe key is a narrower slice of the same
   index — but a future USER-scoped mirror path built on the old, wrong
   comment would have collided. No behavior change, no new migration.
_Last updated: 2026-09-25 (`connector-adapter.ts` + `google-drive-adapter.ts` — PR-1 of the connector-adapter-contract series, founder directive "Drive should be a template reproducible for OneDrive")._

_Last updated: 2026-09-26 (PR #3069 review findings: `loadDriveAccessToken`'s `account_label` SELECT no longer discards its error, and the self-heal CAS write now guards `account_label` on the value read)._
_Last updated: 2026-09-21 (`drive-changes-runner.ts`'s `loadDriveAccessToken` now selects the OAuth client generation for a refresh via `isDriveLegacyGrant` — SCRUM-5287/SCRUM-2903/SCRUM-2330 drive.readonly cutover)._
_Last updated: 2026-09-21 (`drive-changes-processor.ts` 410/404 cursor re-bootstrap + `drive-changes-runner.ts` per-integration single-flight lease — SCRUM-2903/3661/5094/2330 fields-mask incident follow-up)._
_Last updated: 2026-09-13 (`drive-subscription-renewal.ts` — null-cursor bootstrap; the invariant is now "never OVERWRITE", not "never touch")._

## 2026-09-26 — `loadDriveAccessToken` account_label read-error handling (P1) + label CAS race (P2), PR #3069 review

Two findings from an independent review of PR #3069 (`feat/drive-readonly-scope`), both in
`loadDriveAccessToken`:

1. **P1 — a discarded SELECT error looked identical to "no label".** The pre-refresh
   `account_label` SELECT destructured only `data`, never `error`. A transient read failure
   (`data: null, error: <something>`) therefore looked exactly like a legitimate pre-cutover row
   with no label at all (`data: null, error: null`) — the case the scope-heuristic fallback exists
   for. If the refresh that followed then succeeded, the self-heal write unconditionally spread
   `storedLabel ?? { email: null, channel_token: null, resource_id: null }` — nulling out a real
   `email` / `channel_token` / `resource_id` that this SELECT merely failed to read, not one that
   was actually absent. `api/v1/webhooks/drive.ts`'s `resolveDriveChannel` re-reads `account_label`
   fresh on every webhook delivery and fails closed (401 `integration_missing_channel_token`) on a
   null `channel_token` — so a single transient read failure turned into a PERMANENT notification
   failure for that integration. Fixed: the SELECT's `error` now aborts BEFORE the refresh or any
   write, via a new `DriveRunnerError('account_label_read_failed', …)` — retryable by the caller,
   same escalation shape as the other DB-read failures in this function (`token_read_failed`,
   `concurrent_refresh_race`).
2. **P2 — the self-heal write could clobber a concurrent renewal write.** The CAS write that
   persists refreshed tokens also serializes the self-healed `account_label` in the SAME UPDATE, but
   was conditioned only on `encrypted_tokens = $prevCiphertext`. `drive-subscription-renewal.ts`
   independently rewrites the WHOLE `account_label` blob (fresh `channel_token` on every renewal) —
   a renewal landing between this function's `account_label` SELECT and its UPDATE could have its
   fresh credential overwritten by this call's stale copy. Fixed: when the write includes
   `account_label` (i.e. we are NOT already authoritative), the UPDATE now ALSO guards on
   `account_label` being unchanged since the read (`.is('account_label', null)` when the row had no
   label, `.eq('account_label', <raw value read>)` otherwise) — a concurrent account_label writer
   invalidates the predicate and this call falls into the existing "CAS lost, trust the winner" path
   instead of overwriting a label it never actually observed.

Tests: `drive-changes-runner.test.ts`'s new `loadDriveAccessToken — account_label read-error
handling (P1) and label CAS race (P2)` describe block (2 tests) — both reproduced failing against
the pre-fix PR #3069 head before the fix landed. The shared fakes' `update(...).eq(...)` chains
(`makeFakeDb`, `makeIdentityFakeDb`, the CAS-lost regression test's inline db) now also expose
`.is()`, recorded into the same predicate-tracking array as `.eq()`.

## 2026-09-21 — `loadDriveAccessToken` selects OAuth client generation for refresh (SCRUM-5287/SCRUM-2903/SCRUM-2330 drive.readonly cutover)

See `oauth/agents.md`'s 2026-09-21 entry for the full scope-cutover story (why `DRIVE_DEFAULT_SCOPES`
moved from `drive.file` to `drive.readonly`, and why a second OAuth client exists). This file's piece:
`loadDriveAccessToken` — the ONE real production choke point for Drive token refresh (the
`drive-subscription-renewal` cron also routes through it via `jobs/drive-subscription-renewal-deps.ts`)
— now passes `clientGeneration: isDriveLegacyGrant(tokens.scope) ? 'legacy' : 'current'` to
`refreshAccessToken`. `tokens.scope` is the CACHED scope on the decrypted token blob (set at
connect/last-refresh time), not re-derived from Drive mid-refresh — cheap, already in hand, and
exactly what a pre-cutover connection's grant looks like. Getting this backwards sends an old-client
refresh token to the new client's token endpoint, which Google rejects with `invalid_grant`; there is
no migration path for a refresh token itself (it is bound to the client that issued it).
_Last updated: 2026-09-21 (`drive-changes-processor.ts` 410/404 cursor re-bootstrap + `drive-changes-runner.ts` per-integration single-flight lease — SCRUM-2903/3661/5094/2330 fields-mask incident follow-up)._
_Last updated: 2026-09-13 (`drive-subscription-renewal.ts` — null-cursor bootstrap; the invariant is now "never OVERWRITE", not "never touch")._

## 2026-09-25 — connector-adapter contract, PR-1 of 4 (founder directive: Drive as a reproducible template)

New files: `connector-adapter.ts` (the vendor-neutral `ConnectorAdapter`
interface — OAuth lifecycle, watch/cursor lifecycle, changes-feed walk, byte
fetch, fetch-error classification) and `google-drive-adapter.ts`
(`GoogleDriveAdapter`, implementing it by delegating to the existing
`oauth/drive.ts` functions with **zero behavior change**).

**Nothing else changed behaviorally.** `drive-changes-processor.ts`,
`drive-changes-runner.ts`, the webhook route, and the OAuth routes are NOT
rewired to consume this adapter in this PR — they still call `oauth/drive.ts`
directly, unchanged. The one actual code change to an existing file is
exporting `resolveRevision`/`ResolvedDriveRevision` from
`drive-changes-processor.ts` (previously module-private) so the adapter's
`listChanges` reuses Drive's real `headRevisionId` → `mtime:` → `evt:`
fallback chain verbatim instead of duplicating it — same function body, same
every existing call site.

**Contract validation found three real mismatches, all resolved INSIDE the
adapter (the interface shape did not change):**
1. `OAuthTokenSet` is camelCase; Drive's token responses are snake_case —
   `toOAuthTokenSet()` field-renames.
2. `createWatch`/`stopWatch` round-trip ONE `subscriptionId`, but Drive's
   `channels.stop` needs a CLIENT-generated `channelId` (production always
   mints this via `randomUUID()` at the call site, e.g. `drive-oauth.ts`) AND
   the SERVER-issued `resourceId` TOGETHER. `GoogleDriveAdapter.createWatch`
   generates the channelId itself and encodes both into the opaque
   `subscriptionId` as `` `${channelId}:${resourceId}` ``; `stopWatch` splits
   on the first `:` (safe because `channelId` is always our own hyphen-only
   UUID). See that file's module doc comment for the full account, including
   an OPEN GAP it flags but does not solve: real Drive watches also carry a
   caller-supplied verification secret (`channelToken` /
   `X-Goog-Channel-Token`) that this interface has no slot for yet — fine
   today because nothing consumes an adapter-created watch, but a real
   wiring PR must extend the contract before a webhook receiver can trust one.
3. `revoke()` is a faithful wrapper over `revokeOAuthToken` — it does NOT
   encode SCRUM-1237/AUDIT-0424-12's "never actually call Google's revoke,
   the refresh token is shared across sibling orgs" policy. A future
   multi-vendor caller of `ConnectorAdapter.revoke()` must re-derive that
   question per vendor, not assume Drive's answer generalizes.

**Deliberately deferred to PR-3** (per founder scoping — generalize from a
second provider, not for one): a shared health-reason vocabulary, a shared
revision-ledger/dedupe scheme, and any OneDrive/SharePoint implementation.

**Contracts this interface does not cover for ANY provider** (see
`connector-adapter.ts`'s module doc comment): folder rename/move, permission/
ownership changes, historical catch-up on reconnect, retention/expiry of
fetched artifacts.

`google-drive-adapter.test.ts` covers every method via `vi.mock('../oauth/
drive.js')` — no real Google calls. §1.6A: `fetchBytes` has no try/catch (the
underlying `fetchDriveFileBytes` already throws byte-safe errors); a test
asserts a fetch failure propagates untouched rather than being re-wrapped.

## 2026-09-21 — 410/404 cursor re-bootstrap + per-integration single-flight lease (SCRUM-2903/3661/5094/2330 fields-mask incident follow-up)

Companion to the `listChanges` fields-mask fix in `oauth/agents.md`. Because
`changes.list` had never once succeeded in prod, this pipeline had never run
against a real Google response — reviewed the "first-run flood" risk before
this deployed and fixed two real gaps found in that review (both verified
against the flagged prod org's actual state via one read-only Supabase
`execute_sql` query, project `vzwyaatejekddvltxyye`, org
`40383eb2-f1cd-4a85-8099-afafff95e5cf`: `last_token_advanced_at` stuck at
2026-09-14, one enabled `WORKSPACE_FILE_MODIFIED` rule since 2026-09-18,
`google_drive.file_changed` job_queue rows = 0 — a real but bounded backlog,
not an empty one):

1. **410/404 "pageToken invalid/expired" recovery**, `drive-changes-processor.ts`.
   Before this, a `DriveApiError` with status 410 or 404 from `changes.list`
   just bubbled up like any other failure — Google's documented recovery
   (call `changes.getStartPageToken`, resume from "now") never ran, so an
   expired token could fail an integration FOREVER: every future webhook
   would hit the identical throw. Narrowly scoped to 410/404 only — every
   other status (400, including this incident's own shape; 401/403; 429;
   5xx) still fails loud and leaves the OLD cursor untouched, because
   "recovering" from those by discarding the cursor would silently
   fast-forward past real, still-retrievable changes for reasons that have
   nothing to do with token validity. `getStartPageToken` (newly extracted
   in `oauth/drive.ts`, see `oauth/agents.md`) is the reused primitive.
   `ProcessChangesResult.cursorReset?: true` marks a pass that recovered this
   way. Changes made in the expired-token gap are unrecoverable by
   definition (that is what "expired" means to Drive) — this trades silent
   permanent failure for a bounded, LOUD gap and a working cursor going
   forward, still reported via `reportDriveProcessingFailure`.

2. **Per-integration single-flight lease**, `drive-changes-runner.ts`'s
   `runDriveChanges`. Drive can and does deliver bursts of push notifications
   for the SAME integration (the flagged org: ~115/day) — without a guard,
   concurrent webhook deliveries on different Cloud Run instances could each
   independently decrypt/refresh the OAuth token and walk the SAME
   `changes.list` backlog. The revision ledger's `UNIQUE(integration, file,
   revision)` constraint already made this SAFE (a losing concurrent insert
   23505s and counts as a duplicate — never a double-enqueue), just wasteful
   (redundant Drive API calls, redundant token refreshes, and
   `advancePageToken`'s non-CAS UPDATE could regress the cursor to a staler
   value under a race). Reuses `jobs/run-lease.ts`'s existing cross-instance
   TTL-lease primitive (`job_queue`-backed compare-and-set — the SAME
   mechanism `drive-subscription-renewal.ts`'s cron already uses, chosen
   there specifically because a Postgres advisory lock is unsafe through
   PostgREST's pooled backends), with `leaseId` set DYNAMICALLY to the
   integration's own UUID (`driveChangesRunLeaseSpec`, exported for tests)
   rather than a fixed module constant — every other registered lease in
   that file is a singleton cron guard; this is the first per-entity use of
   the primitive. Short TTL (10 min), no heartbeat: a webhook-bound pass is
   expected to finish in seconds to low minutes, not the near-hour crons that
   primitive's heartbeat/deadline machinery exists for. New skip reason
   `{ skipped: 'locked' }` when another run already holds it.

3. **`connector-health.ts` gap fix** (Task 4, "make this failure loud"): the
   existing `cursor_stale` P0-2 signal is BLIND to a cursor that has NEVER
   advanced (`last_token_advanced_at` null) — deliberately, so a
   freshly-connected integration is not false-flagged. But that null is ALSO
   the exact, indistinguishable state of an integration whose every
   `changes.list` call has failed since it connected — this incident's own
   shape. New `changes_list_never_succeeded` `HealthReason`, derived from
   `connected_at` (already read by the health query, no migration) as the
   staleness clock when the cursor has never moved. **No dedicated
   "last changes.list error" column exists on `org_integrations`** (grepped
   every migration touching that table) and `last_renewal_error` is
   semantically CHANNEL-RENEWAL-only (already drives `subscription_expiry`,
   and clears on renewal success even while `changes.list` keeps failing) —
   reusing it would silently HIDE this exact failure the moment a renewal
   sweep happens to succeed, so this does NOT reuse it. The webhook handler
   (`api/v1/webhooks/drive.ts`) also now logs `httpStatus`/`errorDetail` as
   STRUCTURED fields (bounded + PII-scrubbed by construction, per
   `DriveApiError`'s own doc comment) rather than relying on pino's default
   Error serializer to surface `DriveApiError`'s custom properties.

Formally modeled in `machines/driveChangesCursor.machine.ts` (see
`machines/agents.md`) — TLC-verified, all 5 required invariants hold,
mutation-tested (dropping the ledger/enqueue guard produces a real
counterexample; restoring it passes).

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

## 2026-09-22 — Dirty marker moved to jobs/run-lease.ts (PR #3054)

`drive-changes-runner.ts` no longer touches `job_queue` directly. The dirty /
rerun-requested marker it uses at the end of a leased run is
`markRunLeaseDirty` / `checkAndClearRunLeaseDirty` from `../../jobs/run-lease.ts`
(see that folder's agents.md for why). The bounded "exactly one extra pass"
behaviour is unchanged and still pinned by `drive-changes-runner.test.ts`.

## 2026-09-25 — `drive-folder-mirror.ts`: eager mirror at connect/rule-save time (feat/mirror-connected-drive-folders)

THE GAP: migration 0462 already mirrors a connector-sourced Drive folder into
`public.folders`, but LAZILY — only the first time a document from that
folder is actually anchored (`resolve_connector_destination_folder`, fired
from the `anchors`/`connector_artifact` triggers). Founder spec wants the
mirror folder to exist "upon setup", not on first document. This new module
adds the EAGER half, wired from `api/rules-crud.ts`'s `handleCreateRule` /
`handleUpdateRule` (fire-and-forget, same contract as `emitRuleAudit`),
scoped to the Connectors page's own `WORKSPACE_FILE_MODIFIED` +
`action_config.tag === 'connector-google_drive'` rule with a non-empty
`trigger_config.drive_folders[]`.

**No new migration.** Reuses `public.folders` and the SAME dedupe key
(`owner_scope='ORG', org_id, connector_provider, connector_source_id` — the
partial unique index `idx_folders_connector_destination_unique` from 0462)
the lazy SQL path already uses, so the two paths can never create two rows
for one connected folder — whichever runs first wins, the other
finds-and-reuses (select-then-insert, with a `23505` unique-violation
race fallback that re-selects the winner).

**Deliberately NOT `folder_api_create`/`folder_api_update`** (also 0462):
`folder_api_administers_org()` authorizes off `org_members` alone and lacks
the "owner linked only via `profiles.org_id`" fallback that
`rules-crud.ts`'s own `requireOrgAdmin()` (and `drive-folders.ts`'s
`isCallerOrgAdminResult`) already correctly implement — routing back through
the narrower RPC check would silently drop mirroring for exactly the
org-owner accounts `drive-folders.ts`'s own doc comment already flags as a
known landmine. This module writes directly against `public.folders` via the
worker's service-role client instead, the same idiom `rules-crud.ts` already
uses for `organization_rules` (explicit `.eq('org_id', orgId)` scoping, not
RLS, which service_role bypasses).

**Nesting — flagged for founder/product sign-off, not decided here:**
`trigger_config.drive_folders[]` carries only `{folder_id, folder_name}`
today (no ancestor path), so the mirror folder is created FLAT
(`parent_folder_id = NULL`), one per connected Drive folder. Whether a
deeply nested Drive tree should someday mirror as a matching nested Arkova
tree is out of scope — punted, not invented; the existing lazy 0462 path has
the identical granularity limitation for a file's actual parent folder.

Test coverage: `drive-folder-mirror.test.ts` proves idempotency (exactly one
row per connected folder across create + reconnect), the concurrent-insert
race fallback, and tenant isolation (including an adversarial
same-`connector_source_id`-across-two-orgs case). `api/rules-crud.test.ts`
has a matching "Drive folder mirror wiring" describe block proving the
create/update handlers call through only for a connector-tagged Drive rule
with a non-empty `drive_folders[]`, and never for any other rule shape.
## 2026-09-25 — three dead Drive modules deleted (812 lines)

`googleDrive.ts` (373), `drive-watch-bootstrap.ts` (261) and
`drive-change-dedupe.ts` (178) were removed with their test files. All three had
**zero non-test importers**, no barrel export, and no runtime path.

**Why this mattered beyond tidiness.** `drive-change-dedupe.ts` was a prior,
abandoned attempt at exactly the generalization a OneDrive adapter needs — its
`classifyDriveChange`/`revisionKey` were superseded by the ledger-based
reserve/confirm design now inline in `drive-changes-processor.ts`, and nobody
deleted the loser. Anyone building the second connector would have found it,
assumed it was the abstraction to follow, and rebuilt a design this codebase
already rejected once. `googleDrive.ts` (Secret-Manager OAuth/watch) was
superseded by `api/v1/integrations/drive-oauth.ts` + KMS/`org_integrations`.

**The real provider-adapter boundary is elsewhere, and it already exists:**
`adapters.ts` normalizes vendor payloads into `ConnectorCanonicalEventT` (and
already handles Microsoft Graph), and `connector_artifact` is the
provider-neutral sink both Drive and DocuSign write to. Build the OneDrive
adapter against those, not against anything deleted here.
