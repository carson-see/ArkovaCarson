# services/worker/src/proof/

Signed proof bundles for offline verification by court clerks, regulators, and auditors.

## Files

- **signed-bundle.ts** — Wraps proof payloads in detached Ed25519 signatures. Bundle shape: `{ payload, signature, signing_key_id, signed_at_utc, bundle_version }`. Signing uses an injected `SignerFn`; verification uses Node `crypto`. Historical bundles remain verifiable after key rotation via `signing_key_id`.
- **signed-bundle.test.ts** — Tests for bundle creation, signature verification, and key rotation scenarios.
- **kms-signer.ts** — GCP Cloud KMS Ed25519 `SignerFn` adapter. Calls `asymmetricSign` against an `EC_SIGN_ED25519` key version. Never sees private key bytes. Caches key resource name as `signing_key_id`.
- **kms-signer.test.ts** — Tests for KMS signer with mocked GCP KMS client.
- **fixtures/** (PROOF-08 / SCRUM-2341) — canonical cross-consumer proof-fixture set. `proof-fixtures.json` is the self-describing source of truth (one valid inclusion proof + invalid vectors: bad document hash, tampered branch sibling/position, CVE-2012-2459 duplicated-leaf, wrong leaf index, bad block header, bad signature). `index.ts` is the typed loader; `README.md` documents the field contract for the verifier-CLI owner; `proof-fixtures.test.ts` re-derives the tree from `buildMerkleTree` and exercises every vector through `verifyMerkleInclusion` / `verifySignedBundle` / `buildProofResponse`, and asserts the on-chain `op_return_payload` is even-length, has NO version byte (`ARKV ‖ root`), and decodes `[4,36)` to the merkle_root. The SAME vectors are pinned in `utils/merkle-verify.test.ts` (SCRUM-2490) so the hardened verifier and the shared fixtures never drift. Synthetic anchors only — NO real customer data or PII; the bundle signing key is a throwaway, deterministically-seeded test key, never a prod key (prod signs via GCP KMS). Version-stamped to `proof_schema_version: 1` (plain double-SHA256 app-tree, matching on-chain roots — NOT RFC-6962 tagged).

## Rules

- Production signing uses GCP KMS only — no AWS KMS in production (see `feedback_no_aws.md`).
- The worker never holds private key bytes; signing is delegated to KMS.
- Tests use a static Ed25519 key for deterministic round-trips — never call real KMS.
- Bundle `signing_key_id` must always be set so historical bundles can be verified after rotation.
