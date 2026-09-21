# UAT-19 local review and verification

Canonical story: [SCRUM-5268](https://arkova.atlassian.net/browse/SCRUM-5268).
Documentation: [Confluence153256009](https://arkova.atlassian.net/wiki/spaces/A/pages/153256009).
This is draft-preparation evidence, not a hosted migration, actual soak or release.

## Candidate and independent review

Implementation commit `49c9c449c` was merged with reviewed UAT-24
`62afcd3557ff593098ac9f84b358bc7ced450641` at
`e1a98b3eb5cfaf9508641bfd04b954a4eaf9ff73`. Published UAT-24 contains the reviewed
PR2968 parent `5a9c3b392a53ccb405de7d8f2db65c88a7acfef3`, including immutable
contractual-cap0475. UAT-19 adds0477; it does not edit that published migration.
Final publication binds its exact head separately; later test/evidence changes
do not create new hosted observations.

GPT-5.6 Sol implemented; root independently inspected authorization, SQL lock
ordering, stale UI results and recovery, reran tests and inspected browser images.
A second Sol reviewer found additional queue identity and empty-context failures;
those were reproduced and corrected before publication. This is AI-team code
review, not a human release approval.

Review fixes include exact organization filters for member records and CSV,
caller/authority-keyed folder caching, failed bulk-move retention, stale route
guards, pre-lookup resolve authorization, deleted-candidate exclusion and
post-response notification isolation. Approved-parent authority no longer
depends on the caller's primary profile. Valid exact memberships without a
primary profile can reach the queue; malformed/empty explicit context cannot
fall back to another scope. Polling cannot leave successful mutations busy.

Root's added rejection test first failed with an unhandled promise and missing
alert; the shared move dialog now contains failure, shows generic existing copy
and allows explicit retry. Explicit incomplete results also stay open with an
alert. Parent integration preserves contextual creation and member read-only
controls. ACL baseline burn-down removes only the obsolete resolver exception
now corrected by0477; no gate is weakened.

## Executed checks

Run from repository root unless noted. These are focused checks, not a claim
that the entire repository or every hosted CI provider is green.

```sh
npx vitest run src/pages/AnchorQueuePage.test.tsx src/pages/OrgProfilePage.test.tsx src/pages/OrgProfilePageAffiliates.test.tsx src/components/folders/FolderSidebar.test.tsx src/components/folders/MoveToFolderDialog.test.tsx src/components/organization/OrgRegistryTable.test.tsx src/hooks/useOrgProfileFolders.test.tsx src/hooks/useExportAnchors.test.ts src/pages/MyRecordsPage.test.tsx scripts/ci/feedback-rules/secdef-function-grants.test.ts src/tests/migrations/0480-uat24-global-personal-folder-privacy.test.ts src/tests/migrations/0475-contractual-anchor-cap-atomic.test.ts --maxWorkers=2
npx tsc -p tsconfig.build.json --noEmit
```

Root rerun: **12 files,157 tests PASS**, build TypeScript PASS.

From `services/worker`:

```sh
npm test -- --run src/api/queue-resolution-pending.test.ts src/api/queue-resolution.test.ts src/api/collision-context.test.ts src/routes/queue-resolution-mounted.test.ts src/api/v1/folders-mounted-auth.test.ts src/api/v1/folders.test.ts src/api/v1/folders-deps.test.ts src/api/v1/anchor-submit.test.ts src/utils/anchorQuotaGate.test.ts --maxWorkers=2
npm run typecheck
npm run lint
npx vitest run src/api/queue-resolution-pending.test.ts src/api/queue-resolution.test.ts src/api/collision-context.test.ts src/routes/queue-resolution-mounted.test.ts --maxWorkers=2 --coverage.enabled --coverage.include=src/api/queue-resolution.ts --coverage.include=src/api/collision-context.ts --coverage.reporter=text
```

Root rerun: **9 files,174 tests PASS**, TypeScript and full worker zero-warning
lint PASS. Targeted coverage run: **77 tests PASS;86.72% statements,82.35%
branches,100% functions,86.79% lines** across both changed queue handlers.
Mounted tests use the actual JWT verifier and locally signed JOSE AAL1/AAL2,
expired/missing/malformed tokens. Database/provider calls are controlled doubles,
not hosted Auth proof.

```sh
bash scripts/uat19/native-pg-queue-resolution.sh
bash docs/staging/uat24-2026-09-14/run-native-check.sh
npx playwright test -c e2e/uat19-org-profile.config.ts
npx tsx scripts/ci/check-doc-pointers.ts
npx tsx scripts/ci/check-migration-prefix-uniqueness.ts
npx tsx scripts/ci/check-hot-table-ddl-lock-timeout.ts
npm run lint:copy
git diff --check
```

Root native PASS: secondary/no-primary and approved-parent authority;
same-selection one receipt/audit; competing selections one winner without
deadlock; revoked waiter denied with zero mutation; unrelated collision set
completes while another set lock remains held. The minimal runner emits a
`SET LOCAL` outside-transaction warning for0477's non-hot-DDL preamble; it is not
a production migration rehearsal. UAT-24 native privacy/rollback/reapply and
concurrent-cycle assertions also PASS in the integrated tree.

Browser **4/4 PASS** at1280x800 and375x812. Actual OrgProfile, registry, folder
dialogs and AnchorQueuePage are exercised. Network/auth are mocked and Secure
Document internals are stubbed; canonical securing remains inherited UAT-12
evidence, not proven by this browser fixture. Screenshots are synthetic and must
not be represented as hosted data. Doc pointers1832 resolve, no new migration
prefix collisions (15 grandfathered), no new hot-table DDL violations, and copy
lint PASS. Root caught a new exhaustive-deps warning in the scope restart;
the correction genuinely binds completions to the captured caller/org scope key,
without suppressing the rule. Root's final rerun passed all157 tests, build
TypeScript and zero-warning queue-page lint. The final browser rerun passed4/4.

Seven unmodified synthetic screenshots are pinned in [screenshots](screenshots/),
including actual organization profiles at1280/375, queue views, member read-only
views and the desktop partial-move error. Root visually inspected the desktop
profile, partial failure and mobile member layout. Failed IDs remain in the
open move dialog's retry state; registry remount clears checkbox selection, so
the browser evidence does not claim that selected checkboxes remain visible.

## Remaining release gates

The [PLAN](PLAN.md) is independently premortemed and proposes an exclusive clean
rig, exact-head identities,25 hours and at least301 complete five-minute cycles,
targeted authority/concurrency/privacy probes and safe rollback. **Not started.**
Whole-schema migration replay, hosted Auth, real staged worker flows, actual
soak and release admission are separate gates. No real email, provider import,
network securing, payment, hosted schema/configuration, queue or deployment was
changed by this work. Historical parent exceptions do not authorize this head.
