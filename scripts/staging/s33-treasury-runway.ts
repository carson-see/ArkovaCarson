/**
 * SCRUM-2694 offline treasury-runway paper contract.
 *
 * This module performs arithmetic only. It cannot read a treasury, query a
 * chain, resolve a signature, or upgrade asserted mainnet inputs into measured
 * evidence. Lane 3's future generic signature authority remains an explicit
 * dependency rather than a locally invented identity.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

const feeModelSchema = z.object({
  sourcePath: z.literal('services/worker/src/chain/signet.ts'),
  sourceBlobSha: z.string().regex(GIT_SHA),
  expression: z.literal('estimateTxVsize(true, 36)'),
  hasChange: z.literal(true),
  opReturnPayloadBytes: z.literal(36),
  txVbytes: z.literal(157),
}).strict();

const inputSchema = z.object({
  schemaVersion: z.literal('arkova.s33.l1.treasury-runway-input/v1'),
  evidenceMode: z.literal('OFFLINE_PAPER_UNSIGNED'),
  modelId: z.string().regex(SAFE_ID),
  generatedAt: z.string().datetime({ offset: true }),
  exactHeadSha: z.string().regex(GIT_SHA),
  exactTreeSha: z.string().regex(GIT_SHA),
  claimClass: z.literal('ASSERTED_MAINNET_FEE_MODEL_NOT_MEASURED_ON_CHAIN'),
  feeModel: feeModelSchema,
  baseline: z.object({
    transactionsPerDay: z.literal(1),
    claimClass: z.literal('ASSERTED_CURRENT_TOPOLOGY_NOT_CHAIN_MEASURED'),
  }).strict(),
  fanout: z.object({
    orgCounts: z.array(z.number().int().positive().max(10_000).safe()).min(1),
    feeRatesSatPerVbyte: z.array(
      z.number().int().positive().max(200).safe(),
    ).min(1),
  }).strict(),
  illustrativeTreasuryBalanceSats: z.number().int().positive().safe(),
  signetMechanism: z.object({
    claimClass: z.literal('MECHANISM_ONLY_NOT_MAINNET_COST'),
    status: z.literal('DEFERRED_POST_WAVE3'),
    measuredVbytes: z.null(),
    artifactSha256: z.null(),
  }).strict(),
  signature: z.object({
    authority: z.literal('LANE3_GENERIC_SIGNATURE_AUTHORITY'),
    status: z.literal('BLOCKED_UNAVAILABLE'),
    envelope: z.null(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (new Set(value.fanout.orgCounts).size !== value.fanout.orgCounts.length) {
    context.addIssue({
      code: 'custom',
      path: ['fanout', 'orgCounts'],
      message: 'orgCounts must be unique',
    });
  }
  if (
    new Set(value.fanout.feeRatesSatPerVbyte).size
      !== value.fanout.feeRatesSatPerVbyte.length
  ) {
    context.addIssue({
      code: 'custom',
      path: ['fanout', 'feeRatesSatPerVbyte'],
      message: 'feeRatesSatPerVbyte must be unique',
    });
  }
});

export type S33TreasuryRunwayInput = z.input<typeof inputSchema>;

export interface S33TreasuryRunwayBaselineRow {
  readonly feeRateSatPerVbyte: number;
  readonly transactionsPerDay: 1;
  readonly satsPerTransaction: number;
  readonly dailySats: number;
  readonly monthlyThirtyDaySats: number;
  readonly runwayDaysFloor: number;
}

export interface S33TreasuryRunwayFanoutRow {
  readonly orgCount: number;
  readonly feeRateSatPerVbyte: number;
  readonly transactionsPerDay: number;
  readonly multiplierVsBaseline: number;
  readonly satsPerTransaction: number;
  readonly dailySats: number;
  readonly monthlyThirtyDaySats: number;
  readonly runwayDaysFloor: number;
}

export interface S33TreasuryRunwayResult {
  readonly schemaVersion: 'arkova.s33.l1.treasury-runway-result/v1';
  readonly status: 'OFFLINE_PAPER_UNSIGNED';
  readonly releaseAcceptance: false;
  readonly modelId: string;
  readonly generatedAt: string;
  readonly exactHeadSha: string;
  readonly exactTreeSha: string;
  readonly illustrativeTreasuryBalanceSats: number;
  readonly feeModel: Readonly<z.infer<typeof feeModelSchema>>;
  readonly baselineRows: readonly S33TreasuryRunwayBaselineRow[];
  readonly fanoutRows: readonly S33TreasuryRunwayFanoutRow[];
  readonly signetMechanism: Readonly<{
    claimClass: 'MECHANISM_ONLY_NOT_MAINNET_COST';
    status: 'DEFERRED_POST_WAVE3';
    measuredVbytes: null;
    artifactSha256: null;
  }>;
  readonly signature: Readonly<{
    authority: 'LANE3_GENERIC_SIGNATURE_AUTHORITY';
    status: 'BLOCKED_UNAVAILABLE';
    envelope: null;
  }>;
  readonly producerDependencies: readonly [
    'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
  ];
  readonly claims: Readonly<{
    mainnetCost: 'asserted-from-fee-model-not-measured-on-chain';
    signetMechanism: 'separate-and-deferred';
    treasuryBalance: 'illustrative-not-a-treasury-read';
    fanout: 'N-transactions-per-day-versus-one-asserted-baseline';
  }>;
  readonly inputDigestSha256: string;
  readonly resultDigestSha256: string;
}

const RUNWAY_RESULTS = new WeakSet<S33TreasuryRunwayResult>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => (
      `${JSON.stringify(key)}:${stableJson(child)}`
    )).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Cannot digest undefined runway data.');
  return encoded;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function safeProduct(label: string, ...values: number[]): number {
  let product = 1;
  for (const value of values) {
    product *= value;
    if (!Number.isSafeInteger(product)) {
      throw new Error(`${label} must remain a safe integer.`);
    }
  }
  return product;
}

function rowArithmetic(
  treasuryBalanceSats: number,
  txVbytes: number,
  transactionsPerDay: number,
  feeRateSatPerVbyte: number,
): Omit<S33TreasuryRunwayBaselineRow, 'feeRateSatPerVbyte' | 'transactionsPerDay'> {
  const satsPerTransaction = safeProduct(
    'satsPerTransaction',
    txVbytes,
    feeRateSatPerVbyte,
  );
  const dailySats = safeProduct(
    'dailySats',
    transactionsPerDay,
    satsPerTransaction,
  );
  const monthlyThirtyDaySats = safeProduct(
    'monthlyThirtyDaySats',
    dailySats,
    30,
  );
  return {
    satsPerTransaction,
    dailySats,
    monthlyThirtyDaySats,
    runwayDaysFloor: Math.floor(treasuryBalanceSats / dailySats),
  };
}

export function calculateS33TreasuryRunway(
  rawInput: unknown,
): S33TreasuryRunwayResult {
  const input = inputSchema.parse(rawInput);
  const feeRates = [...input.fanout.feeRatesSatPerVbyte]
    .sort((left, right) => left - right);
  const orgCounts = [...input.fanout.orgCounts]
    .sort((left, right) => left - right);
  const baselineRows = feeRates.map((feeRateSatPerVbyte) => ({
    feeRateSatPerVbyte,
    transactionsPerDay: 1 as const,
    ...rowArithmetic(
      input.illustrativeTreasuryBalanceSats,
      input.feeModel.txVbytes,
      1,
      feeRateSatPerVbyte,
    ),
  }));
  const fanoutRows = orgCounts.flatMap((orgCount) => feeRates.map(
    (feeRateSatPerVbyte): S33TreasuryRunwayFanoutRow => ({
      orgCount,
      feeRateSatPerVbyte,
      transactionsPerDay: orgCount,
      multiplierVsBaseline: orgCount,
      ...rowArithmetic(
        input.illustrativeTreasuryBalanceSats,
        input.feeModel.txVbytes,
        orgCount,
        feeRateSatPerVbyte,
      ),
    }),
  ));
  const resultWithoutDigest = {
    schemaVersion: 'arkova.s33.l1.treasury-runway-result/v1' as const,
    status: 'OFFLINE_PAPER_UNSIGNED' as const,
    releaseAcceptance: false as const,
    modelId: input.modelId,
    generatedAt: input.generatedAt,
    exactHeadSha: input.exactHeadSha,
    exactTreeSha: input.exactTreeSha,
    illustrativeTreasuryBalanceSats: input.illustrativeTreasuryBalanceSats,
    feeModel: { ...input.feeModel },
    baselineRows,
    fanoutRows,
    signetMechanism: { ...input.signetMechanism },
    signature: { ...input.signature },
    producerDependencies: [
      'LANE3_GENERIC_SIGNATURE_AUTHORITY_UNAVAILABLE',
    ] as const,
    claims: {
      mainnetCost: 'asserted-from-fee-model-not-measured-on-chain' as const,
      signetMechanism: 'separate-and-deferred' as const,
      treasuryBalance: 'illustrative-not-a-treasury-read' as const,
      fanout: 'N-transactions-per-day-versus-one-asserted-baseline' as const,
    },
    inputDigestSha256: digest(input),
  };
  const result = deepFreeze<S33TreasuryRunwayResult>({
    ...resultWithoutDigest,
    resultDigestSha256: digest(resultWithoutDigest),
  });
  RUNWAY_RESULTS.add(result);
  return result;
}

export function requireS33TreasuryRunwayResult(
  candidate: unknown,
): S33TreasuryRunwayResult {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Paper runway evidence requires a provenance-bound result.');
  }
  const result = candidate as S33TreasuryRunwayResult;
  if (!RUNWAY_RESULTS.has(result)) {
    throw new Error('Paper runway evidence requires a provenance-bound result.');
  }
  return result;
}
