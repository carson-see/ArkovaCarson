# 30. Integration Surface & Packaging v1 (INT)

**Status:** COMPLETE (2026-04-12) | **Epic:** SCRUM-641 | **Priority:** P0 — TOP PRIORITY
**Source:** Arkova Integration Strategy v2 (Google Doc — `1wP7pkOmf7rVdStIHaA9V4QxKPg4hoVB6`)

## Vision

Arkova's core infrastructure is complete: POST /anchor wired E2E, 13 verification API stories done, CLE coverage all 50 states, MCP server deployed at edge.arkova.ai, 1.4M+ documents verified. The remaining gap is **packaging and distribution** — not infrastructure. This epic delivers the SDKs, MCP agent tools, embeddable components, and vertical connectors that turn the API into a developer product.

## Strategic Principles

1. **API-first, not UI-first** — every customer interaction possible without `app.arkova.ai`.
2. **Embeddable widget over browser extension** — zero install friction, viral via backlinks.
3. **MCP as first-class distribution** — verification layer for the agentic economy.
4. **x402 for protocol-level monetization** — machine-to-machine verification revenue model.
5. **Build it all** — every connector built and ready when customers arrive.

## Release Trains

| Release | Stories | Pts | Status |
|---|---|---|---|
| **R-INT-01** YC Demo Critical | INT-01, INT-02, INT-03, INT-09 | 16 | **COMPLETE** |
| **R-INT-02** SDK & Automation | INT-04, INT-05 | 8 | **COMPLETE** |
| **R-INT-03** Vertical Connectors | INT-06, INT-07, INT-08 | 19 | **COMPLETE** |

**Total:** 43 Fibonacci points. All complete.

## Story Index

| Jira | Story | Pts | Status |
|---|---|---|---|
| [SCRUM-642](https://arkova.atlassian.net/browse/SCRUM-642) | INT-01 TypeScript SDK (`@arkova/sdk`) | 5 | **COMPLETE** |
| [SCRUM-643](https://arkova.atlassian.net/browse/SCRUM-643) | INT-02 MCP Server Tool Enhancement | 3 | **COMPLETE** |
| [SCRUM-644](https://arkova.atlassian.net/browse/SCRUM-644) | INT-03 Embeddable Verification Bundle | 5 | **COMPLETE** |
| [SCRUM-645](https://arkova.atlassian.net/browse/SCRUM-645) | INT-09 Webhook CRUD via API | 3 | **COMPLETE** |
| [SCRUM-646](https://arkova.atlassian.net/browse/SCRUM-646) | INT-04 Python SDK (`arkova-python`) | 3 | **SUPERSEDED** — canonical package is now `packages/arkova-py/` |
| [SCRUM-647](https://arkova.atlassian.net/browse/SCRUM-647) | INT-05 Zapier / Make.com | 5 | **COMPLETE** — Zapier CLI app + Make.com module, 15 tests |
| [SCRUM-648](https://arkova.atlassian.net/browse/SCRUM-648) | INT-06 Clio (Law Firm DMS) | 8 | **COMPLETE** — OAuth2, sidebar, CLE tab, webhooks, 22 tests |
| [SCRUM-649](https://arkova.atlassian.net/browse/SCRUM-649) | INT-07 Bullhorn Marketplace App | 8 | **COMPLETE** — candidate tab, status sync, webhooks, 15 tests |
| [SCRUM-650](https://arkova.atlassian.net/browse/SCRUM-650) | INT-08 Screening Report Embed Template | 3 | **COMPLETE** — HTML/PDF/JSON formats, 15 tests |

## What Was Built (Session 39)

### INT-04: Python SDK v0.2.0 (`sdks/python/`) — superseded

> 2026-05-01 update: this historical SDK copy was removed as authoritative source. The canonical Python SDK package is `packages/arkova-py/`, which is the directory used by the publish workflow and API docs.

- Full parity with TypeScript SDK: `anchor()`, `verify()`, `verify_batch()`, `query()`, `ask()`
- Webhook management namespace: `webhooks.create/list/get/update/delete/test()`
- Typed with frozen dataclasses: 13 types (AnchorReceipt, VerificationResult, WebhookEndpoint, NessieQueryResult, etc.)
- `ArkovaError` with `status_code` and `code` fields
- 37 tests with respx mocking

### INT-05: Zapier / Make.com (`integrations/zapier/`)
- **Zapier CLI app**: API key auth, 2 webhook triggers (anchor.secured, anchor.revoked), 3 actions (Anchor Document, Verify Credential, Batch Verify)
- REST hooks (subscribe/unsubscribe via Arkova webhook API)
- **Make.com module** definition JSON (`makecom.json`)
- 15 structural tests

### INT-06: Clio Integration (`integrations/clio/`)
- **ClioConnector**: OAuth2 authorization code flow, token refresh, document/contact CRUD
- **ClioSidebarWidget**: "Anchor with Arkova" — downloads doc, SHA-256 client-side, POST /anchor
- **CleComplianceTab**: Bar number lookup via Arkova CLE API, 10-state CLE requirements database
- **ClioWebhookHandler**: Auto-anchor on document.created, HMAC signature validation
- Verification badge renderer (inline HTML, CSP-safe)
- 22 tests

### INT-07: Bullhorn Marketplace (`integrations/bullhorn/`)
- **BullhornConnector**: REST API with BhRestToken, candidate/file CRUD
- **CandidateVerificationTab**: Full credential summary, one-click anchor, batch verify, status sync to custom fields
- **BullhornWebhookHandler**: Subscription event processing, auto-verify on FILE events
- Status labels: Fully Verified / Partially Verified / Has Revocations / Not Verified
- 15 tests

### INT-08: Screening Report Embed Template (`packages/embed/src/report-block.ts`)
- `renderReportBlock(publicId, options)`: Fetch + render
- `renderReportBlockFromData(data, publicId, options)`: Render from pre-fetched data
- Three formats: HTML (inline styles, CSP-safe), PDF (print-optimized), JSON (structured data)
- Configurable: show/hide fingerprint, network receipt, explorer links, custom branding
- XSS protection via HTML escaping
- 15 tests

## Dependencies

- INT-02 depends on INT-01 (SDK used internally by MCP tools).
- INT-04 mirrors INT-01 (Python after TypeScript ships to lock surface).
- INT-05/06/07 depend on INT-01.
- INT-09 has no dependencies — closes the API-only loop independently.

## Definition of Done (Epic) — ✅ ALL MET

- [x] All 9 INT stories COMPLETE with passing tests
- [x] TypeScript SDK at `packages/sdk/`
- [x] Python SDK at `packages/arkova-py/`
- [x] Zapier app at `integrations/zapier/`
- [x] Make.com module definition at `integrations/zapier/src/makecom.json`
- [x] Clio integration at `integrations/clio/`
- [x] Bullhorn integration at `integrations/bullhorn/`
- [x] Screening report embed at `packages/embed/src/report-block.ts`
- [x] `docs/BACKLOG.md` updated with INT section
- [x] `CLAUDE.md` Section 5 updated with INT story status
