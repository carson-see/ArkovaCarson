# agents.md — services/worker/src/signatures/xades/

_Last updated: 2026-05-16_

## What This Folder Contains

XAdES (XML Advanced Electronic Signatures) builder per ETSI EN 319 132-1/2. Produces XAdES-B-B through XAdES-B-LTA signatures wrapping XML content with SignedProperties.

| File | Purpose |
|------|---------|
| `xadesBuilder.ts` | XAdES signature builder — signer certificate reference, signing time, data object format |
| `xadesBuilder.test.ts` | Tests for XAdES signature construction and SignedProperties validation |

## Do / Don't Rules

- **DO** include signer certificate reference and signing time in SignedProperties
- **DO NOT** process raw document content server-side (Constitution 1.6)
