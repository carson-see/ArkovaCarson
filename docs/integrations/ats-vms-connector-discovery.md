# ATS / VMS Connector Discovery (SCRUM-1153)

> **Status:** Discovery spike, not implementation. Captures the integration
> surface for the four candidate ATS / VMS systems plus a recommended first
> implementable path.
>
> **Audience:** Arkova product + engineering. Counsel review only required
> for the data-flow recommendations called out per vendor.
>
> **Last refreshed:** 2026-04-25 (Claude, Opus 4.7 1M context).

---

## TL;DR — recommended first connector

**Greenhouse → webhook + REST.** Public API + webhook docs, customer-managed
auth (no partner agreement needed for v1), document-per-application data
model that maps cleanly onto Arkova's `CONNECTOR_DOCUMENT_RECEIVED` trigger.
A single Arkova engineer can ship the live receiver in ~2–3 days.

**Lever → second.** Same shape (webhook + REST, customer-managed auth) but
smaller market share and more candidate-flow churn (Lever's `candidate.hired`
event lifecycle is more nuanced than Greenhouse's `application.updated`).

**Fieldglass + Beeline → defer pending vendor agreement.** Both are
SAP/IBM-stack VMS systems with partner-managed auth, mandatory mutual NDAs,
and EDI / SOAP integration surfaces (not REST + webhooks). They unlock
enterprise-grade revenue but cost months of vendor onboarding before the
first event lands.

---

## Per-vendor matrix

| | Greenhouse | Lever | Fieldglass | Beeline |
|---|---|---|---|---|
| **Auth model** | Customer Harvest API key | Customer Personal API key | Partner agreement + mutual NDA | Partner agreement |
| **Webhook?** | Yes — Greenhouse Web Hooks (RESTful) | Yes — Lever Webhooks | No (polling SOAP / EDI) | Limited; primarily polling |
| **Webhook signature** | `Signature: t=<unix>,v0=<hex>` (Stripe-style — HMAC-SHA256 of `<timestamp>.<body>`) | HMAC-SHA256 hex (`X-Lever-Signature` header) | N/A | N/A |
| **Replay protection** | Caller-managed; we'd need a nonce table per vendor | Same | N/A | N/A |
| **Event types we care about** | `application.updated`, `application.hired`, `candidate.hired` | `candidateHired`, `applicationCreated` | Worker assignment status | Worker assignment status |
| **Document data?** | Resume / cover letter via REST `GET /v1/applications/:id/attachments` | Same via `GET /v1/opportunities/:opportunityId/files` | Worker timesheets / contracts via SOAP | Same |
| **Customer onboarding burden** | Low — admin pastes Harvest key into Arkova UI | Low — admin pastes Personal API key | High — IT + procurement involvement | High |
| **Rate limit** | 50 req/10s | 10 req/s | Negotiated | Negotiated |
| **Region** | US-only (some EU pilot) | Global | Global enterprise | Global enterprise |
| **Pricing tier** | Greenhouse Recruiting (mid-market) | Lever LeverTRM (mid-market) | SAP Fieldglass (large enterprise) | Beeline (large enterprise) |
| **Implementation tier** | **Tier 1 (do now)** | **Tier 2 (after Greenhouse stabilizes)** | **Tier 3 (after partner agreement)** | **Tier 3 (after partner agreement)** |

---

## Greenhouse — implementation outline

### Auth
- Customer creates a Harvest API key in Greenhouse → Configure → Dev Center → API Credential Management.
- Permissions: `applications.read`, `candidates.read`, `attachments.read`.
- Key stored in `org_integrations.encrypted_tokens` via the existing
  KMS-backed flow (mirrors DocuSign / Drive in this codebase).

### Webhook receiver
- Endpoint: `POST /webhooks/greenhouse` mounted in `services/worker/src/index.ts`.
- HMAC verification: Greenhouse uses Stripe-style `Signature: t=<unix>,v0=<hex>` (HMAC-SHA256 of `<timestamp>.<body>`) — NOT a raw hex digest. We need a small helper that splits the header and feeds `<timestamp>.<body>` into `verifyHmacSha256Hex` (existing util in `services/worker/src/integrations/oauth/hmac.ts`). Reject the request if the timestamp is older than ±5 minutes.
- Adapter: new `adaptGreenhouse` function in
  `services/worker/src/integrations/connectors/adapters.ts` mapping
  `application.hired` → `CONNECTOR_DOCUMENT_RECEIVED` with vendor=`greenhouse`,
  external_file_id=`<application_id>`, sender_email=`<candidate.email>`,
  payload carrying `job_post_id`, `current_stage`, etc.
- Replay protection: new table `greenhouse_webhook_nonces` keyed on
  (`application_id`, `event_id`).

### Document fetch follow-up job
- Webhook stores the application id; a follow-up `job_queue` job pulls
  the resume + cover-letter attachments via `GET /v1/applications/:id/attachments`
  (same retryable shape as DocuSign's combined-document fetch).

### Rules engine integration
- Uses the existing `CONNECTOR_DOCUMENT_RECEIVED` trigger type. No
  schema changes needed.
- Action types unchanged: AUTO_ANCHOR for hired-candidate documents,
  QUEUE_FOR_REVIEW for flagged stages.

### Effort estimate
- 2–3 days for one engineer including tests + spike-to-live transition.
- Mirrors the Adobe Sign + Checkr scaffold from SCRUM-1030 / 1148.

---

## Lever — implementation outline

Same shape as Greenhouse with these deltas:

- Auth: Personal API key from Lever Settings → Integrations → API Credentials.
- Permissions: `read:applications`, `read:opportunities`, `read:files`.
- Webhook header: `X-Lever-Signature` (HMAC-SHA256 hex).
- Event types: `candidateHired`, `applicationCreated`.
- Doc fetch: `GET /v1/opportunities/:opportunityId/files`.

Implementation can fork the Greenhouse handler once it's live.

---

## Fieldglass + Beeline — gated path

### Why these are tier 3

1. **Mutual NDA** required before SAP/IBM share the integration spec docs.
   Counsel must sign before engineering can scope.
2. **Partner certification** lifecycle is multi-month (architectural review,
   security review, tenancy review, customer reference calls).
3. **Integration surface is SOAP / EDI** not REST + webhooks. Different
   transport, different auth, different validation tooling.
4. **Limited customer overlap** in our current pipeline — Fieldglass /
   Beeline customers tend to be Fortune-500 staffing offices (large
   enterprise) where Arkova's PLG motion is still nascent.

### What we should do today

- Capture the named decision: *"Fieldglass + Beeline are gated tier-3
  connectors pending vendor agreements."*
- Add a `connectors/discovery.md` reference to the connector setup wizard
  (SCRUM-1146 frontend follow-up) so admins selecting "Add ATS/VMS" see a
  clear "request access" CTA for these two.
- Add the entries to `CONNECTOR_CATALOG` in
  `services/worker/src/api/connector-health.ts` with `kind: 'gated'` so
  admins know the connector exists but is not yet wired.

---

## Demo alternatives if Fieldglass / Beeline access is gated

Per [SCRUM-1144](https://arkova.atlassian.net/browse/SCRUM-1144), Arkova
already ships a demo event injector that pushes canonical events through
the production enqueue path. For VMS demos, we can:

1. Use the demo injector to fire `CONNECTOR_DOCUMENT_RECEIVED` events
   tagged `vendor: 'fieldglass-demo'` or `vendor: 'beeline-demo'`.
2. Render those in the connector wizard catalog as a "demo" kind so the
   UI walkthrough can show the rules engine end-to-end without live VMS
   credentials.
3. Document explicitly in customer demo decks that the live integration
   requires a vendor partnership.

---

## Follow-up implementation stories

| Story | Title | Sprint |
|---|---|---|
| (new) | INT-13a — Greenhouse webhook + Harvest API integration | Next sprint |
| (new) | INT-13b — Lever webhook + REST integration | Next + 1 |
| (new) | INT-13c — Fieldglass partner agreement scoping | Counsel-blocked |
| (new) | INT-13d — Beeline partner agreement scoping | Counsel-blocked |

These should be filed as children of [SCRUM-1030](https://arkova.atlassian.net/browse/SCRUM-1030) once this discovery is reviewed.

---

## Open questions for product

1. Do we want the Greenhouse + Lever connectors to be self-serve (admin
   pastes API key in the wizard) or assisted (Arkova staff configures
   per-customer)? **Recommendation:** self-serve — matches the DocuSign
   + Drive flow and avoids per-customer manual cycles.
2. Are there candidate-PII redaction requirements beyond what the existing
   client-side stripping (CLAUDE.md §1.6) covers? **Recommendation:** no
   net-new redaction; the canonical event already strips PII.
3. Should the Greenhouse stage-update event (`application.updated`)
   trigger AUTO_ANCHOR or only QUEUE_FOR_REVIEW? **Recommendation:**
   QUEUE_FOR_REVIEW for everything except the terminal `hired` event,
   which can AUTO_ANCHOR.

---

_Document tracked in SCRUM-1153. Implementation stories spun out of this
spike land separately. Confluence page mirrors this doc on SCRUM-1153._
