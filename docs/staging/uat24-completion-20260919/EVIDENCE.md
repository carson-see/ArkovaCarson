# UAT-24 local completion verification

Local code integration reviewed at `9de38a460` (full SHA pinned in the Draft).
Base: `5a9c3b392a53ccb405de7d8f2db65c88a7acfef3`, the release-owned PR2968
head. Subsequent evidence/screenshot-only commits do not assert new runtime
verification. No hosted deployment, migration application or actual soak.

## Independent root reruns on the integrated tree

Commands run from repository root unless a directory is shown.

| Command / directory | Observed result |
|---|---|
| `npx vitest run src/api/v1/folders-mounted-auth.test.ts src/api/v1/folders.test.ts src/api/v1/folders-deps.test.ts src/api/v1/folders.openapi.test.ts src/api/v1/anchor-submit.test.ts src/utils/anchorQuotaGate.test.ts src/auth.test.ts` in `services/worker` | 117 tests pass, including real locally signed JWTs through the mounted folder discriminator. |
| `npx vitest run src/hooks/useAnchors.test.ts src/hooks/useFolders.test.ts src/hooks/useOrgMembers.test.ts src/pages/MyRecordsPage.test.tsx src/pages/MemberDetailPage.test.tsx src/pages/RuleBuilderPage.folder-label.test.ts src/tests/migrations/0480-uat24-global-personal-folder-privacy.test.ts src/tests/migrations/0475-contractual-anchor-cap-atomic.test.ts scripts/ci/feedback-rules/secdef-function-grants.test.ts` | 94 tests pass. |
| `npx tsc -p tsconfig.build.json --noEmit` | Pass. |
| `npm run typecheck` and `npm run lint` in `services/worker` | Pass; lint enforces zero warnings. |
| `bash docs/staging/uat24-2026-09-14/run-native-check.sh` | Native assertions, historical folder rollback/reapply and concurrent cycle rejection pass; effective privacy stack0462/0464/0480. |
| `bash scripts/uat12/native-pg-anchor-quota.sh` | Daily and contractual one-winner contention, independent counters, duplicate zero charge, cross-scope conflict and NULL denial pass. |
| `npx playwright test --config e2e/uat24-folders.config.ts` | 4 tests pass at1280/375; six settled screenshots saved. |
| `npm test` in `packages/sdk` | 132 tests pass. |
| `npm test` in `packages/api-cli` | 21 tests pass, including prerequisite SDK CJS/ESM/declarations and CLI build. |
| `npm test` in `sdks/mcp-server` | 55 tests pass, including real stdio registration. |
| `npx vitest run src/mcp-tools.test.ts` in `services/edge` | 77 tests pass. |
| `uv run --isolated --no-project --with '.[dev]' python -m pytest -q` in `packages/arkova-py` | 189 tests pass. System Python lacked pytest; isolated dev dependencies used without changing the project lock/config. |
| `uv run --isolated --no-project --with '.[dev]' ruff check src tests` in `packages/arkova-py` | Pass. |
| `npx tsx scripts/ci/check-migration-prefix-uniqueness.ts` | No new collisions;15 grandfathered baseline collisions. |
| `npx tsx scripts/ci/check-doc-pointers.ts` | 1831 references resolve. |

Focused frontend ESLint and copy lint also pass. No repository-wide test-suite,
whole-schema replay, hosted KMS/Auth, live provider or production pass is claimed.

## Review findings closed locally

- Direct authenticated RLS leaked globally personal folders to platform admins;
 0480 restricts administrator reads to explicit organization context, preserving
 owner access and intended ancestor/platform contextual access.
- Active organization and exact membership role now govern records/folders;
 secondary-member drill-down/roster no longer depends on profile primary org.
 Failed moves remain selected/retryable. Realtime callbacks exclude wrong-scope,
 deleted and pipeline records, including stale subscription callbacks.
- Contextual personal folder creation and inherited subfolder disclosure agree
 with the submitted context. Global folders say owner-only; contextual folders
 disclose authorized administrator visibility.
- Python omitted parent is distinct from explicit null; ordinary folder writes
 are not automatically replayed. CLI and served/static OpenAPI gaps are closed.
- Worker lint caught a hand-written `.in()` chunk loop; replaced with the existing
 encoded-wire-byte-bounded helper. Initial screenshots were captured during
 opacity transitions; recaptured after actual animation completion and inspected.
- Fresh parent inventory found a collision with independently published0475;
 unpublished folder privacy migration and references moved to0480. Existing
 contractual-cap0475 bytes are preserved and its native tests rerun.

## Evidence limits and premortem

The browser fixtures execute production folder dialogs/sidebar and MemberDetail
components with mocked data/auth/network boundaries. They prove local layout,
disclosure, keyboard actionability and fixture behavior, not a live selected-org
switch, hosted RLS, provider connection or complete deployed application flow.
Unit tests cover delayed scope responses; actual scoped hosted flows remain in
the proposed soak start gates. Screenshots are in `screenshots/`.

Native fixtures use actual PostgreSQL roles/policies/functions on synthetic
minimal schemas. They are not a production schema clone or Supabase Auth proof.
The privacy baseline failure was demonstrated retrospectively after correction;
do not call that migration test chronological test-first evidence.

The root-authored [PLAN.md](./PLAN.md) was independently premortemed by the Sol
database reviewer and UI reviewer. Their findings prompted truthful connector
AUTO copy, selected-org rule saving, exact commands/counts and explicit browser
limitations. No unresolved blocking plan objection remains. It proposes an
exclusive exact-head T3 window of25 hours/301 complete cycles, not a started soak.

Release remains blocked on current-head CI and actual approved staging/schema/
soak/deployment admission. Keep the Draft and do-not-merge hold. Canonical Jira
and Confluence must distinguish this preparation checkpoint from release.
