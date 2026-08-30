/**
 * CLAUDE.md §1.3 terminology regression test — shipped source only.
 *
 * Found in npm-publish clean-room verification (2026-08-18): fixing the
 * README's "Bitcoin anchor status" / "hash" / "wallet" prose was NOT enough
 * — `client.ts` and `types.ts` carried the same banned terms in JSDoc that
 * `tsup --dts` copies verbatim into the shipped `dist/index.d.ts` /
 * `dist/index.d.mts` (visible in every consumer's editor tooltips) and,
 * for `hash` as a property name, into the compiled `.js`/`.mjs` too. A
 * README-only pass missed all of it. This test scans the actual shipped
 * source files directly so the same gap can't recur silently.
 *
 * `hash` / `block` / `crypto` are intentionally NOT zero-tolerance:
 * `ProofBundle` / `MerkleProofEntry` document a real Merkle-tree inclusion
 * proof and raw Bitcoin block header bytes (`blockHash`, `blockHeader`,
 * "64-hex block hash") needed for independent cryptographic verification —
 * standard, precise technical vocabulary, a different concept from
 * Arkova's document fingerprint (which the rest of this SDK correctly
 * calls "fingerprint" throughout, per the fix in this same change) or the
 * product-facing "Bitcoin anchor" language this fix removed elsewhere.
 * `crypto` covers exactly one legitimate hit: `crypto.subtle.digest(...)`,
 * the real WebCrypto API. Ratchet the counts instead of banning the words
 * outright: any new occurrence forces a conscious look at whether it's
 * another legitimate technical reference or a product-copy mislabel.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const srcDir = dirname(fileURLToPath(import.meta.url));
const SHIPPED_SOURCE_FILES = ['client.ts', 'types.ts', 'index.ts'];

// Zero legitimate use in this SDK for any of these — Arkova's product
// consistently uses "network"/"fingerprint"/"record"/"signer" instead
// (see CLAUDE.md §1.3's replacement table).
const STRICTLY_BANNED = /\b(wallet|gas|transaction|blockchain|bitcoin|testnet|mainnet|utxo|broadcast|cryptocurrency)\b/gi;

// Reviewed 2026-08-18. If any of these counts move, find the new line and
// confirm it's the same legitimate-technical-reference category (Merkle
// proof / raw Bitcoin proof bytes / the real WebCrypto `crypto` global)
// before bumping the number — don't bump blind.
const EXPECTED_COUNTS: Record<string, { hash: number; block: number; crypto: number }> = {
  'client.ts': { hash: 3, block: 1, crypto: 1 },
  'types.ts': { hash: 4, block: 2, crypto: 0 },
  'index.ts': { hash: 0, block: 0, crypto: 0 },
};

describe('shipped source terminology (§1.3)', () => {
  for (const file of SHIPPED_SOURCE_FILES) {
    it(`${file} has no strictly-banned §1.3 terms`, () => {
      const content = readFileSync(join(srcDir, file), 'utf-8');
      const matches = content.match(STRICTLY_BANNED) ?? [];
      expect(matches, `found: ${JSON.stringify(matches)}`).toEqual([]);
    });

    it(`${file} has the expected (reviewed) count of ratcheted terms`, () => {
      const content = readFileSync(join(srcDir, file), 'utf-8');
      const counts = {
        hash: (content.match(/\bhash\b/gi) ?? []).length,
        block: (content.match(/\bblock\b/gi) ?? []).length,
        crypto: (content.match(/\bcrypto\b/gi) ?? []).length,
      };
      expect(counts).toEqual(EXPECTED_COUNTS[file]);
    });
  }
});
