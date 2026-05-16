# agents.md — services/worker/src/api/v1/__test-helpers__/

_Last updated: 2026-05-16_

## What This Folder Contains

Shared test fixture builders for v1 API test suites. Extracted to avoid SonarCloud CPD duplication flags.

| File | Purpose |
|------|---------|
| `build-anchor.ts` | `buildTestAnchor()` — returns a 33-field `AnchorByPublicId` fixture with optional overrides |

## Do / Don't Rules

- **DO** use `buildTestAnchor()` in all v1 test files that need an anchor fixture
- **DO NOT** duplicate anchor fixture construction inline in test files
