# signatures/ — Phase III AdES Signature Engine

## Purpose
Standards-compliant Advanced Electronic Signatures (XAdES, PAdES, CAdES) per ETSI EN 319 132/142/122, with PKI certificate management, RFC 3161 timestamping, and Long-Term Validation.

## Architecture
```
signatures/
  index.ts              — barrel export (import from here)
  types.ts              — all shared type definitions
  constants.ts          — OIDs, ETSI profiles, algorithm constraints
  adesEngine.ts         — main orchestrator (sign + verify flows)
  adesEngine.test.ts    — engine tests (43 tests)
  pki/
    hsmBridge.ts        — HSM signing abstraction (GCP Cloud HSM = prod; AWS KMS = non-deployed optionality per SCRUM-902; Mock for tests)
    certificateManager.ts — X.509 chain validation, parsing
    ocspClient.ts       — OCSP revocation checking with cache
    crlManager.ts       — CRL fetching with cache
    trustStore.ts       — EU Trusted List + custom trust anchors
  timestamp/
    rfc3161Client.ts    — RFC 3161 TimeStampReq/Resp builder/parser
    qtspProvider.ts     — QTSP selection with circuit breaker failover
  ltv/
    ltvBuilder.ts       — LTV data aggregation + validation
```

## Key Rules
- **Private keys NEVER in worker memory** — all signing via HSM bridge (Constitution 1.4)
- **No SHA-1 or MD5** — banned per ETSI TS 119 312 (enforced in hsmBridge validation)
- **No RSA < 2048 bits** — minimum key size enforced
- **Feature-gated** by `ENABLE_ADES_SIGNATURES` flag
- **AdES KMS keys are SEPARATE from Bitcoin KMS keys** — never shared

## API Endpoints (all under /api/v1/)
- `POST /sign` — create AdES signature
- `GET /signatures/:id` — get by public ID
- `POST /verify-signature` — verify integrity + chain + timestamp + LTV
- `GET /signatures` — list (org-scoped, cursor paginated)
- `POST /signatures/:id/revoke` — revoke with reason code

## DB Tables (migrations 0163-0165)
- `signing_certificates` — PKI certs with KMS key references
- `signatures` — signature records linking to anchors/attestations
- `timestamp_tokens` — RFC 3161 TST storage

## Stories
- PH3-ESIG-01: AdES engine (SCRUM-422) — IN PROGRESS
- PH3-ESIG-02: QTSP integration (SCRUM-423) — IN PROGRESS
- PH3-ESIG-03: Compliance center (SCRUM-424) — NOT STARTED

## Tests
Run: `cd services/worker && npx vitest run src/signatures/`
