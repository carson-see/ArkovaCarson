# Proof Packages
_Last updated: 2026-03-10 8:00 PM EST | Story: P7-TS-07, P7-TS-08_

## Overview

Proof packages are downloadable verification bundles that allow recipients to independently verify an anchor's authenticity. The current implementation provides PDF certificates; JSON proof download and ZIP archives are planned but not yet functional.

## Current Implementation

### PDF Certificate (Complete — P7-TS-08)

`src/lib/generateAuditReport.ts` generates PDF certificates using jsPDF (201 lines). Called from `RecordDetailPage`.

The PDF includes:
1. **Document Information** — filename, fingerprint (SHA-256), file size
2. **Anchor Timeline** — created timestamp, secured timestamp
3. **Network Receipt** — receipt ID, block reference (using approved terminology)
4. **Verification Instructions** — how to compute SHA-256, link to public verification page
5. **QR Code** — links to `/verify/{publicId}`

### JSON Proof Download (~~CRIT-5~~ FIXED)

`src/components/public/ProofDownload.tsx` renders download buttons for both PDF and JSON formats. Both handlers work. ~~CRIT-5~~ was resolved 2026-03-10 (commit a38b485) — `onDownloadProofJson` wired in `RecordDetailPage` using `generateProofPackage` + `downloadProofPackage` from `proofPackage.ts`.

**Planned JSON schema (`proofPackage.ts`):**

```json
{
  "version": "1.0",
  "anchor": {
    "public_id": "abc123xyz456",
    "fingerprint": "a1b2c3d4e5f6...",
    "filename": "contract_2024.pdf",
    "file_size": 1048576,
    "created_at": "2024-01-15T10:30:00Z",
    "secured_at": "2024-01-15T10:35:00Z"
  },
  "chain": {
    "network": "Production Network",
    "receipt_id": "btc_tx_001",
    "block_height": 800000,
    "block_timestamp": "2024-01-15T10:35:00Z"
  },
  "verification": {
    "url": "https://app.arkova.io/verify/{public_id}",
    "instructions": "To verify, hash your document with SHA-256..."
  },
  "generated_at": "2024-01-20T14:00:00Z",
  "generated_by": "app.arkova.io"
}
```

### ZIP Archive (Planned — Not Implemented)

A future enhancement would bundle multiple files into a ZIP archive:

```
proof_package_{public_id}.zip
├── proof.json           # Machine-readable proof data
├── certificate.pdf      # Human-readable PDF certificate
├── verification.txt     # Plain text verification instructions
└── README.md            # Package documentation
```

This is not implemented. No ZIP library is installed. The ZIP format is a target for post-launch improvement.

## Verification Instructions

### Command-Line Verification

```
STEP 1: Compute Document Fingerprint
  macOS/Linux:  shasum -a 256 <filename>
  Windows:      Get-FileHash <filename> -Algorithm SHA256

STEP 2: Compare Fingerprints
  The computed fingerprint should match the anchor's fingerprint.

STEP 3: Verify Network Receipt
  Visit: https://app.arkova.io/verify/{public_id}
```

## Public Verification

### Verification Page

Public URL: `https://app.arkova.io/verify/{publicId}`

Uses `get_public_anchor` RPC (SECURITY DEFINER, migrations 0020/0039/0044) to return redacted anchor info. The page renders 5 sections via `PublicVerification.tsx` (P6-TS-01).

### Client-Side Fingerprint Verification

```typescript
async function computeFingerprint(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
```

Fingerprint computation happens client-side only (Constitution 1.6).

## Terminology Compliance

Per Constitution Section 1.3, proof packages use approved terminology:

| Internal | Display |
|----------|---------|
| `chain_tx_id` | Network Receipt ID |
| `chain_block_height` | Block Reference |
| `chain_timestamp` | Network Observed Time |
| `testnet` | Test Environment |
| `mainnet` | Production Network |

## Access Control

- **Own anchors**: Users can download proof packages for their anchors
- **Organization anchors**: ORG_ADMIN can download for any org anchor
- **Public verification**: Anyone with the `public_id` can verify via the public page

## Current Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| PDF certificate generation | Complete | `generateAuditReport.ts` (jsPDF) |
| PDF download button | Complete | `ProofDownload.tsx` |
| JSON proof download | Complete | ~~CRIT-5~~ FIXED (commit a38b485) |
| ZIP archive | Not started | No ZIP library installed |
| Public verification page | Complete | P6-TS-01, 5-section display |
| QR code generation | Complete | P6-TS-02, in AssetDetailView |
| Verification events logging | Complete | P6-TS-06, migration 0042/0045 |
| `proofPackage.ts` test coverage | Complete | PR-HARDENING-1: 33 tests, 100% coverage |
| `validators.ts` test coverage | Complete | PR-HARDENING-1: 10 new tests, 100% functions |

## Related Documentation

- [06_on_chain_policy.md](./06_on_chain_policy.md) — Content policy and allowed on-chain fields
- [08_payments_entitlements.md](./08_payments_entitlements.md) — Report ordering (organization plan)
- [10_anchoring_worker.md](./10_anchoring_worker.md) — Worker service

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit | Rewrote: documented actual implementation (PDF works, ZIP is planned not built), removed fictional ZIP generation code, added implementation status table |
| 2026-03-11 ~12:30 AM EST | Doc audit | Updated CRIT-5 references as resolved (commit a38b485). JSON proof download now working. |
| 2026-03-10 ~7:15 PM EST | PR-HARDENING-1 | `proofPackage.ts` went from 0% to 100% test coverage — 33 tests in `src/lib/proofPackage.test.ts` covering schema validation, package generation for all anchor states, validation function, filename generation, and browser download with DOM mocks. `validators.ts` functions coverage fixed from 71% to 100% with 10 new tests. |
