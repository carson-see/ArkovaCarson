# e2e/fixtures/agents.md

## SCRUM-4448 — development-only securing layout entry

`secure-dialog-layout.html` and `secure-dialog-layout.tsx` mount the actual securing dialog/CSS in an isolated MemoryRouter for browser geometry tests. Vite serves this HTML entry only during development; the production build starts from the root application entry and does not include the fixture. External boundaries are provided by the Playwright helper. This intentionally does not use the authenticated fixture barrel or seed accounts, per the isolated headless UI testing directive.

## 2026-09-13 — `ner-dev-load.html` / `ner-dev-load.tsx` (new)

Minimal dev-server-only entry (same non-production-served pattern as the securing-layout fixture above) that calls `__loadRealTransformersModuleForE2E` from `src/lib/nerPiiDetector.ts` and writes `OK:...` / `FAIL:...` to `#out`. Backs `e2e/ner-dev-load.spec.ts` — pins the 2026-09-13 founder-reported Secure Document Continue regression at its real root cause (see `src/lib/agents.md`). No auth/Supabase boundary needed; this only exercises the client-side model-bundle-loading step.

Playwright test fixtures providing authenticated page contexts and Supabase helpers for E2E tests.

## Files
- **`index.ts`** — barrel export. Import `{ test, expect }` from here in all E2E specs.
- **`auth.ts`** — Playwright fixtures for pre-authenticated sessions (`individualPage`, `orgAdminPage`, `orgBAdminPage`) using saved storageState from `e2e/auth.setup.ts`.
- **`supabase.ts`** — Supabase service client helpers for test data setup/teardown (`getServiceClient`, `createTestAnchor`, `deleteTestAnchor`, `SEED_USERS`).
- **`seed-anchors.ts`** — helpers to seed and cleanup anchor test data sets.

## Conventions
- Never hardcode credentials; use env vars (`E2E_SUPABASE_URL`, etc.).
- All E2E specs should import from `./index.ts`, not individual fixture files.
- Auth uses pre-saved storageState (no per-test login flows).
