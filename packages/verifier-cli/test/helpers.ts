/**
 * Test helpers — an offline, fixture-backed `IndependentNode` so the whole
 * suite runs with NO network reachable (clean-room assertion). The fetch is an
 * `@arkova/verifier` `IndependentNodeFetch` driven entirely by the fixture's
 * canned Esplora REST responses; an unknown path returns 404 (never falls
 * through to a real fetch).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IndependentNodeFetch } from '@arkova/verifier';
import type { IndependentNode, ProofPacket, VerifierFixture } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, '..', 'fixtures');
export const PROOF08_PATH = join(
  FIXTURES_DIR,
  '..',
  '..',
  '..',
  'services',
  'worker',
  'src',
  'proof',
  'fixtures',
  'proof-fixtures.json',
);

export function loadSyntheticFixtures(): VerifierFixture[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'synthetic-vectors.json'), 'utf8'));
  return raw.fixtures as VerifierFixture[];
}

export function loadAdversarialFixtures(): VerifierFixture[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'adversarial-vectors.json'), 'utf8'));
  return raw.fixtures as VerifierFixture[];
}

// ── Manifest (S3-B): the single versioned fixture list all runners obey ──

export interface ManifestEntry {
  id: string;
  source: 'synthetic' | 'adversarial' | 'proof08';
  ref: string;
  mode: 'chain' | 'recompute' | 'signature';
  expected: {
    verdict: 'VERIFIED' | 'NOT_VERIFIED';
    reason_code: string | null;
    signature?: 'verified' | 'failed' | 'skipped';
  };
}

export interface Manifest {
  manifest_version: string;
  reason_enum_version: string;
  reason_codes: string[];
  fixtures: ManifestEntry[];
  excluded: Array<{ id: string; source: string; ref: string; why: string }>;
}

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as Manifest;
}

/** Raw PROOF-08 corpus (services/worker/src/proof/fixtures/proof-fixtures.json). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadProof08(): any {
  return JSON.parse(readFileSync(PROOF08_PATH, 'utf8'));
}

/** Build a recompute-only ProofPacket from a PROOF-08 app-tree vector. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function packetFromProof08Vector(v: any): ProofPacket {
  return {
    fingerprint: v.fingerprint,
    merkle_root: v.merkle_root,
    merkle_proof: v.merkle_proof,
    merkle_index: v.merkle_index,
    leaf_count: v.leaf_count,
    tx_id: null,
    block_height: null,
    block_timestamp: null,
    batch_id: null,
  };
}

/** Resolve a manifest entry to the concrete fixture inputs each runner needs. */
export function resolveManifestEntry(entry: ManifestEntry): VerifierFixture {
  if (entry.source === 'synthetic' || entry.source === 'adversarial') {
    const all = entry.source === 'synthetic' ? loadSyntheticFixtures() : loadAdversarialFixtures();
    const found = all.find((f) => f.name === entry.ref);
    if (!found) throw new Error(`manifest entry ${entry.id}: fixture ${entry.ref} not found in ${entry.source}`);
    return found;
  }
  const corpus = loadProof08();
  const vector =
    entry.ref === 'valid-inclusion'
      ? corpus.valid
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        corpus.invalid.find((i: any) => i.id === entry.ref);
  if (!vector) throw new Error(`manifest entry ${entry.id}: PROOF-08 vector ${entry.ref} not found`);
  return {
    name: entry.id,
    description: vector.description ?? entry.ref,
    packet: packetFromProof08Vector(vector),
    expect: { ok: entry.expected.verdict === 'VERIFIED' },
  };
}

export function readFixtureFile(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

/**
 * Build an offline `IndependentNode` from a fixture's canned REST responses.
 * Text endpoints (`/block-height/:h`, `/block/:hash/header`) are stored as raw
 * strings; everything else is JSON. Mirrors `createEsploraFetch`'s normalized
 * response shape ({ ok, json, text }).
 */
export function offlineNode(fixture: VerifierFixture): IndependentNode {
  const responses = fixture.node ?? {};
  const fetch: IndependentNodeFetch = async (path: string) => {
    if (!(path in responses)) return { ok: false, status: 404 };
    const value = responses[path];
    if (typeof value === 'string') return { ok: true, status: 200, text: value };
    return { ok: true, status: 200, json: value };
  };
  return { label: 'offline-fixture-node', fetch };
}
