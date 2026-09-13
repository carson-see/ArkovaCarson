# integrations/zapier/test/agents.md

Tests for the Zapier integration (INT-05).

## Files
- **`zapier.test.ts`** — integration tests for authentication, triggers, and actions.

## Conventions
- All Arkova API calls must be mocked.
- Run via `vitest` from the `integrations/zapier/` package root.

## DI-775 / SCRUM-3538 — the `VALID_EVENTS` pin, and what actually gates it

`zapier.test.ts` pins the full ordered `VALID_EVENTS` array against the worker allowlist. Two
caveats worth knowing before citing it as a guard:

- It is a hardcoded list, so it fires when someone edits `VALID_EVENTS` and forgets the pin — not
  when the worker registers a new event and this package stands still, which is the direction the
  `anchor.superseded` drift actually travelled.
- **No workflow runs this suite.** There is no CI job for `integrations/zapier`; these tests run
  only when someone runs `vitest` from the package root.

The PR-time gate for the same class is `scripts/ci/check-webhook-event-registration-drift.ts`, which
parses `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` and compares this package's constant against it from inside
the required root `Tests` job. Keep both — the pin gives a local edit a readable failure.

## 2026-09-05 — describe label corrected (PR #2589 review)

`describe('Verify Credential Action')` → `describe('Verify Anchor Action')`. The action itself was
renamed to `verify_anchor` on 2026-09-02 (see `../src/agents.md`, P10); the test's own label was
missed, so the suite still printed "Credential" on every run. No behaviour change — 24 tests, same
before and after.

The §1.3 guard immediately below it (`action display copy has no "credential" wording`) inspects
`key` / `display.label` / `display.description` on the app's actions; it does not and cannot see a
test file's own `describe` strings, which is why this one survived. The remaining `credential_type`
strings in `src/` are the frozen API field name, deliberately kept — see the P10 note in
`../src/agents.md`.

## 2026-09-12 — VALID_EVENTS pin extended (SCRUM-3982)

The `mirrors the worker allowlist exactly (drift guard)` case now expects
`attestation.created` and `attestation.revoked` at the end of the array. The pin
is order-sensitive (`toEqual`), and the worker appends new events rather than
inserting them, so a new event goes at the tail.

Unchanged caveat, worth restating: this pin is a hardcoded array in a workspace
that cannot import the worker constant, and no workflow runs this package's
suite on a pull request. It fires only when someone edits `VALID_EVENTS` and
forgets this list. The gate that keys off the source of truth is
`scripts/ci/check-webhook-event-registration-drift.ts`, inside the required root
`Tests` job.
