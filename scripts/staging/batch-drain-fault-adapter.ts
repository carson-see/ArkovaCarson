/** Strict offline replay and fixed-binary RIG-B1 adapters for SCRUM-2693. */

import { execFile } from 'node:child_process';

import { z } from 'zod';

import type {
  FaultCaseInput,
  FaultControlPort,
  FaultObservation,
} from './batch-drain-fault-control';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import { strictUtcTimestampSchema } from './batch-drain-time';

export const LIVE_FAULT_ENABLE_TOKEN = 'ARKOVA_S33_EXECUTE_LIVE_FAULT_CASE';
export const LIVE_FAULT_CONTROLLER_TIMEOUT_MS = 60_000;
export const LIVE_FAULT_CONTROLLER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const CONTROLLER_BINARY = '/usr/local/bin/arkova-rig-fault-control';
const RIG_B1_SERVICE = 'arkova-worker-s33-rig-b1-staging';
const nonEmpty = z.string().min(1).max(200);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const headSha = z.string().regex(/^[0-9a-f]{40}$/);
const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const timestamp = strictUtcTimestampSchema;
const scenarioSchema = z.enum(['fee-ceiling', 'provider-outage', 'reorg']);
const runtimeSchema = z.object({ headSha, imageDigest }).strict();
const journalStatusSchema = z.enum(['PENDING', 'HELD', 'ADOPTED', 'REVERTED', 'PERSISTED']);

const journalSchema = z.object({
  journalId: uuid,
  batchId: nonEmpty,
  txId: sha256,
  fingerprintRoot: sha256,
  anchorIds: z.array(uuid).min(1).max(10_000),
  createdAt: timestamp,
  recoveryStatus: journalStatusSchema,
  holdReason: nonEmpty.nullable(),
  heldAt: timestamp.nullable(),
  resolvedAt: timestamp.nullable(),
  observedAt: timestamp,
}).strict();

const lookupSchema = z.object({
  source: z.enum(['bitcoin-core-signet-rpc', 'mempool-space']),
  outcome: z.enum(['found', 'not-found', 'unavailable', 'negative-confirmations']),
  txId: sha256,
  confirmations: z.number().int().nullable(),
  observedAt: timestamp,
}).strict();

const anchorSchema = z.object({
  anchorId: uuid,
  status: z.enum(['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED']),
  chainTxId: sha256.nullable(),
}).strict();

const feeSchema = z.object({
  estimateSatVb: z.number().finite().nonnegative(),
  ceilingSatVb: z.number().finite().nonnegative(),
  baseCeilingSatVb: z.number().finite().nonnegative(),
  oldestPendingAt: timestamp,
  evaluatedBeforeClaim: z.boolean(),
}).strict();

const providerSchema = z.object({
  retryAttempts: z.number().int().nonnegative().max(20),
  lookups: z.array(lookupSchema).min(1),
}).strict();

const reorgSchema = z.object({
  priorBlockHash: sha256,
  observedBlockHash: sha256,
  proofStatus: z.literal('stale'),
  auditEvent: z.literal('anchor.reorg_reverted'),
}).strict();

const observationSchema = z.object({
  schemaVersion: z.literal(1),
  runId: nonEmpty,
  scenario: scenarioSchema,
  phase: z.enum(['fault-active', 'fault-cleared']),
  batchId: nonEmpty,
  schedulerExecutionId: nonEmpty,
  faultWindowId: nonEmpty,
  runtime: runtimeSchema,
  observedAt: timestamp,
  journal: journalSchema.nullable(),
  anchors: z.array(anchorSchema).min(1).max(10_000),
  networkTxIds: z.array(sha256).max(10_000),
  broadcastAttempts: z.number().int().nonnegative().max(20),
  refundAnchorIds: z.array(uuid).max(10_000),
  fee: feeSchema.nullable(),
  provider: providerSchema.nullable(),
  reorg: reorgSchema.nullable(),
}).strict();

const replayCaptureSchema = z.object({
  schemaVersion: z.literal(1),
  captureId: nonEmpty,
  runId: nonEmpty,
  active: observationSchema,
  cleared: observationSchema,
}).strict();

export interface FaultReplayCapture {
  schemaVersion: 1;
  captureId: string;
  runId: string;
  active: FaultObservation;
  cleared: FaultObservation;
}

const VERIFIED_FAULT_REPLAY_CAPTURES = new WeakSet<FaultReplayCapture>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseStrict<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  const parsed = parseJsonRejectingDuplicateKeys(raw, label);
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`${label} schema rejected: ${z.prettifyError(result.error)}`);
  return result.data;
}

export function parseFaultReplayCapture(raw: string): FaultReplayCapture {
  const capture = deepFreeze(parseStrict(replayCaptureSchema, raw, 'Fault replay capture') as FaultReplayCapture);
  VERIFIED_FAULT_REPLAY_CAPTURES.add(capture);
  return capture;
}

export class ReplayFaultControlAdapter implements FaultControlPort {
  readonly evidenceMode = 'offline-replay' as const;
  private armed = false;

  constructor(private readonly capture: FaultReplayCapture) {
    if (!VERIFIED_FAULT_REPLAY_CAPTURES.has(capture)) {
      throw new Error('Replay adapter requires the exact parsed fault capture provenance.');
    }
  }

  async arm(input: FaultCaseInput): Promise<void> {
    if (input.runId !== this.capture.runId) throw new Error('Replay capture runId does not match the fault case.');
    this.armed = true;
  }

  async start(input: FaultCaseInput): Promise<void> { this.requireArmed(input); }
  async waitForFault(input: FaultCaseInput): Promise<FaultObservation> { this.requireArmed(input); return this.capture.active; }
  async clear(input: FaultCaseInput): Promise<void> { this.requireArmed(input); }
  async inspect(input: FaultCaseInput): Promise<FaultObservation> { this.requireArmed(input); return this.capture.cleared; }
  async disarm(input: FaultCaseInput): Promise<void> { this.requireArmed(input); this.armed = false; }

  private requireArmed(input: FaultCaseInput): void {
    if (!this.armed) throw new Error('Replay fault adapter is not armed.');
    if (input.runId !== this.capture.runId) throw new Error('Replay capture runId changed after arm.');
  }
}

export interface LiveFaultExecutionEnv {
  ARKOVA_LIVE_FAULT_EXECUTION?: string;
  ARKOVA_LIVE_FAULT_RUN_ID?: string;
}

export interface RigB1LiveFaultTarget {
  rigId: 'RIG-B1';
  gcpProjectId: 'arkova1';
  workerService: string;
  region: 'us-central1';
}

export interface LiveFaultCommandRunner {
  run(args: readonly string[]): Promise<string>;
}

const actionSchema = z.enum(['arm', 'start', 'wait-for-fault', 'clear', 'inspect', 'disarm']);
const acknowledgementSchema = z.object({
  schemaVersion: z.literal(1),
  action: actionSchema,
  runId: nonEmpty,
  status: z.literal('ok'),
}).strict();
const controllerIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);

function assertTarget(target: RigB1LiveFaultTarget): void {
  if (
    target.rigId !== 'RIG-B1'
    || target.gcpProjectId !== 'arkova1'
    || target.region !== 'us-central1'
    || target.workerService !== RIG_B1_SERVICE
  ) throw new Error('Live fault target is outside the fixed RIG-B1 allowlist.');
}

function assertLiveGate(runId: string, env: LiveFaultExecutionEnv): void {
  if (
    env.ARKOVA_LIVE_FAULT_EXECUTION !== LIVE_FAULT_ENABLE_TOKEN
    || env.ARKOVA_LIVE_FAULT_RUN_ID !== runId
  ) throw new Error('Live fault action was not explicitly enabled for this exact run.');
}

function assertControllerIdentity(value: string, label: string): void {
  if (!controllerIdentity.safeParse(value).success) {
    throw new Error(`${label} is outside the live-controller argument identity allowlist.`);
  }
}

class NodeLiveFaultCommandRunner implements LiveFaultCommandRunner {
  async run(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(CONTROLLER_BINARY, [...args], {
        encoding: 'utf8',
        shell: false,
        timeout: LIVE_FAULT_CONTROLLER_TIMEOUT_MS,
        maxBuffer: LIVE_FAULT_CONTROLLER_MAX_BUFFER_BYTES,
      }, (error, stdout) => {
        if (error) {
          // The fixed controller may emit provider or infrastructure details on
          // stderr. Keep those out of caller-visible errors and signed artifacts.
          reject(new Error('Live fault controller failed.'));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

class RigB1LiveFaultControlAdapter implements FaultControlPort {
  readonly evidenceMode = 'live-rig' as const;
  private readonly target: Readonly<RigB1LiveFaultTarget>;

  constructor(
    target: RigB1LiveFaultTarget,
    private readonly env: LiveFaultExecutionEnv,
    private readonly runner: LiveFaultCommandRunner,
  ) {
    assertTarget(target);
    this.target = Object.freeze({ ...target });
  }

  private args(action: z.infer<typeof actionSchema>, input: FaultCaseInput): string[] {
    const schemaVersion = input.schemaVersion;
    const scenario = input.scenario;
    const runId = input.runId;
    const batchId = input.batchId;
    const schedulerExecutionId = input.schedulerExecutionId;
    const faultWindowId = input.faultWindow.id;
    const testedHeadSha = input.runtime.headSha;
    const testedImageDigest = input.runtime.imageDigest;
    assertLiveGate(runId, this.env);
    if (
      schemaVersion !== 1
      || !scenarioSchema.safeParse(scenario).success
      || !headSha.safeParse(testedHeadSha).success
      || !imageDigest.safeParse(testedImageDigest).success
    ) throw new Error('Fault case runtime is outside the live-controller argument allowlist.');
    assertControllerIdentity(runId, 'runId');
    assertControllerIdentity(batchId, 'batchId');
    assertControllerIdentity(schedulerExecutionId, 'schedulerExecutionId');
    assertControllerIdentity(faultWindowId, 'faultWindow.id');
    return [
      action,
      '--rig', this.target.rigId,
      '--project', this.target.gcpProjectId,
      '--service', this.target.workerService,
      '--region', this.target.region,
      '--run-id', runId,
      '--scenario', scenario,
      '--head-sha', testedHeadSha,
      '--image-digest', testedImageDigest,
      '--batch-id', batchId,
      '--scheduler-execution-id', schedulerExecutionId,
      '--fault-window-id', faultWindowId,
    ];
  }

  private async acknowledge(action: 'arm' | 'start' | 'clear' | 'disarm', input: FaultCaseInput): Promise<void> {
    const raw = await this.runner.run(this.args(action, input));
    const value = parseStrict(acknowledgementSchema, raw, `Live fault controller ${action} response`);
    if (value.action !== action || value.runId !== input.runId) {
      throw new Error(`Live fault controller ${action} acknowledgement is cross-run or cross-action.`);
    }
  }

  arm(input: FaultCaseInput): Promise<void> { return this.acknowledge('arm', input); }
  start(input: FaultCaseInput): Promise<void> { return this.acknowledge('start', input); }

  async waitForFault(input: FaultCaseInput): Promise<FaultObservation> {
    const raw = await this.runner.run(this.args('wait-for-fault', input));
    return parseStrict(observationSchema, raw, 'Live fault controller wait-for-fault response');
  }

  clear(input: FaultCaseInput): Promise<void> { return this.acknowledge('clear', input); }

  async inspect(input: FaultCaseInput): Promise<FaultObservation> {
    const raw = await this.runner.run(this.args('inspect', input));
    return parseStrict(observationSchema, raw, 'Live fault controller inspect response');
  }

  disarm(input: FaultCaseInput): Promise<void> { return this.acknowledge('disarm', input); }
}

export function createRigB1LiveFaultControlAdapter(
  target: RigB1LiveFaultTarget,
): FaultControlPort {
  return new RigB1LiveFaultControlAdapter(target, process.env, new NodeLiveFaultCommandRunner());
}

/** Test-only seam; production callers cannot inject an arbitrary executable. */
export function createRigB1LiveFaultControlAdapterForTest(
  target: RigB1LiveFaultTarget,
  env: LiveFaultExecutionEnv,
  runner: LiveFaultCommandRunner,
): FaultControlPort {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected live fault runner is available only in tests.');
  return new RigB1LiveFaultControlAdapter(target, env, runner);
}
