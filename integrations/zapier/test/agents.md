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
