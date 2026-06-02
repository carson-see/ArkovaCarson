# agents.md — components/search
_Last updated: 2026-05-29_

## What This Folder Contains

Search and discovery components: semantic search, credential cards, issuer profiles, and Nessie intelligence panel.

## Recent Changes

- 2026-05-29 SCRUM-1958 (subtask-4): Wired the previously-orphaned `SemanticSearch` into the dashboard. Added `SemanticSearchPanel` (flag-aware wrapper that renders null until `ENABLE_SEMANTIC_SEARCH` resolves true; fail-closed on load/error) and mounted it on `DashboardPage`. Routed all copy through `SEMANTIC_SEARCH_LABELS` in `copy.ts`, friendly match-strength labels (Strong/Good/Fair + "% match", never a raw vector score), honest empty state, and distinct 402/503/network error copy. Filters sidebar DEFERRED to subtask-3 (endpoint takes no filter params) — see the TODO comment in `SemanticSearch.tsx`. The browser does NOT emit `semantic_search.queried`; the worker records AI usage server-side (§1.6 boundary).

## Key Files

- `SemanticSearch.tsx` — Natural language search across org credentials using AI embeddings. `SemanticSearch` is presentational; `SemanticSearchPanel` is the flag-gated mount (use the panel on pages)
- `CredentialCard.tsx` — Displays a credential in an issuer's public registry (type, filename, date, verify link)
- `IssuerCard.tsx` — Issuer profile card in search results
- `NessieIntelligencePanel.tsx` — Nessie compliance intelligence: task-type selector, confidence decomposition, risks/recommendations, verified citations
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
