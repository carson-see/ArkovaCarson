# 30. Integration Surface & Packaging v1 (INT)

**Status:** NEW (2026-04-11) | **Epic:** SCRUM-641 | **Priority:** P0 — TOP PRIORITY (ahead of NCE/GME)
**Source:** Arkova Integration Strategy v2 (Google Doc — `1wP7pkOmf7rVdStIHaA9V4QxKPg4hoVB6`)

## Vision

Arkova's core infrastructure is complete: POST /anchor wired E2E, 13 verification API stories done, CLE coverage all 50 states, MCP server deployed at edge.arkova.ai, 1.4M+ documents verified. The remaining gap is **packaging and distribution** — not infrastructure. This epic delivers the SDKs, MCP agent tools, embeddable components, and vertical connectors that turn the API into a developer product.

## Strategic Principles

1. **API-first, not UI-first** — every customer interaction possible without `app.arkova.ai`.
2. **Build connectors on revenue, not speculation** — INT-06/07/08 are gated on signed LOIs.
3. **Embeddable widget over browser extension** — zero install friction, viral via backlinks.
4. **MCP as first-class distribution** — verification layer for the agentic economy.
5. **x402 for protocol-level monetization** — machine-to-machine verification revenue model.

## Release Trains

| Release | Stories | Pts | Trigger |
|---|---|---|---|
| **R-INT-01** YC Demo Critical | INT-01, INT-02, INT-03, INT-09 | 16 | Build now |
| **R-INT-02** SDK & Automation | INT-04, INT-05 | 8 | After R-INT-01 |
| **R-INT-03** Vertical Connectors | INT-06, INT-07, INT-08 | 19 | LOI-gated (per story) |

**Total:** 43 Fibonacci points. YC demo readiness path = 16 pts (3 days Claude Code).

## Story Index

| Jira | Story | Pts | Priority | Persona |
|---|---|---|---|---|
| [SCRUM-642](https://arkova.atlassian.net/browse/SCRUM-642) | INT-01 TypeScript SDK (`@arkova/sdk`) | 5 | **P0** | Developer (API consumer) |
| [SCRUM-643](https://arkova.atlassian.net/browse/SCRUM-643) | INT-02 MCP Server Tool Enhancement | 3 | **P0** | AI Agent (Claude/LangChain) |
| [SCRUM-644](https://arkova.atlassian.net/browse/SCRUM-644) | INT-03 Embeddable Verification Bundle | 5 | **P0** | Site operator (third-party) |
| [SCRUM-645](https://arkova.atlassian.net/browse/SCRUM-645) | INT-09 Webhook CRUD via API | 3 | **P0** | Developer (API-only) |
| [SCRUM-646](https://arkova.atlassian.net/browse/SCRUM-646) | INT-04 Python SDK (`arkova-python`) | 3 | P1 | Developer (Python) |
| [SCRUM-647](https://arkova.atlassian.net/browse/SCRUM-647) | INT-05 Zapier / Make.com | 5 | P2 | Non-technical staffing admin |
| [SCRUM-648](https://arkova.atlassian.net/browse/SCRUM-648) | INT-06 Clio (Law Firm DMS) | 8 | P2 | Law firm administrator |
| [SCRUM-649](https://arkova.atlassian.net/browse/SCRUM-649) | INT-07 Bullhorn Marketplace App | 8 | P2 | Staffing recruiter |
| [SCRUM-650](https://arkova.atlassian.net/browse/SCRUM-650) | INT-08 Screening Report Embed Template | 3 | P2 | Background screening firm |

## YC Demo Script (60s × 3 + 30s kicker)

| # | Demo | Duration | Story Coverage |
|---|---|---|---|
| 1 | REST API: ATS workflow — candidate uploads diploma → client-side hash → POST /anchor → store public_id → recruiter GET /verify | 60s | INT-01 |
| 2 | MCP Server: AI agent calls verify_document via MCP at edge.arkova.ai | 60s | INT-02 |
| 3 | Embeddable Badge: law firm portal displays live verification badge from a single script tag | 60s | INT-03 |
| K | x402 Protocol kicker (slide-only) — "AI agents pay $0.002/verification at the protocol level" | 30s | Q2 deliverable |

**Total demo:** 3.5 minutes. INT-09 enables the API-only narrative ("never log into app.arkova.ai").

## Build Triggers (LOI-Gated Stories)

- **INT-05 Zapier:** 3+ staffing agencies onboarded.
- **INT-06 Clio:** First law firm pilot signed.
- **INT-07 Bullhorn:** First staffing pilot converts to paid.
- **INT-08 Screening report:** CredentialCheck or equivalent signs LOI.

These stories are scoped, ACs written, and Jira-tracked, but **do not start them speculatively**.

## Dependencies

- INT-02 depends on INT-01 (SDK used internally by MCP tools).
- INT-04 mirrors INT-01 (Python after TypeScript ships to lock surface).
- INT-05/06/07 depend on INT-01.
- INT-09 has no dependencies — closes the API-only loop independently.

## What We Do NOT Build

- **Browser extension:** Consumer product positioning, install friction, IT approval gates. Embeddable widget achieves equivalent visual integration.
- **Isolated user node:** Deferred beyond Phase III pending enterprise deal requirements.
- **Speculative connectors:** Bullhorn/Clio/iManage without signed LOIs.

## Definition of Done (Epic)

- All 9 INT stories COMPLETE with passing tests
- YC demo script rehearsed against staging environment
- TypeScript SDK published to npm as `@arkova/sdk`
- Python SDK published to PyPI as `arkova`
- `embed.js` hosted on `cdn.arkova.ai`
- Webhook CRUD endpoints documented in OpenAPI spec
- MCP server tools registered in `/.well-known/mcp.json`
- `docs/BACKLOG.md` updated with INT section
- `CLAUDE.md` Section 5 updated with INT story status
