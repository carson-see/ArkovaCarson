# UAT-14 local verification evidence

Candidate integration head includes local UAT-14 commit `04118acd8`, merge of
published UAT-19 head `a73f7dd4cf9ca6536f181b0d133860d03d0bb39a`, and the corrective CAS/cleanup
changes in the final local commit. No hosted migration, deployment, soak, or
remote publication was performed by this lane.

## Commands and results

- `npm test -- --run src/lib/profileMedia.test.ts src/components/shared/ProfileMediaImage.test.tsx src/pages/PublicProfilePage.test.tsx src/hooks/usePublicSearch.test.ts src/hooks/useProfile.test.ts src/hooks/useOrganization.test.ts src/lib/validators.test.ts src/components/dashboard/ProfileCard.test.tsx src/pages/OrgProfilePage.test.tsx src/pages/AnchorQueuePage.test.tsx src/components/folders/MoveToFolderDialog.test.tsx src/components/organization/OrgRegistryTable.test.tsx src/hooks/useOrgProfileFolders.test.tsx` — 13 files, 180 tests passed.
- `npm test -- --run src/hooks/useProfile.test.ts src/hooks/useOrganization.test.ts src/lib/profileMedia.test.ts src/components/shared/ProfileMediaImage.test.tsx` — 4 files, 43 tests passed after the CAS/cleanup correction.
- Final focused CAS race/cleanup rerun (`profileMedia`, `useProfile`, and
  `useOrganization`) — 3 files, 37 tests passed, including null/non-null
  preconditions, one-winner two-contender replacement, and both Storage cleanup
  failure shapes.
- `npx playwright test -c e2e/uat14-profiles.config.ts` — 6 tests passed at 1280 and 375 pixels.
- `bash scripts/uat14/native-pg-profile-media.sh` — passed owner/write isolation, AAL, public-toggle, suspension, exact ACL, and actual anon v2 probes.
- `bash docs/staging/uat24-2026-09-14/run-native-check.sh` — passed rollback, RLS assertions, and concurrent-cycle checks after integration.
- `npx vitest run scripts/ci/feedback-rules/secdef-function-grants.test.ts src/tests/migrations/0480-uat24-global-personal-folder-privacy.test.ts` — 2 files, 57 tests passed.
- `npx tsc -p tsconfig.build.json --noEmit` — passed.
- Focused `npx eslint --max-warnings 0` across changed UAT-14 hooks, media helpers, tests, Settings, and organization profile — passed.
- `git diff --check` — passed.

## Root final independent verification

Root reviewed the integrated UAT-19/UAT-24 union and reproduced the failure
paths before publication. Corrective commits through
`5e470cb36a1eb262421afb7960f07484a478779a` address silent zero-row profile
updates, expected-old-pointer CAS for user/org replacement, both resolved and
rejected Storage cleanup errors, same-file retry and unsafe relative fallbacks.
The CAS test uses controlled outcomes for two competing replacements; it is not
a hosted Storage transaction or native concurrency test.

Root reran the 13-file command above with `--maxWorkers=2`: **189 tests PASS**.
Build TypeScript and zero-warning focused ESLint passed. Native profile-media
and inherited UAT-24 runners passed, including actual anonymous v2 reads,
private/inactive/deleted denials, exact per-function grants and no implicit
PUBLIC execute. Security/migration checks passed **57/57**. Browser **6/6**
passed; doc pointers (1,832), migration-prefix, hot-table DDL and copy gates
passed with no new violations. Historical baselines are not new waivers.

Root visually inspected mobile Settings, desktop organization editor and mobile
public profile artifacts. Root also decoded the two mobile screenshot QR codes
using local macOS Vision: `https://app.arkova.ai/profile/person-public` and
`https://app.arkova.ai/issuer/33333333-3333-4333-8333-333333333333`, matching
the canonical personal and organization routes rather than localhost/preview.
A second Sol reviewer independently reviewed media
ACLs, cleanup/concurrency behavior and the proposed soak plan. This is AI-team
code review, not human release approval. The PLAN is bound to exact published
parent `a73f7dd4cf9ca6536f181b0d133860d03d0bb39a`; the PR body records the
final evidence-only commit SHA. No actual soak has started.

## Browser boundary and artifact limits

The editor tests render the production Settings and organization-profile
controls and use Chromium's real `createImageBitmap` and `OffscreenCanvas`.
They intercept Auth/data/Storage boundaries, proving request paths, sanitized
PNG upload content type, pointer payloads, same-file reset, malformed-image
no-upload behavior, and privacy-control requests—not hosted Supabase signing,
expiry, Auth, RLS, or object cleanup. The checked-in public/editor screenshots
are local fixture artifacts and remain unchanged after inspection.

Direct authorized Storage clients can bypass browser-only decode/re-encode and
dimension validation; the private bucket's PNG MIME and 2 MB limits do not
inspect image bytes. Previously issued signed URLs retain their bounded lease,
and legacy HTTPS fallbacks expose the viewer IP to their remote host despite
the no-referrer policy. Those limits require the hosted probes and observation
window described in `PLAN.md`.
