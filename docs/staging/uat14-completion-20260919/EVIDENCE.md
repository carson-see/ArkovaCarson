# UAT-14 local verification evidence

Candidate integration head includes local UAT-14 commit `04118acd8`, merge of
published UAT-19 head `a73f7dd4cf9ca6536f181b0d133860d03d0bb39a`, and the corrective CAS/cleanup
changes in the final local commit. No hosted migration, deployment, soak, or
remote publication was performed by this lane.

## Commands and results

- `npm test -- --run src/lib/profileMedia.test.ts src/components/shared/ProfileMediaImage.test.tsx src/pages/PublicProfilePage.test.tsx src/hooks/usePublicSearch.test.ts src/hooks/useProfile.test.ts src/hooks/useOrganization.test.ts src/lib/validators.test.ts src/components/dashboard/ProfileCard.test.tsx src/pages/OrgProfilePage.test.tsx src/pages/AnchorQueuePage.test.tsx src/components/folders/MoveToFolderDialog.test.tsx src/components/organization/OrgRegistryTable.test.tsx src/hooks/useOrgProfileFolders.test.tsx` — 13 files, 180 tests passed.
- `npm test -- --run src/hooks/useProfile.test.ts src/hooks/useOrganization.test.ts src/lib/profileMedia.test.ts src/components/shared/ProfileMediaImage.test.tsx` — 4 files, 43 tests passed after the CAS/cleanup correction.
- `npx playwright test -c e2e/uat14-profiles.config.ts` — 6 tests passed at 1280 and 375 pixels.
- `bash scripts/uat14/native-pg-profile-media.sh` — passed owner/write isolation, AAL, public-toggle, suspension, exact ACL, and actual anon v2 probes.
- `bash docs/staging/uat24-2026-09-14/run-native-check.sh` — passed rollback, RLS assertions, and concurrent-cycle checks after integration.
- `npx vitest run scripts/ci/feedback-rules/secdef-function-grants.test.ts src/tests/migrations/0480-uat24-global-personal-folder-privacy.test.ts` — 2 files, 57 tests passed.
- `npx tsc -p tsconfig.build.json --noEmit` — passed.
- Focused `npx eslint --max-warnings 0` across changed UAT-14 hooks, media helpers, tests, Settings, and organization profile — passed.
- `git diff --check` — passed.

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
