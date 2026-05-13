# agents.md — src/
_Last updated: 2026-05-12 (React 19 / Tailwind CSS 4 + routine dependency consolidation)._

## What This Folder Contains

React 19 frontend application — TypeScript + Tailwind CSS 4 + shadcn/ui + Vite bundler.

## Architecture

- **23 feature domain folders** in `src/components/` (e.g., anchors, billing, admin, auth)
- **Route-level code splitting** via `React.lazy` — 60+ pages
- **State management:** Supabase-centric (no Redux/Zustand). Custom hooks (`useAnchors`, `useBilling`, etc.) query Supabase directly.
- **Auth:** `useAuth()` + `useProfile()` React Context providers
- **UI copy:** Centralized in `src/lib/copy.ts` — CI enforced via `npm run lint:copy`
- **Rule wizard validation:** `src/lib/ruleSchemas.ts` mirrors only required client-side checks; worker Zod schemas stay authoritative.
- **Design system:** "Precision Engine" — see `docs/reference/BRAND.md`
- **Routing:** react-router-dom v6, named routes in `src/lib/routes.ts`

## Constitution Rules (Immutable)

- **1.6 — Documents NEVER leave the browser.** `generateFingerprint`, `piiStripper`, OCR all run client-side only. Never import these in `services/worker/`.
- **1.3 — No crypto jargon** in user-facing strings. Banned: Wallet, Gas, Hash, Block, Transaction, Crypto, Blockchain, Bitcoin, Testnet, Mainnet, UTXO, Broadcast. See `src/lib/copy.ts`.

## Do / Don't Rules

- **DO** put all UI strings in `src/lib/copy.ts`
- **DO** use Zod validators from `src/lib/validators.ts` before any DB write
- **DO** query Supabase via custom hooks — never `useState` arrays for DB data
- **DO** use `React.lazy` for new route-level pages
- **DON'T** add Redux, Zustand, or other global state libraries
- **DON'T** use `supabase.auth.admin` or service role key in browser code
- **DON'T** import `generateFingerprint` outside `src/` (client-side only)
- **DON'T** set `anchor.status = 'SECURED'` from client code — worker-only
- **DON'T** expose `user_id`, `org_id`, or `anchors.id` publicly — use `public_id`

## Recent Changes

- **SCRUM-694 / SCRUM-915 — React 19 + Tailwind CSS 4 dependency consolidation** (2026-05-12): Consolidates Dependabot PRs #767, #768, and #769 into one migration branch. React/React DOM and types are on 19.x; Tailwind now uses the CSS-first v4 entrypoint in `src/index.css`, `@tailwindcss/postcss`, and `@theme` tokens instead of `tailwind.config.ts`. Deprecated v3 focus/shrink utilities were migrated and the Nordic Vault token regression test now validates CSS theme tokens directly.
- **Routine dependency consolidation** (2026-05-12): Root dependency batch from PRs #770/#771 updated Sentry React, React Query, Tailwind Merge, Playwright, Sentry Vite plugin, Workers types, TypeScript-ESLint, Vite, Vitest, Wrangler, and Node/V8 coverage types. `src/types/database.types.ts` now includes `org_credits`, matching the committed schema used by billing/quota code. `src/tests/drop-search-overload.test.ts` ignores generated `dist/` output so the root test suite stays green after worker builds.
- **SCRUM-1787 — Role-aware home navigation** (2026-05-08): Sidebar logo uses `useProfile().destination` + `destinationToRoute()` for role-aware home routing. Previously hardcoded to `/search`. Now routes to `/dashboard`, `/onboarding/role`, `/onboarding/org`, or `/review-pending` based on user state. Implementation in `src/components/layout/Sidebar.tsx`.
- **SCRUM-1788 — Search verification** (2026-05-08): Added privacy gate tests for `useOrgProfile`, `usePublicMemberProfile`, and `useOrgSubtree` hooks. Verifies `is_public_profile` anonymization in org profiles and 404 behavior for non-public member profiles. 8 search surfaces documented with RLS isolation evidence and p95 < 200ms response-time threshold.
- **SCRUM-1789 — Upload flow verification** (2026-05-08): Added 14 tests for FileUpload routing (single, multi, CSV, XLSX, helper functions). 7 upload surfaces documented. Client-side SHA-256 fingerprinting (Constitution 1.6), bulk BATCH_SIZE=10 processing, credential issuance three-layer gating all verified.
- **SCRUM-1790 — Login/signup verification** (2026-05-08): Added 15 tests for LoginForm component covering email/password login, Google/LinkedIn OAuth button wiring, forgot password flow (resetPasswordForEmail with redirectTo, success message, back navigation), conditional signup link, and onSuccess callback. 5 auth surfaces documented.

## Testing

- Vitest for unit/integration tests
- Playwright for E2E (`e2e/` directory)
- Coverage: `@vitest/coverage-v8`, 80% thresholds on critical paths
- RLS test helpers: `src/tests/rls/helpers.ts` (`withUser()` / `withAuth()`)

## Dependencies

- `react`, `react-dom` — UI framework
- `@supabase/supabase-js` — database + auth
- `react-router-dom` — routing
- `tailwindcss` + `@tailwindcss/postcss` + `shadcn/ui` + `lucide-react` — styling + components + icons
- `zod` — validation
- `pdf.js` + `tesseract.js` — client-side OCR
- `vite` — bundler
