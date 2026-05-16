# e2e/fixtures/agents.md

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
