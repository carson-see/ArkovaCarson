## Root cause (verified in prod, 2026-09-21)

`services/worker/src/integrations/oauth/drive.ts`'s `listChanges()` (~line 596-625, pre-fix) built its Drive `fields` partial-response mask as:

```js
fields: [
  'newStartPageToken',
  'nextPageToken',
  'changes(fileId,removed,changeType,time,',
  'file(id,name,parents,driveId,modifiedTime,headRevisionId,trashed,mimeType,',
  'lastModifyingUser(emailAddress,displayName)))',
].join(''),
```

`.join('')` — an **empty-string** join — fuses the first two top-level entries and the start of `changes(...)` with **no separating commas**: `newStartPageTokennextPageTokenchanges(fileId,...)`. Google rejects this with HTTP 400 `Invalid field selection newStartPageTokennextP...`. Prod logs, last 24h before this fix: 150× `drive changes.list failed` + 150× `drive webhook: runDriveChanges failed — 200 ack so Drive does not retry-storm`. All five Drive flags are ON in prod; pushes arrive and authenticate; `google_drive.file_changed` has **never once** been enqueued; **zero** `connector_artifact` rows with `source=google_drive` have ever existed. Bug dates to commit `90b4b9c72` (2026-05-04). Because `changes.list` has never once succeeded in prod, everything downstream (folder-rule match, revision ledger, rule-event enqueue, file fetch/export, SHA-256, `connector_artifact` insert, link-back fields) has never run against a real Google response.

## Fix

Rebuilt the mask as one explicit string with commas written where they belong (`CHANGES_LIST_FIELDS` constant in `drive.ts`) — no `.join('')` left to get wrong a second time:

```
newStartPageToken,nextPageToken,changes(fileId,removed,changeType,time,file(id,name,parents,driveId,modifiedTime,headRevisionId,trashed,mimeType,lastModifyingUser(emailAddress,displayName)))
```

## Red → green (TDD record)

1. Added `assertValidFieldsMask()` — a structural fields-mask validator (`oauth/__test-helpers__/fields-mask.ts`) — **and** an exact-decoded-string assertion in `drive.test.ts`. The structural validator is documented (and mutation-tested against itself) as *insufficient alone* for this exact bug shape: a no-separator join fuses two field names into one syntactically-valid-looking identifier that a generic tokenizer cannot distinguish from a legitimately long single field name — only the exact-string assertion actually pins the regression.
2. Ran `npx vitest run src/integrations/oauth/drive.test.ts` against the **unmodified** code: **RED** — `AssertionError: expected 'newStartPageTokennextPageTokenchanges…' to be 'newStartPageToken,nextPageToken,chang…'` (plus `getStartPageToken is not a function`, since that extraction was net-new).
3. Applied the fix + extracted `getStartPageToken()`. Re-ran: **GREEN**, 46/46 in that file.

## Call-site sweep (every Google API call in `oauth/drive.ts` that sets `fields`/`q`/`pageToken`/`supportsAllDrives`/`includeItemsFromAllDrives`)

| Call site | What was validated | Defect found |
|---|---|---|
| `listChanges` → `changes.list` | `fields` exact string + structural validator; `pageToken`/`includeRemoved`/`supportsAllDrives`/`includeItemsFromAllDrives` params; Bearer header; parses a documented-shape response including a change with `parents` absent (shared-drive item) | **YES — the incident** |
| `getFileMetadata` → `files.get` | `fields=id,name,parents,driveId` exact string + structural validator | No |
| `getSharedDriveName` → `drives.get` | `fields=name` exact string + structural validator | No |
| `listChildFolders` → `files.list` | `fields=nextPageToken,files(id,name,driveId)` exact string + structural validator; `q` construction + `escapeDriveQueryLiteral` injection guard (pre-existing, re-confirmed, already had its own test) | No |
| `createChangesWatch` → `changes/startPageToken` + `changes.watch` | Exact URL/path/query-param assertions for both calls, My-Drive and shared-drive-scoped variants; POST body shape | No |
| `getStartPageToken` (newly extracted) → `changes/startPageToken` | Exact URL/param assertions, My-Drive and shared-drive-scoped | No (new function, correct by extraction — same logic `createChangesWatch` already exercised) |
| `fetchDriveFileBytes` → `files.get?alt=media` / `files/export` | No `fields` param (media/export fetch) — out of scope for this defect class, unchanged | N/A |
| `exchangeCode`/`refreshAccessToken`/`stopDriveChannel`/`revokeOAuthToken` | No `fields`/`q` params | N/A |

Repo-wide `git grep -n "\.join('')" services/worker/src/integrations services/worker/src/api/v1/integrations` found **exactly one** hit: the `listChanges` line fixed here. `oauth/docusign.ts` joins OAuth scopes with `.join(' ')` (space-separated is the *correct* separator for a scope string — not the same defect class). No other connector HTTP builder in the repo uses `.join('')`.

## Google API reference confirmation

The `google-developer-knowledge` MCP returned `API key not valid. Please pass a valid API key.` on every call this session (server-side auth failure — flagging per the harness's "treat as connection failure, not missing capability" guidance, not a silent skip). Confirmed instead via `WebFetch` directly against Google's docs:

- `developers.google.com/drive/api/guides/fields-parameter`: commas separate sibling fields at a nesting level; parentheses denote the next nesting level — worked example given: `fields=nextPageToken,changes(file(id,name,owners(displayName,emailAddress)))`, exactly the shape `CHANGES_LIST_FIELDS` now uses.
- `developers.google.com/drive/api/reference/rest/v3/changes/list`: `pageToken`, `includeRemoved`, `supportsAllDrives`, `includeItemsFromAllDrives` are the documented params (all already present, unchanged by this fix); `nextPageToken` appears whenever more pages remain, `newStartPageToken` only on the terminal page — matches the existing pagination logic in `drive-changes-processor.ts` exactly.

## Downstream dry-read (Task 3)

New `drive-changes-e2e.test.ts`: one realistic, two-page, five-change-shape `changes.list` fixture (in-watched-folder file, out-of-folder file, a removed file, a Google-native Doc with no `headRevisionId`, and a shared-drive item with `parents` entirely absent) run through the real `processDriveChanges` orchestrator. Asserts: only the two in-folder/native-doc changes enqueue; cursor advances to `newStartPageToken` **exactly once**, at the end; a mid-walk (page 2) failure does **not** advance the cursor while page 1's genuine enqueue is preserved; replaying the identical fixture is idempotent (0 new enqueues, all 4 non-removed changes counted as ledger duplicates); every enqueued `google_drive.file_changed` payload parses against the **real** `DriveFileChangedJobPayload` Zod contract `jobs/drive-file-changed.ts` consumes; no payload field is ever a `Buffer`/typed array or an unbounded string (§1.6A).

## First-run-flood review (orchestrator requirement B)

Traced `runDriveChanges` → `drive-changes-processor.ts` in full before this deployed:

- **Per-run page cap**: `SAFE_PAGE_LIMIT = 25` pages/run (~1,250 changes), pre-existing. Confirmed it **persists progress at the cap boundary** (`drive-changes-processor.ts`, cap-exit branch) rather than replaying the same window forever — already tested (`SCRUM-1647 follow-up` test), now additionally locked in by this PR's new mid-walk-failure tests.
- **Concurrent pushes racing `last_page_token`**: **no guard existed**. Fixed — added a per-integration single-flight lease in `drive-changes-runner.ts` (reuses `jobs/run-lease.ts`'s cross-instance TTL-lease primitive, dynamically keyed by `integration.id`). Red-first: new tests in `drive-changes-runner.test.ts` assert `{ skipped: 'locked' }` when another run holds the lease (no token refresh, no Drive call, no processor call) and that the lease releases even when `processDriveChanges` throws.
- **410/404 "pageToken invalid/expired"**: **not handled before this PR** — bubbled up and would fail the SAME integration forever (every subsequent webhook hits the identical throw). Fixed — `drive-changes-processor.ts` now catches 410/404 specifically, calls the newly-extracted `getStartPageToken()`, persists the fresh token, and returns cleanly (`result.cursorReset: true`). Every OTHER status (400 — this incident's own shape — 401/403/429/5xx) still fails loud with the cursor untouched, by design. Red-first tests cover both statuses, the "recovery itself fails" path, and a mid-walk 410.
- **Per-invocation exceeding quota/credits/anchor cap**: each matched file enqueues its own `google_drive.file_changed` job (unchanged). One read-only Supabase `execute_sql` query against **prod** (project `vzwyaatejekddvltxyye`, org `40383eb2-f1cd-4a85-8099-afafff95e5cf` — this is Arkova's own internal org, not an external customer) confirms: `last_token_advanced_at` stuck at `2026-09-14T00:00:01Z` (the null→bootstrap fix from that date landed, then every subsequent `changes.list` 400'd), `has_page_token: true`, **1 enabled** `WORKSPACE_FILE_MODIFIED` rule (created 2026-09-18), **0** existing `google_drive.file_changed` job_queue rows (no backlog sitting in the queue today), `ai_credits` monthly_allocation 100/period with 7 used this month (unrelated — §1.6A connector fingerprinting is SHA-256 only, no AI credits consumed). First successful `changes.list` after this deploys will walk the backlog since 2026-09-14 (bounded by `SAFE_PAGE_LIMIT`, resumable across runs, single-flighted, idempotent via the ledger) — a real but bounded, low-risk first drain on Arkova's own org.
- **16KB `organization_rule_events.payload` CHECK**: unaffected — the enqueued payload (`org_id`, `file_id`, `parent_ids`, `revision_id`, `integration_id`, `actor_email`) is bounded ids/strings, not document content; unchanged by this PR.

## TLA PreCheck (orchestrator requirement, founder standing rule)

New `machines/driveChangesCursor.machine.ts` — models one integration's cursor lifecycle (`NO_CURSOR → BOOTSTRAPPED → WALKING → {FAILED_PAGE, TOKEN_EXPIRED, ADVANCED}`), the single-flight lease, and the ledger reserve/enqueue/compensate sequence, driven by `webhooks/drive.ts` → `drive-changes-runner.ts` → `drive-changes-processor.ts`. Concurrency (duplicate + overlapping push notifications for the same integration) is modeled by making `pushArrives` independently re-firable rather than via a second domain, mirroring `docusignInboundDedup.machine.ts`'s pattern.

Five invariants map 1:1 to the orchestrator's five numbered requirements — `noRegressionOnFailure` (1), `jobNeverEnqueuedWithoutReservation` (2), `capReleasesResources` (3, see below), `tokenExpiryReleasesLock` (4), `failureAlwaysObservable` (5). **What it does NOT prove, stated plainly**: the DSL has zero arithmetic (no real page counter — `walkProgress` is a 3-valued NONE/PARTIAL/AT_CAP abstraction) and zero temporal/liveness operators (confirmed against the DSL's full 13-expression-kind reference) — so requirement (3)'s "eventually drained" is **not** provable as true liveness here; `capReleasesResources` (a safety invariant proving the cap-reached state always frees the lock and exits WALKING) plus the standard TLC deadlock check (left ON — confirms the full reachable graph never reaches zero enabled actions) is the closest sound abstraction, proving draining **can** always resume, not that it **will**.

Built AFTER the code fixes above were already implemented and unit-tested, so it **confirms** those designs rather than discovering them — `proofPassed: true` on first `check`, no RED→GREEN cycle to report. Mutation-tested for real teeth: dropping the ledger/enqueue guard from `enqueueJobSucceeds` produces a genuine TLC counterexample (`jobEnqueued=TRUE` with `ledgerHasEntry=FALSE` in 5 steps); restoring it returns `proofPassed: true`.

Certificate (tier `pr`, 1 integration): proofPassed **true**; all 5 invariants checked; 268 states generated / 76 distinct, depth 11, deadlock checked, 15/15 actions reachable. `nightly` tier (2 integrations): proofPassed **true**; 40,585 generated / 5,776 distinct, depth 21. `bash scripts/verify-machines.sh` (no filter, all 21 machines including this new one): **PASS 21/21**.

## Test counts

- `oauth/drive.test.ts`: **46/46** (net-new: `listChanges` fields-mask suite, `assertValidFieldsMask` self-tests, `getStartPageToken` suite, `createChangesWatch` exact-URL suite, exact-string augmentation on 3 existing call sites)
- `connectors/drive-changes-processor.test.ts`: **41/41** (net-new: mid-walk/first-page failure non-advance, 400-does-not-trigger-recovery, 410/404 recovery ×2, recovery-itself-fails, 410-mid-walk)
- `connectors/drive-changes-runner.test.ts`: **28/28** (net-new: single-flight locked-skip, lease-released-on-throw, happy-path lease-released assertion)
- `connectors/drive-changes-e2e.test.ts` (new file): **4/4**
- `api/connector-health.test.ts`: **54/54** (net-new: `changes_list_never_succeeded` ×5)
- `api/v1/webhooks/drive.test.ts`: **17/17** (net-new: `ENABLE_DRIVE_CHANGES_RUNNER=true` path had **zero** prior coverage — success, `DriveApiError` structured-log, non-`DriveApiError` structured-log ×3)
- `api/v1/integrations/drive-folders.test.ts`: **14/14** (test-only `config.js` mock fix — no production code changed here; a transitive-import regression from the new `run-lease.ts` dependency, caught and fixed before this PR)
- Full `services/worker` suite: **13,874 passed / 21 skipped**, 1 pre-existing unrelated failure (`ai/zk-proof.test.ts` — requires `npm run build:circuit` compiled artifacts, gitignored, environmental, confirmed unrelated to this change)
- `npx tsc --noEmit` (worker): clean. `eslint --max-warnings 0 src/ "scripts/**/*.ts"` (worker): clean.
- Root: `npm run typecheck`: clean. `npm run lint`: clean (2 pre-existing unrelated warnings elsewhere, 0 errors). `npm run lint:copy`: compliant (0 new violations). `npx tsx scripts/ci/check-doc-pointers.ts`: OK, 1,855 references resolve.

## Tier

`Tier: T2` — confirmed by running `requiredTierFor()` from `scripts/ci/check-staging-evidence.ts` against the real changed-file list: `{ tier: 'T2', reason: 'services/worker/src/api/connector-health.ts — public API surface' }`.

Head SHA: `7ddf6294bf225ec1778f9aac3202c7d88b16b6dd`

## Staging Soak Evidence

**PENDING — no soak run yet.**

Evidence path (orchestrator requirement C) — path (1), a real Google account credential, is required for merge-grade proof; this PR does not claim that proof and has not attempted to fabricate it. Stating both fillable paths honestly:

**Path (1) — real Google credential on a rig (preferred).** Deploy this branch's image to an isolated staging rig, connect a real Google Drive account with a watched folder, drop a real file into that folder, and confirm: `changes.list` 400s drop to **zero** in the rig's logs; a `google_drive.file_changed` job is enqueued; the job drains through `jobs/drive-file-changed.ts` to a `connector_artifact` row; that artifact reaches a **SECURED** anchor with correct file/folder/revision link-back fields, visible in the API response and traceable back to the original webhook payload. This is the merge-grade path — the August Drive soaks on this pipeline were synthetic (no real Google credential), which is documented as part of how this incident survived undetected for months.

**Path (2) — founder-approved residual-risk note + immediate post-deploy prod proof.** If no real Google credential can be placed on an isolated rig before this needs to merge, a founder/CTO-approved residual-risk note stating that gap explicitly, PLUS — immediately after this deploys to prod — capture: `changes.list` 400s dropping to zero in prod logs for the flagged org (`40383eb2-f1cd-4a85-8099-afafff95e5cf`), confirmation that `google_drive.file_changed` jobs are now enqueuing (query `job_queue` for `type='google_drive.file_changed'`, `payload->>org_id`), and at least one real SECURED anchor with file/folder/revision link-back on the record.

Neither path's evidence has been collected as of this PR — this section states the plan, not a completed soak. Do not treat this PR as merge-ready without one of the two paths above filled in.

## Rollback plan

Revert this commit. Flags unchanged (all five Drive flags stay exactly as they are in prod today — this PR does not flip any flag). Reverting restores the pre-fix (broken) `listChanges` behavior — i.e., Drive changes processing returns to its prior all-failing, silently-200-acked state, which is the CURRENT prod state, so a revert is a true no-op relative to today's behavior (not a regression from a previously-working state).

## Jira

SCRUM-2903, SCRUM-3661, SCRUM-5094, SCRUM-2330

🤖 Generated with [Claude Code](https://claude.com/claude-code)
