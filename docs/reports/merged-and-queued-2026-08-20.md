# Arkova: what shipped and what is queued (20 Aug 2026)

_For Carson. Plain English first, technical detail second. Everything below was checked
directly against GitHub, the live `/health` endpoint, the live production frontend bundle,
and the repo's own git history at write time (2026-08-20, ~15:00-15:30 UTC), not assumed
from PR titles or from HANDOFF.md._

## The one-paragraph version

Eleven pull requests merged into `main` in the last 48 hours. Of those, eight were test and
CI-tooling improvements that happened to ride along in the worker's most recent redeploy;
none of them change what the product does for a user. One is a counsel-ordered privacy-copy
fix for Kenya that I independently verified is live on the production website right now. Two
are paperwork (a docs-only staging rebuild record, and a manifest that tracks a still-open
fix). Nothing is currently sitting in the merge queue; every other open PR is still a draft
by design, because the team is mid-way through a 27-PR review campaign, none of which has
been soaked yet. Two rigs are currently busy soaking six of those PRs; that work is untouched
by this report.

---

## 1. Merged in the last 48 hours

Verified via `gh pr list --state merged`, filtered to `mergedAt >= 2026-08-18T16:00Z`, then
cross-checked against `git log` on `origin/main`. Eleven PRs, oldest to newest:

### #2277: bump the secret-scanning tool to its latest version
- **What it does:** Updates the automated tool that scans every commit for accidentally
  leaked passwords and API keys to its newest release.
- **Why it mattered:** Routine maintenance, keeps the scanner able to catch newer types of
  leaked credentials. Not a response to an incident.
- **What changed technically:** Bumped the `trufflesecurity/trufflehog` GitHub Action from
  3.96.0 to 3.97.0 in a CI workflow file. No application code touched.
- **Production:** Not applicable. This is a CI tool, not something that runs in the product.

### #2273: stronger proof that legal documents never reach the AI
- **What it does:** Adds a much stronger automated check making sure we can never
  accidentally let an AI provider read a legal (bar/CLE) document, which our data agreement
  forbids.
- **Why it mattered:** Counsel directly asked, "is there a test that would fail if someone
  removed this protection?" There was one, but it only checked the classifier's answer, not
  that the AI was actually never called. This closes that gap by mocking a real AI provider
  and proving it gets zero calls for a legal document even with the feature flag on.
- **What changed technically:** Two new test suites added to `professional-education.test.ts`;
  the protected production code itself was not touched (confirmed byte-identical to `main`).
- **Production:** Test-only, nothing to deploy. (The commit did ride along in the worker's
  2026-08-19 redeploy, see #2234 below, but a test file has no effect on the running
  service.)

### #2257: an existing code-quality check now actually blocks bad merges
- **What it does:** A check that looks for dead exported code had been running on every PR
  since July 28th, but was never wired to actually stop a merge; it just reported problems
  and let them through anyway. This wires it in.
- **Why it mattered:** A check that can't block anything protects nothing. This closes that
  gap.
- **What changed technically:** Added `check-success = Orphaned Export Lint` to Mergify's
  merge rules. Config-only; the lint logic itself is unchanged.
- **Production:** Not applicable. This changes how PRs merge, not what runs live.

### #2253: closed a real gap in the outage-prevention safety check
- **What it does:** Teaches our "don't freeze the app" safety check to also catch a new
  table quietly pointing a foreign key back at one of our busiest tables, which can cause
  the exact same kind of outage as directly altering that busy table.
- **Why it mattered:** This is literally the failure mode behind the August 11th outage
  (11 minutes 39 seconds of errors on the verification endpoint from one unguarded database
  change). It was found because a currently-open migration (in PR #2219, still unmerged) had
  exactly this shape and slipped past the existing check.
- **What changed technically:** New pattern added to
  `scripts/ci/check-hot-table-ddl-lock-timeout.ts` for `REFERENCES <hot table>`; 34 new/updated
  tests, confirmed it catches the real defect in #2219.
- **Production:** Not applicable directly (it's a CI check), but it protects prod from a
  repeat of the August 11th outage class.

### #2244: turned on testing for a whole folder of code that was never tested
- **What it does:** Our software developer kits (the packages partners use to integrate with
  Arkova) had never actually been run by our automated test system; a broken SDK could pass
  review with nobody noticing. This turns that testing on.
- **Why it mattered:** Closes a blind spot. Also caught two tests that were checking for
  stale, wrong numbers; one asserted the SDK exposes 6 tools when it correctly exposes 10,
  including 4 real compliance tools already live in the product.
- **What changed technically:** New `sdk-tests` CI step running the test suite across `sdks/`;
  corrected the two stale test assertions to match the real, intended tool list.
- **Production:** Not applicable. CI/test-only; no runtime behavior changed.

### #2243: fixed a bug in our OWN testing that was masquerading as product bugs
- **What it does:** Fixed a bug in our automated browser-testing setup where logging out
  ONE test user was accidentally logging out EVERY test user sharing that login, which made a
  large chunk of unrelated tests fail for reasons that had nothing to do with the product.
- **Why it mattered:** Without this, a wave of test failures looks like a real regression and
  can hide an actual one underneath the noise. After the fix, the full suite ran clean
  (313 of 313 tests passing).
- **What changed technically:** Root cause was `supabase-js`'s `signOut()` defaulting to a
  "log out everywhere" scope inside a shared test helper. Scoped it to just the calling
  client.
- **Production:** Not applicable. Test-infrastructure fix only.

### #2268: fixed a flaky test that failed only when the computer was busy
- **What it does:** Fixed a timing bug in our own test tooling that made one test randomly
  fail whenever the machine running it was under load, even though nothing was actually
  broken.
- **Why it mattered:** False failures waste review time and erode trust in what CI is
  telling us.
- **What changed technically:** Raised an internal timeout from 15 seconds (too tight under
  load) to 120 seconds; removed nine per-test timeout overrides that were silently fighting
  the file-level budget.
- **Production:** Not applicable.

### #2234: made our test suite actually runnable outside one laptop, and stopped it from destroying test data
- **What it does:** Fixed two bugs in how our automated browser tests log in and clean up
  after themselves, so the full suite can run against a shared test server instead of only
  ever working on one engineer's own machine, and so a test stops deleting real seeded data
  without putting it back.
- **Why it mattered:** The suite was silently hardcoded to `localhost`, so whole categories
  of tests never actually ran anywhere except one machine. Separately, one test deleted a
  database row it never restored, corrupting later runs.
- **What changed technically:** Derived the login-session storage key and web address from
  the actual configured URLs instead of a hardcoded `sb-127-auth-token` / `localhost:5173`;
  added a restore step for the row a spec was deleting.
- **Production:** **This is the exact commit the live worker is currently running.** I
  confirmed this myself: `curl https://api.arkova.ai/health` right now returns
  `git_sha: b6cfad73c73fbaf45bea08e3b155d61501a49daa`, which is the precise merge commit of
  this PR, and GitHub Actions shows a successful `Deploy Worker` run against that exact commit
  at 2026-08-19T19:04:27Z. **But the change itself only touches test code (`e2e/`)**, nothing
  about how the live service behaves for a real user changed. I traced every commit between
  the prior known-live worker SHA (`f5d1070fc`, 2026-08-12) and this one, and confirmed all
  eight are CI, test, or docs changes; zero behavioral code shipped to the worker since
  August 12th.

### #2285: rebuilt the staging (pre-production testing) database from scratch
- **What it does:** Documents that our staging database had quietly stopped existing (DNS
  lookup failure, 503 error) and rebuilds it on a fresh project, confirmed healthy and in
  exact sync with production's real database structure.
- **Why it mattered:** Without a working staging environment, no new database or backend
  change can be safely tested before it goes live. This restores that capability.
- **What changed technically:** New Supabase project (`fizyjojbebyalirtjjht`); replayed every
  migration to match production; re-pointed the staging worker service at it; fixed a missing
  secret that was crash-looping the freshly redeployed staging worker; confirmed `/health` is
  green. Docs-only PR, no application code changed.
- **Production:** Not applicable. This is entirely about the testing environment, not the
  live product. Explicitly did not touch prod, the soak rig, or any open PR branch.

### #2271: removed an incorrect legal claim shown to Kenyan users
- **What it does:** Stops the app from telling Kenyan users their data is protected under a
  European legal mechanism (Standard Contractual Clauses) that does not actually apply under
  Kenyan law, and corrects a sentence claiming files "never leave your browser" (not fully true for documents pulled in through a connector like Google Drive or DocuSign).
- **Why it mattered:** Legal counsel flagged this as an inaccurate compliance claim and
  ordered it removed the same day it was found, having already told a partner it was being
  fixed. Leaving it live risked misrepresenting our legal protections to users and a partner
  in Kenya.
- **What changed technically:** Deleted the incorrect `KENYA_TRANSFER_BASIS` /
  `KENYA_RIGHTS` / `KENYA_BREACH_TIMELINE` copy fields, replacing them with the same
  "under review by counsel" placeholder already used elsewhere; corrected the Section 3
  privacy wording; corrected on `main` today.
- **Production: LIVE, independently verified today, not just claimed.** Frontend deploys go
  through Vercel, separately from the paused worker pipeline, so this reached production on
  2026-08-18 via a direct Vercel promote, well before it merged to `main` today. I fetched the
  actual JavaScript bundle currently served at `app.arkova.ai` and grepped it myself: the old
  "Section 48" and "Sections 25 to 38" text is gone (0 occurrences), the Kenya-specific rights
  and breach-timeline fields no longer exist in the bundle at all, and the counsel-approved
  placeholder text is present. Today's merge to `main` just catches the repository up with
  what has already been serving live for two days.

### #2221: paperwork that keeps an open fix's audit trail honest
- **What it does:** Files a record saying a fix for a SOC 2 control (API-key revocation
  currently being unreachable, see PR #2220 in the campaign below) is queued for real testing
  once the current freeze lifts, instead of silently skipping the requirement.
- **Why it mattered:** Keeps the audit trail truthful; the record explicitly says "not yet
  proven" rather than being silent about it.
- **What changed technically:** Adds one JSON manifest file pointing at #2220's exact commit.
  No code.
- **Production:** Not applicable: #2220, the actual fix, is still open and unmerged. This PR
  only files the paperwork for it.

---

## 2. Currently queued or ready to merge

**Nothing.** I checked every open PR's draft status and merge labels directly
(`gh pr list --state open --json isDraft,mergeStateStatus,labels`, 40 open PRs total):

- 33 of the 40 are drafts. Mergify (and GitHub) will not queue a draft PR, that is a hard
  rule, not a judgment call.
- The other 7 are all Dependabot dependency-bump PRs, and every one carries a `do-not-merge`
  label, whose own description reads "Blocks Mergify queue entry."

So there is no PR sitting in a merge queue, and none has been "embarked" by Mergify. This
matches the deliberate state described in the team's own wave plan: the whole 27-PR review
campaign is intentionally still in draft because none of it has been soak-tested yet.

---

## 3. Prepared but not yet merged (the review campaign)

This is the batch of PRs the team spent the last several days reviewing and rebasing onto a
common baseline (`main @ b6cfad73c`), grouped by which two testing rigs will exercise them and
in what order. Source: `docs/staging/wave-plan-2026-08-20.md`. **None of this has been
soak-tested yet; every evidence block reads "NOT RUN: soak pending" on purpose.** That is
the honest state, not a gap to be embarrassed about.

Of the plan's original "27 prepared PRs," three (the whole of "Wave 0") already merged today
as the CI-only, no-soak-needed items; they are the last three entries in Section 1 above
(#2285, #2271, #2221). The table below reflects what is left, verified live against GitHub
right now.

### Already soaking: do not touch (out of scope for this report, flagged for awareness only)

| PR | What it's about |
|---|---|
| #2216 | A hung background job could silently disable payment/receipt promotion for every customer, not just the one job. |
| #2250 | A blockchain wallet-balance check was treating "found nothing" the same as "the request failed." It was missing a fallback. |
| #2269 | Consolidated rate-limiter fix: a bug let the same request slip past our per-minute request limits under multi-server load. |
| #2219 | New backend router for the HakiChain partner-onboarding workflow. |
| #2235 | Data-integrity fixes: a locking timeout inside a privileged database function, and two admin dashboards that were returning server errors. |
| #2248 | Repairs missing staging-rig setup instructions and replays some database permission revokes that got lost. |

These six occupy both available testing rigs (`fullsoak` and `standing`) as of today; the
first rig frees 2026-08-21T16:51Z, the second 2026-08-22T14:00Z. Per your instruction, I did
not touch either rig or any of these six PRs while producing this report.

### Wave 1: frontend/config, low risk (2 hour soak, first rig to free)

| PR | Plain-English summary |
|---|---|
| #2241 | Kills a UI flash where a record briefly shows "not found" before the real data loads. |
| #2255 | Renaming a record you don't have permission to rename now fails with a clear error instead of silently doing nothing. |
| #2256 | Removes a confusing duplicate "My Records" view; the Documents page now just links out to the real one. |
| #2275 | Admins can now see pending org invitations they send (no backend bug, just missing visibility). |
| #2215 | Fixes test-data IDs so they're valid under a newer, stricter validation rule (no user-facing effect). |
| #2259 | Scopes every Sentry (error-monitoring) alert rule to only fire in production. Config only, and does not itself turn the rules on. |

### Wave 2: worker/backend, moderate risk (12 hour soak)

| PR | Plain-English summary |
|---|---|
| #2258 | Makes sure error reports sent to our monitoring tool never leak sensitive data nested inside a larger object, not just at the top level. |
| #2270 | Stops a monitoring "check-in" alarm from firing falsely for non-production environments. |
| #2254 | Fixes a monitoring dashboard number that could read as "zero backlog" when there actually was one. |
| #2233 | Stops a data-ingestion pipeline from reporting "success" (HTTP 200) when it actually failed; fixes two specific broken data-source connections. |
| #2267 | Prevents a rare kind of malformed-text database write error across the worker. |
| #2245 | Requests only the minimum Google Drive access we actually need, instead of accidentally inheriting broader permissions. |
| #2211 | Restricts self-serve organization-verification actions to org admins only. |

### Wave 3: worker/backend, moderate risk (12 hour soak)

| PR | Plain-English summary |
|---|---|
| #2272 | Turns on a per-organization activity digest email, skipping orgs with nothing to report. |
| #2276 | Adds a separate, platform-wide daily health summary for internal admins. |
| #2232 | **Fixes a P0-severity bug: an internal audit log had never actually written a single row.** Also fixes a broken UI element and a data-contract mismatch. |
| #2246 | Corrects proof-language wording: a connector-fetched document's fingerprint proves we hashed exactly those bytes, not that the file traces back to its original source. |
| #2220 | Restores the ability to revoke or delete an API key, which was broken (this is the SOC 2 control referenced by #2221 above). |
| #2252 | Finishes fixing a set of mismatches between the Python SDK and what the API actually returns. (Supersedes #2247, which should be closed once this lands.) |
| #2274 | Prep work for publishing our SDKs on npm. Packaging only, not a runtime change. |
| #2230 → #2236 | Improves visibility into why a Google Drive connection attempt was denied, and fixes a related Drive-search and pricing-claim issue. Must land in that order; #2236 is built on top of #2230's branch. |

### Wave 4: higher risk, needs a dedicated rig (48 hour soak)

| PR | Plain-English summary |
|---|---|
| #2249 | One malformed database row could currently stop an entire batch job for every customer; fixes it to skip just the bad row. |
| #2266 | Fixes a specific data-write failure class and adds a safe quarantine path instead of losing the record. |
| #2251 | A rejected quota request was, in a specific case, still being counted against the customer's quota, and could report the wrong number back to them. |

### Held for Carson's decision (per the wave plan, not acted on)

- **SDK-only PRs (#2252, #2274, and the now-superseded #2247)** are automatically graded as
  "moderate risk, needs 12h soak" by the path-based rule, but none of them deploy anything.
  An SDK package has no live runtime to soak. The wave plan is explicitly asking you whether to
  grant an exception, rather than burning rig time proving nothing.
- **Dependabot (7 PRs, all `do-not-merge`):** #2262 (19 production dependency bumps),
  #2263 (11 worker dependency bumps), #2264 (a major version bump to the Google Cloud KMS
  library, touches our currently-dormant hardware-key-signing code path, flagged as needing
  real review, not a rubber stamp), #2260/#2261 (Cloudflare edge tooling), #2279 (a small,
  low-risk id-generator bump). None of these are moving without your say-so.

---

## How this was verified

- **Merged-PR list:** `gh pr list --state merged`, filtered on `mergedAt`, cross-checked
  against `git log --oneline` on `origin/main`.
- **Open-PR / queue state:** `gh api repos/.../pulls --paginate` (40 open, 7 non-draft, all 7
  Dependabot with `do-not-merge`), plus the `do-not-merge` label's own stated effect
  ("Blocks Mergify queue entry").
- **Production worker state:** `curl https://api.arkova.ai/health` read directly (returned
  `git_sha b6cfad73c73fbaf45bea08e3b155d61501a49daa`), cross-checked against the GitHub
  Actions run history for `deploy-worker.yml` (successful run at that exact SHA,
  2026-08-19T19:04:27Z), cross-checked against `git merge-base --is-ancestor` for each of the
  eight PRs claimed live in Section 1. `DEPLOY_WORKER_PAUSED` confirmed `true` via
  `gh variable get` (last changed 2026-08-19T19:26:45Z, after that deploy).
- **Production frontend state:** fetched the live `app.arkova.ai` JavaScript bundle directly
  and grepped it for the specific strings the Kenya fix (#2271) claims to have removed/added,
  rather than relying on the PR's own evidence block.
- **Wave plan:** read directly from `docs/staging/wave-plan-2026-08-20.md` on this branch.

Nothing in this report touched either soak rig, the six soaking PRs, or made any merge/ready
state change. The only write action taken was this file.

_Compiled 2026-08-20 by Claude, for Carson._
