# integrations/zapier/agents.md

Zapier integration for Arkova (INT-05). Enables no-code automation of document anchoring and verification.

## Structure
- **`src/`** — Zapier app definition: authentication, actions, triggers, constants.
- **`test/`** — integration tests.
- **`vitest.config.ts`** — test runner config.
- **`package.json`** — standalone package; targets Zapier platform v18.6.0.

## Conventions
- Auth: API key (`ak_*`) validated via `GET /api/v1/health`.
- Triggers use REST hooks (webhook subscribe/unsubscribe); not polling.
- Never call real Arkova APIs in tests.

## 2026-09-05 — clean-install lockfile repair (SCRUM-4464)

The inherited lockfile placed `picomatch@2.3.2` at the top level where a peer
requires 4.x, and omitted the nested 2.x dependency needed by `micromatch`.
Node 22 `npm ci` failed before any test could run. The reconciled lock resolves
4.0.7 at the top level and 2.3.2 under `micromatch`; package declarations and
existing native `libc` constraints are preserved. Clean installation, all 24
tests, and the package build pass. Keep the lock installable with `npm ci`;
an existing dependency directory is not evidence that a fresh install works.
