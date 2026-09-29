# integrations/zapier/src/agents.md

Zapier app source code (INT-05).

## Files
- **`index.ts`** — Zapier app entry point: registers authentication, triggers, and actions.
- **`authentication.ts`** — API key auth: user provides `ak_*` key, validated via health endpoint.
- **`constants.ts`** — `BASE_URL`, `DEFAULT_EVENTS`, `VALID_EVENTS`, `BATCH_SYNC_LIMIT`. (The webhook-event export is named `VALID_EVENTS`; `VALID_WEBHOOK_EVENTS` is the worker-side name it mirrors.)
- **`makecom.json`** — Make.com (Integromat) integration manifest.
- **`actions/`** — Zapier action definitions (anchorDocument, verifyAnchor, batchVerify).
- **`triggers/`** — Zapier trigger definitions (anchorSecured, anchorRevoked).

## Conventions
- All actions hit the `/api/v1/` endpoints with `X-API-Key` header.
- Batch verify is capped at `BATCH_SYNC_LIMIT` (20) credentials per request.
- `credential.*` webhook events require explicit opt-in (SCRUM-1743).

## DI-775 / SCRUM-3538 — `VALID_EVENTS` is a mirror, not a picker

`VALID_EVENTS` mirrors the worker's `VALID_WEBHOOK_EVENTS`, which is derived from
`PAYLOAD_SCHEMAS_BY_EVENT_TYPE` in `services/worker/src/webhooks/payload-schemas.ts`.
`anchor.superseded` was added to it here after being dispatchable and subscribable in the worker
since SCRUM-2937.

Do not read that as "a Zap author can now select supersession." Nothing in this app consumes
`VALID_EVENTS` — `triggers/anchorSecured.ts`, `triggers/anchorRevoked.ts` and each `makecom.json`
module subscribe with a hardcoded `events` array, so the packaged integration still exposes exactly
two events. Broadening that is separate work; this constant only keeps the documented supported set
honest.

Drift is gated by `scripts/ci/check-webhook-event-registration-drift.ts` (runs in the required root
`Tests` job). The pin in `../test/zapier.test.ts` is a second, local check — no workflow runs this
package's suite, so it is not a CI gate on its own.

## 2026-09-02 — "Credential" removed from action labels (SCRUM-3901 / epic SCRUM-3894)

`actions/verifyCredential.ts` → `actions/verifyAnchor.ts` (`verifyAnchorAction`, key `verify_anchor`);
labels/descriptions no longer say "Credential" ("Verify Anchor", "Batch Verify Anchors"). Zapier
exposes labels to AI-action tool pickers, so the same collision that caused BUG-2026-09-02-001 applied.
The `credential_type` FIELD is unchanged (it mirrors the API). Safe: the app was never registered on
the Zapier platform (`.zapierapprc` absent), so no live Zap references the old key.

## 2026-09-12 — attestation events added to VALID_EVENTS (SCRUM-3982)

`constants.ts` `VALID_EVENTS` gained `attestation.created` and
`attestation.revoked`, appended after `compliance.document_expiring` so the
array matches the worker's `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` declaration order —
`scripts/ci/check-webhook-event-registration-drift.ts` compares this surface as
an ORDERED list, and `test/zapier.test.ts` pins it with `toEqual`.

Nothing in this app reads `VALID_EVENTS`, and no packaged trigger subscribes to
either event, so listing them mirrors the worker allowlist rather than shipping
a new Zap. `attestation.revoked` additionally has no reachable producer yet.

## 2026-09-19 — Finality webhook triggers

`VALID_EVENTS` includes the two registered public-only finality events,
`anchor.revocation_anchored` and `attestation.active`.

## 2026-09-21 — BASE_URL moved to the public API gateway (SCRUM-3888)

`BASE_URL` (and `src/makecom.json`'s `baseUrl`) moved from the raw Cloud Run
revision host to `https://api.arkova.ai`. The raw host has no Cloudflare
origin guard in front of it (CLAUDE.md §1.1); SCRUM-3888 enforces that guard
and will 403 direct requests to it, so every client default had to move.
Same fix, same day, across `integrations/shared/src/constants.ts`,
`integrations/clio/src/{cle-compliance,sidebar-widget}.ts` (now import the
shared constant instead of redeclaring it — see `integrations/shared/src/agents.md`),
`integrations/bullhorn/src/candidate-tab.ts` (same), `packages/sdk`, and
`packages/embed`. A repo-wide regression guard,
`scripts/ci/check-run-app-host-literal.ts`, now fails CI on any new raw-host
literal outside its explicit, reasoned allowlist — see that file's own
agents.md note.
## 2026-09-26 — registry mirror only

`VALID_EVENTS` mirrors all worker-subscribable webhook names, including the four agent lifecycle events. This enables subscription validation but does not add a new Zapier trigger. Keep it in canonical order for `check-webhook-event-registration-drift.ts`.
