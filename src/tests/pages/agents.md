# agents.md — tests/pages
_Last updated: 2026-05-16_

## What This Folder Contains

Page-level contract tests that assert URL parameter parsing and deep-link behavior for specific routes. These are pure-logic tests (no DOM rendering).

## Key Files
- `my-records-url-params.test.ts` — validates the `/my-records?action=upload&credential_type=...` deep-link contract used by the compliance scorecard (NCA-FU2c); asserts param reading and scrubbing

## Do / Don't Rules
- DO: Add a test here when a page exposes a URL-param contract that other features depend on
- DON'T: Test DOM rendering here — use component tests or E2E specs for that
