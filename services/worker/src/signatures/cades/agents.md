# agents.md — services/worker/src/signatures/cades/

_Last updated: 2026-05-16_

## What This Folder Contains

CAdES (CMS Advanced Electronic Signatures) builder per ETSI EN 319 122-1/2. Produces CAdES-B-B through CAdES-B-LTA signatures using ASN.1 DER encoding via pkijs.

| File | Purpose |
|------|---------|
| `cadesBuilder.ts` | CAdES signature builder — CMS SignedData (RFC 5652) with ETSI baseline attributes |
| `cadesBuilder.test.ts` | Tests for CAdES signature construction and attribute validation |

## Do / Don't Rules

- **DO** use pkijs/asn1js for all ASN.1 DER encoding
- **DO NOT** process raw document bytes server-side (Constitution 1.6)
