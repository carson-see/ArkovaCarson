# agents.md — test
_Last updated: 2026-07-28_

## What This Folder Contains

Global Vitest setup file loaded before all frontend tests. Not to be confused with `src/tests/` (integration/security test suites).

## Key Files
- `setup.ts` — polyfills `File.arrayBuffer`, `File.text`, and `crypto.subtle` for jsdom; imports `@testing-library/jest-dom` matchers. 2026-07-28 (L2-A5): the `crypto` mock also gained `randomUUID()` — jsdom doesn't implement it, and `AdminOrganizationsPage.tsx`'s credit-adjust idempotency key (and any future client-side idempotency-key code) needs a real-shaped UUID under test.

## Do / Don't Rules
- DO: Add jsdom polyfills here when the test environment lacks browser APIs
- DON'T: Put individual test files here — this folder is setup-only
