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
