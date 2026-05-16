# agents.md — services/worker/src/signatures/pki/

_Last updated: 2026-05-16_

## What This Folder Contains

PKI infrastructure for the signatures subsystem — certificate management, HSM signing, trust store, OCSP, and CRL handling.

| File | Purpose |
|------|---------|
| `certificateManager.ts` | X.509 certificate chain resolution, validation, and ETSI TS 119 312 algorithm enforcement |
| `hsmBridge.ts` | Abstract signing interface over AWS KMS and GCP Cloud HSM (RSA, ECDSA P-256/P-384) — private keys never enter worker memory |
| `hsmBridge.test.ts` | Tests for HSM signing abstraction |
| `trustStore.ts` | EU Trusted List (EUTL) and custom trust anchor management with periodic refresh |
| `ocspClient.ts` | OCSP client — real-time certificate revocation status checks with TTL caching |
| `crlManager.ts` | CRL fetcher — distribution point fetching with TTL caching for LTV embedding |

## Do / Don't Rules

- **DO** use `hsmBridge.ts` for all signing — private key material never enters worker memory (Constitution 1.4)
- **DO** validate certificate chains against the trust store before accepting
- **DO NOT** use Bitcoin secp256k1 keys for AdES signing — use RSA or ECDSA P-256/P-384
