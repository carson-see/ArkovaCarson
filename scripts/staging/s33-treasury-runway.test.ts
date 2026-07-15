import { describe, expect, it } from 'vitest';

import {
  calculateS33TreasuryRunway,
  requireS33TreasuryRunwayResult,
  type S33TreasuryRunwayInput,
} from './s33-treasury-runway';

const input = (
  overrides: Partial<S33TreasuryRunwayInput> = {},
): S33TreasuryRunwayInput => ({
  schemaVersion: 'arkova.s33.l1.treasury-runway-input/v1',
  evidenceMode: 'OFFLINE_PAPER_UNSIGNED',
  modelId: 's33-w3-c-runway-fixture',
  generatedAt: '2026-07-15T20:30:00.000Z',
  exactHeadSha: 'a'.repeat(40),
  exactTreeSha: 'b'.repeat(40),
  claimClass: 'ASSERTED_MAINNET_FEE_MODEL_NOT_MEASURED_ON_CHAIN',
  feeModel: {
    sourcePath: 'services/worker/src/chain/signet.ts',
    sourceBlobSha: 'c'.repeat(40),
    expression: 'estimateTxVsize(true, 36)',
    hasChange: true,
    opReturnPayloadBytes: 36,
    txVbytes: 157,
  },
  baseline: {
    transactionsPerDay: 1,
    claimClass: 'ASSERTED_CURRENT_TOPOLOGY_NOT_CHAIN_MEASURED',
  },
  fanout: {
    orgCounts: [5, 25, 50, 100],
    feeRatesSatPerVbyte: [2, 10, 50],
  },
  illustrativeTreasuryBalanceSats: 5_000_000,
  signetMechanism: {
    claimClass: 'MECHANISM_ONLY_NOT_MAINNET_COST',
    status: 'DEFERRED_POST_WAVE3',
    measuredVbytes: null,
    artifactSha256: null,
  },
  signature: {
    authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
    status: 'BLOCKED_UNAVAILABLE',
    envelope: null,
  },
  ...overrides,
});

describe('S3.3 W3-C treasury runway paper contract', () => {
  it('derives the explicit N-times mainnet paper sensitivity without a chain measurement claim', () => {
    const result = calculateS33TreasuryRunway(input());

    expect(result.status).toBe('OFFLINE_PAPER_UNSIGNED');
    expect(result.releaseAcceptance).toBe(false);
    expect(result.claims).toEqual({
      mainnetCost: 'asserted-from-fee-model-not-measured-on-chain',
      signetMechanism: 'separate-and-deferred',
      treasuryBalance: 'illustrative-not-a-treasury-read',
      fanout: 'N-transactions-per-day-versus-one-asserted-baseline',
    });
    expect(result.baselineRows).toEqual([
      expect.objectContaining({
        feeRateSatPerVbyte: 2,
        transactionsPerDay: 1,
        satsPerTransaction: 314,
        dailySats: 314,
      }),
      expect.objectContaining({
        feeRateSatPerVbyte: 10,
        transactionsPerDay: 1,
        satsPerTransaction: 1_570,
        dailySats: 1_570,
      }),
      expect.objectContaining({
        feeRateSatPerVbyte: 50,
        transactionsPerDay: 1,
        satsPerTransaction: 7_850,
        dailySats: 7_850,
      }),
    ]);
    expect(
      result.fanoutRows.find(
        ({ orgCount, feeRateSatPerVbyte }) =>
          orgCount === 25 && feeRateSatPerVbyte === 10,
      ),
    ).toEqual({
      orgCount: 25,
      feeRateSatPerVbyte: 10,
      transactionsPerDay: 25,
      multiplierVsBaseline: 25,
      satsPerTransaction: 1_570,
      dailySats: 39_250,
      monthlyThirtyDaySats: 1_177_500,
      runwayDaysFloor: 127,
    });
    expect(result.inputDigestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.resultDigestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('strictly rejects unknown fields and any attempt to relabel paper inputs as measured', () => {
    const withSecret = {
      ...input(),
      feeModel: { ...input().feeModel, measuredOnChain: true },
    } as unknown;
    expect(() => calculateS33TreasuryRunway(withSecret)).toThrow(
      /unrecognized|measuredOnChain|strict/i,
    );

    const measuredClaim = {
      ...input(),
      claimClass: 'MEASURED_MAINNET_COST',
    } as unknown;
    expect(() => calculateS33TreasuryRunway(measuredClaim)).toThrow(
      /claimClass|ASSERTED_MAINNET|invalid/i,
    );

    const fabricatedSignet = {
      ...input(),
      signetMechanism: {
        ...input().signetMechanism,
        status: 'MEASURED',
        measuredVbytes: 157,
        artifactSha256: `sha256:${'d'.repeat(64)}`,
      },
    } as unknown;
    expect(() => calculateS33TreasuryRunway(fabricatedSignet)).toThrow(
      /signetMechanism|DEFERRED_POST_WAVE3|invalid/i,
    );
  });

  it('requires unique bounded sensitivity inputs and safe arithmetic', () => {
    expect(() => calculateS33TreasuryRunway(input({
      fanout: { orgCounts: [25, 25], feeRatesSatPerVbyte: [2, 10] },
    }))).toThrow(/orgCounts|unique/i);
    expect(() => calculateS33TreasuryRunway(input({
      fanout: { orgCounts: [25], feeRatesSatPerVbyte: [201] },
    }))).toThrow(/feeRates|200|less than or equal/i);
    expect(() => calculateS33TreasuryRunway(input({
      illustrativeTreasuryBalanceSats: Number.MAX_SAFE_INTEGER + 1,
    }))).toThrow(/safe|balance/i);
  });

  it('brands the immutable result and rejects caller clones as signed-input evidence', () => {
    const result = calculateS33TreasuryRunway(input());
    expect(requireS33TreasuryRunwayResult(result)).toBe(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.fanoutRows)).toBe(true);
    expect(() => requireS33TreasuryRunwayResult(structuredClone(result)))
      .toThrow(/provenance|paper runway/i);
    expect(result.signature).toEqual({
      authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY',
      status: 'BLOCKED_UNAVAILABLE',
      envelope: null,
    });
  });
});
