/**
 * M2 — the PUBLISHED contract and the implementation must not disagree.
 *
 * `docs/api/openapi.yaml` is the contract we hand to integrators. When
 * migration 0427 added `tx_inclusion_branch` / `tx_block_index` to the emitted
 * `proof_bundle`, only the in-worker prose blob in `api/v1/docs.ts` changed;
 * the published `ProofBundle` schema — which carries an explicit `properties`
 * map AND a `required` list — was untouched. The two drifted, and nothing in CI
 * compared them, so the drift was invisible.
 *
 * This is the comparison. It is deliberately a DETECTOR rather than a second
 * hand-kept list: the expected key set comes from `buildProofPacket`, the
 * canonical packet builder whose field set `generateAuditReport.test.ts`
 * already pins as "matches PROOF-05 / CLI". Adding a field to the bundle
 * without publishing it (or publishing one the bundle does not emit) fails
 * here.
 *
 * The YAML is read with a narrow, asserted parser rather than a dependency: the
 * `ProofBundle` block is a flat two-level map, and every extraction below is
 * checked for non-emptiness so a parse that silently finds nothing cannot pass
 * as agreement.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildProofPacket, type AuditReportData } from './generateAuditReport';

const OPENAPI_PATH = resolve(process.cwd(), 'docs/api/openapi.yaml');

/**
 * Extract the `ProofBundle` schema's `required` list and `properties` keys.
 *
 * Scoped to the block that starts at `    ProofBundle:` and ends at the next
 * sibling schema (a line at the same four-space indent). Property names sit at
 * eight spaces under `      properties:`; required entries are `        - name`
 * under `      required:`.
 */
function readPublishedProofBundle(): { required: string[]; properties: string[] } {
  const src = readFileSync(OPENAPI_PATH, 'utf8');
  const start = src.indexOf('\n    ProofBundle:\n');
  if (start === -1) throw new Error(`ProofBundle schema not found in ${OPENAPI_PATH}`);

  const rest = src.slice(start + 1);
  // Next sibling schema: a line indented exactly four spaces ending in ':'.
  const siblingMatch = /\n {4}[A-Za-z][A-Za-z0-9_]*:\n/.exec(rest.slice(1));
  const block = siblingMatch ? rest.slice(0, siblingMatch.index + 1) : rest;

  const requiredStart = block.indexOf('\n      required:\n');
  const propertiesStart = block.indexOf('\n      properties:\n');
  if (requiredStart === -1) throw new Error('ProofBundle has no required: list');
  if (propertiesStart === -1) throw new Error('ProofBundle has no properties: map');

  const requiredBlock = block.slice(requiredStart, propertiesStart);
  const required = [...requiredBlock.matchAll(/^ {8}- ([a-z_][a-z0-9_]*)$/gm)].map((m) => m[1]);

  const propertiesBlock = block.slice(propertiesStart);
  const properties = [...propertiesBlock.matchAll(/^ {8}([a-z_][a-z0-9_]*):$/gm)].map((m) => m[1]);

  return { required, properties };
}

/** The canonical emitted field set, from the packet builder itself. */
function implementationKeys(): string[] {
  const data: AuditReportData = {
    publicId: 'PUB-1',
    filename: 'doc.pdf',
    fingerprint: 'aa'.repeat(32),
    status: 'SECURED',
    createdAt: '2026-08-01T00:00:00.000Z',
    proof: { fingerprint: 'aa'.repeat(32) },
  };
  const packet = buildProofPacket(data);
  if (!packet) throw new Error('buildProofPacket returned null for a SECURED fixture');
  return Object.keys(packet).sort();
}

describe('M2 — published ProofBundle contract vs the emitted bundle', () => {
  it('the parser actually finds the schema (a silent miss must not read as agreement)', () => {
    const { required, properties } = readPublishedProofBundle();
    expect(required.length).toBeGreaterThan(10);
    expect(properties.length).toBeGreaterThan(10);
    expect(implementationKeys().length).toBeGreaterThan(10);
  });

  it('publishes EXACTLY the fields the bundle emits — no more, no fewer', () => {
    const published = readPublishedProofBundle().properties.slice().sort();
    const emitted = implementationKeys();

    const missingFromSpec = emitted.filter((k) => !published.includes(k));
    const extraInSpec = published.filter((k) => !emitted.includes(k));

    expect(
      missingFromSpec,
      `emitted by the bundle but NOT published in docs/api/openapi.yaml: ${missingFromSpec.join(', ')}`,
    ).toEqual([]);
    expect(
      extraInSpec,
      `published in docs/api/openapi.yaml but NOT emitted by the bundle: ${extraInSpec.join(', ')}`,
    ).toEqual([]);
  });

  it('every published property is also listed as required — the API always emits the key', () => {
    // The bundle emits every key on every non-null bundle; nullability is
    // expressed with `nullable: true`, not by omitting the key. A property that
    // is published but not required would tell an integrator the key may be
    // absent, which is not what the route does.
    const { required, properties } = readPublishedProofBundle();
    const notRequired = properties.filter((p) => !required.includes(p));
    expect(
      notRequired,
      `published but not marked required (the route always emits these keys): ${notRequired.join(', ')}`,
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
