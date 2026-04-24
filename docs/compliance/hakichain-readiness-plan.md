# HakiChain Readiness Plan

**Date:** 2026-04-24
**Scope:** HakiChain partner intake response from 2026-04-22
**Jira:** SCRUM-1170 through SCRUM-1177
**Confluence:** https://arkova.atlassian.net/wiki/spaces/A/pages/26738689/HakiChain+Readiness+Plan+-+2026-04-24
**Status:** Drafted for Claude/Carson review

This plan answers one question: can Arkova handle what HakiChain needs without pretending unfinished work is already done?

## Executive readout

Arkova can support the HakiChain pilot, but the pilot should be sequenced carefully.

The core anchoring platform is close: CIBA already covers the anchor queue, batch economics, per-org quotas, rule execution, webhook HMAC, and worker scale primitives. Existing API-RICH and PROOF-SIG work covers most of the verification/proof surface HakiChain expects. REG already has Kenya and Nigeria foundations. PUBLIC-ORG gives us a starting point for sub-organization and white-label surfaces.

The missing work is mostly packaging and compliance readiness:

- Parent/sub-organization credit allocation needs a product path, not just low-level quota primitives.
- Retroactive anchoring needs original-document metadata and date semantics.
- HakiChain needs callback replay, not just one-way webhooks.
- Lawyers need one evidence package, not several API endpoints they have to stitch together.
- The legal document classes HakiChain named need launch presets.
- Kenya filing coordination needs a local-support handoff with human approval.
- Uganda, Tanzania, Rwanda, and Ghana need REG follow-up before production processing of residents' personal data.

## Recommended pilot boundaries

| Area | Recommendation | Why |
| --- | --- | --- |
| First production geography | Kenya-only, after ODPC filing path is approved | Kenya has the most existing Arkova documentation and HakiChain can help locally. |
| Demo / sandbox geography | All named countries allowed with synthetic or non-personal test data | Lets HakiChain validate flows without creating regulatory exposure. |
| Production personal data outside Kenya | Do not launch until per-country REG follow-ups are reviewed | Uganda, Tanzania, Rwanda, and Ghana have registration/transfer obligations not yet in Arkova docs. |
| Nigerian personal data | Defer until existing Nigeria REG stories are complete | Nigeria docs exist, but NDPC registration/SCC execution are still pending. |
| White-label | Design/spec now; implement after PUBLIC-ORG basics settle | Avoid conflicting with active public-org and onboarding work. |

## Plan of attack

### Phase 0 - Non-code readiness, safe now

Owner: Codex/Claude documentation pass.

- SCRUM-1175: publish Africa readiness matrix and file country follow-ups.
- SCRUM-1176: update Kenya filing checklist with HakiChain local-support handoff.
- Create this readiness plan as the shared sequencing page.
- Keep all regulator submission and filing actions human-approved.

### Phase 1 - Pilot unblockers

Owner: Claude after current migration-heavy work is clear.

1. SCRUM-1170 - Parent/sub-organization credit allocation.
2. SCRUM-1171 - Bulk and retroactive anchoring metadata.
3. SCRUM-1172 - Lifecycle webhooks and replay.
4. SCRUM-1173 - Audit-ready evidence package.

These are the highest-value HakiChain gaps. They connect existing CIBA/API/PROOF primitives into partner workflows.

### Phase 2 - Legal workflow polish

Owner: Claude/product.

1. SCRUM-1174 - HakiChain launch document presets.
2. SCRUM-1177 - White-label legal community package.
3. API docs and sample payloads for Django integration.

This should happen after Phase 1 APIs are stable enough that HakiChain is not integrating against a moving target.

### Phase 3 - Jurisdiction expansion

Owner: REG/compliance with counsel review.

Use SCRUM-1175 as the parent matrix. Country follow-ups should be treated as launch gates for production processing:

- Uganda: PDPO registration and transfer posture.
- Tanzania: PDPC registration and transfer/permit posture.
- Rwanda: NCSA registration plus outside-Rwanda transfer/storage authorization.
- Ghana: Data Protection Commission registration and privacy notice posture.
- Nigeria: continue existing REG-23/24/25 work.

## Current backlog fit

| HakiChain need | Current coverage | Gap story |
| --- | --- | --- |
| 8,000-12,000 anchors/year | CIBA batching and worker scale cover this volume comfortably. | None for raw capacity. |
| Parent org creates sub-orgs | PUBLIC-ORG has schema/rendering pieces; org admin exists. | SCRUM-1170 |
| Parent allocates credits | PAY/CIBA has credit/quota primitives. | SCRUM-1170 |
| Bulk anchoring | CIBA and manual org run exist. | SCRUM-1171 |
| Retroactive anchoring | Not safely modeled as a first-class workflow. | SCRUM-1171 |
| Webhooks/callbacks | Webhook catalog and HMAC exist. | SCRUM-1172 |
| Replay/reconciliation | Not partner-packaged. | SCRUM-1172 |
| Evidence trail | Verification/proof/lifecycle pieces exist. | SCRUM-1173 |
| Legal doc types | Contract/legal extraction stories exist. | SCRUM-1174 |
| Kenya filing help | Kenya ODPC packet exists. | SCRUM-1176 |
| Africa coverage | Kenya/Nigeria/South Africa docs exist; HakiChain countries are broader. | SCRUM-1175 + follow-ups |
| White-label | PUBLIC-ORG and self-host docs exist. | SCRUM-1177 |

## Risks and guardrails

- Do not run `supabase db push --linked` for this work.
- Do not add migration files for readiness documentation.
- Do not claim production support for Uganda, Tanzania, Rwanda, Ghana, or Nigeria until REG follow-ups are reviewed.
- Do not describe HakiChain retroactive anchoring as proving historical existence on-chain. The correct claim is: original document date is recorded as metadata; anchoring date proves when Arkova secured the fingerprint.
- Do not imply Arkova stores raw legal documents unless the implementation changes. Current architecture remains fingerprint/metadata-oriented.

## Claude review note

Review this plan against any active CIBA, PUBLIC-ORG, API-V2, or connector work before implementing Phase 1. In particular, avoid overlapping with the open `SCRUM-1168/1169` integration OAuth work and any staged migrations. This PR is intended to be documentation-only and should not touch `supabase/migrations`.
