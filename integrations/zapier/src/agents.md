# integrations/zapier/src/agents.md

Zapier app source code (INT-05).

## Files
- **`index.ts`** — Zapier app entry point: registers authentication, triggers, and actions.
- **`authentication.ts`** — API key auth: user provides `ak_*` key, validated via health endpoint.
- **`constants.ts`** — `BASE_URL`, `DEFAULT_EVENTS`, `VALID_EVENTS`, `BATCH_SYNC_LIMIT`. (The webhook-event export is named `VALID_EVENTS`; `VALID_WEBHOOK_EVENTS` is the worker-side name it mirrors.)
- **`makecom.json`** — Make.com (Integromat) integration manifest.
- **`actions/`** — Zapier action definitions (anchorDocument, verifyCredential, batchVerify).
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
