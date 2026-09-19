# agents.md — e2e/

## UAT-22 invitation list browser probe (2026-09-14)

The opt-in `uat22-platform-invite.spec.ts` distinguishes mocked GET list responses from POST create responses and checks that the sent invite appears after refresh at 1280px and 375px. This is browser transport/rendering coverage with real fixture auth, not live worker/DB proof. The real mounted-router counterpart is `services/worker/src/api/admin-invitations.local.test.ts`; both remain explicit local runs with fixture prerequisites. No skip was removed.

_Last updated: 2026-09-13 (`ner-dev-load.spec.ts` added)._

## 2026-09-13 — `ner-dev-load.spec.ts` / `ner-dev-load.config.ts` (new)

Pins the founder-reported "Secure Document Continue is broken" regression at
its real layer: `src/lib/nerPiiDetector.ts`'s bundle loader, not
`SecureDocumentDialog.tsx` (see `src/lib/agents.md` for the full mechanism).
Run with `-c e2e/ner-dev-load.config.ts`. No seeded account or Supabase
needed. Like `secure-dialog-layout.spec.ts`, this MUST run against a real
`vite dev` server, not vitest/jsdom — the defect is in how Vite's dev server
serves a `/public` asset requested via `import()`, which jsdom cannot
reproduce. Drives `__loadRealTransformersModuleForE2E` (the real loader,
never `__setTransformersLoaderForTesting`) against the real vendored
`public/vendor/transformers.bundle.min.js`; stops at "module loaded" rather
than running full on-device inference, since backend/WASM/WebGPU selection is
a separate concern from the bundle-loading bug this fix addresses.

## 2026-09-13 SCRUM-4989 — `uat-pr2840.spec.ts` was NOT actually excluded from CI; it self-skips now

The 2026-09-12 note below documented the *intent* that this file never runs under the
shared suite, but nothing enforced it: `playwright.config.ts`'s `testIgnore` only names
`oauth-email-confirmation.spec.ts`, and `ci.yml`'s "Run E2E tests" step is a bare
`playwright test --project=chromium` with no file filter, so its default `testDir: './e2e'`
glob picked this file up anyway. PR #2840's CI run (34741690944, head 647ca9cac) failed the
"E2E Tests" job on exactly this: every authenticated/profile-reading case (`:179`, `:199`,
`:224`, `:282`, both viewports) timed out ~16-17s on its first
`toBeVisible({ timeout: 15_000 })`/`.poll()` against `npm run dev` on :5173 with the `setup`
project's real seed-user `storageState` already loaded — an environment this spec was never
written for (it wants `vite preview` on :4173 with a clean context). Only the static
`/how-it-works` JSON-LD case, which reads no profile data, passed.

Fix (T0, e2e/-only): the spec now self-enforces the boundary instead of relying on the shared
config to keep excluding it. `uat-pr2840.config.ts` declares no `projects`, so it runs as one
anonymous (empty-name) project; every project in `playwright.config.ts` is named
(`chromium`/`firefox`/`webkit`/`mobile-*`/`setup`). A file-level `test.beforeEach` calls
`test.skip(testInfo.project.name !== '', …)`, so a run under the shared config reports these
tests skipped (green) instead of failing, while `npx playwright test e2e/uat-pr2840.spec.ts
--config=e2e/uat-pr2840.config.ts` is unaffected (project name `''`). Adding the file to
`testIgnore` in root `playwright.config.ts` would also fix the CI failure but was rejected for
this change: it is a non-`e2e/` config edit, and the tier detector
(`scripts/ci/check-staging-evidence.ts`) does not carve `playwright.config.ts` into T0. If a
future edit ever adds `projects` to `uat-pr2840.config.ts`, give it an empty-string project
name (or update this guard) — do not let the name collide with a shared-config project name.

## 2026-09-13 — `uat-suborg-ux.spec.ts` (sub-organisation UAT capture)

Same shape and the same boundary as `uat-pr2840.spec.ts`: its own
`uat-suborg-ux.config.ts` with **no `projects` array**, so its one implicit project has an empty
name, and a file-level `test.beforeEach` skips whenever `testInfo.project.name !== ''`. That is what
stops the shared `playwright.config.ts` glob (`testDir: './e2e'`, no `testMatch`) from running it
against `.env.test` and a real rig.

Differences from the 2840 capture worth knowing:

- it drives `npm run dev` on **:5173**, not `vite preview` on :4173 — there is no build step, so the
  loop is fast enough to re-shoot after each fix;
- it stubs **both** Supabase and the worker (`page.route` on `http://localhost:3001/**`), because the
  panel under test is worker-backed, not PostgREST-backed;
- it is parameterised so ONE spec reproduces both sides of the change:
  `SUBORG_UAT_OUT` picks the output directory (default `after`) and `SUBORG_UAT_TAB` picks the tab
  the panel is expected on (default `affiliates`, `settings` for a pre-fix checkout).

It also writes `discoverability-<width>.json` — the measured pixel offset of the panel heading
inside AppShell's scrolling column. That number, not a screenshot, is the evidence for the founder's
"clunky" complaint, and it is worth re-measuring rather than re-arguing whenever someone proposes
moving the panel again.

**There is still no CI-suite e2e coverage of the sub-org flow.** There never was; adding it needs a
real Supabase project with a seeded parent/child pair and an affiliation row, which a UAT capture
deliberately does not touch. Do not mistake this file for that gate.


## 2026-09-12 SCRUM-4989 — `uat-pr2840.spec.ts` runs OUTSIDE the CI suite

`uat-pr2840.spec.ts` + `uat-pr2840.config.ts` are a one-off T1 UAT capture for PR #2840,
deliberately **not** part of `npm run test:e2e`. They carry their own config because the repo
config loads `.env.test`, runs `auth.setup.ts` against a real Supabase project, and pulls in all
of `e2e/` — this capture must touch no rig. It drives a local `vite preview` build with every
Supabase call stubbed via `page.route` and a session injected at the `sb-127-auth-token`
localStorage key (see `helpers/supabase-storage-key.ts` for why that key has to be exact).

Its hostile/safe pair is the pattern worth copying: a capture that proves something does NOT
render is worthless without the control showing the same code path DOES render legitimate values.

Evidence and reproduction steps: `docs/uat/pr-2840/README.md`.


## 2026-09-12 — SCRUM-4507: the Drive record-detail fixture MUST be written with the service client

`record-detail.spec.ts` gained a Google Drive block mirroring the DocuSign one. Its `beforeAll`
writes `metadata` through `serviceClient`, and that is load-bearing rather than incidental:
migration 0423's trigger strips `connector_source` from any write by a non-`service_role` caller.
A fixture written as the user would produce a record with no marker, hence no chips — and the spec
would pass while testing nothing. Same reason the DocuSign block above uses the service client.

## 2026-09-08 — every failed E2E job used to discard its own evidence

`playwright.config.ts` set `reporter: process.env.CI ? 'list' : 'html'`. The `list`
reporter never creates `playwright-report/`, so ci.yml's E2E job step "Upload
Playwright report" (`if: failure()`, `path: playwright-report/`) had been uploading
NOTHING since it was added. Not a silent no-op either — the job log says so out loud:

```
##[warning]No files were found with the provided path: playwright-report/. No artifacts will be uploaded.
```

(run 34176908799 attempt 1, PR #2496, 2026-09-08T02:35:14Z — the same job whose log
names `trace.zip`, `test-failed-1.png` and `error-context.md`, none of which survived).
That is why the MFA enrollment flake (PR #2691) had to be root-caused from the raw job
log instead of the trace.

CI now runs `[['list'], ['html', { open: 'never' }]]`: the streaming per-test output is
unchanged, and the HTML reporter additionally embeds the `test-results/` attachments —
trace, failure screenshot, error-context ARIA snapshot — into `playwright-report/data/`,
which the existing upload step then carries. No workflow change was needed. `open: 'never'`
stops the reporter trying to launch a browser on the runner.

**Verified by reproduction, not by inspection:** one deliberately-failing spec run under
`CI=true` produces no `playwright-report/` on the old config and a 2.0 MB / 22-file report
containing the `.zip` trace, the `.png` and the `.md` error-context on the new one.

**Do not "simplify" this back to a single reporter string.** `list` alone is what broke it,
and `html` alone loses the streaming per-test lines that make a long E2E job readable while
it runs. `playwright-report/` is gitignored (`.gitignore` line 194).

## 2026-09-03 — MFA enrollment/challenge spec + `helpers/totp.ts` + `helpers/mfa.ts` (SCRUM-3167 / SCRUM-3584)

New `e2e/mfa-enrollment-and-challenge.spec.ts`, plus two new helper modules, covering the
Settings-page 2FA rewrite (`TwoFactorSetup.tsx`, `src/components/auth/agents.md`) and the
login-time MFA gate being built in parallel on the sibling branch
`security/mfa-enforcement-3167` (`AuthGuard` / `MfaChallenge` / `MfaEnrollmentRequired` /
`MfaGraceNudge` / `src/lib/mfaPolicy.ts`). **Written against that branch's agreed test-id
contract before it merged — not executed against a live stack this session** (no dev server /
local Supabase reachable here; another session owns the shared local stack per
`project_local_supabase_shared_project_id`). Run it for real at integration once both branches
land, before citing it as merge-grade evidence.

**Fully self-contained — no `SEED_USERS`, no `.auth/*.json`.** The MFA-3167 soak rig
(`fizyjojbebyalirtjjht`) has none of the usual seed users (`demo-admin@arkova.local` /
`demo-user@arkova.local` / `sarah@arkova.ai` are all absent there), so every scenario creates
its own disposable user (and, where needed, its own disposable org) via the service client and
logs in through the real `/login` UI. The spec sets its own empty
`test.use({ storageState: { cookies: [], origins: [] } })`, so it never depends on the `setup`
project's saved sessions either. **Item 36 correction (PR #2637 review):** every checked-in
project in `playwright.config.ts` declares `dependencies: ['setup']` — there is no
`dependencies: []` project in this repo. In CI, this spec therefore still runs under `setup`
and pays for seed-user logins it never reads (harmless waste, not a correctness issue, since
the empty storageState override above means it never touches `.auth/*.json` regardless).
Against a rig with NO seed users at all (e.g. the MFA-3167 soak rig, which has none of the
usual seed users), run it with a config whose project has `dependencies: []` instead — the
soak harness ships one outside this repo.

- **`helpers/totp.ts`** — dependency-free RFC 6238 TOTP (`base32Decode`, `totp`; SHA-1, 6 or
  8 digits, 30s step; only `node:crypto`, no new npm dependency). Ported from a CTO-session
  scratchpad script proven against the RFC 6238 Appendix B vectors. `e2e/` is **not** in
  `vitest.config.ts`'s `include` globs, so the vector re-assertions live as a Playwright
  `test.describe('totp helper')` block inside the new spec, not a `.test.ts` file — that block
  needs no `page` fixture and no live stack, so it is the one part of the spec that genuinely
  could run standalone. Item 26 (SonarCloud typescript:S8786, PR #2637 review): the base32
  cleanup no longer trims trailing `=` padding with a regex quantifier anchored at the end
  (`/=+$/`, flagged for potential super-linear backtracking) — `stripTrailingBase32Padding()`
  does a plain backward character scan instead (no backtracking, O(n) in the padding length).
  Behaviourally identical; re-verified against the RFC vectors after the change.
- **`helpers/mfa.ts`** — `createDisposableUser`/`deleteDisposableUser` (same idiom as
  `withProfileSession` in `helpers/profile-session.ts`: `auth.admin.createUser()` then an
  **explicit** `profiles` upsert — never assume an `auth.users` trigger populates it),
  `createDisposableOrg`/`deleteDisposableOrg` (a throwaway `organizations` row — needed because
  `RouteGuard` sends an ORG_ADMIN with a NULL `org_id` to `/onboarding/org`, never `/dashboard`;
  only `display_name`/`legal_name` are required on that table, everything else defaults safely
  and `hipaa_mfa_required` defaults `false`), `loginViaUi` (drives the real `/login` form via
  the `#email`/`#password` locators from `auth.setup.ts` — unlike `createProfileSession`'s
  storageState injection, these specs need a real login because that's what the AuthGuard MFA
  gate runs on), `setEnforceDateOverride` (writes `arkova_mfa_enforce_from_override` via
  `page.addInitScript` so it's present before the app's first script runs),
  `readSecretFromSettings` (reads `twofactor-secret` on `/settings`),
  `submitTotpCodeWithBoundaryRetry` (item 23/A2-6, PR #2637 review — guards the RFC 6238 30s
  step boundary: computes the code as late as possible, nudging forward one step if within 3s
  of the boundary, and retries EXACTLY ONCE — waiting out a full step first — if the server
  rejects it as a wrong code; a second failure is a real defect and is left to fail the test).
  Since 2026-09-08 its failure message names the endpoint, HTTP status, GoTrue code, server
  `msg` and the on-screen text, and it observes `/challenge` as well as `/verify` — see
  `e2e/helpers/agents.md`, and note there that the step boundary is NOT a plausible cause of a
  rejection (GoTrue validates with `Skew: 1`).
  Every TOTP fill+submit in the spec goes through this helper now, not a raw `.fill(totp(...))`.
- **The spec** covers: (a) a disposable INDIVIDUAL enrolling TOTP in Settings then completing
  the SAME factor as a login challenge (`mfa-challenge*` test ids) on the next sign-in; (b) a
  disposable ORG_ADMIN with its own throwaway org seeing the dismissible `mfa-grace-nudge`
  before the enforcement date (future override) while still reaching the app, and the dismissal
  surviving a reload (sessionStorage); (c) a disposable ORG_ADMIN past the enforcement date
  (past override) hitting the hard `mfa-enrollment-required` block and completing it — proves
  the block is a real onboarding step, not a dead end (this one does NOT need a disposable org:
  `AuthGuard` runs before `RouteGuard`, so the MFA block renders regardless of `org_id`, and
  landing on `/onboarding/org` afterward still satisfies `APP_URL_PATTERN`); (d) adding and
  removing a second "backup" `TwoFactorSetup` factor, handling the optional AAL2
  `twofactor-stepup` prompt.
- **`auth.setup.ts`** (unchanged by the self-containment pass — the CI local stack still has
  seed users) patches `arkova_mfa_enforce_from_override=2099-01-01T00:00:00Z` into every seed
  user's saved `storageState` file after login (under `resolveE2EFrontendOrigin()` — Playwright
  matches storageState by origin, same reasoning as `createProfileSession`), then verifies the
  entry landed the same way it already verifies the Supabase session token. Without this, the
  ~100 existing specs that reuse `.auth/*.json` would start seeing the grace nudge / hard block
  for `orgAdmin`/`orgBAdmin` sessions once the 2026-09-21 default enforcement date
  (`src/lib/mfaPolicy.ts`) passes. A plain UI login never writes this key on its own — it has to
  be patched into the file, not read back from the page.
- **Item 17/B4 (PR #2637 review) — the `arkova_mfa_enforce_from_override` localStorage key is
  NOT unconditionally honoured.** `src/lib/mfaPolicy.ts`'s `resolveMfaEnforceFrom()` only reads
  it when `import.meta.env.DEV === true` OR `import.meta.env.VITE_MFA_ALLOW_DATE_OVERRIDE ===
  'true'` (CTO ruling A4-1) — never on a plain production build with neither set. `npm run dev`
  (what CI's E2E job runs) always satisfies `DEV === true`, so the override works there with no
  extra flag. A **built-preview** run (`vite build` + `vite preview`, or any Vercel-style
  production bundle) does NOT satisfy `DEV`, so after 2026-09-21 (the baked default enforcement
  date) it will stop honouring the override UNLESS `VITE_MFA_ALLOW_DATE_OVERRIDE=true` was set
  at build time — the MFA-3167 soak build sets this flag explicitly for exactly this reason
  (`docs/reference/ENV.md`: never set it on Vercel prod). If this spec (or `auth.setup.ts`'s
  patched override) is ever run against a built-preview instead of `npm run dev`, confirm that
  build set the flag first — otherwise every override-dependent assertion here (the grace-nudge
  scenario's future date, the hard-block scenario's past date, and `auth.setup.ts`'s far-future
  patch protecting the other ~100 specs) silently stops working with no error, just the real
  (unoverridden) enforcement date taking over.
- **Do not widen `AnchorUpdateSchema` or any other spec's fixtures for this feature** — MFA
  state lives entirely in `auth.mfa_factors` / `auth.sessions`, the disposable users' own
  `profiles` rows, and (for scenario (b)) one disposable `organizations` row — never on
  `anchors`.
- **Do not assume any seed user or a `setup`-project `.auth/*.json` file exists** when adding a
  new case to this spec — the whole point of this file is that it works on a rig with neither.
## SCRUM-4448 — isolated securing layout regression

`secure-dialog-layout.spec.ts` mounts the real securing dialog, children and CSS through a development-only HTML fixture. Run `npx playwright test -c e2e/secure-dialog-layout.config.ts` for isolated headless Chromium on port 5200 (or set `E2E_BASE_URL` to another loopback Vite server). No seeded account or remote service is needed. The spec deliberately imports the base Playwright test rather than the authenticated fixture barrel: that barrel requires live credential environment variables at module load, while this layout suite uses deterministic boundary mocks and blocks non-loopback requests. This is a presentation/interaction proof, not production anchoring or auth evidence. Geometry, intact attestation labels, extracted-field editing, enabled actions, field focus, keyboard navigation and screenshots cover four viewport sizes; keep the real components and transition logic in this fixture.

## UAT-01 / SCRUM-4031 — public signup entry (2026-09-05)

`signup-entry.spec.ts` runs without seed sessions or backend writes. At 1280px and 375px it checks immediate email/OAuth controls, keyboard order, mismatch recovery, sign-in navigation, no horizontal overflow and screenshot attachments. Build with a stale `VITE_BETA_INVITE_CODE` value to reproduce legacy deployments. This smoke does not establish email delivery or server confirmation policy; `auth.spec.ts` owns the real confirmation-required account creation check.


_Last updated: 2026-08-29 (DocuSign record deep links spec added to record-detail.spec.ts)._

## 2026-08-29 — DocuSign Record case added to `record-detail.spec.ts` (bilateral rollout, frontend-targeted T2)

New `DocuSign Record (bilateral rollout, frontend-targeted T2)` describe block: creates a SECURED anchor via `createTestAnchor` then sets DocuSign-shaped `metadata` (`connector_source: 'docusign'`, `account_id`, `envelope_id`, `_signers`) via a **direct `serviceClient.from('anchors').update({ metadata })`** call, not `createTestAnchor`'s `AnchorUpdateSchema` — that schema is `.strict()` and shared by every spec that creates a non-PENDING test anchor, so it deliberately was NOT widened with a `metadata` field for one spec's fixture data. Asserts the real page renders `data-testid="docusign-account-link"` / `"docusign-envelope-link"` with the exact expected hrefs (`target="_blank" rel="noopener noreferrer"`) and at least one `data-testid="docusign-signer-row"` with a working `docusign-signer-link-0`. Component-level validation/injection-matrix coverage lives in `src/lib/docusignLinks.test.ts` + `AssetDetailView.test.tsx` (`src/components/anchor/agents.md`) — this spec proves only the end-to-end wire-up against a real page load.

**Not executed against a live stack this session** — this worktree has no `.env.test` and the Docker daemon was not running (`npx supabase status` failed with "Cannot connect to the Docker daemon"), so no local Supabase/worker stack was reachable. Standing up one was deliberately not attempted here: per `project_local_supabase_shared_project_id`, ALL worktrees share the same `arkova` Supabase containers/volumes, so starting or stopping that stack from an agent session risks trampling a concurrent worktree's repro. Verified instead via `E2E_SUPABASE_SERVICE_KEY=dummy E2E_SEED_PASSWORD=dummy npx playwright test --list e2e/record-detail.spec.ts` (no network calls, no test execution) — the new case parses and is correctly enumerated across all 5 browser projects, confirming no import/syntax defect. Run for real against a live rig before merge-grade soak evidence is claimed.

## 2026-08-23 — verify-ratelimit-contract.spec.ts is no longer a RED artifact

This spec shipped 2026-07-07 as a deliberately-failing repro whose header said the fix was
"WITHHELD this window" and told readers not to edit `services/worker/src/index.ts`. Both statements
are stale, and one was stale the day after it landed:

- The **checkout-limiter mechanism it describes was fixed on 2026-07-08** by `7ed0f687f`
  (`routes/admin-paths.ts`): `adminRouter`'s first middleware now `next('router')`s out for any path
  outside its own prefixes, so `rateLimiters.checkout` never sees `/api/v1/*`. The spec was never
  updated, so it kept documenting a defect that main no longer had, and kept naming file:line
  locations that had moved.
- The **residual** §1.10 gap was a different limiter — the 60/min `apiIpShadowGuard`, which shared one
  bare-per-IP bucket with `apiV1Router`'s 100/min `anonRateLimiter` and so capped anonymous verify at
  ~30/min. That is now fixed too (`middleware/apiIpShadowGuard.ts` + `utils/rateLimit.ts` scoping).

The header is rewritten as a contract spec: what §1.10 requires, what used to break it and where each
mechanism was fixed. The assertions are unchanged in substance — they were always written against
the fixed behaviour.

**Lesson for the next RED artifact:** a spec whose docstring asserts the state of production code
goes stale silently the moment someone fixes it elsewhere. If you land one, put the defect's
mechanism behind a named helper the spec can assert against, or expect to be re-reading a fossil.

Running it still needs a Carson-provisioned throwaway rig (`E2E_SUPABASE_PROJECT_REF` +
`E2E_WORKER_URL`); without one the suite skips rather than touching a protected ref.

## 2026-08-23 — api-keys.spec.ts revoke-flip de-flaked (locator + shared 429 bucket)

The #2220 revoke block flaked on every post-#2220 tree (main run 32623769492: ✘✘✓ on
`api-keys.spec.ts:169`). Two independent causes, both fixed test-side:

1. **Self-contradictory keyCard locator.** The card locator filtered on the key name AND a
   Revoke button; ApiKeySettings.tsx unmounts that button on revoke, so the post-revoke
   assertions re-resolved against nothing (clean list) or an ancestor div containing another
   key's Revoke button — pass/fail depended on leftover keys. Now anchored on the card root
   (`div.shadow-card-rest`) + key name + the delete button (present in every key state).
2. **Shared per-IP rate-limit bucket saturation.** Every worker limiter with default options
   keys on bare `req.ip` with empty scope, so the whole suite shares ONE `::1` bucket, each
   dashboard call costs 3 increments (`apiIpShadowGuard` ×2 mounts + v1 anon limiter), and the
   strictest gate 429s at 60/60s — the revoke PATCH raced the rest of the suite's traffic. The
   spec now gates the create→revoke→delete flow on measured headroom via
   `waitForSharedRateLimitHeadroom` (page-context probe of a /api/v1 404 path, reading the
   exposed X-RateLimit-*/Retry-After headers). Test-side only: no limiter raised, no bypass.
   If OTHER specs start 429-flaking the same way, reuse the helper — do NOT bump the worker
   limits for CI.

## 2026-08-12 — api-keys.spec.ts now covers revoke + delete (FD-P7 / CC6.8)

The create-key test's success branch continues into revoke-with-confirmation (badge flips to
Revoked, Revoke button disappears) and then deletes the key so e2e runs do not accrete keys. This
flow was unreachable before the FD-P7 fix (server stripped `id` from key responses); if the revoke
step starts failing with a 404 on `/api/v1/keys/undefined`, the id-strip regressed server-side.

Playwright E2E test specs and shared fixtures for the Arkova application.

## Live findings an agent must know before touching this code

- **A green test that pins the WRONG PREMISE is worse than no test.** This
  class of defect bit three separate lanes on 2026-08-01, so it gets top
  billing. The signup spec asserted the user lands on `/dashboard` immediately
  after "Create account", justified by a comment claiming prod auto-confirms
  signups — and `supabase/config.toml` was set to `enable_confirmations = false`
  **to make CI match that claim**. The claim was false. Verified live against
  prod on 2026-08-01: signup returns HTTP 200 with `confirmation_sent_at` set
  and **no session**, and the user row lands with `email_confirmed_at = NULL`.
  So CI was faithfully validating the opposite of production, on the one flow
  whose entire purpose is that it stops and waits for the user.
  - The failure mode is specific and worth recognising: someone hits a spec
    that disagrees with an environment, and "fixes" it by changing the
    **environment config** to match the spec's assumption instead of checking
    which one is right. The spec then goes green and permanently encodes the
    wrong premise.
  - **Rule: when a spec's expectation depends on an environment setting, the
    comment justifying it must cite VERIFIED evidence from that environment —
    a request/response, an auth log line, or a DB row — not an assumption.**
    If you cannot produce that evidence, you do not yet know which behaviour is
    correct, and flipping a config to go green is guessing.
  - Corollary: `supabase/config.toml` is a *mirror* of the real project's auth
    settings, not a place to negotiate with a failing test. Changing it changes
    what every local and CI run believes production does.

- **A fully-mocked spec proves the client, not the write — say so in the
  docblock, and assert the OUTCOME the user came for.** Sibling of the
  wrong-premise finding above, found 2026-08-03.
  `ctdl-registry-import.spec.ts` stubbed both worker legs and asserted the
  in-dialog success link, then stopped. It never looked at the Imported Records
  list — so it passed for a route that created records **permanently invisible**
  to the user who added them (`credentials-ctdl-registry-anchor.ts` wrote
  `anchors.user_id` but no `anchor_recipients` row; `get_my_credentials()`
  inner-joins that table with no fallback). Every visible assertion was green
  and every one of them was about the dialog.
  - **Rule: assert the user-visible end state of the flow, not the last thing
    the component rendered.** "Add" is not the outcome; "the record is in my
    list" is. A spec that stops at the confirmation UI is testing that the
    confirmation UI renders.
  - When the stubs make an assertion structurally incapable of catching a
    server-side defect, state that in the docblock and name the suite that
    does cover it. Coverage that only looks like coverage is how this shipped.
- **`fixtures/index.ts` is a single point of failure — never use `__dirname`
  in it (or in anything it re-exports).** The root package is
  `"type": "module"`, so Playwright transpiles the barrel to ESM where
  `__dirname` is undefined. Every spec imports from this barrel, so one
  `__dirname` throws at module load and takes the **entire** suite down before
  a single test is listed — `playwright test --list` returned
  `Total: 0 tests in 0 files`, not a per-spec failure. Landed 2026-08-02 in
  `e01fa2198`, fixed 2026-08-03 with
  `fileURLToPath(new URL('...', import.meta.url))`.
  - Symptom to recognise: a "No tests found" / 0-test run that looks like a
    bad path filter but is actually a module-load crash in the barrel. Check
    the top of the output for the `ReferenceError` before touching globs.
  - The path-gated `Run E2E tests` CI step (`e2e-changed`) means a barrel
    break can sit on `main` for a while, going unnoticed on the PRs that do
    not touch app paths. Do not read a green CI as proof the suite ran.
- **Click-interception and paint-order bugs are E2E-only. Never answer this
  defect class with Vitest+jsdom.** jsdom has no layout engine and no
  hit-testing, so `fireEvent.click(el)` dispatches straight at the target and
  passes green against a build where a real user's click is swallowed by an
  overlaying element. Only a real browser (Playwright actionability, or
  `document.elementFromPoint`) catches it. Precedent: the 2026-07-28
  `FileUpload` Remove-button defect (an `absolute inset-0` file input painting
  over a non-positioned sibling). `FileUpload.test.tsx` had no Remove-button
  coverage — but adding a jsdom one would NOT have caught it either, which is
  the point.
- **Couple route globs to source constants, never hardcoded paths.** The
  `template-review.spec.ts` intercept hardcoded
  `**/vendor/transformers.web.min.js*`; #1416 renamed the loader target, the
  stub silently stopped matching, the real loader ran, and the spec timed out
  deterministically for days. Route on `TRANSFORMERS_BROWSER_MODULE` imported
  from `src/lib/nerPiiDetector` so a rename fails at import/typecheck time
  instead of stranding the intercept.
- **Never point E2E at a soaking rig.** `helpers/soaking-ref-guard.ts`
  (`assertNotSoakingRef`) throws before any repro `execute_sql`/deploy/load if
  the target is shared staging, prod, a `*-staging`-shaped ref, or an
  operator-listed soaking rig — and it cross-checks `E2E_SUPABASE_URL`, not
  just the ref, because the seed path writes against the URL.
- **Stub third-party network at the Playwright `route()` boundary**, not by
  hoping CSP blocks it. #1600 added `mempool.space` to `connect-src`, which
  turned previously-CSP-blocked enrichment legs into live calls and broke
  `treasury-errors.spec.ts` on every PR run until the legs were explicitly
  stubbed to fail fast.
- **Never call bare `auth.signOut()` in a spec — supabase-js defaults it to
  `scope: 'global'`, which revokes EVERY session for that seed user,** including
  the `.auth/*.json` storageState session `auth.setup.ts` minted and every later
  spec in a single-invocation run reuses. 2026-08-15, fullsoak side-rig:
  `cross-tenant.spec.ts`'s PostgREST-leg `afterAll` (added by #2213) global-signed-out
  demo-admin; every subsequent `orgAdminPage` spec (csv-upload, dashboard,
  error-states, integrations-docusign*, member-invite, org-admin…) bounced to
  /login while the storageState JWT was still 55 min from expiry — GoTrue
  answered 403 `session_not_found` for it. Two things masked it: CI's local
  GoTrue does not bounce the app on a revoked session, and per-spec
  invocations re-mint sessions every spec. Pass an explicit scope
  (`{ scope: 'local' }`, the same convention as `src/hooks/useAuth.ts`);
  `tests/infra/signout-scope-guard.test.ts` now ratchets this over every
  `e2e/**/*.ts` file.

## File Inventory

### Auth Setup (`e2e/auth.setup.ts`)

Playwright setup project that runs **once** before all test projects. Logs in each distinct seed user via the UI login form and saves the authenticated browser state (cookies + localStorage) to `.auth/*.json`. All test projects depend on this setup and reuse the saved state via `storageState` — no per-test login overhead.

Tests that need unauthenticated state (e.g., `auth.spec.ts`, `route-guards.spec.ts`, `onboarding.spec.ts`, `identity.spec.ts`) override with `test.use({ storageState: { cookies: [], origins: [] } })`.

### Fixtures (`e2e/fixtures/`)

| File | Purpose |
|------|---------|
| `auth.ts` | Extended Playwright `test` object with `individualPage`, `orgAdminPage`, `orgBAdminPage` fixtures. Uses pre-saved `storageState` (no per-test login). `orgBAdminPage` opens a separate browser context with sarah's state. |
| `supabase.ts` | Supabase service client (env-var backed), `SEED_USERS` constants, `createTestAnchor()` / `deleteTestAnchor()` helpers |
| `seed-anchors.ts` | Seed SECURED anchors fixture — creates reusable anchors in various states for E2E tests |
| `index.ts` | Barrel export — all specs import from here |

### Helpers (`e2e/helpers/`)

| File | Purpose |
|------|---------|
| `soaking-ref-guard.ts` | **SCRUM-2603** hard guard. `assertNotSoakingRef(ref)` throws BEFORE any repro `execute_sql`/deploy/load if the target Supabase ref is shared staging (`ujtlwnoqfhtitcmsnrpq`), prod (`vzwyaatejekddvltxyye`), any `*-staging`-shaped ref, or any operator-listed soaking micro-rig ref (`SOAKING_PROJECT_REFS` env). Deny-list match is **case-insensitive** (both sides lowercased before `Set.has`) so a cased variant of a protected ref cannot slip past — mirroring the `/staging/i` heuristic. **Also cross-checks `E2E_SUPABASE_URL`**: the seed/teardown path (`getServiceClient()` in `fixtures/supabase.ts`) writes against the URL, not the ref, so a CLEAN throwaway ref paired with a URL still pointing at a protected project (host EQUALS or EMBEDS a denied ref, or is staging-shaped, case-insensitively) is REFUSED — closing the blind spot where `createTestAnchor()` could dirty a soaking/prod DB despite a clean ref field. `evaluateReproTargetUrl()` is the pure URL evaluator; the ref evaluator folds it in so all call sites gain URL protection. The #1147 contamination scar made mechanical (§1.11A). Pure `evaluateReproTargetRef()` / `evaluateReproTargetUrl()` are unit-tested in `tests/infra/soaking-ref-guard.test.ts`. Does NOT stand up / write / tear down any rig — validation only. |

### Existing Specs

| File | Flow | Tests | Fixtures Used |
|------|------|-------|---------------|
| `auth.spec.ts` | Login, signup, validation, sign-out | 7 | `test`, `expect`, `SEED_USERS` |
| `route-guards.spec.ts` | Unauthenticated redirects, role-based routing, mid-onboarding redirect | 5 | `test`, `expect` |
| `onboarding.spec.ts` | Role selection, org onboarding form, review gate | 7 | `test`, `expect` |
| `identity.spec.ts` | Role immutability, privileged field protection, org scoping, review gate | 7 | `test`, `expect` |
| `identity-entitlement.spec.ts` | **PAY-01 / SCRUM-2384** verified-identity entitlement gate via the worker `GET /api/v1/identity/entitlement`: granted on current entitlement+subscription, denied after revoke (closed window), denied on a STALE subscription period (SCRUM-1791), fail-closed with no subscription. Mints a real worker Bearer token (`signInWithPassword`); seeds `entitlements`+`subscriptions` via service client. Requires the worker on `E2E_WORKER_URL`. | 4 | `test`, `expect`, `getServiceClient`, `SEED_USERS`, `@supabase/supabase-js` |
| `public-verification.spec.ts` | Public verify page (valid/invalid ID, sensitive data, no auth, file size) | 5 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS` |
| `public-org.spec.ts` | Public org page (`/issuer/:orgId`): hero, JSON-LD, OG/canonical, anon admin-CTA absence, anonymized vs public members, mobile (375px), unknown-org error | 8 | `test`, `expect` |
| `extraction-csp-fail-closed.spec.ts` | **§1.6 fail-closed exit proof (WEBEXT-02/03/04 / SCRUM-2504/2505/2506).** Serves a probe page under the EXACT deployed CSP (parsed from `vercel.json`) and proves: the CSP blocks the off-origin Tesseract/NER CDNs (jsdelivr, huggingface.co), `'self'` /vendor is reachable, and a model-load failure sends ZERO document-metadata egress (no `/api/v1/ai/extract` request). Unauthenticated (empty storageState); no backend fixtures. _(Restored 2026-07-28, lost by the union-merge-driver incident; see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`.)_ | 3 | `@playwright/test` (direct), `node:fs` (reads `vercel.json`) |
| `dashboard.spec.ts` | Dashboard: welcome, stats, My Records, Secure Document button, privacy toggle, org admin view, navigation | 7 | `test`, `expect`, `individualPage`, `orgAdminPage` |
| `anchor-creation.spec.ts` | Secure Document dialog: upload → fingerprint → confirm step → cancel, **+ Remove-file click-interception regression** (2026-07-28) | 6 | `test`, `expect`, `getServiceClient`, `individualPage` |
| `record-detail.spec.ts` | Record detail: SECURED sections, fingerprint, QR code, proof downloads, lifecycle, PENDING state, 404 error, DocuSign metadata deep links + signer row | 9 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `individualPage` |
| `revocation.spec.ts` | Revoke dialog: confirmation fields, enable on typing, cancel, reason field, REVOKED status | 5 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `orgAdminPage` |
| `csv-upload.spec.ts` | Bulk upload wizard: CSV upload, column mapping, validation errors, processing | 5 | `test`, `expect`, `orgAdminPage` |
| `org-admin.spec.ts` | Org admin: members table, org registry, issue credential form, status filter, export CSV | 5 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `orgAdminPage` |
| `settings.spec.ts` | Profile edit, privacy toggle, identity IDs, webhook settings page, credential templates page | 5 | `test`, `expect`, `individualPage`, `orgAdminPage` |
| `cross-tenant.spec.ts` | **Cross-tenant isolation — hardened per DEG-4 (SOAK-PREMORTEM-SOC2-2026-08-11 §4); its daily run is the G4/CC6.1 soak evidence.** UI (user-to-user, org-to-org, list isolation) + direct PostgREST reads with a cross-tenant JWT (RLS zero-rows) + public API with a cross-tenant org API key (`GET /api/v1/jobs/:id` → 403/404; keys minted via real `POST /api/v1/keys`). "Blocked" = the explicit `Record Not Found` heading ON the record path — a /login redirect FAILS (the old helper passed on ANY navigation away, so an expired session made the suite green while proving nothing). Every isolation test is preceded by a positive-access precondition (accessor reads its OWN data; distinct `precondition: <label> session not authenticated` failure). Verdict logic is pure (`helpers/cross-tenant-assertions.ts`) and unit-tested in `tests/infra/cross-tenant-assertions.test.ts`. Fixtures are **PENDING-only** (service-role SECURED seeding re-created the fabricated-SECURED class and inflated Day-7 counts). sarah/orgBAdmin is seeded `is_platform_admin=true` so she is victim-only, never an accessor. MCP/edge tenant scoping is DECLARED UNTESTED (TODO at file bottom) — no edge-worker e2e harness exists. PostgREST/API legs need `VITE_SUPABASE_ANON_KEY` + live worker (`E2E_WORKER_URL`); missing deps fail loudly, never skip. | 7 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `individualPage`, `orgAdminPage`, `@playwright/test` `request`, `@supabase/supabase-js`, `helpers/cross-tenant-assertions` |
| `error-states.spec.ts` | Error handling: 404 record, invalid verification, expired session, unknown routes | 5 | `test`, `expect`, `individualPage` |
| `performance.spec.ts` | Frontend performance smoke: dashboard load <5s, stats render <3s, verification page <3s, navigation <3s, org admin <5s | 5 | `test`, `expect`, `individualPage`, `orgAdminPage` |
| `legal-pages.spec.ts` | Public privacy and terms routes: update notices present, launch-blocker placeholder copy absent | 2 | `@playwright/test`, unauthenticated empty storageState |
| `integrations-docusign.spec.ts` | DocuSign org settings connector: status, connect, disconnect, error states, non-admin boundary, 1280px + 375px screenshot attachments | 11 | `test`, `expect`, `getServiceClient`, `SEED_USERS`, `orgAdminPage`, `individualPage` |
| `integrations-adobe-sign.spec.ts` | Adobe Sign org settings connector (SCRUM-1148 follow-up): status, connect consent URL (asserts `webhook_write` + `webhook_retention` are actually in the scope string), OAuth round-trip, disconnect, non-admin boundary, 1280px + 375px card screenshots. Plus the three states DocuSign has no equivalent of — `adobe_sign_unconfigured` / kill-switch 503 (**the live prod path**: no Adobe app is registered), `webhook_registration_failed` (Adobe plan lacks webhook access; asserts the toast does NOT say "try again"), and a disconnect that left a live webhook Adobe-side. **Screenshot helper is card-scoped, NOT `fullPage`** — this app scrolls inside a container, so `fullPage` captures only the page header and the first version of this spec produced byte-identical "connected"/"disconnected" images. | 19 | `test`, `expect`, `getServiceClient`, `SEED_USERS`, `orgAdminPage`, `individualPage` |
| `route-screenshot-baseline.spec.ts` | **Route matrix + screenshot baseline (SCRUM-1998 / GA-S2 / E3).** Enumerates the app's routes (derived from the LOCKED `src/lib/routes.ts` `ROUTES` map) and captures a deterministic full-page screenshot of each at BOTH 1280px desktop + 375px mobile. 57 route cases × 2 viewports = 114 shots/project. | 57 | `test`, `expect`, `getServiceClient`, `getSeedUserOrgId`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `acceptDisclaimerIfVisible`, `ROUTES` |
| `verify-ratelimit-contract.spec.ts` | **SCRUM-2603 (RED de-risking artifact).** Proves the verify endpoint is 429'd far below the §1.10 anon 100/min contract (first 429 ≈ request #4, ~1/25th — every `/api/*` limiter shares one no-scope per-IP bucket that a single verify request increments multiple times; the checkout limit-10 binds first) because `adminRouter`'s checkout limiter (routes/admin.ts:37) is mounted at `/api` (index.ts:351) ahead of the verify router (index.ts:458). Runs **serial** (shared per-IP bucket) with a distinct TEST-NET-3 IP per test. Test 1: 11 anon GETs → all 2xx. Test 2: asserts no sub-contract 429 (429 with `X-RateLimit-Limit` < 100) — a passing-response `=100` check is NOT fail-first because the anon(100) limiter is the last-writer, so the header reads 100 even on the broken order. Test 3: drives past 100/min → real 429 carries `Retry-After`. **Written RED**; the index.ts mount-order fix is WITHHELD (soaking surface). Runs ONLY against a Carson-provisioned throwaway rig cleared by the soaking-ref guard — skips otherwise, never touches a protected rig. | 3 | `test`, `expect`, `getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`, `assertNotSoakingRef` |

## Route Screenshot Baseline — Matrix (SCRUM-1998)

`route-screenshot-baseline.spec.ts` is the GA visual baseline harness. The route
matrix is **derived from `src/lib/routes.ts`** (every entry references a `ROUTES.*`
constant, so it tracks the LOCKED route table). Each route is captured at both GA
baseline viewports and the result is (a) attached to the Playwright report via
`testInfo.attach()` and (b) written to `ROUTE_BASELINE_DIR` (default
`test-results/route-baseline/`; set `ROUTE_BASELINE_DIR=docs/screenshots/baseline`
to curate a committed snapshot per the ticket).

| Bucket | Auth | Count | Notes |
|--------|------|-------|-------|
| Public routes | none (empty storageState) | 20 | login, signup, verify form, search, marketing/legal pages, developer/API pages; param-public routes use a deterministic unknown id → graceful not-found surface |
| Individual user routes | `individual` storageState | 12 | dashboard, documents, records, my-credentials, settings (+ api-keys/webhooks/templates), help, billing, attestations |
| Org admin routes | `orgAdmin` storageState | 23 | organizations/organization, review-queue, AI/compliance pages, rules, anchor-queue, signature-compliance, auditor-batch + the platform-admin `/admin/*` console |
| Parameterized detail routes | individual / orgAdmin | 2 | `/records/:id` (seeded SECURED anchor) + `/organizations/:orgId` (seeded org); each skips gracefully if its seed row is absent |

**Determinism:** animations disabled per shot (`animations: 'disabled'`); dynamic
regions masked (`[data-dynamic]`, `[data-testid="relative-time"]`, `<time>`); each
route waits on an explicit, **bounded** ready signal — never a fixed timeout and
never `networkidle` (see below). **The ready gate is asymmetric by auth:**

- **Authed routes (hard gate):** gate on `#main-content` (it exists only inside the
  authenticated AppShell), budget `AUTHED_READY_TIMEOUT_MS` (15 s). A broken authed
  app route is a high-value signal and **fails the job**.
- **Public routes (capture-and-report):** gate on `publicContentReady` — bounded by
  `PUBLIC_READY_TIMEOUT_MS` (8 s). If a public route does **not** paint real content
  within that window the shot is **still captured**, the route is recorded in
  `thinPublicRoutes`, `console.warn`'d, annotated (`thin-public-route`), and surfaced
  in an end-of-suite FINDING summary — the spec stays **GREEN** (a WIP/stub marketing
  page or a slow-settling network must not red-fail the whole baseline job), while the
  problem is reported loudly (never a silent skip).

`publicContentReady` asserts the page **painted real content**: it polls (via
`waitForFunction`, not `waitForTimeout`) for the first element under `#root` that is
BOTH visible (non-zero box, not `display:none`/`visibility:hidden`) AND carries
non-whitespace text. It must NOT be rewritten as
`page.locator('main, [role="main"], #root > *').first()` — see the Do/Don't rule
below for why that hangs. Heading regexes are kept tight (a miss is not a silent
pass — it falls through to the content check).

**Visual-diff posture:** baselines are attachment-based, NOT `toHaveScreenshot()`
pixel diffs (the repo has no committed golden images; pixel diffs are brittle across
OS/CI). The gate is route *rendering* (the ready signal), not pixel equality.
`playwright.config.ts` carries `expect.toHaveScreenshot` defaults + a
`snapshotPathTemplate` for any future opt-in golden-image spec.

**Local note:** the authed buckets need the `auth.setup.ts` sessions, which require
Supabase creds — exercised in CI, not on a credential-less local checkout (repo norm).

**CI time budget:** 114 full-page captures per browser project (57 cases × 2
viewports), chromium only, serialized (`workers: 1`, `retries: 2`) under the ~25-min
E2E job cap — roughly 6–10 min steady-state. **If the E2E budget tightens, this spec
is the first candidate to split into its own CI shard**: it is self-contained (one
spec file, `ROUTE_BASELINE_DIR`-scoped output), so sharding it off the critical-path
E2E job is low-risk.

## Do / Don't Rules

- **DO** import `test` and `expect` from `./fixtures` for seeded/authenticated flows.
- **DO** import from `@playwright/test` directly only for public unauthenticated smoke specs that do not need seed data or service-role helpers.
- **DO** use `SEED_USERS` constants for known test credentials
- **DO** clean up test data in `afterAll` / `afterEach` via service client
- **DO** use timestamped unique names for test data to avoid collisions
- **DON'T** hardcode Supabase URLs, keys, or passwords in spec files
- **DON'T** create cross-spec dependencies — each spec is isolated
- **DON'T** use `page.waitForTimeout()` — use proper `waitForURL()` or `expect().toBeVisible()`
- **DON'T** gate a screenshot/route assertion on `body` being visible — `<body>` is visible even on a blank/white-screen page, so it is a no-op that always passes. Assert a primary content region **with non-empty text** so a broken page actually fails (see `publicContentReady` / `mainContentReady` in `route-screenshot-baseline.spec.ts`).
- **DON'T** detect "the page painted" with `page.locator('main, [role="main"], #root > *').first()` — `.first()` resolves to the first DOM-order match of ANY clause, which on pages that render a JSON-LD schema component first (`PersonSchema`/`HowToSchema`/`FAQSchema`/`OrganizationSchema`) binds to a **zero-height, zero-text `<section>` wrapper** and hangs the gate for the full timeout. Scan for the first **visible, non-empty-text** element instead (skips the empty schema wrapper). This was the PR #998 30s-timeout root cause.
- **DON'T** red-fail the whole route-baseline job on a single non-painting **public** route — capture the shot and record it as a reported finding (`thinPublicRoutes` + `console.warn` + annotation + end-of-suite summary). Keep the **hard** assertion for **authed** routes (`#main-content`), where a non-painting route is a real defect.
- **DO** keep click-interception / paint-order regressions as **E2E** tests, never Vitest+jsdom. jsdom has no layout engine and no hit-testing, so `fireEvent.click(el)` dispatches directly at the target and passes green against a build where a real user's click is swallowed by an overlaying element. Only a real browser (Playwright actionability, or `document.elementFromPoint`) catches this class of bug. Precedent: the 2026-07-28 `FileUpload` Remove-button defect (an `absolute inset-0` file input painting over a non-positioned sibling). `FileUpload.test.tsx` had no Remove-button coverage at the time — but adding a jsdom one would NOT have caught it either, which is the point: don't answer this defect class with a unit test.
- **DO** pair a real `.click()` with an explicit `elementFromPoint` assertion when testing interception — a bare click failure surfaces as a generic actionability timeout, whereas the hit-test names the actual interceptor in the failure message.
- **DON'T** use a default (substring) `getByRole('button', { name })` match inside the FileUpload drop zone — the drop-zone wrapper is itself a `div[role="button"]` and its accessible name is computed from its whole subtree, so it absorbs descendant sr-only text (e.g. "Remove file") and the locator resolves to 2 elements. Use `exact: true`.
- **DON'T** instantiate a context fixture (`orgAdminPage`, `orgBAdminPage`) in a test that doesn't use it — each eagerly opens a browser context + teardown. Destructure only the fixtures the block actually drives.
- **DON'T** assume a multi-file drop always routes to the CSV bulk-upload wizard. 2026-08-01 (SCRUM-2911 W1, PR #1738): `FileUpload.tsx`'s `dispatchFiles` now only calls `onBulkDetected` (→ `BulkUploadWizard`, "Bulk Upload Records" heading) when EVERY dropped file is a spreadsheet (`isBulkUploadFile`); a mixed-format multi-file drop (e.g. two PDFs) calls `onMixedBatchDetected` (→ `MixedBatchUploadWizard`) instead. `csv-upload.spec.ts`'s `openBulkUploadDialog` helper used to drop two PDFs as a shortcut and broke when this landed (GH Actions run referenced in PR #1738); fixed by dropping two `.csv` files instead so the helper actually exercises the bulk-CSV path it's testing. **Gap**: the mixed-format batch anchoring flow itself (`MixedBatchUploadWizard`, `/api/v1/anchor/bulk/self-service`) has no E2E spec yet — only Vitest component/unit coverage.
- **DON'T** hardcode the `SecureDocumentDialog` confirm-step submit locator on visible text alone — prefer `getByTestId('securing-path-queue')` (the always-present "Add to Queue" path) or `getByTestId('securing-path-instant')` ("Secure Instantly", only rendered when `exposedSecuringPaths(capability)` includes `'instant'` — hardcoded unreachable this sprint per R5). 2026-08-01 (QUEUE-01 / SCRUM-2894, PR #1737): the confirm button's visible text changed from "Secure Document" to "Add to Queue", and three call sites that previously called `handleConfirm([])` directly (AI-disabled Continue, extraction-failed Skip, privacy-blocked Continue-without) now route through the confirm step too — so a stale `/Secure Document/i` locator both mismatches the new text AND misses that some paths now require an explicit click they didn't before. Broke `anchor-creation.spec.ts`, `secure-document.spec.ts`, and `template-review.spec.ts` (GH Actions run 30707096632); fixed by switching to the testid and, where the path previously auto-submitted, adding the click.
- **DON'T** assert the raw uploaded filename on the PUBLIC verify/search surfaces — the projection deliberately withholds it. 0385 suppresses issuer-authored free text for records the academic gate cannot positively classify as safe, and 0390 (SCRUM-3102) flipped that gate to **fail closed on an ABSENT `credential_type`**, so `is_academic_record_credential_type(NULL)` is TRUE and `filename` projects `academic_record_public_label(NULL)` — the controlled fallback label exported as `PUBLIC_FALLBACK_FILENAME_LABEL` from `./fixtures` (sourced from `scripts/ci/public-pii-projection-contract.json`, so a label change can't pass E2E while breaking the projection suites). `createTestAnchor` never sets `credential_type`, so **every** anchor it makes is NULL-typed and redacted. 2026-08-10: the `public-verification.spec.ts` status matrix (PENDING/SUBMITTED/SECURED/EXPIRED/REVOKED) still asserted the OLD leaky behaviour and hard-failed all 5 cases on `main` (GH Actions run 31315601862) — the sibling specs had been corrected but this loop was missed. Assert **both** directions (label visible + raw name `toHaveCount(0)`): the negative alone passes on a blank card, the positive alone passes while the name leaks elsewhere.
- **DON'T** wrap a step that is actually unconditional in `if (await locator.isVisible({ timeout }).catch(() => false))` — that converts "slow" into "silently skipped" and relocates the failure. 2026-08-10: `anchor-creation.spec.ts` guarded its `securing-path-queue` click this way; both routes into the confirm step (extraction-failed Skip, and the AI-off Continue) `await autoSelectTemplate('OTHER')` — a live Supabase round-trip to `credential_templates` — *before* `setStep('confirm')`, so under CI load the step landed after the 10s probe, the click never fired, and the run failed 15s later in the anchor poll with a misleading "row never appeared", passing on retry (the flaky signature in run 31315601862). Use `await expect(locator).toBeVisible({ timeout })` then click unconditionally: it makes Playwright *wait* instead of race, and fails at the real cause. Reserve the `isVisible` guard for genuinely optional UI.
- **DON'T** drive `/pricing` checkout with `mockBillingStatus` — it cannot reach that page. `PricingPage` gets plans + subscription from `useBilling`, which queries PostgREST directly (`from('plans')`, `from('subscriptions')`), **not** the worker's `/api/billing/status`. Two seeded facts then block the checkout branch, and both must be mocked (`mockNewSubscriberWithPurchasablePlan` in `billing.spec.ts`): (1) the seeded `individual` user (demo-user) already holds an **ACTIVE** `individual` subscription, and `handleSelectPlan` correctly routes any non-canceled subscriber to the billing **portal** instead of a new checkout — so as that user the checkout path is unreachable by design, and a `waitForURL(/\/billing\/success/)` just times out at the unmocked portal call; (2) `seed.sql` ships `free`/`individual`/`professional`/`organization`, but `BILLING_PLAN_ORDER` renders only `free` + `individual_verified_*` — the paid pair exists in **prod only**, so the seeded catalogue's single rendered card is the $0 `free` one and clicking its "Select Plan" proves nothing about paying. 2026-08-10 (PR #2060, GH Actions run 31397351956). Note `maybeSingle()` in postgrest-js fetches as a **list** and enforces cardinality client-side, so "no row" is an empty **array**, not `null`. Pin the concrete `planId` in the assertion — `expect.any(String)` passes even when the click starts checkout for the free plan.
- **DO** treat the seeded current plan as load-bearing when asserting a `PricingCard` button: the card whose id matches the current plan renders a **disabled "Current Plan"**, not "Select Plan". demo-user is on `individual` (absent from `BILLING_PLAN_ORDER`), so nothing is marked current and `free` shows "Select Plan"; mock the subscription away and `free` becomes the fallback current plan and its button changes. `getByRole('button', { name: 'Select Plan' }).first()` silently re-targets when that shifts.

## Dependencies

- `@playwright/test` — test framework
- `@supabase/supabase-js` — service client for test data setup/teardown
- `dotenv` — loads `.env.test` in `playwright.config.ts`
- Environment variables (set in `.env.test`, see `.env.test.example`):
  - `E2E_SUPABASE_SERVICE_KEY` (required) — service role key for test data setup
  - `E2E_SEED_PASSWORD` (required) — shared password for seed test users
  - `E2E_SUPABASE_URL` (optional, defaults to `http://127.0.0.1:54321`)
- Local Supabase must be running with seed data loaded (`npx supabase db reset`)

---

Historical change log: [./agents-changelog.md](./agents-changelog.md)

## 2026-09-05 — SCRUM-4035 OAuth confirmation routing

`oauth-email-confirmation.spec.ts` runs via `playwright.uat03.config.ts` in CI before hosted-stack setup. Its seven real-app browser cases mock only external Auth/worker boundaries and verify pending routing without profile reads, delivery/retry, explicit proof confirmation, account switching/recovery, post-MFA authenticated routing, and mandatory MFA after confirmation. The default config excludes this separately executed fixture; no tests are conditionally skipped. Screenshots at 1280/375 are uploaded. This does not prove hosted Google consent or real mailbox receipt.

The synthetic session JWT must include an explicit `aal`. Post-MFA onboarding controls use `authenticated`/`aal2`; completing mailbox confirmation yields `authenticated`/`aal1` and must stop at mandatory MFA without reading `profiles`. A role-only `authenticated` fixture is not proof of product authority.
## PR #2637 soak closeout timing correction (2026-09-05)

The 12h UI window contained three failures and is preserved as failed evidence.
`mfa-harness-timing.spec.ts` reproduces premature helper completion on delayed
success/error using real browser DOM timing. MFA scenarios wait for completed
verification and asynchronous step-up outcomes. Their total 90s budget permits
two real RFC6238 step changes; individual action deadlines remain bounded.

The closeout suite additionally rotates a real GoTrue token through the browser
BroadcastChannel while the backup QR is visible, asserts the same QR/secret
survive, and requires the AAL downgrade challenge after factor removal. It covers
platform-admin enrollment plus ordinary-user and org-admin platform-route and
foreign-private-profile denials. Enrollment screenshots mask QR and secret data.

At375px the header account button is named by initials, because the full name
is hidden. MFA sign-out probes use the banner's menu trigger across widths;
they still click the real Sign out action and require a new-login challenge.

## 2026-09-11 — UAT-04 all-user MFA

Auth setup removes old fixture factors, performs real TOTP enrollment, and saves
only same-user `authenticated`/AAL2 sessions. The former 2099 enforcement-date
override is gone. Browser coverage pins direct `/login` and `/signup` AAL1
routing to the non-skippable gate for individual and organization users.

## Mandatory MFA and ordinary success fixtures

Billing reuses the real MFA session produced by `auth.setup.ts`. Disposable
profile flows complete MFA without changing their onboarding/profile state.
Direct tenant-isolation and entitlement tests borrow setup's AAL2 bearer; their
positive access checks must pass before a negative isolation result is meaningful.
The sign-out test uses its own real UI login and MFA enrollment, so signing out
cannot revoke a later test's saved seed session. Intentional AAL1 rejection tests
and `loginViaUi` retain their original authentication level.

## 2026-09-19 — UAT-12 secure-dialog acceptance

`secure-dialog-layout.spec.ts` verifies canonical self-service submission for
untagged and tagged child-organization documents, exact private-tag partitions,
instant/queue keyboard actionability, purchase/admin guidance, and durable
NEEDS_CREDIT/HELD recovery states at 1280px and 375px. Its isolated fixture mocks
only account and network boundaries; submissions are captured at the worker HTTP
boundary and rearm must reuse the original fingerprint.

UAT-23 spreadsheet layout evidence covers 1280×800, 375×812, 1280×480, and 375×480 through the standalone no-seed fixture.
