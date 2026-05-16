# agents.md — components/search
_Last updated: 2026-05-16_

## What This Folder Contains
Search and discovery components: semantic search, credential cards, issuer profiles, and Nessie intelligence panel.

## Key Files
- `SemanticSearch.tsx` — Natural language search across org credentials using AI embeddings; gated behind ENABLE_SEMANTIC_SEARCH
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
- DO: Gate semantic search behind `ENABLE_SEMANTIC_SEARCH` feature flag
