# agents.md — services/worker/src/jobs/__tests__/

_Last updated: 2026-05-16_

## What This Folder Contains

Tests for job processors — public record fetchers, pipeline health, embedding, anchor scheduling, and training export.

| File | Purpose |
|------|---------|
| `australiaLawFetcher.test.ts` | Tests for Australian law public record fetcher |
| `cmsPhysicianFetcher.test.ts` | Tests for CMS physician data fetcher |
| `ecfrFetcher.test.ts` | Tests for eCFR (electronic Code of Federal Regulations) fetcher |
| `edgarFetcher.test.ts` | Tests for SEC EDGAR filing fetcher |
| `fccUlsFetcher.test.ts` | Tests for FCC ULS license fetcher |
| `federalRegisterFetcher.test.ts` | Tests for Federal Register fetcher |
| `feeAwareScheduler.test.ts` | Tests for fee-aware anchor batch scheduling |
| `intlComplianceFetcher.test.ts` | Tests for international compliance data fetcher |
| `ixbrlParser.test.ts` | Tests for iXBRL inline XBRL parser |
| `kenyaLawFetcher.test.ts` | Tests for Kenya law fetcher |
| `newFetchers.test.ts` | Tests for newly added public record fetchers |
| `pipeline-health.test.ts` | Tests for pipeline health monitoring |
| `publicRecordAnchor.test.ts` | Tests for public record anchor creation |
| `publicRecordEmbedder.test.ts` | Tests for public record embedding generation |
| `trainingExporter.test.ts` | Tests for training data export from golden dataset |
| `usptoFetcher.test.ts` | Tests for USPTO patent/trademark fetcher |

## Do / Don't Rules

- **DO** mock all external HTTP calls (public record APIs, databases)
- **DO NOT** call real government APIs in tests
