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

**Extended in the fix round (item 4B)** after an independent TLA + simplify pass reproduced this machine's original certificate exactly, then found a real production bug the original machine couldn't express (see Review record below). The machine now carries **eight** invariants, not five — the original five map 1:1 to the base requirements (`noRegressionOnFailure`, `jobNeverEnqueuedWithoutReservation`, `capReleasesResources`, `tokenExpiryReleasesLock`, `failureAlwaysObservable`); three more were added for the fix round: `noConcurrentWalkers` (a walker that lost its lease can never still land a cursor advance), `cursorNeverRewinds` (a standalone 3-generation G0/G1/G2 CAS sub-model proving `advancePageToken`'s compare-and-swap never lets a stale walker roll back a later commit), and `pendingPushNeverDroppedWhileLocked` (the `{skipped:'locked'}` branch never silently discards a pending push — the safety half of item 3's liveness requirement). Every WALKING-state action now additionally requires `lockHeld[i]`, the model-side expression of the new per-page `stillHoldsLease()` check.

**What it does NOT prove, stated plainly**: the DSL has zero arithmetic (no real page counter — `walkProgress` is a 3-valued NONE/PARTIAL/AT_CAP abstraction) and zero temporal/liveness operators (confirmed against the DSL's full 13-expression-kind reference) — so requirement (3)'s "eventually drained" and item 3's "a pending push is eventually processed" are **not** provable as true liveness here. `capReleasesResources`/`pendingPushNeverDroppedWhileLocked` (safety invariants) plus the standard TLC deadlock check (left ON — confirms the full reachable graph never reaches zero enabled actions) is the closest sound abstraction: it proves draining/resumption **can** always happen, not that it **will** within any bound.

Built AFTER the code fixes above were already implemented and unit-tested, so it **confirms** those designs rather than discovering them from scratch for the original five invariants (`proofPassed: true` on first `check`). The fix-round extension is different: it formally reproduced a bug the verifier found in the code BEFORE the item 4A fix landed, then confirmed the fix closes it. All eight invariants are mutation-tested for real teeth — full RED→GREEN traces recorded in `machines/agents.md`:

- `jobNeverEnqueuedWithoutReservation`: dropping the ledger/enqueue guard produces a genuine TLC counterexample (`jobEnqueued=TRUE` with `ledgerHasEntry=FALSE` in 5 steps); restoring it returns `proofPassed: true`.
- `noConcurrentWalkers`: removing the `lockHeld` conjunct from `pageSucceedsFinal`'s guard (the pre-fix shape) produces a 6-step counterexample ending `cursorState=ADVANCED, lostLeaseWhileWalking=TRUE` — reproduces the verifier's described bug exactly.
- `cursorNeverRewinds`: removing the CAS conjunct from `commitG0toG1ForA`'s guard produces a 4-step counterexample where a stale walker rewinds `persistedGen` from G2 back to G1 after a second walker legitimately reached G2.
- `pendingPushNeverDroppedWhileLocked`: changing `beginRunSkippedLocked`'s update to drop the pending push (the pre-item-3 bug) produces a 6-step counterexample ending `pendingPush=FALSE, pushDroppedWhileLocked=TRUE`.

All four mutations were reverted and re-verified GREEN.

Certificate (tier `pr`, 1 integration, current/final): proofPassed **true**; all 8 invariants checked; 7,019 states generated / 1,210 distinct, depth 16, deadlock checked, `withinBudget: true`. Budget raised (`pr` 100k→2M, `nightly` 10M→500B) to cover the raw variable-product growth from the new variables (1,152 → 248,832). `bash scripts/verify-machines.sh` (no filter, all 21 machines including this one): **PASS 21/21**.

## Test counts (post fix-round, current head)

- `oauth/drive.test.ts`: **52/52** (net-new since the original PR: `driveGrantExcessScopes` unit suite — exact match, subset, `email`/`profile` alias, `openid`, superset, null/undefined/empty — item 5)
- `oauth/drive-fetch-bytes.test.ts`: **16/16** (net-new: item 6's 403-classification suite — every known `KNOWN_DRIVE_FILE_ACCESS_DENIED_REASONS` value, `exportSizeLimitExceeded`, unrecognized-reason fallthrough, unparseable-body fallthrough; original 403 test moved to status 500 since 403 now gets a bounded classified read)
- `connectors/drive-changes-processor.test.ts`: **52/52** (net-new since the original PR: single-flight lease-lost-abort ×several, CAS-miss on final-page/cap-reached, 400+invalidPageToken triggers recovery / bare-400 does not, gap-visibility ×4 — item 4A/2)
- `connectors/drive-changes-runner.test.ts`: **35/35** (net-new: dirty-flag mark/check/clear, second bounded pass on dirty, lease-dirty-then-skip — item 3)
- `connectors/drive-changes-e2e.test.ts`: **4/4** (updated for real CAS semantics — the idempotency test's second run now correctly reports `cursorAdvanceLost: true` on a stale snapshot rather than re-advancing)
- `api/connector-health.test.ts`: **62/62** (net-new: `grant_exceeds_requested` signal ×several — item 5; `file_access_not_granted` signal ×several — item 6)
- `api/v1/webhooks/drive.test.ts`: **17/17** (unchanged from the original PR)
- `api/v1/integrations/drive-oauth.test.ts`: **16/16** (net-new: over-grant guard — exact-match accepted, superset refused + audit event + nothing persisted + userinfo/watch never reached — item 5)
- `api/v1/integrations/drive-folders.test.ts`: **14/14** (unchanged)
- `jobs/drive-subscription-renewal-deps.test.ts`: **27/27** (net-new: reconciliation sweep wiring — runs in the same lease-held pass, failure-isolated, never runs when renewal lease held elsewhere — item 3)
- **Every test file that imports `services/worker/src/jobs/run-lease.ts`** (SHARED infrastructure — checked because the fix-round changes there must be byte-identical for existing lease holders): 19 files, **339/339** — `drive-folders.test.ts`, `drive-changes-runner.test.ts`, `publicRecordAnchor-lease.test.ts`, `publicRecordAnchor-revert-in-filter.test.ts`, `publicRecordAnchor.test.ts`, `run-lease.deadline.test.ts`, `run-lease.test.ts`, `batch-anchor.compliance-chunking.test.ts`, `batch-anchor.intent.test.ts`, `batch-anchor.lease.test.ts`, `batch-anchor.proofs.test.ts`, `batch-anchor.test.ts`, `batch-drain-reconcile.test.ts`, `check-confirmations.lease.test.ts`, `check-confirmations.test.ts`, `drive-subscription-renewal-deps.test.ts`, `leased-chain-jobs.test.ts`, `in-process-cron-audit.test.ts`, `body-read-timeout.test.ts`.
- Full `services/worker` suite: **13,919 passed / 21 skipped**, 1 pre-existing unrelated failure (`ai/zk-proof.test.ts` — requires `npm run build:circuit` compiled artifacts, gitignored, environmental, confirmed unrelated to this change — same failure the original PR reported, count unchanged)
- `npx tsc --noEmit` (worker): clean. `eslint --max-warnings 0 src/ "scripts/**/*.ts"` (worker): clean.
- Root: `npm run typecheck`: clean. `npm run lint`: clean (2 pre-existing unrelated warnings elsewhere, 0 errors). `npm run lint:copy`: compliant (0 new violations). `npx tsx scripts/ci/check-doc-pointers.ts`: OK, 1,860 references resolve.
- `bash scripts/verify-machines.sh` (full 21-machine suite, no filter): **PASS 21/21**.

## Review record

**2026-09-21 — independent code review + debug pass, then an independent TLA + simplify pass, both against this PR (starting head `7ddf6294b`).**

*Code review + debug verdict: SHIP-WITH-FOLLOWUP.* Findings and disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 | Expired-pageToken detection was unverified against Google's real 400-shape behavior (issue tracker 196413673 shows `invalidPageToken` can arrive as a 400, not just 410/404) | **Fixed** — `isInvalidPageTokenError` narrowly parses `error.errors[].reason`/`.message` for the `invalidPageToken` shape; matches 410/404 unconditionally, matches 400 only when the body names the pageToken parameter invalid; a bare 400 (this incident's own bug shape) never matches, preserving self-consistency with the root-cause fix |
| 2 | `result.cursorReset` was computed but never read — a re-bootstrap silently jumps the cursor to "now" and loses whatever changed in the gap, with no visibility | **Fixed** — `recordCursorGap` persists gap start/end to `audit_events` (no migration); both bounds are logged; the post-bootstrap `advancePageToken` call is wrapped so a failed persist is logged as "WIDENING" and rethrown rather than silently widening the gap further |
| 3 | A push arriving while another run holds the lease was dropped (`{skipped:'locked'}`, nothing re-runs) | **Fixed** — a dirty/rerun-requested marker on the same lease row (`job_queue.attempts`, no migration) makes the holder take one more bounded pass before releasing; the hourly `drive-subscription-renewal` sweep now also runs a bounded reconciliation pass (`runDriveReconciliationSweep`) over stale integrations with enabled rules, failure-isolated from the renewal it rides alongside |
| 4 | Lease TTL was flat 10 min with no renewal or `maxRunMs`, unlike every other lease in `run-lease.ts` | **Fixed** — see the TLA findings below; this became a "fix it," not a "justify it," after the independent TLA pass found a real counterexample |
| 5 (SCRUM-5287, P1 security) | Prod holds a 32-scope grant for the one connected org because the OAuth callback persisted whatever Google returned, unchecked | **Fixed** — `driveGrantExcessScopes` compares the granted scope against the requested set (normalizing Google's `email`/`profile` short-alias echo, allowing `openid`); a superset grant is refused before persistence, audited (org id + excess scope **names** only, no token), and surfaced via a new connector-health reason `grant_exceeds_requested` |
| 6 | `drive.file` only covers app-created/Picker-selected files, but Arkova's `DriveFolderPicker` is a custom browser over `drive.metadata.readonly`, never the real Google Picker — so ordinary files 403 on fetch | **Consciously not "fixed" here, per explicit instruction not to change scopes in this PR.** Made loud instead: a 403 is now classified via `extractDriveFileErrorReason` into `DriveFileAccessError`/`DriveExportSizeLimitError` with a distinct connector-health reason `file_access_not_granted`; the doc comment on `DRIVE_DEFAULT_SCOPES` now states the limitation truthfully instead of implying full coverage |

**TLA + simplify pass verdict: PASS-WITH-FOLLOWUP, then confirmed clean.** The pass independently reproduced this PR's original `driveChangesCursor.machine.ts` certificate exactly (same 268/76-state pr-tier numbers), then extended a scratch copy and found a real production bug the original (pre-fix-round) code could not survive: `acquireRunLease`/`releaseRunLease` with a flat, un-renewed TTL lets a healthy-but-slow page walk outlive its lease; a second push then acquires the "expired" lease and walks the same pages concurrently with the first — a genuine concurrent-writer race, not a modeling artifact. The verifier supplied a 7-step TLC counterexample.

Fix landed in `drive-changes-runner.ts` (heartbeat pattern via `withRunLease`, `maxRunMs = 2 × DRIVE_CHANGES_RUN_LEASE_TTL_MS`), `drive-changes-processor.ts` (per-page `stillHoldsLease()` check that aborts without advancing if the lease is lost mid-walk), and a CAS-based `advancePageToken(expected_page_token)` that never rewinds the persisted cursor on a compare-and-swap mismatch. `machines/driveChangesCursor.machine.ts` was extended to formally confirm this fix (item 4B): three new invariants (`noConcurrentWalkers`, `cursorNeverRewinds`, `pendingPushNeverDroppedWhileLocked`), each independently mutation-tested — guard/update reverted to its pre-fix shape reproduces a clean counterexample matching the verifier's own described bug class, then reverted back to confirm GREEN. Full trace detail in `machines/agents.md`'s 2026-09-21 fix-round entry. Final certificate: `proofPassed: true`, all 8 invariants, 7,019 states / 1,210 distinct, depth 16, `withinBudget: true`.

**What remains consciously not fixed, stated plainly (not papered over):** item 6's scope-reality gap (real Google Picker integration) is out of scope for this PR by explicit instruction — it is now loud (`file_access_not_granted`) rather than fixed. The `runDriveReconciliationSweep` bounded per-integration reconciliation loop is NOT separately TLA-modeled (documented in the machine's own CODE↔MODEL MAP as intentionally out of this machine's per-integration scope — it is bounded, best-effort, and already covered by targeted unit tests in `drive-subscription-renewal-deps.test.ts`). Item 3's "eventually processed" requirement is proven only as a safety property (push never silently dropped) plus deadlock-freedom, not as true liveness — this DSL has no temporal operators, stated in both the machine header and above.

## Tier

`Tier: T2` — confirmed by running `requiredTierFor()` from `scripts/ci/check-staging-evidence.ts` against the real changed-file list: `{ tier: 'T2', reason: 'services/worker/src/api/connector-health.ts — public API surface' }`. The fix-round additionally touches `services/worker/src/jobs/run-lease.ts` (shared lease infrastructure) and `services/worker/src/api/v1/integrations/drive-oauth.ts` (OAuth callback) — both still within worker/public-API-surface territory, tier unchanged at T2.

Original PR head SHA: `7ddf6294bf225ec1778f9aac3202c7d88b16b6dd`. Current LOCAL head (fix-round items 1–7 + A–D complete, uncommitted-to-remote per the active push freeze — GitHub Actions budget exhausted as of this update): `c7694b683` — see commit history for the individual checkpoint commits per fix-round item. **This PR has not been pushed since `7ddf6294b`**; the head above is local-only pending the coordinator lifting the freeze.

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
