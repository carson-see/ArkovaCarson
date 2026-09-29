import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyProof } from '../src/verify.js';
import { loadSyntheticFixtures, offlineNode } from './helpers.js';
import type { ProofPacket } from '../src/types.js';

const FIXTURES = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/hosted-full-proof-bundles.json', import.meta.url)),
  'utf8',
)) as ProofPacket[];

function altered(packet: ProofPacket, patch: Partial<ProofPacket>): ProofPacket {
  return JSON.parse(JSON.stringify({ ...packet, ...patch })) as ProofPacket;
}

function displayBlockHash(header: string): string {
  const first = createHash('sha256').update(Buffer.from(header, 'hex')).digest();
  return Buffer.from(createHash('sha256').update(first).digest()).reverse().toString('hex');
}

describe('hosted full proof package transaction inclusion', () => {
  it.each(FIXTURES.map((packet, index) => [index, packet] as const))(
    'folds real hosted bundle %s into its supplied block header',
    async (_index, packet) => {
      const report = await verifyProof(packet);
      expect(report.ok).toBe(true);
      expect(report.packetTxInclusion).toEqual({
        branchLength: packet.tx_inclusion_branch?.length,
        blockIndex: packet.tx_block_index,
      });
      expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')?.status).toBe('pass');
    },
  );

  it('rejects a changed transaction-inclusion sibling', async () => {
    const packet = structuredClone(FIXTURES[0]);
    if (!packet.tx_inclusion_branch?.[0]) throw new Error('fixture branch unavailable');
    packet.tx_inclusion_branch[0].hash = '00'.repeat(32);
    const report = await verifyProof(packet);
    expect(report.ok).toBe(false);
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')).toMatchObject({
      status: 'fail', code: 'ROOT_NOT_IN_HEADER',
    });
  });

  it('rejects a changed block Merkle root', async () => {
    const packet = structuredClone(FIXTURES[0]);
    if (!packet.block_header) throw new Error('fixture header unavailable');
    packet.block_header = `${packet.block_header.slice(0, 72)}${'00'.repeat(32)}${packet.block_header.slice(136)}`;
    delete packet.block_hash;
    const report = await verifyProof(packet);
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('ROOT_NOT_IN_HEADER');
  });

  it('rejects a changed header that disagrees with the claimed block hash', async () => {
    const packet = structuredClone(FIXTURES[0]);
    if (!packet.block_header) throw new Error('fixture header unavailable');
    packet.block_header = `${packet.block_header.slice(0, -2)}${packet.block_header.endsWith('00') ? '01' : '00'}`;
    const report = await verifyProof(packet);
    expect(report.ok).toBe(false);
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')).toMatchObject({
      status: 'fail', code: 'BLOCK_HASH_MISMATCH',
    });
  });

  it('rejects an index whose bits contradict the supplied directions', async () => {
    const report = await verifyProof(altered(FIXTURES[0], { tx_block_index: 0 }));
    expect(report.ok).toBe(false);
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')).toMatchObject({
      status: 'fail', code: 'MALFORMED_BUNDLE',
    });
  });

  it.each([
    ['non-array branch', { tx_inclusion_branch: 'nope' as unknown as ProofPacket['tx_inclusion_branch'] }],
    ['fractional index', { tx_block_index: 1.5 }],
    ['negative index', { tx_block_index: -1 }],
    ['out-of-range index', { tx_block_index: 2 ** 10 }],
    ['malformed txid', { tx_id: 'not-a-txid' }],
  ] as const)('rejects malformed claimed evidence (%s)', async (_label, patch) => {
    const report = await verifyProof(altered(FIXTURES[0], patch));
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('MALFORMED_BUNDLE');
  });

  it('rejects a malformed sibling without losing the otherwise coherent branch', async () => {
    const packet = structuredClone(FIXTURES[0]);
    if (!packet.tx_inclusion_branch?.[0]) throw new Error('fixture branch unavailable');
    packet.tx_inclusion_branch[0].hash = 'zz'.repeat(32);
    const report = await verifyProof(packet);
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('MALFORMED_BUNDLE');
  });

  it.each([
    ['missing header', { block_header: null }],
    ['missing branch', { tx_inclusion_branch: null }],
    ['missing index', { tx_block_index: null }],
  ] as const)('rejects an incomplete claimed proof (%s)', async (_label, patch) => {
    const report = await verifyProof(altered(FIXTURES[0], patch));
    expect(report.ok).toBe(false);
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')).toMatchObject({
      status: 'fail', code: 'MALFORMED_BUNDLE',
    });
  });

  it('preserves the explicit legacy packet contract when no transaction evidence is claimed', async () => {
    const packet = structuredClone(FIXTURES[0]);
    delete packet.block_header;
    delete packet.block_hash;
    delete packet.tx_inclusion_branch;
    delete packet.tx_block_index;
    const report = await verifyProof(packet);
    expect(report.ok).toBe(true);
    expect(report.packetTxInclusion).toBeNull();
    expect(report.steps.some((step) => step.id === 'packet_tx_inclusion')).toBe(false);
  });

  it('grades the complete nested proof bundle returned by the API', async () => {
    const source = structuredClone(FIXTURES[0]);
    const nested = {
      block_hash: source.block_hash,
      block_header: source.block_header,
      tx_inclusion_branch: source.tx_inclusion_branch,
      tx_block_index: source.tx_block_index,
    };
    delete source.block_hash;
    delete source.block_header;
    delete source.tx_inclusion_branch;
    delete source.tx_block_index;
    source.proof_bundle = nested;
    const report = await verifyProof(source);
    expect(report.ok).toBe(true);
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')?.status).toBe('pass');
  });

  it('keeps a valid packet proof distinct from an independent-node outage', async () => {
    const report = await verifyProof(FIXTURES[0], {
      chain: {
        label: 'offline.example',
        fetch: async () => {
          throw new Error('synthetic transport outage');
        },
      },
    });
    expect(report.verdict).toBe('INDETERMINATE');
    expect(report.availabilityCode).toBe('NETWORK_UNAVAILABLE');
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')?.status).toBe('pass');
  });

  it('accepts a valid empty branch at index zero when the header root is the txid', async () => {
    const fixture = loadSyntheticFixtures().find((item) => item.name === 'single-leaf-pass');
    if (!fixture?.node) throw new Error('single-leaf fixture unavailable');
    const header = Object.entries(fixture.node).find(([path]) => path.endsWith('/header'))?.[1];
    if (typeof header !== 'string') throw new Error('single-leaf header unavailable');
    const blockHash = (fixture.node[`/tx/${fixture.packet.tx_id}`] as { status: { block_hash: string } }).status.block_hash;
    const packet: ProofPacket = {
      ...fixture.packet,
      block_hash: blockHash,
      block_header: header,
      tx_inclusion_branch: [],
      tx_block_index: 0,
    };
    const report = await verifyProof(packet, { chain: offlineNode(fixture) });
    expect(report.ok).toBe(true);
    expect(report.packetTxInclusion).toEqual({ branchLength: 0, blockIndex: 0 });
  });

  it('rejects a self-consistent substituted header that is not the independently confirmed block', async () => {
    const fixture = loadSyntheticFixtures().find((item) => item.name === 'single-leaf-pass');
    if (!fixture?.node) throw new Error('single-leaf fixture unavailable');
    const original = Object.entries(fixture.node).find(([path]) => path.endsWith('/header'))?.[1];
    if (typeof original !== 'string') throw new Error('single-leaf header unavailable');
    const changed = `${original.slice(0, -2)}${original.endsWith('00') ? '01' : '00'}`;
    const packet: ProofPacket = {
      ...fixture.packet,
      block_hash: displayBlockHash(changed),
      block_header: changed,
      tx_inclusion_branch: [],
      tx_block_index: 0,
    };
    const report = await verifyProof(packet, { chain: offlineNode(fixture) });
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('BLOCK_HASH_MISMATCH');
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')?.status).toBe('pass');
    expect(report.steps.find((step) => step.id === 'block_confirm')?.status).toBe('fail');
  });

  it('rejects contradictory top-level and selected nested headers instead of mixing containers', async () => {
    const fixture = loadSyntheticFixtures().find((item) => item.name === 'single-leaf-pass');
    if (!fixture?.node) throw new Error('single-leaf fixture unavailable');
    const original = Object.entries(fixture.node).find(([path]) => path.endsWith('/header'))?.[1];
    if (typeof original !== 'string') throw new Error('single-leaf header unavailable');
    const changed = `${original.slice(0, -2)}${original.endsWith('00') ? '01' : '00'}`;
    const packet: ProofPacket = {
      ...fixture.packet,
      // This independently valid top-level header must not mask a forged
      // nested header selected with the nested branch and index.
      block_header: original,
      proof_bundle: {
        block_hash: displayBlockHash(changed),
        block_header: changed,
        tx_inclusion_branch: [],
        tx_block_index: 0,
      },
    };
    const report = await verifyProof(packet, { chain: offlineNode(fixture) });
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('MALFORMED_BUNDLE');
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')).toMatchObject({
      status: 'fail', code: 'MALFORMED_BUNDLE',
    });
  });

  it.each([
    ['non-string top-level header', { block_header: 42 }],
    ['non-string nested header', { nestedBlockHeader: { forged: true } }],
    ['non-string top-level block hash', { block_hash: 42 }],
    ['non-string nested block hash', { nestedBlockHash: { forged: true } }],
  ] as const)('rejects malformed duplicate claims without throwing (%s)', async (_label, malformed) => {
    const fixture = loadSyntheticFixtures().find((item) => item.name === 'single-leaf-pass');
    if (!fixture?.node) throw new Error('single-leaf fixture unavailable');
    const header = Object.entries(fixture.node).find(([path]) => path.endsWith('/header'))?.[1];
    if (typeof header !== 'string') throw new Error('single-leaf header unavailable');
    const blockHash = (fixture.node[`/tx/${fixture.packet.tx_id}`] as { status: { block_hash: string } }).status.block_hash;
    const packet = {
      ...fixture.packet,
      block_header: 'block_header' in malformed ? malformed.block_header : header,
      block_hash: 'block_hash' in malformed ? malformed.block_hash : blockHash,
      proof_bundle: {
        block_header: 'nestedBlockHeader' in malformed ? malformed.nestedBlockHeader : header,
        block_hash: 'nestedBlockHash' in malformed ? malformed.nestedBlockHash : blockHash,
        tx_inclusion_branch: [],
        tx_block_index: 0,
      },
    } as unknown as ProofPacket;
    const report = await verifyProof(packet, { chain: offlineNode(fixture) });
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('MALFORMED_BUNDLE');
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')).toMatchObject({
      status: 'fail', code: 'MALFORMED_BUNDLE',
    });
  });

  it('accepts duplicate header claims only when they match the selected nested proof', async () => {
    const fixture = loadSyntheticFixtures().find((item) => item.name === 'single-leaf-pass');
    if (!fixture?.node) throw new Error('single-leaf fixture unavailable');
    const header = Object.entries(fixture.node).find(([path]) => path.endsWith('/header'))?.[1];
    if (typeof header !== 'string') throw new Error('single-leaf header unavailable');
    const blockHash = (fixture.node[`/tx/${fixture.packet.tx_id}`] as { status: { block_hash: string } }).status.block_hash;
    const packet: ProofPacket = {
      ...fixture.packet,
      block_header: header,
      block_hash: blockHash,
      proof_bundle: {
        block_hash: blockHash,
        block_header: header,
        tx_inclusion_branch: [],
        tx_block_index: 0,
      },
    };
    const report = await verifyProof(packet, { chain: offlineNode(fixture) });
    expect(report.ok).toBe(true);
    expect(report.steps.find((step) => step.id === 'packet_tx_inclusion')?.status).toBe('pass');
    expect(report.steps.find((step) => step.id === 'block_confirm')?.status).toBe('pass');
  });
});
