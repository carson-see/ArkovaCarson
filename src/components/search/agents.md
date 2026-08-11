# agents.md — components/search
_Last updated: 2026-07-21_

## What This Folder Contains

Search and discovery components: semantic search, credential cards, issuer profiles, and Nessie intelligence panel.

## Recent Changes

- 2026-05-29 SCRUM-1958 (subtask-4): Wired the previously-orphaned `SemanticSearch` into the dashboard. Added `SemanticSearchPanel` (flag-aware wrapper that renders null until `ENABLE_SEMANTIC_SEARCH` resolves true; fail-closed on load/error) and mounted it on `DashboardPage`. Routed all copy through `SEMANTIC_SEARCH_LABELS` in `copy.ts`, friendly match-strength labels (Strong/Good/Fair + "% match", never a raw vector score), honest empty state, and distinct 402/503/network error copy. Filters sidebar DEFERRED to subtask-3 (endpoint takes no filter params) — see the TODO comment in `SemanticSearch.tsx`. The browser does NOT emit `semantic_search.queried`; the worker records AI usage server-side (§1.6 boundary).

## Key Files

- `SemanticSearch.tsx` — Natural language search across org credentials using AI embeddings. `SemanticSearch` is presentational; `SemanticSearchPanel` is the flag-gated mount (use the panel on pages)
- `CredentialCard.tsx` — Displays a credential in an issuer's public registry (type, filename, date, verify link)
- `IssuerCard.tsx` — Issuer profile card in search results
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useSemanticSearch` — AI embedding search
- `@/hooks/usePublicSearch` — public registry data types
- `@/lib/copy` (NESSIE_LABELS, SEARCH_LABELS, CREDENTIAL_TYPE_LABELS) — UI strings

## Do / Don't Rules
- DO: Only display PII-stripped metadata in search results (Constitution 4A)
- DO: Strip HTML tags from credential labels before rendering (SCRUM-501 fix)
- DO: Gate semantic search behind `ENABLE_SEMANTIC_SEARCH` — mount `SemanticSearchPanel`, not the bare `SemanticSearch`
- DO: Show match strength as a friendly percentage/label, never the raw similarity score
- DON'T: Add a filters sidebar until SCRUM-1958 subtask-3 wires server-side filter params (no dead/fake controls)
- DON'T: POST audit/usage events from the browser — the worker logs AI usage server-side (§1.6)
- DON'T: add a Nessie surface to this folder. Nessie is OFF by founder directive; `src/lib/nessie-surfaces-offline.test.ts` fails on any non-test file under `src/` that mounts a `Nessie*` component

## 2026-08-10 — `NessieIntelligencePanel.tsx` deleted

The panel was mounted ungated at `ComplianceDashboardPage.tsx:760` on
`/organization/compliance`, a route behind `AuthGuard` + `RouteGuard` only — so
every authenticated customer could reach a query box for a service that is
switched off, and a confidence percentage plus confidence-decomposition panel
that SCRUM-2914 had ordered removed from the UI. `src/components/anchor/agents.md`
claimed these surfaces were "unreachable because Nessie is off"; that claim was
false and is corrected there.

Deleted rather than left unrendered: an unmounted component with no flag gate is
exactly what got re-mounted here, and the SCRUM-2914 directive means a revived
copy would need its confidence UI rewritten anyway. `git log` holds it. Its
`NESSIE_LABELS` copy keys went with it; only `INSIGHTS_*` survive, for
`NessieInsights` in `components/anchor`.

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

IssuerCard count string now "{count} verified records" (via copy.ts SEARCH_LABELS). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
