/**
 * Conformance suite — runs every self-describing fixture through verifyProof()
 * with an OFFLINE, fixture-backed independent node (an @arkova/verifier
 * IndependentNodeFetch served from canned Esplora REST responses). No network
 * is touched.
 *
 * This pins the verdict for passing vectors, recompute failures, the
 * CVE-2012-2459 forged self-pair (structural guard, driven by leaf_count), an
 * on-chain root mismatch, and the txid-binding regression (Carson #1353
 * verify.ts:173): a mismatched tx body → NOT VERIFIED.
 */

import { describe, it, expect } from 'vitest';
import { verifyProof } from '../src/verify.js';
import { renderReport } from '../src/lib/report.js';
import { loadSyntheticFixtures, offlineNode } from './helpers.js';

describe('verifier conformance (offline fixtures)', () => {
  const fixtures = loadSyntheticFixtures();

  it('loads at least 9 synthetic vectors', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(9);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: ${fixture.description}`, async () => {
      const chain = fixture.node ? offlineNode(fixture) : undefined;
      const report = await verifyProof(fixture.packet, { chain });

      expect(report.ok, `expected ok=${fixture.expect.ok} for ${fixture.name}`).toBe(
        fixture.expect.ok,
      );

      if (fixture.expect.reasonIncludes) {
        const allDetail = report.steps.map((s) => s.detail).join(' | ');
        expect(allDetail).toContain(fixture.expect.reasonIncludes);
      }

      // The verifier must NEVER derive its verdict from the packet's own
      // `verified` claim — prove that by checking it reports its own verdict
      // even when the packet claim and the truth diverge.
      if (fixture.packet.verified != null) {
        expect(report.serverClaimedVerified).toBe(fixture.packet.verified);
      }
    });
  }

  it('a passing vector reports a real independent node and a confirmed block', async () => {
    const f = fixtures.find((x) => x.name === 'odd-leaf-pass')!;
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    expect(report.ok).toBe(true);
    expect(report.independentNode).toBe('offline-fixture-node');
    expect(report.blockHeight).toBe(812345);
    expect(report.steps.find((s) => s.id === 'op_return')?.status).toBe('pass');
    expect(report.steps.find((s) => s.id === 'block_confirm')?.status).toBe('pass');
  });

  it('recompute-only (no chain) is honest: on-chain steps are skipped, not passed', async () => {
    const f = fixtures.find((x) => x.name === 'odd-leaf-pass')!;
    const report = await verifyProof(f.packet, {}); // no chain
    expect(report.steps.find((s) => s.id === 'recompute')?.status).toBe('pass');
    expect(report.steps.find((s) => s.id === 'op_return')?.status).toBe('skipped');
    expect(report.steps.find((s) => s.id === 'block_confirm')?.status).toBe('skipped');
    // recompute alone passes ⇒ ok true, but the report makes the gap explicit.
    expect(report.ok).toBe(true);
    expect(report.independentNode).toBeNull();
  });

  it('CVE-2012-2459: the forged self-pair trips the STRUCTURAL guard (leaf_count), not a recompute mismatch', async () => {
    const f = fixtures.find((x) => x.name === 'forged-self-pair-fail')!;
    // The fixture supplies merkle_index + leaf_count → the structural guard is active.
    expect(f.packet.leaf_count).toBe(4);
    expect(f.packet.merkle_index).toBe(0);
    const report = await verifyProof(f.packet, {});
    expect(report.ok).toBe(false);
    const recompute = report.steps.find((s) => s.id === 'recompute')!;
    expect(recompute.status).toBe('fail');
    // Distinguishes the STRUCTURAL guard from a plain recompute mismatch.
    expect(recompute.detail).toContain('CVE-2012-2459');
    expect(recompute.detail).not.toContain('recomputed root does not match');
  });

  it('txid-binding (Carson #1353 verify.ts:173): a mismatched tx body → NOT VERIFIED', async () => {
    const f = fixtures.find((x) => x.name === 'txid-mismatch-fail')!;
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    expect(report.ok).toBe(false);
    // Recompute (app tree) is fine; the on-chain inclusion step is what fails,
    // because confirmInclusion binds the proof to packet.tx_id.
    expect(report.steps.find((s) => s.id === 'recompute')?.status).toBe('pass');
    expect(report.steps.find((s) => s.id === 'block_confirm')?.status).toBe('fail');
    const detail = report.steps.map((s) => s.detail).join(' | ');
    expect(detail).toContain('inclusion proof');
  });

  it('txid-binding GUARD (Carson #1353 2nd-pass): a body whose own txid differs → NOT VERIFIED via txid_mismatch', async () => {
    const f = fixtures.find((x) => x.name === 'txid-body-mismatch-fail')!;
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    expect(report.ok).toBe(false);
    // Recompute (app tree) passes; the guard rejects on the body's self-identity
    // BEFORE reading status/vout, so the OP_RETURN (op_return) step is the one
    // that fails — distinct from the #7 fixture which only trips later inclusion.
    expect(report.steps.find((s) => s.id === 'recompute')?.status).toBe('pass');
    expect(report.steps.find((s) => s.id === 'op_return')?.status).toBe('fail');
    const detail = report.steps.map((s) => s.detail).join(' | ');
    expect(detail).toContain('does NOT identify as the requested receipt');
  });

  it('timestamp honesty (Carson #1353 2nd-pass, §1.5): a forged packet time → flagged + NOT VERIFIED, header-measured time reported', async () => {
    const f = fixtures.find((x) => x.name === 'forged-timestamp-fail')!;
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    expect(report.ok).toBe(false);
    // The on-chain inclusion itself is genuine: recompute, op_return, and block
    // all pass. ONLY the timestamp-honesty step fails.
    expect(report.steps.find((s) => s.id === 'recompute')?.status).toBe('pass');
    expect(report.steps.find((s) => s.id === 'op_return')?.status).toBe('pass');
    expect(report.steps.find((s) => s.id === 'block_confirm')?.status).toBe('pass');
    expect(report.steps.find((s) => s.id === 'timestamp_honesty')?.status).toBe('fail');
    // The reported Network Observed Time is MEASURED from the header, NOT the
    // packet's claim — and the two are surfaced as distinct, divergent values.
    expect(report.observedTimeAgrees).toBe(false);
    expect(report.networkObservedTime).not.toBeNull();
    expect(report.networkObservedTime).not.toBe(report.packetClaimedTime);
    // The packet claimed a DIFFERENT instant than the header recorded.
    expect(report.packetClaimedTime).toBe(f.packet.block_timestamp);
    expect(Date.parse(report.networkObservedTime!)).not.toBe(
      Date.parse(report.packetClaimedTime!),
    );
    const detail = report.steps.map((s) => s.detail).join(' | ');
    expect(detail).toContain('Time MISMATCH');
    // The rendered report must present the measured time, flag the divergence,
    // and never pass the claimed time off as observed.
    const rendered = renderReport(report);
    expect(rendered).toContain('measured from the independent network header');
    expect(rendered).toContain('DISAGREES with the measured time above');
  });

  it('a genuine on-chain vector reports a header-measured Network Observed Time that AGREES with the packet claim', async () => {
    const f = fixtures.find((x) => x.name === 'odd-leaf-pass')!;
    const report = await verifyProof(f.packet, { chain: offlineNode(f) });
    expect(report.ok).toBe(true);
    expect(report.steps.find((s) => s.id === 'timestamp_honesty')?.status).toBe('pass');
    expect(report.observedTimeAgrees).toBe(true);
    // The measured time is a real ISO instant equal to the packet's honest claim.
    expect(report.networkObservedTime).not.toBeNull();
    expect(Date.parse(report.networkObservedTime!)).toBe(Date.parse(f.packet.block_timestamp!));
  });

  it('recompute-only mode never promotes the packet-claimed time to a measured Network Observed Time', async () => {
    const f = fixtures.find((x) => x.name === 'odd-leaf-pass')!;
    const report = await verifyProof(f.packet, {}); // no chain
    expect(report.networkObservedTime).toBeNull(); // nothing was MEASURED
    expect(report.packetClaimedTime).toBe(f.packet.block_timestamp); // claim surfaced
    expect(report.steps.find((s) => s.id === 'timestamp_honesty')?.status).toBe('skipped');
    const rendered = renderReport(report);
    expect(rendered).toContain("record's own claim; NOT independently measured");
    expect(rendered).not.toContain('Network observed time:');
  });

  // The cli.test terminology check only covers --offline output. The ON-CHAIN
  // rendered report (with confirmed-block detail strings) is user-facing too —
  // assert the §1.3 ban across a passing AND a failing on-chain vector.
  it('the ON-CHAIN rendered report contains no banned crypto terms (§1.3)', async () => {
    const BANNED =
      /\b(Wallet|Gas|Hash|Transaction|Crypto|Blockchain|Bitcoin|Testnet|Mainnet|UTXO|Broadcast)\b/;
    for (const name of [
      'odd-leaf-pass',
      'wrong-root-onchain-fail',
      'txid-mismatch-fail',
      'txid-body-mismatch-fail',
      'forged-timestamp-fail',
    ]) {
      const f = fixtures.find((x) => x.name === name)!;
      const report = await verifyProof(f.packet, { chain: offlineNode(f) });
      expect(renderReport(report), `banned term in ${name} report`).not.toMatch(BANNED);
    }
  });
});
