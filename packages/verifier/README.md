# arkova-verifier — independent on-chain confirmation for Arkova anchors

A **standalone, MIT-licensed** library that confirms an Arkova anchor is
recorded on the public Bitcoin network — checked against **a node you choose**,
with **zero Arkova network calls** and **zero runtime dependencies**.

It exists so that the claim "this fingerprint was committed on chain" can be
checked by someone who does not trust Arkova. Every fact it reports is read off
bytes the independent node served; nothing is taken from Arkova, and nothing is
taken on faith from the anchor packet being checked.

Used on its own for the on-chain step, or via
[`arkova-verifier-cli`](https://www.npmjs.com/package/arkova-verifier-cli) (the `arkova-verify` command), which
adds the Merkle recompute and report rendering around it.

## Install

```bash
npm install arkova-verifier
```

Node >= 18 (uses the built-in `fetch` and `node:crypto`; nothing else).

## Usage

```js
import { confirmInclusion, createEsploraFetch } from 'arkova-verifier';

const result = await confirmInclusion(
  {
    txId: '<64-hex network receipt id>',
    expectedMerkleRoot: '<64-hex app Merkle root>',
    blockHeight: 800000,
  },
  // Point this at ANY Esplora-compatible node — your own, ideally.
  { fetch: createEsploraFetch('https://blockstream.info/api') },
);

result.confirmed;      // true only when every check below passed
result.status;         // 'confirmed' | 'payload_mismatch' | 'not_in_block' | ...
result.observedTime;   // ISO-8601 UTC, read off the block header itself
result.extractedMerkleRoot; // what was ACTUALLY on chain, on a mismatch
```

`confirmInclusion` **never throws**. Every failure — including an unreachable or
uncooperative node — maps to a `status`, and the result reports what was really
found rather than only that something went wrong.

The transport is injected, so you are never locked to one provider: pass any
`(path) => Promise<{ ok, status?, json? }>` function. `createEsploraFetch` is a
convenience builder for the Esplora REST shape (Blockstream, mempool.space, or a
self-hosted `electrs`).

Endpoints used, all read-only:
`GET /tx/:txid` · `GET /tx/:txid/merkle-proof` · `GET /block/:hash/header` ·
`GET /block-height/:height`

## What it checks

All four must pass for `confirmed: true`:

1. **Anchor payload** — the single `OP_RETURN` output is decoded structurally at
   a fixed byte offset (`ARKV(4)‖root(32)`) and the root must equal the one you
   supplied. This is a decode, **not** a substring search, so a value that merely
   appears somewhere in the output does not pass.
2. **Inclusion** — the node's Merkle proof is folded **starting from your txid**
   up to the merkleroot in the independently fetched header. A genuine proof for
   a *different* transaction in the same block is rejected.
3. **Height binding** — the transaction's block height matches the height you
   stated, **and** `/block-height/:h` maps that height back to the same block
   hash. A reorg that moved the receipt shows up here.
4. **Header integrity** — the 80-byte header double-SHA256s to the block hash it
   claims to be, and it is that header's merkleroot that step 2 is checked
   against.

`observedTime` is then read from header bytes `[68,72)` — the network's own
timestamp for that block, **measured** off the header rather than accepted from
any packet field. `null` only when no header was fetched and validated.

## What this proves — and what it does not

Stated in the terms Arkova uses for all proof material (measured / asserted /
not asserted):

**Measured** — by this library, from bytes the independent node served:
the `OP_RETURN` payload; that your transaction is committed in that block's
merkleroot; that the header hashes to the block hash claimed; that the height
and hash agree in both directions; and the block's own timestamp.

**Asserted by the node you chose, and NOT verified here** — that the block is
part of the valid, most-work chain. This library does **not** download or
validate a header chain, does **not** check proof-of-work, and does **not**
determine which chain has the most work. It confirms the receipt is in *that
block* and that *that block's* header is internally consistent. Whether the
block is on the real chain is a fact you are trusting your chosen node for. That
is why the node is injectable: point it at infrastructure you control, or run
the same check against several independent nodes and compare.

**NOT asserted, by anyone** — nothing about the document's contents, the
holder's identity, the issuer's legitimacy, or any registry listing. A
`confirmed: true` means one narrow thing: *this Merkle root was committed in
this block at this time.* It is not a signature check, and it is not a
substitute for recomputing the Merkle root from a fingerprint and inclusion path
— that step belongs to the caller (and is what
[`arkova-verifier-cli`](https://www.npmjs.com/package/arkova-verifier-cli) wraps around this library).

## Design constraints

- **Never contacts Arkova.** No Arkova host, no Arkova credential, no Arkova RPC
  token.
- **Zero runtime dependencies.** `node:crypto` only. Bitcoin parsing is
  pure-buffer — no `bitcoinjs-lib`, no HTTP client, no Arkova imports.
- **No default endpoint and no hidden fallback.** This library contains no URL
  literal at all: `createEsploraFetch` requires you to name the node, and
  `confirmInclusion` only ever talks to the transport you hand it. (The
  `https://blockstream.info/api` default you may have seen belongs to
  `arkova-verifier-cli`, which needs *some* default for a bare command line.)

## License

MIT — see [LICENSE](./LICENSE).
