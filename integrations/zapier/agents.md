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

## 2026-09-12 — attestation events mirrored (SCRUM-3982)

`VALID_EVENTS` gained `attestation.created` and `attestation.revoked`, appended
after `compliance.document_expiring` to match the worker's declaration order
(`test/zapier.test.ts` pins the array with `toEqual`). This constant is the
mirror of the worker allowlist; nothing in this app reads it, and no packaged
trigger subscribes to either event, so listing them does not by itself give a
Zap author a way to pick them. `attestation.revoked` in particular has a
registered schema but no reachable producer yet — see
`services/worker/src/webhooks/agents.md`.

## 2026-09-14 — reproducible CLI 19 build (PR #2945)

Reproduced clean-install failure on both the original PR and its Mergify
speculative head: Vitest 5's required Vite peer tree was missing from the lock.
Reconcile with stock npm and verify from an empty dependency directory; do not
use legacy peer resolution or an existing node_modules directory as proof.
TypeScript 7 removed the old Node resolver. This CommonJS package uses the
paired Node16 module and resolution modes, preserving CommonJS output. The
review checks include clean install, 24 tests, build and local Zapier validation.
Zapier publication and real Zaps remain separate from these local checks.
