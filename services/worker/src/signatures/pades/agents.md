# agents.md — services/worker/src/signatures/pades/

_Last updated: 2026-05-16_

## What This Folder Contains

PAdES (PDF Advanced Electronic Signatures) builder per ETSI EN 319 142-1/2. Produces signature dictionary data that the client embeds into the PDF (Constitution 1.6 — no server-side document processing).

| File | Purpose |
|------|---------|
| `padesBuilder.ts` | PAdES signature builder (B-B through B-LTA) — produces signature dictionary data, not full PDF |

## Do / Don't Rules

- **DO** produce only signature dictionary data for client-side embedding
- **DO NOT** process or manipulate PDF documents server-side (Constitution 1.6)
