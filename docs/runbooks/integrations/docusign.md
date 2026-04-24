# DocuSign Connector Runbook

Story: SCRUM-1101 — CONN-V2-03 DocuSign connector

## Runtime Shape

- Admin OAuth uses DocuSign Authorization Code Grant with `signature extended openid email`.
- Connect sends completed-envelope notifications to `POST /webhooks/docusign`.
- The worker verifies `X-DocuSign-Signature-1` over the raw request body before parsing.
- Valid completed envelopes enqueue an `ESIGN_COMPLETED` rules event and a retryable `docusign.envelope_completed` job.
- The retry job uses `job_queue` with `max_attempts = 5`; failures back off exponentially and then park as `dead`.

## Secret Manager Values

Provision these as Cloud Run secrets, then redeploy the worker through the human-owned deploy path:

```bash
DOCUSIGN_INTEGRATION_KEY=
DOCUSIGN_CLIENT_SECRET=
DOCUSIGN_CONNECT_HMAC_SECRET=
DOCUSIGN_DEMO=true
```

Do not paste refresh tokens into logs, tickets, or Confluence. Refresh tokens are encrypted through `GCP_KMS_INTEGRATION_TOKEN_KEY` before persistence in `org_integrations.encrypted_tokens`.

## DocuSign Admin Setup

1. Create or select the Arkova DocuSign app/integration key.
2. Add the worker OAuth callback URL to allowed redirect URIs.
3. Enable Connect for the account and subscribe to `envelope-completed`.
4. Enable HMAC signing and copy the HMAC key into `DOCUSIGN_CONNECT_HMAC_SECRET`.
5. Set the Connect payload format to JSON.
6. Point Connect to `https://<worker-host>/webhooks/docusign`.

## Verification

1. Connect a sandbox DocuSign account through OAuth.
2. Complete a sandbox envelope.
3. Confirm `organization_rule_events` receives one sanitized `ESIGN_COMPLETED` event within two minutes.
4. Confirm `job_queue` receives one `docusign.envelope_completed` job.
5. Replay the same payload with one byte changed and the original signature; the worker must return `401`.
6. Force the eSignature document fetch to return `503`; the job should retry and eventually move to `dead` after five attempts.

## Operational Notes

- Unknown connected accounts return `200 { orphaned: true }` to avoid DocuSign retry storms.
- Missing `DOCUSIGN_CONNECT_HMAC_SECRET` returns `503` so Connect retries after the secret is fixed.
- Raw webhook payloads and signed PDFs are not persisted by the webhook route.
- New migrations were not required for this story; it uses `org_integrations`, `organization_rule_events`, and `job_queue`.
