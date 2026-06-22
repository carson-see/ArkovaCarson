# Lane 1 — Open (MIT) Verifier + SDK Proof-Helpers Pre-Design

> **Sprint-0 Lane-1 deliverable (pre-design so Sprint 1 codes, not scopes).** Feeds roadmap **Q1.6 Open verifier & SDK GA** (L1, T2; SCRUM-2340/2394 + propose SDK-PY). Status: DRAFT.
> Grounded in origin/main `45167170`: `services/worker/src/utils/merkle.ts`, `services/worker/src/api/v1/verify-proof.ts`, `packages/sdk` (TS), `packages/arkova-py` (Python, SCRUM-1112 Done).

## 1. Goal

A **standalone, MIT-licensed verifier** that proves a document's fingerprint is committed in an on-chain Merkle root **without trusting Arkova's servers**. This is the platform's trust story: "anyone can verify."

## 2. Trustless verification algorithm (the design principle)

Given a proof packet, an independent party must be able to:

1. **Recompute the Merkle root** from `fingerprint` + `merkle_proof[]` using the **exact canonical algorithm** — double-SHA256 internal nodes, odd-level duplicates last, `position` left/right semantics — byte-for-byte matching `merkle.ts::verifyMerkleProof`.
2. **Confirm `recomputed_root == OP_RETURN payload`** in `tx_id`, fetching the tx from an **independent source** (the verifier's own node / Esplora / Blockstream — **never** Arkova).
3. **Confirm `tx_id` is in a real block** at `block_height` via a Bitcoin **SPV/merkle inclusion proof** against a block header obtained independently.
4. **⚠ DO NOT trust the API's `verified` field or `anchors.status`.** Today `verify-proof.ts:191` derives `verified` from `status === 'SECURED'|'SUBMITTED'` — **verdict-from-status**, the exact anti-pattern Train D **SCRUM-2490 (PROOF-VERIFY)** is fixing server-side. The OSS verifier sidesteps it entirely by **recomputing** (steps 1–3). This is the headline design constraint.

## 3. Proof-packet format (from the live API)

```
{ fingerprint, merkle_root, merkle_proof:[{hash,position}],
  tx_id, block_height, block_timestamp, batch_id }
```
Plus the optional `?format=signed` **Ed25519 signed bundle** (`proof/signed-bundle.ts`), verifiable against the published key (`docs.arkova.ai/keys.json` + `did:web:app.arkova.ai` key `arkova-proof-2026-q2`). The signature proves *Arkova issued this packet*; steps 1–3 prove *the on-chain fact* — the verifier reports both independently and never lets the signature substitute for recomputation.

## 4. Repo scaffold (S1 deliverable)

- **Separate public GitHub repo**, **MIT license**, **zero Arkova-server runtime dependency**.
- A language-agnostic **spec** (the algorithm above + the canonical hashing rules) + reference impls in **TS and Python**.
- **CLI** (`arkova-verify proof.json [--rpc <independent-node>]`) + library API.
- **Golden test vectors**: fixture proof packets whose expected roots match `merkle.ts` exactly (single-leaf, odd-leaf-count, deep tree) — the conformance suite both SDKs must pass.

## 5. SDK GA alignment (don't rebuild — SCRUM-1112 caution)

`packages/arkova-py` (Python SDK) already shipped (SCRUM-1112, **Done**). So **SDK-PY is GA/proof-helpers, NOT a rebuild** (S0-E2 reconciliation flag). Both `packages/sdk` (TS) and `packages/arkova-py` get a `verifyProof()` helper wrapping the same canonical recomputation + the conformance vectors; GA = published to npm/PyPI against those vectors.

## 6. Claims-review (R-7)

The verifier proves exactly one thing: **a fingerprint is included in an on-chain Merkle root committed at a given time**. It does **not** assert document contents, identity, or "listed in the Credential Registry." The CLI/output copy goes through the claims-review gate; terminology ban applies to any user-facing strings (Fingerprint, Anchor Receipt, Network Observed Time — not Hash/Transaction/Block).

## 7. Sprint boundary

- **S1:** MIT verifier repo scaffold + spec + canonical test vectors (this design ratified).
- **S2:** CLI v0.1 (recompute + independent tx fetch).
- **S3:** TS SDK proof-helper GA. **S4:** Python SDK proof-helper GA.
