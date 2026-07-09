import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type DriverMode = 'self-test' | 'live-trigger-proof';

export interface DriverOptions {
  mode?: DriverMode;
  evidenceJsonl?: string;
  admissionJson?: string;
  preflightJson?: string;
  triggerProofJson?: string;
  expectedSha?: string;
  expectedProjectRef?: string;
  expectedTagUrl?: string;
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
  evidenceForSoak: boolean;
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

function readJsonArtifact(path: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${label} JSON at ${path}: ${message}`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.map(stringValue).find((value): value is string => value !== undefined);
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function includesPr1455Tag(url: string | undefined): boolean {
  return Boolean(url?.includes('pr-1455'));
}

function cleanMirrorFromPreflight(preflight: Record<string, unknown>): boolean {
  return preflight.environment_type === 'clean_mirror'
    || preflight.environmentType === 'clean_mirror'
    || preflight.status === 'clean_mirror'
    || preflight.result === 'clean_mirror';
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

function validateAdmissionAndPreflight(options: DriverOptions): CheckResult {
  const missing = [
    options.admissionJson ? undefined : '--admission-json',
    options.preflightJson ? undefined : '--preflight-json',
  ].filter((item): item is string => Boolean(item));
  if (missing.length > 0) {
    return check('exact_head_admission_and_clean_preflight', false, {
      missing,
      requirement: 'Live countable mode requires exact-head admission plus clean_mirror preflight artifacts.',
    });
  }

  const admission = readJsonArtifact(options.admissionJson as string, 'admission');
  const preflight = readJsonArtifact(options.preflightJson as string, 'preflight');
  const deploy = nestedRecord(admission.deploy);
  const deployed = nestedRecord(admission.deployed);
  const service = nestedRecord(admission.service);
  const image = nestedRecord(admission.image);
  const preflightClean = cleanMirrorFromPreflight(preflight);
  const headSha = firstString(admission.headSha, admission.sha, admission.prHeadSha);
  const buildSha = firstString(admission.buildSha, deploy.buildSha, deployed.buildSha, service.buildSha);
  const projectRef = firstString(admission.projectRef, admission.stagingProjectRef, preflight.staging_project_ref, preflight.projectRef);
  const tagUrl = firstString(admission.tagUrl, admission.serviceUrl, deploy.tagUrl, deploy.url, deployed.tagUrl, service.tagUrl);
  const imageDigest = firstString(admission.imageDigest, deploy.imageDigest, deployed.imageDigest, image.digest);
  const expectedShaOk = !options.expectedSha || (headSha === options.expectedSha && buildSha === options.expectedSha);
  const expectedProjectOk = !options.expectedProjectRef || projectRef === options.expectedProjectRef;
  const expectedTagOk = !options.expectedTagUrl || tagUrl === options.expectedTagUrl;
  const ok = preflightClean
    && expectedShaOk
    && expectedProjectOk
    && expectedTagOk
    && includesPr1455Tag(tagUrl)
    && Boolean(imageDigest?.startsWith('sha256:') || imageDigest?.includes('@sha256:'));

  return check('exact_head_admission_and_clean_preflight', ok, {
    admissionJson: options.admissionJson,
    preflightJson: options.preflightJson,
    expectedSha: options.expectedSha,
    headSha,
    buildSha,
    expectedProjectRef: options.expectedProjectRef,
    projectRef,
    expectedTagUrl: options.expectedTagUrl,
    tagUrl,
    hasPr1455Tag: includesPr1455Tag(tagUrl),
    imageDigest,
    preflightCleanMirror: preflightClean,
  });
}

function validateLiveTriggerProof(options: DriverOptions): CheckResult {
  if (!options.triggerProofJson) {
    return check('live_0357_secured_trigger_proof', false, {
      missing: ['--trigger-proof-json'],
      requirement: 'Countable PR #1455 evidence must prove 0357 was applied on the isolated clean mirror and exercised with the GUC enabled.',
    });
  }

  const proof = readJsonArtifact(options.triggerProofJson, '0357 trigger proof');
  const projectRef = firstString(proof.projectRef, proof.stagingProjectRef);
  const migration = firstString(proof.migration, proof.migrationVersion);
  const environmentType = firstString(proof.environmentType, proof.environment_type);
  const ok = proof.pr === 1455
    && migration === '0357'
    && (!options.expectedProjectRef || projectRef === options.expectedProjectRef)
    && environmentType === 'clean_mirror'
    && proof.triggerInstalled === true
    && (proof.gucEnabled === true || proof.guc === 'on')
    && proof.invalidSecuredRejected === true
    && proof.validSecuredAccepted === true
    && proof.evidenceForSoak === true;

  return check('live_0357_secured_trigger_proof', ok, {
    triggerProofJson: options.triggerProofJson,
    projectRef,
    migration,
    environmentType,
    triggerInstalled: proof.triggerInstalled,
    gucEnabled: proof.gucEnabled ?? proof.guc,
    invalidSecuredRejected: proof.invalidSecuredRejected,
    validSecuredAccepted: proof.validSecuredAccepted,
    nonSecuredUnaffected: proof.nonSecuredUnaffected,
    evidenceForSoak: proof.evidenceForSoak,
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
  if (mode === 'live-trigger-proof') {
    checks.push(validateAdmissionAndPreflight(options), validateLiveTriggerProof(options));
  }
  const failedChecks = checks.filter((item) => !item.ok).map((item) => item.name);
  const blockers = mode === 'self-test'
    ? [
      'No exact-head isolated deploy/admission JSON is provided by this self-test.',
      '0357 trigger behavior still requires clean isolated DB apply + live trigger exercise before T3 soak evidence can count.',
    ]
    : failedChecks.map((name) => `Required live evidence check failed: ${name}`);
  const status = checks.every((item) => item.ok) ? 'pass' : 'fail';
  const result: Pr1455DriverResult = {
    pr: 1455,
    tier: 'T3',
    status,
    evidenceForSoak: mode === 'live-trigger-proof' && status === 'pass',
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
    } else if (arg === '--live-trigger-proof') {
      options.mode = 'live-trigger-proof';
    } else if (arg === '--evidence-jsonl') {
      options.evidenceJsonl = argv[++idx];
    } else if (arg === '--admission-json') {
      options.admissionJson = argv[++idx];
    } else if (arg === '--preflight-json') {
      options.preflightJson = argv[++idx];
    } else if (arg === '--trigger-proof-json') {
      options.triggerProofJson = argv[++idx];
    } else if (arg === '--expected-sha') {
      options.expectedSha = argv[++idx];
    } else if (arg === '--expected-project-ref') {
      options.expectedProjectRef = argv[++idx];
    } else if (arg === '--expected-tag-url') {
      options.expectedTagUrl = argv[++idx];
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
