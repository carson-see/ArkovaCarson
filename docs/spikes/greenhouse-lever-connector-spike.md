# SCRUM-1104 - Greenhouse / Lever Connector Spike

Date: 2026-04-24

## Decision

Go, but Greenhouse should be the first ATS MVP. Lever is viable as a follow-up once a design partner confirms they need Lever-specific document ingestion.

## Research Summary

- Greenhouse Harvest API supports candidate/application/offer workflows, Basic Auth with endpoint permissions, paginated responses, and rate-limit headers. Approved partner/custom integrations are limited by the `X-RateLimit-Limit` header per 10 seconds.
- Greenhouse recruiting webhooks include a `Signature` header computed as HMAC-SHA256 over the exact raw JSON body and a `Greenhouse-Event-ID` delivery id. Candidate attachments include `offer_letter` and `signed_offer_letter`; attachment URLs expire after 7 days and should be downloaded immediately.
- Lever API supports Basic Auth for customer keys and OAuth for partner apps. OAuth access tokens expire after one hour; refresh tokens expire after one year or after 90 days of inactivity.
- Lever webhooks cover candidate/opportunity lifecycle events such as stage change and hired. Webhooks created through the API can only be modified through the API, which affects customer support workflows.
- Lever supports PDF uploads and other document formats, but the public docs are less direct than Greenhouse for signed offer-letter retrieval.

## Proposed MVP

1. Start with Greenhouse Harvest + Recruiting Webhooks.
2. Store the Greenhouse Harvest API key in `org_integrations.encrypted_tokens` using the same KMS-backed pattern as other connector tokens.
3. Configure Greenhouse webhook events for candidate/application hired or offer transitions.
4. Verify the `Signature` HMAC over the raw body before parsing.
5. Use the application/candidate identifiers from the webhook to fetch application/candidate attachments and select `signed_offer_letter` first, then `offer_letter`.
6. Enqueue a sanitized `CONNECTOR_DOCUMENT_RECEIVED` event with `vendor = 'greenhouse'` plus a retryable `greenhouse.offer_letter_received` job for document bytes.

## Explicit Limitation

No live PoC was executed in this session because the repo/session does not contain a Greenhouse or Lever sandbox tenant, API credentials, webhook signing secret, or partner OAuth application. The acceptance alternative is this documented limitation: official docs support the implementation path, but the one-off offer-letter ingestion test requires Carson to provision a sandbox ATS tenant.

## v1.1 Effort Estimate

- Greenhouse-only MVP: 3-5 engineering days after sandbox access.
- Lever parity: 4-6 additional engineering days because OAuth setup, event selection, and document retrieval need separate validation.
- Shared multi-ATS abstraction: defer until both Greenhouse and Lever have production-shaped webhook/document flows.

## Risks

- Recruiting data is sensitive PII. Webhook handlers must persist sanitized metadata only and keep document bytes in transient worker handoff.
- Greenhouse attachment URLs are temporary; delayed jobs must fetch promptly or refetch the application/candidate attachment list.
- Greenhouse and Lever webhook signatures must be verified against the raw body before JSON parsing.
- Rate-limit behavior should honor provider reset headers and back off rather than polling.

## Reference Prospects

No customer calls were available inside this Codex session. Recommended validation list: two recruiting agencies using Greenhouse, one in-house talent team using Greenhouse, one Lever-based recruiting firm, and one hybrid Greenhouse/Lever consultancy.

## Sources

- Greenhouse Harvest API: https://developer.greenhouse.io/harvest.html
- Greenhouse Recruiting Webhooks: https://developers.greenhouse.io/webhooks.html
- Lever Developer Documentation: https://hire.lever.co/developer/documentation
