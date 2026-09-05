# integrations/bullhorn/src/agents.md

Bullhorn ATS connector source code (INT-07).

## Files
- **`connector.ts`** — `BullhornConnector` class: authenticated REST API client for candidate records, file attachments, and custom field updates.
- **`candidate-tab.ts`** — `CandidateVerificationTab`: custom tab showing credential verification status, one-click anchoring, and summary metrics.
- **`webhook-handler.ts`** — `BullhornWebhookHandler`: processes Bullhorn subscription events for automatic verification on new file uploads.
- **`types.ts`** — TypeScript interfaces: `BullhornConfig`, `BullhornCandidate`, `BullhornCredential`, etc.
- **`index.ts`** — barrel export.

## Conventions
- Documents are fingerprinted client-side; only hashes are sent to Arkova.
- Custom field IDs (`verificationStatusFieldId`, `verificationCountFieldId`) are configurable per deployment.

## 2026-09-05 — shared constant-time compare; unset secret no longer silent (PR #2589 review)

- **`constantTimeEqual` moved to `integrations/shared/src/constant-time.ts`.** It was a private copy
  here; Clio's signature check needed the same primitive, and two hand-written timing-safe compares
  are two chances to get the no-early-exit property wrong. `webhook-handler.ts` now imports it and
  **re-exports the name**, so `import { constantTimeEqual } from '../src/webhook-handler'` (which
  `test/bullhorn.test.ts` does) still resolves. The relative import `../../shared/src/constant-time`
  resolves under both this package's vitest and its `tsc --noEmit` — `shared/` sits outside this
  tsconfig's `include`, but TypeScript follows imports beyond `include`, and `noEmit` means nothing
  lands outside `rootDir`.
- **`webhookSecret` absent now warns once at construction.** The field is optional and
  `verifyInboundSecret` fails closed without it — correct, and *silent*: a deploy that forgot to set
  the secret answers 100% of genuine Bullhorn events `rejected_unauthenticated`, which is
  indistinguishable on the wire from an attacker being turned away. Behaviour is unchanged (the
  existing fail-closed tests still pass verbatim); the only addition is a `console.warn` naming
  `webhookSecret`, the resulting `rejected_unauthenticated` action, and the
  `x-arkova-webhook-secret` header. **The secret's value is never printed** — only the fact that it
  is absent — and a test asserts no config value (secret, REST token, or API key) appears in the
  warning.

Suite is 20 tests. Run with `npx vitest run` from `integrations/bullhorn/`.
