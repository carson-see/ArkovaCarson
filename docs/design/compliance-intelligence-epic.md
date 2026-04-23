# CIBA — Compliance Intelligence & Efficient Batch Anchoring

**Epic:** [SCRUM-1010](https://arkova.atlassian.net/browse/SCRUM-1010)
**Confluence:** [CIBA Epic page](https://arkova.atlassian.net/wiki/spaces/A/pages/20414465)
**Created:** 2026-04-21
**Author:** Tech lead (Claude Code session)
**Status:** Sprint 1 scope landing in this PR

---

## 1. Context

Two Google Docs and a partner response draft arrived together:

1. *Arkova Integration Strategy & Middleware Architecture v3* — defines INT-10 Workspace, INT-11 Smart Versioning, INT-12 E-Sign connectors.
2. *Epic: Enterprise Compliance Intelligence & Efficient Batch Anchoring v2* — defines ARK-101..104 (Smart Version Flagging, Merkle Batching, Treasury Alerts, Document Lineage).
3. *Hakichain partner response draft (2026-04-17)* — pitches an **org-configurable Rules Engine** ("every time we receive a background check from Veremark, extract the metadata and add it to our organization's queue; remind me daily at 9 AM and 4:30 PM EST") + DocuSign/Adobe/Google/SharePoint triggers + re-anchor-with-revocation.

An accuracy audit against the repo found **most of what the partner response describes is not built**. Migration 0031 already adds lineage columns and 0012/0036 ship `revoke_anchor`, but every other pitch bullet — rules engine, scheduled reminders, connectors, no-code UI, semantic match, NL authoring, persistent-URI supersede, queue dashboard, per-org rate limits, onboarding wizard — is a gap.

This document consolidates all three source docs into a single epic design, maps gaps to 20 Jira stories, and describes Sprint 1 scope.

## 2. Accuracy audit

| Feature described in pitch | Actual code today |
|---|---|
| Sign up + manually anchor | Live (1.41M+ anchors) |
| Revoke anchor (individual) | Live (migration 0012/0036) |
| Parent/child version columns | Live (migration 0031) |
| Batch Merkle anchoring (10K) | Live (`services/worker/src/jobs/batch-anchor.ts`) |
| Treasury API (read) | Live (`services/worker/src/api/treasury.ts`) |
| Atomic supersede + persistent-URI + lineage UI | Gap → ARK-104 |
| Treasury low-balance alerts | Gap → ARK-103 |
| Smart version flagging + queue | Gap → ARK-101 / INT-11 |
| Org-configurable Rules Engine | **Major gap** → ARK-105..110 |
| Scheduled queue review reminders | Gap → ARK-107 |
| No-code rule builder UI | Gap → ARK-108 |
| Gemini semantic rule matching | Gap → ARK-109 |
| Natural-language rule authoring | Gap → ARK-110 |
| Google / M365 connectors | Gap → INT-10 |
| DocuSign / Adobe connectors | Gap → INT-12 |
| ATS / BGC connectors (Veremark class) | Gap → INT-13 |
| Per-org rate limits / tier quotas | Gap → SCALE-01 |
| 10K-DAU auto-scale + backpressure | Gap → SCALE-02 |
| Uniform webhook HMAC middleware | Gap → SEC-01 |
| Prompt-injection defense | Gap → SEC-02 |
| First-time admin onboarding | Gap → UX-01 |
| Admin queue dashboard | Gap → UX-02 |
| OrgRequiredGate + UAT bugs | Gap → UX-03 |

## 3. Story roll-up

| Track | Stories |
|---|---|
| Core lifecycle | SCRUM-1011..1016 (ARK-101..104, INT-10, INT-12) |
| Rules Engine | SCRUM-1017..1022 (ARK-105..110) |
| 10K-DAU hardening | SCRUM-1023..1026 (SCALE-01, SCALE-02, SEC-01, SEC-02) |
| UX / adoption | SCRUM-1027..1029 (UX-01..03) |
| Connectors (deferred) | SCRUM-1015, 1016, 1030 (INT-10, INT-12, INT-13) |

Total: 20 stories, ~97 story points.

## 4. Gemini capabilities — answer to "can it reason and set jobs?"

Yes, with human-in-the-loop guardrails:

- **ARK-109** — Gemini embeddings + cosine match for semantic rule triggers. No LLM generation; pure vector math. Provider-neutral via `IAIProvider`, Cloudflare AI fallback.
- **ARK-110** — Gemini function-calling / structured output converts plain English into structured rule configs. Admin always reviews + enables. Drafts always ship `enabled=false`. Zod + adversarial corpus wrap the boundary.

Both respect the `CLAUDE.md` §1.6 PII boundary — only client-side-stripped metadata is ever embedded.

## 5. Sprint 1 scope (this PR)

| Story | Delivery |
|---|---|
| **ARK-105** (SCRUM-1017) | Data model migration + Zod schemas (foundation for Sprint 2+) |
| **ARK-104** (SCRUM-1014) | Migration + supersede endpoint + lineage endpoint + UI timeline |
| **ARK-103** (SCRUM-1013) | Low-balance cron + Slack/email dispatch + treasury health endpoint |
| **ARK-101** (SCRUM-1011) | Migration (`pending_resolution` state) + queue endpoints |
| **UX-03** (SCRUM-1029) | `OrgRequiredGate` component + 4 UAT bug fixes |
| **ARK-102** (SCRUM-1012) | Audit tests pinning Trigger A/B/C behavior |

Out of scope in Sprint 1:
- Full admin UI for queue (UX-02) or rule builder (ARK-108) — backend ready, UI in Sprint 2.
- Rules Engine worker (ARK-106) — schema lands; worker in Sprint 2.
- Gemini semantic match + NL authoring — Sprint 3.
- Connectors (INT-10, INT-12, INT-13) — blocked on vendor accounts + legal.

## 6. Migrations this PR

| Migration | Story | Description |
|---|---|---|
| 0224 | ARK-105 | `organization_rules` + `organization_rule_executions` + RLS + audit event types |
| 0225 | ARK-104 | `SUPERSEDED` anchor status enum value |
| 0226 | ARK-104 | `supersede_anchor` + `get_anchor_lineage` + `get_current_anchor_public_id` RPCs |
| 0227 | ARK-101 | `PENDING_RESOLUTION` anchor status enum value |
| 0228 | ARK-101 | `anchor_queue_resolutions` table + `resolve_anchor_queue` + `list_pending_resolution_anchors` RPCs |
| 0229 | ARK-103 | `treasury_alert_state` singleton for alert dedup |

## 7. Non-functional requirements

- Tests: 80%+ coverage on new code; RLS tests for every new table
- Copy: user-facing strings in `src/lib/copy.ts`; `lint:copy` green
- Security: client-side PII boundary held; HMAC-ready (SEC-01 ships the middleware in Sprint 2, but migrations + endpoints here use the existing auth patterns)
- Observability: audit events on all state transitions; Sentry on unhandled errors

## 8. Confluence page map

Epic: [CIBA](https://arkova.atlassian.net/wiki/spaces/A/pages/20414465)
Per-story pages: children of the epic page, one per SCRUM-1011..1030.

## 9. Open decisions

- **ARK-102 fast-track trigger** — decision: defer until Product confirms per-org tier. Spec Trigger C is optional in Sprint 1.
- **ARK-104 status vs. reason pattern** — decision: add `SUPERSEDED` as a distinct status (not a `revocation_reason` marker). Cleaner lineage UI queries, auditor-friendly.
- **ARK-110 Gemini provider fallback** — decision: Gemini primary, Cloudflare AI fallback via `IAIProvider`. Matches 2026-03-14 architecture decision.

## 10. References

- [CLAUDE.md](../../CLAUDE.md) — directive rules (client-side PII boundary §1.6, schema-first §1.2)
- [HANDOFF.md](../../HANDOFF.md) — rolling state
- `services/worker/src/jobs/batch-anchor.ts` — existing 10K batch pipeline
- Migrations 0012, 0031, 0036 — existing revocation + lineage primitives
- `docs/bugs/uat_2026_04_18_product_guide.md` — UAT bug source for UX-03
