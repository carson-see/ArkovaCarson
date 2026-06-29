# Canonical proof fixtures (PROOF-08 / SCRUM-2341)

`proof-fixtures.json` is the **single, code-grounded vector set** that every
proof consumer tests against — the verify API (`api/v1/verify-proof.ts`), the
PDF proof renderer, the SDK, the verifier CLI, and the server-side verify path.
Import it through `index.ts` (typed loader) rather than re-parsing the JSON.

These are the **same vectors** the SCRUM-2490 adversarial Merkle suite
(`utils/merkle-verify.test.ts`) pins, so the hardened verifier and the
cross-consumer fixtures never drift apart.

**Synthetic anchors only — NO real customer data or PII.** Leaves derive from
`sha256("arkova-fixture-leaf-N")`; `public_id`/`batch_id` are obviously fake;
the signing key is a throwaway, deterministically-seeded test key (never a
production key — prod signs via GCP KMS).

## Hashing rule (proof_schema_version 1)

Plain **double-SHA256 over positional concatenation** (Bitcoin standard),
identical to `utils/merkle.ts::buildMerkleTree`. This is what the on-chain
Merkle roots are committed under, so the v1 verifier must reproduce it. The
RFC-6962 tagged-hash format is reserved for a future `proof_schema_version=2`
and is **not** represented here.

Every vector is stamped to `proof_schema_version: 1` at the file level.

## On-chain commitment format (v0 — no version byte)

The `valid.on_chain.op_return_payload` is the **real** Arkova OP_RETURN
commitment, hex-encoded:

```
ARKV (4 bytes = 41524b56) ‖ 32-byte merkle_root [‖ optional 8-byte metadata hash]
```

There is **NO version byte** — confirmed in `chain/base.ts:111/124`,
`chain/signet.ts`, and `chain/signet.integration.test.ts`. The payload is
therefore always **even-length** hex, and the decoded bytes `[4, 36)` equal the
fixture's `merkle_root`. (An earlier fixture carried a stray `01` version byte
*and* an odd-length payload — both bugs; fixed under PROOF-08.)

## File shape

| Key | Meaning |
|---|---|
| `fixture_set_version` | semver of the fixture set itself |
| `proof_schema_version` | the on-chain proof schema these vectors target (1, non-null) |
| `hash_rule` | human-readable statement of the hashing rule + v0 no-version-byte note |
| `tree` | the synthetic 4-leaf tree: `leaves[]`, `merkle_root`, `leaf_count` |
| `valid` | the ONE canonical valid inclusion vector (+ `on_chain` block fields) |
| `invalid[]` | every adversarial vector; each carries `id`, `attack`, `expect_invalid_reason` |
| `signed_bundle` | a valid Ed25519 `SignedBundle` + the test keypair + a tampered `bad_signature_value` |

### Inclusion vector fields (`valid` and app-tree `invalid[]`)

```
fingerprint            64-hex document hash (the leaf)
merkle_root            64-hex root committed on-chain
merkle_index           integer leaf index (enables the CVE-2012-2459 guard)
leaf_count             total leaves in the batch tree (arms the duplicate-leaf guard)
merkle_proof[]         [{ hash: 64-hex, position: "left" | "right" }, ...]   (objects, NOT bare strings)
expect_invalid_reason  (invalid only) regex the verifier's `reason` must match
```

A consumer verifies a vector by calling, in effect:

```ts
verifyMerkleInclusion(fingerprint, merkle_proof, merkle_root,
  { leafIndex: merkle_index, leafCount: leaf_count })
```

`valid` ⇒ `{ valid: true }`; every `invalid[]` ⇒ `{ valid: false, reason }` where
`reason` matches `expect_invalid_reason`.

### Block-header vector (`bad-block-header`)

Layer-2 bitcoin-tree. Carries `block_header_hex` (deliberately not 160-hex),
`block_hash`, `tx_id`. Consumers enforce the 80-byte (160-hex) header rule from
`chain/confirmation-proof.ts`.

### Signature vector (`bad-signature`)

Uses `signed_bundle`: verify `valid_bundle` against `test_public_key_pem` ⇒
valid; swap `signature.value` for `bad_signature_value` ⇒ `verifySignedBundle`
reports `valid: false` / `signature verification failed`.

`signed_bundle.valid_bundle.payload` carries the **same canonical proof-bundle
fields** as the `valid` vector — `fingerprint`, `merkle_root`, `merkle_proof`,
`merkle_index`, `leaf_count`, `tx_id`, `block_height`, `block_hash`,
`block_header`, `op_return_payload`, `block_timestamp`, `proof_schema_version`
— so a CLI / SDK / PDF consumer that verifies the signed bundle still exercises
the CVE-2012-2459 structural-guard inputs (`merkle_index` / `leaf_count`) and the
canonical OP_RETURN field. A `proof-fixtures.test.ts` assertion pins the signed
payload to the `valid` vector for every canonical field so the two cannot drift
apart. The signature was regenerated over the expanded payload with the checked-in
deterministic throwaway test key (regenerate via `node scripts/gen-proof08.mjs`-style
re-sign through `canonicaliseJson` + `staticEd25519Signer`).

## Coverage

| `id` | `attack` | Layer | Rejected by |
|---|---|---|---|
| `valid-inclusion` | — (valid) | app-tree | accepted |
| `bad-document-hash` | wrong-document-hash | app-tree | root recompute mismatch |
| `tampered-merkle-branch` | tampered-branch-sibling | app-tree | root recompute mismatch |
| `flipped-branch-position` | tampered-branch-position | app-tree | root recompute mismatch |
| `duplicated-leaf-attack` | cve-2012-2459-self-pair | app-tree | structural self-pair guard |
| `wrong-leaf-index` | leaf-index-out-of-range | app-tree | index/count range check |
| `bad-block-header` | malformed-block-header | bitcoin-tree | 160-hex header rule |
| `bad-signature` | tampered-ed25519-signature | bundle | Ed25519 verify fail |

## Regenerating

The vectors are deterministic. `proof-fixtures.test.ts` re-derives the tree
from `buildMerkleTree(sha256("arkova-fixture-leaf-N"))` and asserts the JSON
matches — so an accidental hand-edit of a hash fails CI. The signed bundle is
produced with a deterministically-seeded test Ed25519 key (seed
`arkova-proof08-fixture-ed25519!!`). To change the tree, update the leaf seeds,
recompute via `buildMerkleTree`, re-sign the bundle with the test key, and
update both the JSON and the assertions.
