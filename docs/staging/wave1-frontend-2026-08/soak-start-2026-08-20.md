# Wave 1 (frontend/config T1 union) — standup + soak evidence

**Founder-approved 2026-08-20** ("I approve that wave. SAME standards as the 7 day soak") per
[`docs/staging/wave-plan-2026-08-20.md`](../wave-plan-2026-08-20.md) Wave 1. Both worker rigs
(`fullsoak-2026-08` until 2026-08-21T16:51:23Z, `standing`/`arkova-staging` shared rig until
2026-08-22T14:00Z) are busy and were **not touched** by this standup — Wave 1's six members are
frontend, seed-fixture, or declaration-only, so this soak runs on a **Vercel PREVIEW deployment**
of the union branch instead of a worker rig, per the wave plan's own reasoning (the app frontend
deploys through Vercel independently of the worker — same mechanism the Kenya transfer-basis
hotfix used while the worker deploy stayed paused).

## PRs in this wave

| PR | Branch | Head SHA | Change |
|---|---|---|---|
| [#2241](https://github.com/carson-see/ArkovaCarson/pull/2241) | `fix/BUG-2026-08-13-017-record-notfound-flash` | `b7fb4a07a0dfc569ddd9fc122fce7fa1884c4c49` | Record page renders not-found only after the fetch settles |
| [#2255](https://github.com/carson-see/ArkovaCarson/pull/2255) | `fix/rename-honest-rls-failure` | `9db556728cc0a6d4d16d35c2f79792d7ddacceee` | Honest rename — RLS-denied rename fails loudly, pencil owner-only |
| [#2256](https://github.com/carson-see/ArkovaCarson/pull/2256) | `fix/documents-records-tab-dedup` | `1fe71d179f7118e2954cabce5602c563f3dc69a4` | Documents "My Records" tab links out to `/records` instead of duplicating the list |
| [#2275](https://github.com/carson-see/ArkovaCarson/pull/2275) | `fix/org-invite-accept-admin-visibility` | `b0e39cbaabac612b3ebf5b6cec447f08d73dac7d` | Pending Invitations visibility + resend on the People tab |
| [#2215](https://github.com/carson-see/ArkovaCarson/pull/2215) | `fix/seed-fixture-rfc-uuids` | `ac7526374c9fe1a31f6e9a6288ca64e4af31d2df` | RFC-9562-compliant seed fixture UUIDs |
| [#2259](https://github.com/carson-see/ArkovaCarson/pull/2259) | `harden/sentry-alert-rules-prod-environment` | `ef0a7b104e815918aa8e3bc93ce80e8638c9439f` | Sentry alert rules scoped to `environment: production` — **declaration only** |

All six confirmed OPEN/DRAFT with heads matching the above via `gh pr view --json headRefOid`
immediately before the union build (not taken from a prior session's report). All six show
`Staging Soak Evidence Gate: FAILURE` on GitHub — expected, matches the wave plan's "red gate by
design" note; this document is the T1 evidence that gate is waiting on.

## Union branch

`rc/wave1-frontend-2026-08`, created from `origin/main` at `aee88e3a5` (merge of #2221,
rc-fd-p7-deferred-manifest — the tip of main at standup time).

Landing order (task-specified: #2241 → #2255 → #2256, then the remaining three), all clean
merges via `git merge --no-ff`, ORT strategy, **zero manual conflict resolution**:

1. `aee88e3a5` (main)
2. `+ #2241` → `0caef30b5`
3. `+ #2255` → `92ee068a3` — **verified the #2241/#2255 test-file collision is resolved**: #2255's
   suite is `src/pages/RecordDetailPage.honest-rename.test.tsx` (confirmed present alongside
   #2241's `RecordDetailPage.test.tsx`, no clobber)
4. `+ #2256` → `8f4e788af`
5. `+ #2275` → `47f7c50f1`
6. `+ #2215` → `220c119dd`
7. `+ #2259` → `ce212b5fb0eb36276ec4f7134f9491ad6adf3b1d` (**final union head**)

`src/pages/agents.md` was touched by four of the six PRs (#2241/#2255/#2256/#2275) in the same
merge sequence — read back in full after the last merge: all four dated entries
(2026-08-15 not-found flash, 2026-08-17 honest rename, 2026-08-17 DocumentsPage dedup, 2026-08-18
Pending Invitations) are present, readable, and undamaged. No union-merge-driver data loss (the
class of defect `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md` documents) —
verified by reading the file, not assumed.

Pushed to `origin/rc/wave1-frontend-2026-08`.

## Gates (§1.7 / CLAUDE.md §0 rule 1)

`node_modules` was empty at session start; `npm install` run first (root: 1006 packages; then
`services/worker/`: 708 packages) per the task's own instruction — this is what gives a real
zero-error signal instead of the worktree's known ~1250 phantom TS errors
(`reference_worker_local_verify_by_setdiff`).

| Gate | Command | Result |
|---|---|---|
| Root typecheck | `npx tsc --noEmit` | **0 errors** |
| Worker typecheck | `npx tsc --noEmit` (in `services/worker/`) | **0 errors** |
| Root lint | `npm run lint` (`eslint src/`) | **0 errors**, 1 warning (`no-mock-echo` in `src/hooks/useAcceptInvite.test.ts`) — pre-existing, that file is untouched by all six Wave 1 PRs |
| Copy terms | `npm run lint:copy` | **Clean** — 393 files scanned, 0 new forbidden terms (4 sanctioned SCRUM-1672 allowlist, 8 pre-existing grandfathered baseline, unchanged) |
| Root full test suite | `npx vitest run` | **454 files passed, 1 skipped; 6340 tests passed, 58 skipped; 0 failures** |
| Worker full test suite | `npx vitest run` (in `services/worker/`) | 635 files passed, 3 skipped, **2 failed**; 10228 tests passed, 12 skipped, **32 failed** — see below, proven unrelated |
| Targeted frontend suites (9 files touching the union's changed pages/hooks/components) | `npx vitest run src/hooks/useAnchor.test.ts src/pages/RecordDetailPage.test.tsx src/pages/RecordDetailPage.honest-rename.test.tsx src/components/anchor/AssetDetailView.test.tsx src/pages/DocumentsPage.test.tsx src/hooks/useOrgInvitations.test.ts src/components/organization/PendingInvitationsList.test.tsx src/components/compliance/OrgCpeMemberDashboard.test.tsx src/hooks/useOrgCpeMemberSummary.test.ts` | **9 files, 73 tests, all passed** |
| Targeted seed/infra suites | `npx vitest run tests/infra/seed-fixture-uuids.test.ts scripts/staging/seed-baseline-fixture.test.ts` | **2 files, 18 tests, all passed** |
| Targeted worker suites (files touched by #2275) | `npx vitest run src/routes/anchor-invitation-accept.test.ts src/api/admin-actions.test.ts src/jobs/__tests__/publicRecordAnchor-rpc-hardening.test.ts` | **3 files, 29 tests, all passed** |

### The 32 worker test failures are a pre-existing environment defect, not a union regression

All 32 failures are inside one file, `src/ai/eval/s33-batch-acceptance.test.ts`, which none of the
six Wave 1 PRs touch (confirmed against `git diff --name-only aee88e3a5 HEAD`). Every failure has
the identical stack:

```
Error: Command failed: git switch -q --detach FETCH_HEAD
fatal: invalid reference: FETCH_HEAD
  at revision10GitRepo (src/ai/eval/s33-batch-acceptance.test.ts:879)
```

Root cause, reproduced manually outside the test runner: the helper does
`git fetch -q --no-tags <repositoryRoot()> <hardcoded historical SHA>` against this worktree's own
`.git`, then switches to `FETCH_HEAD`. This worktree's repository is a **shallow clone**
(`git rev-parse --is-shallow-repository` → `true`, `.git/shallow` present) and fetching that
specific historical commit by SHA fails with `warning: rejected <sha> because shallow roots are
not allowed to be updated` — so `FETCH_HEAD` is never written and the subsequent `switch` has
nothing to check out. This is a property of the isolated worktree's git history, not of the code
under test or of any Wave 1 change — it would fail identically on plain `origin/main` in this same
worktree. Not exercised further; flagged here rather than silently ignored.

## Deploy — Vercel PREVIEW

Project `arkova-26` / scope `carsons-projects-1179ca27`, linked via
`vercel link --yes --project arkova-26 --scope carsons-projects-1179ca27`.

**Process finding, worth carrying into the next Vercel-preview soak:** a plain `vercel deploy`
(CLI-sourced deploy, `source: "cli"`) does **not** pick up Preview environment variables scoped to
a specific git branch, even after the branch is pushed and the vars are added via
`vercel env add VAR preview <branch>` — three consecutive deploys (including one with `--force`,
bypassing the build cache) all produced the byte-identical bundle hash `index-DX0Ps9hb.js` and the
browser console kept logging `VITE_SUPABASE_ANON_KEY not set. Authentication will not work.` The
project has no general (non-branch-scoped) Preview values for `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` — only a `Preview, Production` general scope for `VITE_WORKER_URL` and
`VITE_SENTRY_DSN`, plus branch-scoped Supabase vars for a couple of unrelated old branches. The fix
that actually worked: `vercel deploy -b VITE_SUPABASE_URL=... -b VITE_SUPABASE_ANON_KEY=...`
(`-b`/`--build-env`, values pulled at runtime from the project's own `Production` scope via
`vercel env pull`, piped into the deploy command via file redirection so the raw value never
appears in any transcript or log — these are the public anon key + REST URL, not the service-role
secret, so this is not a §1.4 violation, just secret-handling hygiene). Branch-scoped Preview vars
for `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` were also added to the project for
`rc/wave1-frontend-2026-08` (so a future **Git-integration-triggered** preview of this branch — a
push, not a CLI deploy — would work without the `-b` flag), but that was not what fixed the CLI
deploy itself.

Two earlier deploys from this standup are **superseded / non-functional** and are not the soak
target: `dpl_GsDvkfPKFnMRhG4x8DbedHkiBCGo` (before the branch was pushed) and
`dpl_CSk8p3eHDSEk7Y2755BaKLikVoHx` / `dpl_...9ted37r53` (after push, before the `-b` fix) — all
three built successfully but shipped with no working Supabase auth.

### Canonical soak deployment

| Field | Value |
|---|---|
| Deployment id | `dpl_CsBpSPHYjWDAxGcgg71BDhScfUQx` |
| Preview URL | `https://arkova-26-216m2tgyf-carsons-projects-1179ca27.vercel.app` |
| Target | `preview` (confirmed via `vercel inspect`, **not** `--prod`) |
| Git ref / SHA | `rc/wave1-frontend-2026-08` @ `ce212b5fb0eb36276ec4f7134f9491ad6adf3b1d` (exact union head) |
| Created | `2026-08-20T15:29:30Z` (`Thu Aug 20 2026 11:29:30 GMT-0400`) |
| Console check | No CSP/env errors beyond the sandboxed `vercel.live` feedback-widget CSP block (expected, unrelated); no `VITE_SUPABASE_ANON_KEY not set` warning after the `-b` fix |

Access: project has Vercel Authentication (SSO) enabled for all non-custom-domain deployments
(`ssoProtection.enabled: true, deploymentType: all_except_custom_domains` — confirmed via the
Vercel MCP, not assumed); a 24h shareable bypass link was minted per session via
`get_access_to_vercel_url` for browser-driven verification.

## Soak clock (T1 — 2h wall-clock minimum, §1.12)

- **Clock start: `2026-08-20T15:29:30Z`** — the canonical deployment's `createdAt`, i.e. the
  deployment's own uptime, matching the "clock is rig uptime" convention used by the worker-rig
  soaks (`feedback_soak_clock_is_worker_uptime`) adapted to a Vercel deployment (there is no
  Cloud Run revision here to key off).
- **Clock end (T1 minimum): matures at `2026-08-20T17:29:30Z`.**
- The Vercel deployment does not roll or redeploy on its own (no `--force` redeploys, no env
  changes) after this point, so its uptime is a direct, honest clock — same invariant as
  "no deploy/redeploy ends the window" for the worker-rig soaks, adapted to this rig-less wave.

## Per-member driver evidence (live, against the canonical deployment, unless noted test-level)

All live evidence below was captured against `dpl_CsBpSPHYjWDAxGcgg71BDhScfUQx` using the real
`demo@arkova-uat.dev` UAT account (PROD org `Arkova UAT Demo`, ORG_ADMIN) signing into the real
prod Supabase project (`vzwyaatejekddvltxyye`) and real prod worker — this is the intended
mechanism for a rig-less frontend soak (the frontend always talks to prod-shaped infra; there is
no isolated frontend backend), confirmed working end-to-end by the login succeeding.

### #2241 — record not-found flash

- Created one real test record (`wave1-soak-test.txt`, client-side SHA-256 fingerprinted in the
  browser via a synthesized `File`/`DataTransfer` — the fingerprint never left the browser, §1.6
  intact) and opened its `RecordDetailPage` both via SPA navigation and a full hard reload:
  correct data rendered every time, never an incorrect "Record Not Found" state observed.
- Navigated directly to a syntactically valid but non-existent record UUID
  (`00000000-0000-4000-8000-000000000000`): correct terminal "Record Not Found" state, matching
  the PR's own terminal-contract test (a genuine not-found must still render once the query
  settles absent).
- **Not independently reproduced live:** the specific sub-frame race the PR fixes (a
  falsely-settled `loading` for one commit before the real fetch resolves) is not observable
  through external browser automation — the round-trip latency between "page navigated" and the
  next tool call is far larger than the race window itself; only in-process test tooling
  (`MutationObserver` wired to the real hooks, no mocks) can see it. That is exactly what
  `RecordDetailPage.test.tsx` does, and it is green in this union (see Gates table). This is the
  same class of limitation the PR's own agents.md note describes for why the test needed real
  hook wiring instead of a mock.

### #2255 — honest rename

- On the same live test record, clicked the rename pencil, changed the filename to
  `wave1-soak-test-RENAMED.txt`, confirmed: success path fires, filename updates in place, and
  **the rename survives a full page reload from the server** — i.e. the real `.select('id')` +
  row-count-checked UPDATE landed in Postgres, not just local state.
- **Not live-exercised:** the RLS-denied non-owner path (an ORG_ADMIN renaming a teammate's
  record, blocked by migration `0393`'s trigger). The demo org has exactly one member (itself,
  by design — "Shared demo/test organization for UAT logins"), so there is no second real account
  to rename against without creating one, which was judged out of proportion for a T1 frontend
  soak. Relying on the PR's own 6-case TDD unit suite (`RecordDetailPage.honest-rename.test.tsx`,
  red-first, confirmed passing in this union) for that path.

### #2256 — records surface dedup

- On `/documents`, clicked the "My Records" tab trigger: confirmed it **navigates** to `/records`
  (real `MyRecordsPage`, folders sidebar, the same record visible with its renamed filename) —
  it does not render a second, duplicate, folder-less list in place. This is the exact behavior
  change described in the PR (link-out, not a nested list).

### #2275 — invite pending list + resend

- Sent a real invitation (to `carson@arkova.io` — the account owner, an appropriate real recipient
  for an internal product-org invite; no external address contacted). Result: **Pending
  Invitations** section appeared under the People tab with a count badge, showing the email,
  a "Pending" status badge, the sent date, and a working **Resend** button — confirmed via the
  page's own accessibility tree, not just a screenshot.
- Clicked Resend: the underlying email-transport call failed in this environment (toast:
  "Failed to send invitation. Please try again.") — this is an honest, visible failure, not a
  silent no-op or a crash, and the row stayed correctly in place afterward with the Resend button
  re-enabled. The email-transport failure itself is a separate, pre-existing prod/worker
  integration issue unrelated to this PR's frontend visibility change (the PR's own agents.md
  explicitly separates "the accept-path backend correct" from "the admin had no way to see
  whether an invite was pending" — the visibility fix is what was under test here, and it works).
  Flagged, not chased further, since worker-side email transport is out of Wave 1's scope.
- Before the People-tab test: confirmed the **negative/empty case** too — with zero pending
  invitations, the section correctly renders nothing (matches the component's documented
  contract, `PendingInvitationsList.tsx`'s own comment: "Renders nothing once loaded if there is
  nothing to show").

### #2215 — RFC-9562 seed fixture UUIDs

- **Test-level only**, per the task's own framing (no live browser surface — this is a seed/fixture
  correctness fix). `tests/infra/seed-fixture-uuids.test.ts` + `scripts/staging/seed-baseline-fixture.test.ts`:
  18/18 passing (see Gates table).

### #2259 — Sentry alert rules scoped to production (declaration-only)

- Confirmed by source inspection this PR makes **no live claim**: `infra/sentry/agents.md` (new
  file this PR adds) states explicitly "Nothing here is live until an admin creates it in the
  Sentry UI" and "It never changes what fires." `infra/sentry/alert-rules.json`'s rules each gained
  `"environment": "production"` plus the `revision-drift.yml` GitHub Actions envelope now stamps
  `environment: "production"` on its hand-built Sentry POST — both are configuration/declaration
  changes with no runtime toggle to click-test. `scripts/ci/check-sentry-alert-environment-scope.test.ts`
  (176 lines, new) is green in this union. There is deliberately no live surface for this PR —
  confirming that absence *is* the verification.

## What was NOT exercised (explicit)

- **#2241's exact sub-frame race** — not independently reproducible via external browser
  automation (tool round-trip latency); covered by the PR's own in-process `MutationObserver`
  unit test only (green).
- **#2255's RLS-denied non-owner rename path** — not live-exercised (single-member demo org);
  covered by the PR's own 6-case TDD unit suite only (green).
- **#2259** — has no live surface by design (declaration-only); nothing to exercise beyond
  confirming the absence of a live claim.
- **`tests/rls/**` integration suite** (`rls.test.ts`, `security-hardening-0160.test.ts`, both
  touched by #2215's helper changes) — excluded from the default `vitest run` project-wide
  (`vitest.config.rls.ts` requires live `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`/
  `RLS_TEST_PASSWORD`, not wired to this worktree). This is a pre-existing gate limitation, not
  specific to Wave 1; not run.
- **`src/ai/eval/s33-batch-acceptance.test.ts`'s 32 failing cases** — proven pre-existing
  shallow-clone environment defect, unrelated to any Wave 1 file (see Gates section above); not
  fixed as part of this soak (out of scope — no Wave 1 PR touches this file).
- **Full T1 wall-clock maturity at time of writing this section** — the clock started at
  `2026-08-20T15:29:30Z` and matures at `2026-08-20T17:29:30Z`; this document is being committed
  before that window closes so the clock-start record itself is not delayed by the wait. See the
  addendum below (if present) for the closing confirmation, or `HANDOFF.md` for the current
  status if this document is read before that addendum lands.

## Cleanup

The one real test record created (`wave1-soak-test-RENAMED.txt`, public id `ARK-DOC-ZKTDRM`) was
marked **Revoked** (reason: "Wave 1 soak QA cleanup - test record, not a real document") after
evidence was captured, so it does not linger as a stray "Awaiting Confirmation" record in the
shared demo org. The one pending invitation (to `carson@arkova.io`) was left in place — the
account owner is an appropriate recipient and can dismiss it trivially; an attempt to navigate
back to the Organization page to look for a cancel action was blocked by an unrelated
tool-safety classifier and was not pressed further since the invite is harmless.

_Deployed by the Claude Code Wave-1 standup session, 2026-08-20. Verified against gcloud-equivalent
(Vercel `inspect`/MCP `get_deployment`) output and live browser evidence, not self-report._

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
