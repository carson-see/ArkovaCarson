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
import type { IndependentNode, VerifierFixture } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, '..', 'fixtures');

export function loadSyntheticFixtures(): VerifierFixture[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'synthetic-vectors.json'), 'utf8'));
  return raw.fixtures as VerifierFixture[];
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
