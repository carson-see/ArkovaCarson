/**
 * Pure Wave-3 treasury pre-split and organization fan-out contracts.
 *
 * This module deliberately cannot reach a wallet, node, database, or cloud
 * API. It plans deterministic signet work and validates facts captured later
 * by a separately supervised adapter.
 */

import { createHash } from 'node:crypto';

import { parseUtcTimestamp } from './batch-drain-time';

const TX_ID = /^[0-9a-f]{64}$/;
const SIGNET_TREASURY_ADDRESS = /^tb1[a-z0-9]{20,87}$/;

export interface TreasuryInput {
  readonly txId: string;
  readonly vout: number;
  readonly valueSats: number;
  readonly confirmations: number;
}

export interface TreasuryPresplitPlanInput {
  readonly planId: string;
  readonly network: 'signet';
  readonly treasuryAddress: string;
  readonly inputs: readonly TreasuryInput[];
  readonly outputCount: number;
  readonly feeSats: number;
  readonly minOutputSats: number;
}

export interface TreasuryPresplitOutput {
  readonly outputIndex: number;
  readonly address: string;
  readonly valueSats: number;
}

export interface TreasuryPresplitPlan {
  readonly planId: string;
  readonly network: 'signet';
  readonly treasuryAddress: string;
  readonly inputs: readonly TreasuryInput[];
  readonly outputs: readonly TreasuryPresplitOutput[];
  readonly outputCount: 32;
  readonly feeSats: number;
  readonly minOutputSats: number;
  readonly planDigest: string;
}

export interface TreasuryPresplitObservation {
  planDigest: string;
  splitTxId: string;
  network: 'signet';
  observedAt: string;
  inputsSpent: Array<{ txId: string; vout: number }>;
  outputs: Array<{
    vout: number;
    address: string;
    valueSats: number;
    confirmations: number;
    spent: boolean;
  }>;
}

export interface ConfirmedTreasuryOutput {
  readonly txId: string;
  readonly vout: number;
  readonly address: string;
  readonly valueSats: number;
  readonly confirmations: number;
}

export interface ConfirmedTreasurySplit {
  readonly planDigest: string;
  readonly splitTxId: string;
  readonly network: 'signet';
  readonly observedAt: string;
  readonly confirmedOutputCount: 32;
  readonly outputs: readonly ConfirmedTreasuryOutput[];
}

export interface RankedOrganization {
  readonly orgId: string;
  readonly rank: number;
}

export interface OrgFanOutReservation {
  readonly orgId: string;
  readonly rank: number;
  readonly input: {
    readonly txId: string;
    readonly vout: number;
    readonly valueSats: number;
  };
}

export interface OrgFanOutPlan {
  readonly planId: string;
  readonly network: 'signet';
  readonly sourceSplitPlanDigest: string;
  readonly reservations: readonly OrgFanOutReservation[];
  readonly planDigest: string;
}

interface OrgFanOutPlanSource {
  readonly planId: string;
  readonly confirmedSplit: ConfirmedTreasurySplit;
  readonly orgs: readonly RankedOrganization[];
}

export interface OrgFanOutObservation {
  planDigest: string;
  observedAt: string;
  transactions: Array<{
    orgId: string;
    input: { txId: string; vout: number; valueSats: number };
    txId: string;
    network: 'signet';
    accepted: boolean;
    tooLongMempoolChain: boolean;
  }>;
  consolidation: {
    observedAt: string;
    spentOutpoints: Array<{ txId: string; vout: number }>;
  };
}

export interface OrgFanOutEvidenceSummary {
  readonly acceptedOrganizations: number;
  readonly uniqueInputs: number;
  readonly consolidationInterference: false;
  readonly observedAt: string;
}

const CONFIRMED_SPLITS = new WeakSet<ConfirmedTreasurySplit>();
const TREASURY_PRESPLIT_PLANS = new WeakSet<TreasuryPresplitPlan>();
const ORG_FAN_OUT_PLAN_SOURCES = new WeakMap<
  OrgFanOutPlan,
  Readonly<OrgFanOutPlanSource>
>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Cannot digest undefined plan data.');
  return encoded;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function requireId(value: string, label: string): void {
  if (!value?.trim()) throw new Error(`${label} is required.`);
}

function requireTxId(value: string, label: string): void {
  if (!TX_ID.test(value)) throw new Error(`${label} must be lowercase 64-hex.`);
}

function requireSafeInteger(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
  if (value < minimum) throw new Error(`${label} must be at least ${minimum}.`);
}

function outpoint(value: { txId: string; vout: number }): string {
  return `${value.txId}:${value.vout}`;
}

export function planTreasuryPresplit(input: TreasuryPresplitPlanInput): TreasuryPresplitPlan {
  requireId(input.planId, 'planId');
  if (input.network !== 'signet') throw new Error('Treasury pre-split plans are signet-only.');
  if (!SIGNET_TREASURY_ADDRESS.test(input.treasuryAddress)) {
    throw new Error('treasuryAddress must be a bounded lowercase tb1 signet treasury address.');
  }
  if (input.outputCount !== 32) throw new Error('Treasury pre-split must create exactly 32 outputs.');
  requireSafeInteger(input.feeSats, 'feeSats', 0);
  requireSafeInteger(input.minOutputSats, 'minOutputSats', 1);
  if (input.inputs.length === 0) throw new Error('Treasury pre-split requires confirmed inputs.');

  const seen = new Set<string>();
  const inputs = input.inputs.map((candidate, index): TreasuryInput => {
    requireTxId(candidate.txId, `inputs[${index}].txId`);
    requireSafeInteger(candidate.vout, `inputs[${index}].vout`, 0);
    requireSafeInteger(candidate.valueSats, `inputs[${index}].valueSats`, 1);
    requireSafeInteger(candidate.confirmations, `inputs[${index}] confirmed-input confirmations`, 1);
    const key = outpoint(candidate);
    if (seen.has(key)) throw new Error(`Duplicate treasury input outpoint ${key}.`);
    seen.add(key);
    return { ...candidate };
  }).sort((left, right) => left.txId.localeCompare(right.txId) || left.vout - right.vout);

  const totalInputSats = inputs.reduce((sum, candidate) => {
    const next = sum + candidate.valueSats;
    if (!Number.isSafeInteger(next)) throw new Error('Treasury input total must be a safe integer.');
    return next;
  }, 0);
  const outputSats = totalInputSats - input.feeSats;
  if (!Number.isSafeInteger(outputSats) || outputSats <= 0) {
    throw new Error('Treasury inputs are insufficient after the declared fee.');
  }
  const baseOutputSats = Math.floor(outputSats / input.outputCount);
  const remainder = outputSats % input.outputCount;
  if (baseOutputSats < input.minOutputSats) {
    throw new Error('Treasury pre-split would create an output below the declared minimum (dust guard).');
  }

  const outputs: TreasuryPresplitOutput[] = Array.from(
    { length: input.outputCount },
    (_, outputIndex) => ({
      outputIndex,
      address: input.treasuryAddress,
      valueSats: baseOutputSats + (outputIndex < remainder ? 1 : 0),
    }),
  );
  const core = {
    planId: input.planId,
    network: input.network,
    treasuryAddress: input.treasuryAddress,
    inputs,
    outputs,
    outputCount: 32 as const,
    feeSats: input.feeSats,
    minOutputSats: input.minOutputSats,
  };
  const plan = deepFreeze<TreasuryPresplitPlan>({ ...core, planDigest: digest(core) });
  TREASURY_PRESPLIT_PLANS.add(plan);
  return plan;
}

export function requireTreasuryPresplitPlan(candidate: unknown): TreasuryPresplitPlan {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Treasury readiness requires a validated pre-split plan provenance handle.');
  }
  const plan = candidate as TreasuryPresplitPlan;
  if (!TREASURY_PRESPLIT_PLANS.has(plan)) {
    throw new Error('Treasury readiness requires a validated pre-split plan provenance handle.');
  }
  return plan;
}

export function assertTreasuryPresplitObservation(
  plan: TreasuryPresplitPlan,
  observation: TreasuryPresplitObservation,
): ConfirmedTreasurySplit {
  requireTreasuryPresplitPlan(plan);
  if (observation.planDigest !== plan.planDigest) throw new Error('Treasury split observation plan digest mismatch.');
  if (observation.network !== 'signet') throw new Error('Treasury split observation must be on signet.');
  requireTxId(observation.splitTxId, 'splitTxId');
  parseUtcTimestamp(observation.observedAt, 'treasury split observedAt');
  if (observation.inputsSpent.length !== plan.inputs.length) {
    throw new Error('Treasury split observation does not contain the exact input set.');
  }
  plan.inputs.forEach((expected, index) => {
    const actual = observation.inputsSpent[index];
    if (!actual || actual.txId !== expected.txId || actual.vout !== expected.vout) {
      throw new Error(`Treasury split input ${index} does not match the planned input.`);
    }
  });
  if (observation.outputs.length !== 32) {
    throw new Error('Treasury split observation must contain exactly 32 outputs.');
  }
  const outputs = plan.outputs.map((expected, index): ConfirmedTreasuryOutput => {
    const actual = observation.outputs[index];
    if (
      !actual
      || actual.vout !== expected.outputIndex
      || actual.address !== expected.address
      || actual.valueSats !== expected.valueSats
    ) throw new Error(`Treasury split output ${index} value, address, or vout does not match the plan.`);
    requireSafeInteger(actual.confirmations, `outputs[${index}] confirmed-output confirmations`, 1);
    if (actual.spent) throw new Error(`Treasury split output ${index} is already spent.`);
    return {
      txId: observation.splitTxId,
      vout: actual.vout,
      address: actual.address,
      valueSats: actual.valueSats,
      confirmations: actual.confirmations,
    };
  });
  const confirmed = deepFreeze<ConfirmedTreasurySplit>({
    planDigest: plan.planDigest,
    splitTxId: observation.splitTxId,
    network: 'signet',
    observedAt: observation.observedAt,
    confirmedOutputCount: 32,
    outputs,
  });
  CONFIRMED_SPLITS.add(confirmed);
  return confirmed;
}

export function planOrgFanOut(input: {
  readonly planId: string;
  readonly confirmedSplit: ConfirmedTreasurySplit;
  readonly orgs: readonly RankedOrganization[];
}): OrgFanOutPlan {
  requireId(input.planId, 'planId');
  if (!CONFIRMED_SPLITS.has(input.confirmedSplit)) {
    throw new Error('Organization fan-out requires a validated confirmed treasury split.');
  }
  if (input.orgs.length <= 25) throw new Error('Organization fan-out requires more than 25 organizations.');
  if (input.orgs.length > input.confirmedSplit.outputs.length) {
    throw new Error('Organization fan-out exceeds the confirmed split output count.');
  }
  const orgIds = new Set<string>();
  const ranks = new Set<number>();
  const orgs = input.orgs.map((org, index) => {
    requireId(org.orgId, `orgs[${index}].orgId`);
    requireSafeInteger(org.rank, `orgs[${index}].rank`, 1);
    if (orgIds.has(org.orgId) || ranks.has(org.rank)) {
      throw new Error('Organization fan-out org IDs and ranks must be unique.');
    }
    orgIds.add(org.orgId);
    ranks.add(org.rank);
    return { ...org };
  }).sort((left, right) => left.rank - right.rank || left.orgId.localeCompare(right.orgId));
  orgs.forEach((org, index) => {
    if (org.rank !== index + 1) throw new Error('Organization fan-out ranks must be contiguous from one.');
  });
  const reservations: OrgFanOutReservation[] = orgs.map((org, index) => {
    const output = input.confirmedSplit.outputs[index]!;
    return {
      ...org,
      input: { txId: output.txId, vout: output.vout, valueSats: output.valueSats },
    };
  });
  const core = {
    planId: input.planId,
    network: 'signet' as const,
    sourceSplitPlanDigest: input.confirmedSplit.planDigest,
    reservations,
  };
  const plan = deepFreeze({ ...core, planDigest: digest(core) });
  ORG_FAN_OUT_PLAN_SOURCES.set(plan, deepFreeze({
    planId: input.planId,
    confirmedSplit: input.confirmedSplit,
    orgs: input.orgs.map((org) => ({ ...org })),
  }));
  return plan;
}

function requireOrgFanOutPlan(candidate: unknown): OrgFanOutPlan {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(
      'Organization fan-out evidence requires a validated plan provenance handle.',
    );
  }
  const plan = candidate as OrgFanOutPlan;
  const source = ORG_FAN_OUT_PLAN_SOURCES.get(plan);
  if (!source) {
    throw new Error(
      'Organization fan-out evidence requires a validated plan provenance handle.',
    );
  }
  const rebuilt = planOrgFanOut(source);
  if (stableJson(plan) !== stableJson(rebuilt)) {
    throw new Error(
      'Validated organization fan-out plan does not match its strict rebuilt source.',
    );
  }
  if (plan.reservations.length <= 25) {
    throw new Error(
      'Organization fan-out evidence requires more than 25 reservations.',
    );
  }
  const orgIds = new Set<string>();
  const ranks = new Set<number>();
  const reservedInputs = new Set<string>();
  plan.reservations.forEach((reservation, index) => {
    requireId(reservation.orgId, `reservations[${index}].orgId`);
    requireSafeInteger(reservation.rank, `reservations[${index}].rank`, 1);
    if (reservation.rank !== index + 1) {
      throw new Error(
        'Organization fan-out reservation ranks must be contiguous from one.',
      );
    }
    requireTxId(reservation.input.txId, `reservations[${index}].input.txId`);
    requireSafeInteger(
      reservation.input.vout,
      `reservations[${index}].input.vout`,
      0,
    );
    requireSafeInteger(
      reservation.input.valueSats,
      `reservations[${index}].input.valueSats`,
      1,
    );
    const inputKey = outpoint(reservation.input);
    if (
      orgIds.has(reservation.orgId)
      || ranks.has(reservation.rank)
      || reservedInputs.has(inputKey)
    ) {
      throw new Error(
        'Organization fan-out requires unique org IDs, ranks, and one unique reserved UTXO per organization.',
      );
    }
    orgIds.add(reservation.orgId);
    ranks.add(reservation.rank);
    reservedInputs.add(inputKey);
  });
  if (
    orgIds.size !== plan.reservations.length
    || reservedInputs.size !== plan.reservations.length
  ) {
    throw new Error(
      'Organization fan-out requires more than 25 unique organizations with one unique UTXO each.',
    );
  }
  return plan;
}

export function assertOrgFanOutObservation(
  plan: OrgFanOutPlan,
  observation: OrgFanOutObservation,
): OrgFanOutEvidenceSummary {
  requireOrgFanOutPlan(plan);
  if (observation.planDigest !== plan.planDigest) throw new Error('Organization fan-out observation plan digest mismatch.');
  const fanOutObservedAt = parseUtcTimestamp(observation.observedAt, 'fan-out observedAt');
  const consolidationObservedAt = parseUtcTimestamp(
    observation.consolidation.observedAt,
    'consolidation observedAt',
  );
  if (consolidationObservedAt < fanOutObservedAt) {
    throw new Error('Treasury consolidation must be observed at or after the fan-out boundary.');
  }
  if (observation.transactions.length !== plan.reservations.length) {
    throw new Error('Organization fan-out observation does not match every reservation.');
  }
  const usedInputs = new Set<string>();
  const txIds = new Set<string>();
  plan.reservations.forEach((expected, index) => {
    const actual = observation.transactions[index];
    if (!actual || actual.orgId !== expected.orgId) {
      throw new Error(`Organization fan-out transaction ${index} does not match its reservation.`);
    }
    if (
      actual.input.txId !== expected.input.txId
      || actual.input.vout !== expected.input.vout
      || actual.input.valueSats !== expected.input.valueSats
    ) throw new Error(`Organization fan-out transaction ${index} reused or changed its reserved input.`);
    const inputKey = outpoint(actual.input);
    if (usedInputs.has(inputKey)) throw new Error(`Organization fan-out reused input ${inputKey}.`);
    usedInputs.add(inputKey);
    requireTxId(actual.txId, `transactions[${index}].txId`);
    if (txIds.has(actual.txId)) throw new Error('Organization fan-out transaction IDs must be unique.');
    txIds.add(actual.txId);
    if (actual.network !== 'signet') throw new Error('Organization fan-out transactions must target signet.');
    if (actual.tooLongMempoolChain) throw new Error('Organization fan-out hit too-long-mempool-chain.');
    if (!actual.accepted) throw new Error('Organization fan-out transaction was not accepted.');
  });
  for (const spent of observation.consolidation.spentOutpoints) {
    requireTxId(spent.txId, 'consolidation spent txId');
    requireSafeInteger(spent.vout, 'consolidation spent vout', 0);
    if (usedInputs.has(outpoint(spent))) {
      throw new Error('Treasury consolidation interfered with a reserved organization fan-out input.');
    }
  }
  return deepFreeze({
    acceptedOrganizations: plan.reservations.length,
    uniqueInputs: usedInputs.size,
    consolidationInterference: false as const,
    observedAt: observation.observedAt,
  });
}
