# agents.md — services/worker/src/signatures/ltv/

_Last updated: 2026-05-16_

## What This Folder Contains

Long-Term Validation (LTV) data aggregation for B-LT and B-LTA signature levels. Embeds OCSP responses and CRLs into signatures for offline verification decades after signing.

| File | Purpose |
|------|---------|
| `ltvBuilder.ts` | LTV data aggregator — collects OCSP responses and CRLs for the entire signing chain |
| `ltvBuilder.test.ts` | Tests for LTV data collection and embedding |

## Do / Don't Rules

- **DO** aggregate LTV data for all certificates in the chain (leaf through root)
- **DO** use injected `CertificateManager`, `OcspClient`, `CrlManager` for testability
