import { describe, expect, it } from 'vitest';
import { verifyProof } from '../src/verify.js';
import { loadSyntheticFixtures } from './helpers.js';
import type { ProofPacket, VerifierFixture } from '../src/types.js';

function firstPassingRecomputeFixture(): VerifierFixture {
  const fixture = loadSyntheticFixtures().find((item) => item.expect.ok);
  if (!fixture) throw new Error('no passing synthetic fixture available');
  return fixture;
}

describe('ProofPacket transaction inclusion claim boundary', () => {
  it('preserves legacy packets that carry a header but no transaction branch claim', async () => {
    const fixture = firstPassingRecomputeFixture();
    const report = await verifyProof({ ...fixture.packet, block_header: '00'.repeat(80) });
    expect(report.ok).toBe(true);
    expect(report.packetTxInclusion).toBeNull();
    expect(report.steps.some((step) => step.id === 'packet_tx_inclusion')).toBe(false);
  });

  it('rejects a top-level half-pair instead of borrowing nested evidence', async () => {
    const fixture = firstPassingRecomputeFixture();
    const packet: ProofPacket = {
      ...fixture.packet,
      tx_inclusion_branch: [],
      proof_bundle: {
        block_header: '00'.repeat(80),
        tx_inclusion_branch: [],
        tx_block_index: 0,
      },
    };
    const report = await verifyProof(packet);
    expect(report.ok).toBe(false);
    expect(report.packetTxInclusion).toBeNull();
    expect(report.reasonCode).toBe('MALFORMED_BUNDLE');
  });

  it('rejects malformed nested claimed evidence', async () => {
    const fixture = firstPassingRecomputeFixture();
    const report = await verifyProof({
      ...fixture.packet,
      proof_bundle: {
        block_header: 'not-a-header',
        tx_inclusion_branch: [],
        tx_block_index: 0,
      },
    });
    expect(report.ok).toBe(false);
    expect(report.reasonCode).toBe('HEADER_INVALID');
  });

  it('preserves the explicit no-evidence contract', async () => {
    const fixture = firstPassingRecomputeFixture();
    const report = await verifyProof({
      ...fixture.packet,
      proof_bundle: {
        block_header: null,
        tx_inclusion_branch: null,
        tx_block_index: null,
      },
    });
    expect(report.ok).toBe(true);
    expect(report.packetTxInclusion).toBeNull();
  });
});
