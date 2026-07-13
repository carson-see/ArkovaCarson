/**
 * Concrete crash-control adapters.
 *
 * ReplayCrashControlAdapter drives the production orchestrator from one strict
 * captured record without side effects. GatedLiveCrashControlAdapter connects
 * the same eight lifecycle operations to a real action implementation, but
 * checks a two-part run-specific gate before every possible action.
 */

import { z } from 'zod';

import type {
  CrashBarrier,
  CrashCaseInput,
  CrashControlPort,
  CrashObservation,
  RecoveryEvidence,
  RestartEvidence,
  TerminationEvidence,
} from './batch-drain-crash-control';

export const LIVE_CRASH_ENABLE_TOKEN = 'ARKOVA_S33_EXECUTE_LIVE_CRASH_CASE';

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const headSha = z.string().regex(/^[0-9a-f]{40}$/);
const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp');
const runtime = { headSha, imageDigest };

const claimSchema = z.object({
  fingerprint: sha256, orgId: nonEmpty, claimOrder: z.number().int().positive(),
}).strict();
const networkAcceptanceSchema = z.object({
  txId: sha256, rawTxSha256: sha256, nodeId: nonEmpty, network: z.literal('signet'),
  state: z.enum(['mempool', 'confirmed']), observedAt: timestamp,
}).strict();
const phase4Schema = z.object({
  batchId: nonEmpty, txId: sha256, rowCount: z.number().int().positive(), persistedAt: timestamp,
}).strict();
const barrierSchema = z.object({
  ...runtime,
  runId: nonEmpty,
  killpoint: z.enum(['after-claim', 'after-merkle-tree', 'after-intent-persist', 'after-broadcast-before-submit', 'after-submit-persist']),
  batchId: nonEmpty,
  armedTrigger: z.enum(['org-scheduler', 'global-flush']),
  schedulerExecutionId: nonEmpty,
  faultWindowId: nonEmpty,
  workerId: nonEmpty,
  claimedLeaves: z.array(claimSchema).min(1),
  claimedAt: timestamp,
  reachedAt: timestamp,
  merkleRoot: sha256.optional(),
  merkleBuiltAt: timestamp.optional(),
  intentTxId: sha256.optional(),
  signedBytesSha256: sha256.optional(),
  intentPersistedAt: timestamp.optional(),
  networkAcceptance: networkAcceptanceSchema.optional(),
  phase4Persisted: phase4Schema.optional(),
}).strict();
const terminationSchema = z.object({
  ...runtime,
  workerId: nonEmpty, source: z.literal('cloud-run-audit-log'), logEntryId: nonEmpty,
  signal: z.enum(['SIGKILL', 'SIGTERM']), requestedAt: timestamp, exitedAt: timestamp,
}).strict();
const restartSchema = z.object({
  ...runtime,
  previousWorkerId: nonEmpty, workerId: nonEmpty, source: z.literal('cloud-run-audit-log'),
  logEntryId: nonEmpty, startedAt: timestamp,
}).strict();
const recoverySchema = z.object({
  recoverySchedulerExecutionId: nonEmpty,
  correlatedDrainExecutionId: nonEmpty,
  source: z.literal('cloud-scheduler'),
  endpointPath: z.literal('/jobs/recover-broadcasts'),
  httpStatus: z.literal(200),
  startedAt: timestamp,
  completedAt: timestamp,
}).strict();
const executionSchema = z.object({
  schedulerExecutionId: nonEmpty, armedTrigger: z.enum(['org-scheduler', 'global-flush']),
  faultWindowId: nonEmpty, startedAt: timestamp, completedAt: timestamp,
}).strict();
const triggerSchema = z.object({
  trigger: z.enum(['org-scheduler', 'global-flush']), schedulerExecutionId: nonEmpty,
  batchId: nonEmpty, firedAt: timestamp,
}).strict();
const passRowSchema = z.object({
  fingerprint: sha256, orgId: nonEmpty, batchId: nonEmpty, schedulerExecutionId: nonEmpty,
  claimOrder: z.number().int().positive(),
  status: z.enum(['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'FAILED']),
  chainTxId: sha256.nullable(), merkleRoot: sha256.nullable(),
  creditDenialReason: nonEmpty.nullable(), queueCreditChargedAt: timestamp.nullable(),
  queueCreditDeniedAt: timestamp.nullable(),
}).strict();
const transactionSchema = z.object({
  txId: sha256, batchId: nonEmpty, merkleRoot: sha256, signedBytesSha256: sha256,
  network: z.literal('signet'), nodeId: nonEmpty, chainState: z.enum(['mempool', 'confirmed']),
  acceptedAt: timestamp,
}).strict();
const leafSchema = z.object({
  txId: sha256, batchId: nonEmpty, fingerprint: sha256, orgId: nonEmpty,
  merkleIndex: z.number().int().nonnegative(),
}).strict();
const proofSchema = leafSchema.extend({
  merkleRoot: sha256, leafCount: z.number().int().positive(),
  proofPath: z.array(z.object({ hash: sha256, position: z.enum(['left', 'right']) }).strict()),
}).strict();
const gateSchema = z.object({
  eventId: nonEmpty, schedulerExecutionId: nonEmpty, fingerprint: sha256, orgId: nonEmpty,
  decision: z.enum(['not-required', 'allowed', 'denied']), reason: nonEmpty.nullable(),
  referenceId: nonEmpty.nullable(), requiredAmount: z.number().int().nonnegative(),
  balanceBefore: z.number().int().nonnegative().nullable(), balanceAfter: z.number().int().nonnegative().nullable(),
  occurredAt: timestamp,
}).strict();
const ledgerEventSchema = z.object({
  eventId: nonEmpty, schedulerExecutionId: nonEmpty, fingerprint: sha256, orgId: nonEmpty,
  kind: z.enum(['debit', 'refund']), amount: z.number().int().positive(), referenceId: nonEmpty,
  occurredAt: timestamp,
}).strict();
const balanceSchema = z.object({
  schedulerExecutionId: nonEmpty, orgId: nonEmpty,
  before: z.number().int().nonnegative(), after: z.number().int().nonnegative(),
}).strict();
const deltaSchema = z.object({ schedulerExecutionId: nonEmpty, orgId: nonEmpty, delta: z.number().int() }).strict();
const drainObservationSchema = z.object({
  execution: executionSchema,
  triggerFirings: z.array(triggerSchema).min(1),
  pendingBefore: z.number().int().nonnegative(),
  pendingAfter: z.number().int().nonnegative(),
  passRows: z.array(passRowSchema).min(1),
  transactions: z.array(transactionSchema).min(1),
  txLeaves: z.array(leafSchema).min(1),
  proofs: z.array(proofSchema).min(1),
  creditGateEvents: z.array(gateSchema).min(1),
  creditLedgerEvents: z.array(ledgerEventSchema),
  orgBalances: z.array(balanceSchema).min(1),
  ledgerDeltas: z.array(deltaSchema).min(1),
}).strict();
const attemptSchema = z.object({
  batchId: nonEmpty, schedulerExecutionId: nonEmpty, txId: sha256, signedBytesSha256: sha256,
}).strict();
const uptimeSchema = z.object({
  ...runtime,
  workerId: nonEmpty, source: z.literal('cloud-run-audit-log'), startedAt: timestamp,
  observedUntil: timestamp, uptimeMs: z.number().int().nonnegative(), logEntryIds: z.array(nonEmpty).min(1),
}).strict();
const observationSchema = z.object({
  runId: nonEmpty, finalWorkerId: nonEmpty, observedAt: timestamp,
  drain: drainObservationSchema, broadcastAttempts: z.array(attemptSchema).min(1),
  processUptime: z.array(uptimeSchema).min(2),
}).strict();

const crashReplayCaptureSchema = z.object({
  schemaVersion: z.literal(1),
  captureId: nonEmpty,
  runId: nonEmpty,
  barrier: barrierSchema,
  termination: terminationSchema,
  restart: restartSchema,
  recovery: recoverySchema,
  observation: observationSchema,
}).strict();

export interface CrashReplayCapture {
  schemaVersion: 1;
  captureId: string;
  runId: string;
  barrier: CrashBarrier;
  termination: TerminationEvidence;
  restart: RestartEvidence;
  recovery: RecoveryEvidence;
  observation: CrashObservation;
}

export function parseCrashReplayCapture(raw: string): CrashReplayCapture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Crash replay capture must contain valid JSON.');
  }
  const result = crashReplayCaptureSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Crash replay capture schema rejected: ${z.prettifyError(result.error)}`);
  return result.data as CrashReplayCapture;
}

export class ReplayCrashControlAdapter implements CrashControlPort {
  private armed = false;

  constructor(private readonly capture: CrashReplayCapture) {}

  async arm(input: CrashCaseInput): Promise<void> {
    if (input.runId !== this.capture.runId) throw new Error('Replay capture runId does not match the crash case.');
    this.armed = true;
  }

  async start(): Promise<void> { this.requireArmed(); }
  async waitForKillpoint(): Promise<CrashBarrier> { this.requireArmed(); return this.capture.barrier; }
  async terminate(): Promise<TerminationEvidence> { this.requireArmed(); return this.capture.termination; }
  async waitForRestart(): Promise<RestartEvidence> { this.requireArmed(); return this.capture.restart; }
  async recover(): Promise<RecoveryEvidence> { this.requireArmed(); return this.capture.recovery; }
  async inspect(): Promise<CrashObservation> { this.requireArmed(); return this.capture.observation; }
  async disarm(): Promise<void> { this.requireArmed(); this.armed = false; }

  private requireArmed(): void {
    if (!this.armed) throw new Error('Replay crash adapter is not armed.');
  }
}

export interface LiveCrashExecutionEnv {
  ARKOVA_LIVE_CRASH_EXECUTION?: string;
  ARKOVA_LIVE_CRASH_RUN_ID?: string;
}

function assertLiveGate(input: CrashCaseInput, env: LiveCrashExecutionEnv): void {
  if (
    env.ARKOVA_LIVE_CRASH_EXECUTION !== LIVE_CRASH_ENABLE_TOKEN
    || env.ARKOVA_LIVE_CRASH_RUN_ID !== input.runId
  ) throw new Error('Live crash action was not explicitly enabled for this exact run.');
}

class GatedLiveCrashControlAdapter implements CrashControlPort {
  constructor(private readonly actions: CrashControlPort, private readonly env: LiveCrashExecutionEnv) {}

  async arm(input: CrashCaseInput): Promise<void> { assertLiveGate(input, this.env); return this.actions.arm(input); }
  async start(input: CrashCaseInput): Promise<void> { assertLiveGate(input, this.env); return this.actions.start(input); }
  async waitForKillpoint(input: CrashCaseInput): Promise<CrashBarrier> { assertLiveGate(input, this.env); return this.actions.waitForKillpoint(input); }
  async terminate(input: CrashCaseInput & { workerId: string }): Promise<TerminationEvidence> { assertLiveGate(input, this.env); return this.actions.terminate(input); }
  async waitForRestart(input: CrashCaseInput & { previousWorkerId: string }): Promise<RestartEvidence> { assertLiveGate(input, this.env); return this.actions.waitForRestart(input); }
  async recover(input: CrashCaseInput): Promise<RecoveryEvidence> { assertLiveGate(input, this.env); return this.actions.recover(input); }
  async inspect(input: CrashCaseInput): Promise<CrashObservation> { assertLiveGate(input, this.env); return this.actions.inspect(input); }
  async disarm(input: CrashCaseInput): Promise<void> { assertLiveGate(input, this.env); return this.actions.disarm(input); }
}

export function createGatedLiveCrashControlAdapter(
  actions: CrashControlPort,
  env: LiveCrashExecutionEnv,
): CrashControlPort {
  return new GatedLiveCrashControlAdapter(actions, env);
}
