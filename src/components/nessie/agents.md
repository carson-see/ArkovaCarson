# agents.md — components/nessie
_Last updated: 2026-05-16_

## What This Folder Contains
Nessie AI compliance assistant chat interface and citation display.

## Key Files
- `NessieChat.tsx` — Chat-style interface for compliance questions with inline citations backed by anchored documents; supports compliance_qa, risk_analysis, and recommendation task types
- `CitationCard.tsx` — Displays a citation source from Nessie's response: document title, source, and anchor status

## Dependencies
- `@/lib/workerClient` (workerFetch) — Nessie query API calls

## Do / Don't Rules
- DO: Always show citations with anchor status so users can verify evidence provenance
- DO NOT: Send raw document content to Nessie — only PII-stripped metadata is queried
