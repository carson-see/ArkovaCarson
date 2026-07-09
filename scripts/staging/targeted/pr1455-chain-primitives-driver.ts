import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type DriverMode = 'self-test';

export interface DriverOptions {
  mode?: DriverMode;
  evidenceJsonl?: string;
  now?: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  details: Record<string, unknown>;
}

type CanonicalCalldataModule = {
  buildAnchorCalldata: (fingerprint: string, metadataHash?: string) => string;
  parseAnchorCalldata: (calldata: string) => {
    fingerprint: string;
    metadataHashTruncated?: string;
  } | null;
};

type DynamicFeeModule = {
  computeBatchFeeCeiling: (input: {
    baseCeiling: number;
    oldestPendingAgeMs: number;
    absoluteCapSatPerVb: number;
  }) => number;
};

type FeeSchedulerModule = {
  FEE_HARD_DEADLINE_MS: number;
  checkDynamicFeeConditions: (input: {
    baseCeiling: number;
    oldestPendingAgeMs: number;
    absoluteCapSatPerVb: number;
    queuedSince: number | null;
    estimator: { name: string; estimateFee: () => Promise<number> };
  }) => Promise<{ shouldSubmit: boolean; reason: string }>;
};

type CtidGuardModule = {
  isRealCtid: (value: string) => boolean;
  assertRealCtidOrAbsent: (value: string | undefined, label: string) => string | undefined;
  FabricatedCtidError: new (...args: unknown[]) => Error;
};

export interface Pr1455DriverResult {
  pr: 1455;
  tier: 'T3';
  status: 'pass' | 'fail';
  evidenceForSoak: false;
  mode: DriverMode;
  at: string;
  changedBehavior: string;
  checks: CheckResult[];
  blockers: string[];
}

const MIN = 60_000;
const CHANGED_BEHAVIOR =
  'PR #1455 chain primitives: canonical Base anchor calldata decode, dynamic batch fee ceiling/scheduler decisions, CTID invariance, and gated 0357 SECURED-chain-receipt trigger design.';

function ensureWorkerImportEnv(): void {
  process.env.NODE_ENV ||= 'test';
  process.env.SUPABASE_URL ||= 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
  process.env.STRIPE_SECRET_KEY ||= 'sk_test_pr1455_driver';
  process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_pr1455_driver';
  process.env.API_KEY_HMAC_SECRET ||= 'pr1455-driver-hmac-secret';
  process.env.CRON_SECRET ||= 'pr1455-driver-cron-secret';
}

function check(name: string, ok: boolean, details: Record<string, unknown>): CheckResult {
  return { name, ok, details };
}

async function runtimeImport<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}

async function runCanonicalCalldataChecks(): Promise<CheckResult> {
  ensureWorkerImportEnv();
  const { buildAnchorCalldata, parseAnchorCalldata } =
    await runtimeImport<CanonicalCalldataModule>('../../../services/worker/src/chain/base.js');

  const fingerprint = 'a'.repeat(64);
  const metadataHash = 'b'.repeat(64);
  const canonical36 = buildAnchorCalldata(fingerprint);
  const canonical44 = buildAnchorCalldata(fingerprint, metadataHash);
  const parsed36 = parseAnchorCalldata(canonical36);
  const parsed44 = parseAnchorCalldata(canonical44);
  const rejected = [
    parseAnchorCalldata(`${canonical36}ff`) === null,
    parseAnchorCalldata(`0xff${canonical36.slice(2)}`) === null,
    parseAnchorCalldata(`0x41524b56${fingerprint}a`) === null,
    parseAnchorCalldata(`0x41524b56${'g'.repeat(64)}`) === null,
  ];

  return check('canonical_base_anchor_calldata_decode', rejected.every(Boolean)
    && parsed36?.fingerprint === fingerprint
    && parsed36.metadataHashTruncated === undefined
    && parsed44?.fingerprint === fingerprint
    && parsed44.metadataHashTruncated === 'b'.repeat(16), {
    acceptedCanonicalLengths: [36, 44],
    rejectedShapes: ['trailing_junk', 'non_zero_offset_prefix', 'partial_metadata', 'non_hex'],
  });
}

async function runDynamicFeeChecks(): Promise<CheckResult> {
  ensureWorkerImportEnv();
  const { computeBatchFeeCeiling } =
    await runtimeImport<DynamicFeeModule>('../../../services/worker/src/chain/fee-estimator.js');
  const { checkDynamicFeeConditions, FEE_HARD_DEADLINE_MS } =
    await runtimeImport<FeeSchedulerModule>('../../../services/worker/src/jobs/feeAwareScheduler.js');

  const estimator = (rate: number) => ({ name: 'pr1455-driver', estimateFee: async () => rate });
  const ceilingCases = [
    computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 30 * MIN, absoluteCapSatPerVb: 200 }) === 50,
    computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 30 * MIN + 1, absoluteCapSatPerVb: 200 }) === 100,
    computeBatchFeeCeiling({ baseCeiling: 50, oldestPendingAgeMs: 60 * MIN, absoluteCapSatPerVb: 200 }) === 100,
    computeBatchFeeCeiling({ baseCeiling: 300, oldestPendingAgeMs: 60 * MIN + 1, absoluteCapSatPerVb: 200 }) === 200,
  ];
  const fresh = await checkDynamicFeeConditions({
    baseCeiling: 50,
    oldestPendingAgeMs: 0,
    absoluteCapSatPerVb: 200,
    queuedSince: null,
    estimator: estimator(80),
  });
  const aged = await checkDynamicFeeConditions({
    baseCeiling: 50,
    oldestPendingAgeMs: 31 * MIN,
    absoluteCapSatPerVb: 200,
    queuedSince: null,
    estimator: estimator(80),
  });
  const deadline = await checkDynamicFeeConditions({
    baseCeiling: 50,
    oldestPendingAgeMs: 0,
    absoluteCapSatPerVb: 200,
    queuedSince: Date.now() - FEE_HARD_DEADLINE_MS - 1000,
    estimator: estimator(1000),
  });

  return check('dynamic_batch_fee_ceiling_and_scheduler', ceilingCases.every(Boolean)
    && fresh.shouldSubmit === false
    && fresh.reason === 'above_threshold'
    && aged.shouldSubmit === true
    && aged.reason === 'below_threshold'
    && deadline.shouldSubmit === true
    && deadline.reason === 'deadline_exceeded', {
    strictBoundaries: ['30m stays 1x', '30m+1ms becomes 2x', '60m stays 2x'],
    capInjectedByCaller: true,
    schedulerBranches: {
      freshHighFee: fresh.reason,
      agedToleratedFee: aged.reason,
      deadline: deadline.reason,
    },
  });
}

async function runCtidInvarianceChecks(): Promise<CheckResult> {
  const {
    isRealCtid,
    assertRealCtidOrAbsent,
    FabricatedCtidError,
  } = await runtimeImport<CtidGuardModule>('../../../services/worker/src/ctdl/ctdl-ctid-guard.js');

  const real = 'ce-a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const fabricated = 'ce-SUPER_SECRET_public_id_should_not_leak';
  let fabricatedRejected = false;
  let valueFree = false;
  try {
    assertRealCtidOrAbsent(fabricated, 'credential');
  } catch (error) {
    fabricatedRejected = error instanceof FabricatedCtidError;
    const message = error instanceof Error ? error.message : String(error);
    valueFree = !message.includes(fabricated) && !message.includes('SUPER_SECRET');
  }

  return check('ctid_invariance_fail_closed', isRealCtid(real)
    && assertRealCtidOrAbsent(` ${real} `, 'credential') === real
    && assertRealCtidOrAbsent(undefined, 'issuer') === undefined
    && fabricatedRejected
    && valueFree, {
    realCtidPassesThrough: real,
    fabricatedRejected,
    valueFreeError: valueFree,
    absenceStaysAbsent: true,
  });
}

function runSecuredTriggerDesignCheck(): CheckResult {
  const migrationPath = resolve('supabase/migrations/0357_scrum2486_secured_chain_integrity_trigger.sql');
  const sql = readFileSync(migrationPath, 'utf8');
  const requiredFragments = [
    'CREATE OR REPLACE FUNCTION public.enforce_secured_anchor_chain_present()',
    "current_setting('arkova.secured_enforce_chain_present', true)",
    "NEW.status IS DISTINCT FROM 'SECURED'",
    'NEW.chain_tx_id IS NULL OR NEW.chain_timestamp IS NULL',
    'CREATE TRIGGER trg_anchors_chain_present_on_secured',
  ];

  return check('secured_chain_receipt_trigger_design', requiredFragments.every((fragment) => sql.includes(fragment)), {
    migrationPath,
    gatedByGuc: 'arkova.secured_enforce_chain_present',
    requiresIsolatedDbForCountableEvidence: true,
    note: 'This static check is admission prep only; countable T3 evidence must apply 0357 on a clean isolated project and exercise the trigger there.',
  });
}

export async function runPr1455AdmissionDriver(options: DriverOptions = {}): Promise<Pr1455DriverResult> {
  const mode = options.mode ?? 'self-test';
  const checks = [
    await runCanonicalCalldataChecks(),
    await runDynamicFeeChecks(),
    await runCtidInvarianceChecks(),
    runSecuredTriggerDesignCheck(),
  ];
  const blockers = [
    'No exact-head isolated deploy/admission JSON is provided by this self-test.',
    '0357 trigger behavior still requires clean isolated DB apply + live trigger exercise before T3 soak evidence can count.',
  ];
  const result: Pr1455DriverResult = {
    pr: 1455,
    tier: 'T3',
    status: checks.every((item) => item.ok) ? 'pass' : 'fail',
    evidenceForSoak: false,
    mode,
    at: options.now ?? new Date().toISOString(),
    changedBehavior: CHANGED_BEHAVIOR,
    checks,
    blockers,
  };

  if (options.evidenceJsonl) {
    appendFileSync(options.evidenceJsonl, `${JSON.stringify(result)}\n`);
  }
  return result;
}

function parseArgs(argv: string[]): DriverOptions {
  const options: DriverOptions = {};
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === '--self-test') {
      options.mode = 'self-test';
    } else if (arg === '--evidence-jsonl') {
      options.evidenceJsonl = argv[++idx];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const result = await runPr1455AdmissionDriver(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result));
  if (result.status !== 'pass') {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
