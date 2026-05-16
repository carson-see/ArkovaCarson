# services/worker/src/proof/

Signed proof bundles for offline verification by court clerks, regulators, and auditors.

## Files

- **signed-bundle.ts** — Wraps proof payloads in detached Ed25519 signatures. Bundle shape: `{ payload, signature, signing_key_id, signed_at_utc, bundle_version }`. Signing uses an injected `SignerFn`; verification uses Node `crypto`. Historical bundles remain verifiable after key rotation via `signing_key_id`.
- **signed-bundle.test.ts** — Tests for bundle creation, signature verification, and key rotation scenarios.
- **kms-signer.ts** — GCP Cloud KMS Ed25519 `SignerFn` adapter. Calls `asymmetricSign` against an `EC_SIGN_ED25519` key version. Never sees private key bytes. Caches key resource name as `signing_key_id`.
- **kms-signer.test.ts** — Tests for KMS signer with mocked GCP KMS client.

## Rules

- Production signing uses GCP KMS only — no AWS KMS in production (see `feedback_no_aws.md`).
- The worker never holds private key bytes; signing is delegated to KMS.
- Tests use a static Ed25519 key for deterministic round-trips — never call real KMS.
- Bundle `signing_key_id` must always be set so historical bundles can be verified after rotation.
