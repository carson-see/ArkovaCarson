# SCRUM-1103 — Clio Connector Spike

Date: 2026-04-24

## Decision

Go, with a narrow MVP: Clio Manage document ingestion only. Defer matter/contact sync, billing, custom actions, and Clio Grow until after one law-firm design partner validates the document workflow.

## Research Summary

- Clio Manage API v4 supports OAuth 2.0, region-specific API hosts, fields selection, pagination, ETags, and API minor version headers. Official docs: https://docs.developers.clio.com/clio-manage/api-reference/
- Clio exposes webhooks for models including `document`, `folder`, and `matter`; webhook activation uses a `X-Hook-Secret` header. Official docs: https://docs.developers.clio.com/clio-manage/api-reference/
- Clio rate limits are per access token. The published default during peak hours is 50 requests per minute, with `X-RateLimit-*` and `Retry-After` headers. Official docs: https://docs.developers.clio.com/api-docs/rate-limits
- API v4 supports multiple data regions: US, EU, Canada, and Australia. A connector must store the tenant region/base URL at connection time.

## Proposed MVP

1. OAuth connect flow stores encrypted refresh tokens in `org_integrations`.
2. Admin chooses region at connect time or the callback stores the discovered region host.
3. Webhook subscription watches Clio `document` updates for the connected account.
4. Webhook handler validates Clio's activation/delivery secret, resolves the document metadata, and enqueues a sanitized `CONNECTOR_DOCUMENT_RECEIVED` event with `vendor = 'clio'`.
5. A retryable `clio.document_received` job fetches document bytes and passes them to the same injected sink pattern used by the DocuSign connector.

## Explicit Limitation

No live PoC was executed in this session because the repo does not contain Clio sandbox credentials, a registered Clio developer app, or tenant consent. The spike acceptance alternative is documented here: the implementation path is feasible from official docs, but a live "one document into Arkova queue" test must wait for Carson to provision a Clio developer app and sandbox firm account.

## Risks

- Rate limit headroom is tight for firms with large document backfills. MVP should be event-driven and avoid polling except for reconciliation.
- Legal documents are sensitive. The connector should persist only sanitized metadata and keep document bytes in the worker handoff path.
- Region selection is a real tenant boundary. Never infer US default after OAuth without checking the tenant's base URL.
- Webhook replay/idempotency must use provider event id plus document id. Do not trust document filename as an idempotency key.

## Next Implementation Ticket

Create `services/worker/src/integrations/oauth/clio.ts` and `services/worker/src/integrations/connectors/clio.ts` with the same dependency-injected testing style as DocuSign. Add `clio` to the worker and frontend connector enums only after the backend route can reject tampered webhooks and enqueue a retryable job.
