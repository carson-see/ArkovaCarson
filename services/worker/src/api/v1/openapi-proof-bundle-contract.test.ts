/**
 * M2 — the PUBLISHED contract and the API implementation must not disagree.
 *
 * `docs/api/openapi.yaml` is the contract handed to integrators. When migration
 * 0427 added `tx_inclusion_branch` / `tx_block_index` to the emitted
 * `proof_bundle`, only the in-worker prose blob in `docs.ts` changed; the
 * published `ProofBundle` schema — which carries an explicit `properties` map
 * AND a `required` list — was untouched. The two drifted and nothing in CI
 * compared them.
 *
 * WHY THIS LIVES IN THE WORKER SUITE. A first pass put it in the root suite and
 * compared the spec against the FRONTEND `buildProofPacket`. Those two happen
 * to carry the same 15 keys today, so it was green — but the spec documents the
 * API's bundle, built by `buildProofBundle` in `verify-proof.ts`, so adding a
 * field to the API without touching the frontend packet would have sailed
 * straight through the very failure mode the detector is named for. The
 * comparison has to be against the builder the document actually describes.
 *
 * The expected key set therefore comes from `buildProofResponse` — the real
 * route helper — driven by a fixture complete enough to earn a non-null bundle.
 * The YAML is read with a narrow, asserted parser rather than a new dependency;
 * every extraction is checked for non-emptiness so a parse that silently finds
 * nothing cannot pass as agreement.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildMerkleTree } from '../../utils/merkle.js';
import { buildProofResponse, type MerkleProofResponse } from './verify-proof.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// services/worker/src/api/v1 -> repo root
const OPENAPI_PATH = resolve(HERE, '../../../../../docs/api/openapi.yaml');

const GENESIS_HEADER =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

/**
 * Extract the `ProofBundle` schema's `required` list and `properties` keys.
 *
 * Scoped to the block starting at `    ProofBundle:` and ending at the next
 * sibling schema (a line at the same four-space indent). Property names sit at
 * eight spaces under `      properties:`; required entries are `        - name`.
 */
function readPublishedProofBundle(): { required: string[]; properties: string[] } {
  if (!existsSync(OPENAPI_PATH)) {
    throw new Error(`openapi.yaml not found at ${OPENAPI_PATH}`);
  }
  const src = readFileSync(OPENAPI_PATH, 'utf8');
  const start = src.indexOf('\n    ProofBundle:\n');
  if (start === -1) throw new Error(`ProofBundle schema not found in ${OPENAPI_PATH}`);

  const rest = src.slice(start + 1);
  const siblingMatch = /\n {4}[A-Za-z][A-Za-z0-9_]*:\n/.exec(rest.slice(1));
  const block = siblingMatch ? rest.slice(0, siblingMatch.index + 1) : rest;

  const requiredStart = block.indexOf('\n      required:\n');
  const propertiesStart = block.indexOf('\n      properties:\n');
  if (requiredStart === -1) throw new Error('ProofBundle has no required: list');
  if (propertiesStart === -1) throw new Error('ProofBundle has no properties: map');

  const required = [
    ...block.slice(requiredStart, propertiesStart).matchAll(/^ {8}- ([a-z_][a-z0-9_]*)$/gm),
  ].map((m) => m[1]);
  const properties = [
    ...block.slice(propertiesStart).matchAll(/^ {8}([a-z_][a-z0-9_]*):$/gm),
  ].map((m) => m[1]);

  return { required, properties };
}

/** The keys the API's OWN bundle builder emits, from the real route helper. */
function emittedBundleKeys(): string[] {
  const fpA = 'aa'.repeat(32);
  const tree = buildMerkleTree([fpA, 'bb'.repeat(32), 'cc'.repeat(32)]);
  const result = buildProofResponse(
    {
      public_id: 'PUB-CONTRACT',
      fingerprint: fpA,
      status: 'SECURED',
      chain_tx_id: 'f1'.repeat(32),
      chain_block_height: 800_100,
      chain_timestamp: '2026-08-01T00:00:00.000Z',
      metadata: null,
    },
    {
      merkle_root: tree.root,
      proof_path: tree.proofs.get(fpA),
      batch_id: 'batch-contract',
      merkle_index: 0,
      block_header: `\\x${GENESIS_HEADER}`,
      block_hash: GENESIS_HASH,
      op_return_payload: `\\x41524b56${tree.root}`,
      proof_schema_version: 1,
      tx_inclusion_branch: null,
      tx_block_index: null,
    },
    3,
    false,
  ) as MerkleProofResponse;

  if (!result || 'error' in result || result.proof_bundle == null) {
    throw new Error('fixture did not produce a non-null proof_bundle');
  }
  return Object.keys(result.proof_bundle).sort();
}

describe('M2 — published ProofBundle contract vs the bundle the API emits', () => {
  it('the parser and the fixture both actually produce something (a silent miss is not agreement)', () => {
    const { required, properties } = readPublishedProofBundle();
    expect(required.length).toBeGreaterThan(10);
    expect(properties.length).toBeGreaterThan(10);
    expect(emittedBundleKeys().length).toBeGreaterThan(10);
  });

  it('publishes EXACTLY the fields the API bundle emits — no more, no fewer', () => {
    const published = readPublishedProofBundle().properties.slice().sort();
    const emitted = emittedBundleKeys();

    const missingFromSpec = emitted.filter((k) => !published.includes(k));
    const extraInSpec = published.filter((k) => !emitted.includes(k));

    expect(
      missingFromSpec,
      `emitted by proof_bundle but NOT published in docs/api/openapi.yaml: ${missingFromSpec.join(', ')}`,
    ).toEqual([]);
    expect(
      extraInSpec,
      `published in docs/api/openapi.yaml but NOT emitted by proof_bundle: ${extraInSpec.join(', ')}`,
    ).toEqual([]);
  });

  it('every published property is also required — the route always emits the key', () => {
    // Nullability is expressed with `nullable: true`, not by omitting the key,
    // so a published-but-optional property would misdescribe the response.
    const { required, properties } = readPublishedProofBundle();
    const notRequired = properties.filter((p) => !required.includes(p));
    expect(
      notRequired,
      `published but not marked required (the route always emits these): ${notRequired.join(', ')}`,
    ).toEqual([]);
  });

  it('names the 0427 bitcoin-tree fields specifically', () => {
    const { properties, required } = readPublishedProofBundle();
    for (const field of ['tx_inclusion_branch', 'tx_block_index']) {
      expect(properties).toContain(field);
      expect(required).toContain(field);
    }
  });
});
