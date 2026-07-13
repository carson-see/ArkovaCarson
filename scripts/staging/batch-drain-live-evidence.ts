#!/usr/bin/env -S npx tsx
/**
 * S3.3 RIG-B1 evidence consumer.
 *
 * The immutable run declaration and all six capture digests are authenticated
 * by one independently Ed25519-signed envelope. Filesystem permissions are
 * defense in depth only and are never treated as the authenticity boundary.
 * Scheduler, worker-log, DB, signet, Cloud Run, and supervisor captures are
 * six independent raw exports whose exact SHA-256 digests are named by that
 * declaration. Runtime facts are derived only after strict schema validation;
 * a combined caller-authored "evidence bundle" is intentionally unsupported.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, types as utilTypes } from 'node:util';

import { z } from 'zod';

import {
  assertDrainWindowObservation,
  type DrainPassObservation,
  type DrainWindowEvidenceSummary,
  type DrainWindowExpectation,
} from './batch-drain-observation';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';

export const LIVE_EVIDENCE_ENABLE_VALUE = 'ARKOVA_S33_COLLECT_LIVE_RAW_EVIDENCE';
export const SOAK_FLOOR_MINUTES = 2_880;
export const SOAK_REQUIRED_UPTIME_MINUTES = SOAK_FLOOR_MINUTES;
export const SOAK_WALL_FLOOR_MINUTES = SOAK_FLOOR_MINUTES + 30;
export const MAX_HEARTBEAT_GAP_MINUTES = 5;
export const DEFAULT_EVIDENCE_TRUST_ROOT = '/var/lib/arkova/s33-evidence/trust-roots';

// CTO-owned launch configuration. These are deliberately null until the CTO
// approves and commits the production Ed25519 public key + SPKI fingerprint.
// CLI flags and environment variables are intentionally not consulted.
const CTO_EVIDENCE_PUBLIC_KEY_PEM: string | null = null;
const CTO_EVIDENCE_KEY_FINGERPRINT: string | null = null;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const headSha = z.string().regex(/^[0-9a-f]{40}$/);
const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const projectRef = z.string().regex(/^[a-z]{20}$/);
const nonEmpty = z.string().min(1);
const isoTimestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp');
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const rawCaptureDigestsSchema = z.object({
  scheduler: sha256Hex,
  workerLogs: sha256Hex,
  database: sha256Hex,
  signet: sha256Hex,
  cloudRun: sha256Hex,
  supervisor: sha256Hex,
}).strict();

const claimSchema = z.object({ fingerprint: sha256Hex, orgId: nonEmpty }).strict();
const faultWindowSchema = z.object({ id: nonEmpty, startsAt: isoTimestamp, endsAt: isoTimestamp }).strict();
const passExpectationSchema = z.object({
  batchId: nonEmpty,
  armedTrigger: z.enum(['org-scheduler', 'global-flush']),
  schedulerExecutionId: nonEmpty,
  faultWindow: faultWindowSchema,
  claims: z.array(claimSchema).min(1),
}).strict();
const windowExpectationSchema = z.object({
  scenarioId: nonEmpty,
  kind: z.enum(['eligible-10000', 'eligible-12500', 'poison-isolation']),
  armedTrigger: z.enum(['org-scheduler', 'global-flush']),
  expectedInitialPending: nonNegativeInteger,
  expectedFinalPending: nonNegativeInteger,
  passes: z.array(passExpectationSchema).min(1),
}).strict();
const recoveryExpectationSchema = z.object({
  schedulerExecutionId: nonEmpty,
  correlatedDrainExecutionId: nonEmpty,
  faultWindowId: nonEmpty,
}).strict();

export const runDeclarationSchema = z.object({
  schemaVersion: z.literal(1),
  declarationId: nonEmpty,
  gitBaseSha: headSha,
  gitHeadSha: headSha,
  imageDigest,
  rigId: z.literal('RIG-B1'),
  gcpProjectId: nonEmpty,
  projectRef,
  soakId: nonEmpty,
  leaseId: nonEmpty,
  cleanMirrorAttestationId: nonEmpty,
  workerService: nonEmpty,
  workerRevision: nonEmpty,
  region: nonEmpty,
  soakStartedAt: isoTimestamp,
  soakEndedAt: isoTimestamp,
  recoveries: z.array(recoveryExpectationSchema),
  windows: z.array(windowExpectationSchema).min(1),
}).strict();

export type RunDeclaration = z.infer<typeof runDeclarationSchema>;

export interface ImmutableRunDeclaration {
  readonly value: RunDeclaration;
  readonly contentSha256: string;
  readonly trustRootId: string;
  readonly trustRootSha256: string;
  readonly rawCaptureDigests: RawCaptureDigests;
}

const VERIFIED_DECLARATIONS = new WeakSet<ImmutableRunDeclaration>();

const evidenceTrustRootSchema = z.object({
  schemaVersion: z.literal(1),
  envelopeId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  keyFingerprint: sha256Hex,
  signedPayloadRaw: nonEmpty,
  signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();

const evidenceSignedPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  envelopeId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  declaration: runDeclarationSchema,
  rawCaptureDigests: rawCaptureDigestsSchema,
}).strict();

const commonRawFields = {
  schemaVersion: z.literal(1),
  exportId: nonEmpty,
  declarationSha256: sha256Hex,
  rigId: z.literal('RIG-B1'),
  soakId: nonEmpty,
  gitHeadSha: headSha,
  imageDigest,
  generatedAt: isoTimestamp,
};

const schedulerRecordSchema = z.object({
  recordId: nonEmpty,
  purpose: z.enum(['preclock', 'drain', 'recovery']),
  schedulerExecutionId: nonEmpty,
  correlatedDrainExecutionId: nonEmpty.nullable(),
  faultWindowId: nonEmpty.nullable(),
  gcpProjectId: nonEmpty,
  workerRevision: nonEmpty,
  workerId: nonEmpty,
  path: z.string().regex(/^\/jobs\/[a-z0-9-]+(?:\?[A-Za-z0-9_=&%-]+)?$/),
  trigger: z.enum(['org-scheduler', 'global-flush']),
  statusCode: z.number().int(),
  firedAt: isoTimestamp,
  completedAt: isoTimestamp,
}).strict();
const schedulerCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('cloud-scheduler'),
  records: z.array(schedulerRecordSchema).min(1),
}).strict();

const workerLogRecordSchema = z.object({
  recordId: nonEmpty,
  insertId: nonEmpty,
  traceId: nonEmpty,
  workerId: nonEmpty,
  event: z.enum(['trigger-fired', 'credit-gate']),
  schedulerExecutionId: nonEmpty,
  batchId: nonEmpty,
  trigger: z.enum(['org-scheduler', 'global-flush']),
  fingerprint: sha256Hex.nullable(),
  orgId: nonEmpty.nullable(),
  decision: z.enum(['not-required', 'allowed', 'denied']).nullable(),
  reason: nonEmpty.nullable(),
  referenceId: nonEmpty.nullable(),
  requiredAmount: nonNegativeInteger.nullable(),
  balanceBefore: nonNegativeInteger.nullable(),
  balanceAfter: nonNegativeInteger.nullable(),
  occurredAt: isoTimestamp,
}).strict();
const workerLogsCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('cloud-logging'),
  records: z.array(workerLogRecordSchema).min(1),
}).strict();

const dbExecutionSchema = z.object({
  schedulerExecutionId: nonEmpty,
  armedTrigger: z.enum(['org-scheduler', 'global-flush']),
  faultWindowId: nonEmpty,
  workerId: nonEmpty,
  startedAt: isoTimestamp,
  completedAt: isoTimestamp,
  pendingBefore: nonNegativeInteger,
  pendingAfter: nonNegativeInteger,
}).strict();
const dbPassRowSchema = z.object({
  fingerprint: sha256Hex,
  orgId: nonEmpty,
  batchId: nonEmpty,
  schedulerExecutionId: nonEmpty,
  claimOrder: positiveInteger,
  status: z.enum(['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'FAILED']),
  chainTxId: sha256Hex.nullable(),
  merkleRoot: sha256Hex.nullable(),
  creditDenialReason: nonEmpty.nullable(),
  queueCreditChargedAt: isoTimestamp.nullable(),
  queueCreditDeniedAt: isoTimestamp.nullable(),
}).strict();
const dbTransactionSchema = z.object({
  txId: sha256Hex,
  batchId: nonEmpty,
  merkleRoot: sha256Hex,
  signedBytesSha256: sha256Hex,
}).strict();
const dbLeafSchema = z.object({
  txId: sha256Hex,
  batchId: nonEmpty,
  fingerprint: sha256Hex,
  orgId: nonEmpty,
  merkleIndex: nonNegativeInteger,
}).strict();
const proofSiblingSchema = z.object({ hash: sha256Hex, position: z.enum(['left', 'right']) }).strict();
const dbProofSchema = dbLeafSchema.extend({
  merkleRoot: sha256Hex,
  leafCount: positiveInteger,
  proofPath: z.array(proofSiblingSchema),
}).strict();
const dbLedgerEventSchema = z.object({
  eventId: nonEmpty,
  schedulerExecutionId: nonEmpty,
  fingerprint: sha256Hex,
  orgId: nonEmpty,
  kind: z.enum(['debit', 'refund']),
  amount: positiveInteger,
  referenceId: nonEmpty,
  occurredAt: isoTimestamp,
}).strict();
const dbOrgBalanceSchema = z.object({
  schedulerExecutionId: nonEmpty,
  orgId: nonEmpty,
  before: nonNegativeInteger,
  after: nonNegativeInteger,
}).strict();
const dbLedgerDeltaSchema = z.object({
  schedulerExecutionId: nonEmpty,
  orgId: nonEmpty,
  delta: z.number().int(),
}).strict();
const databaseCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('db-query-export'),
  projectRef,
  queryId: nonEmpty,
  isolation: z.literal('repeatable-read'),
  executions: z.array(dbExecutionSchema).min(1),
  passRows: z.array(dbPassRowSchema).min(1),
  transactions: z.array(dbTransactionSchema).min(1),
  txLeaves: z.array(dbLeafSchema).min(1),
  proofs: z.array(dbProofSchema).min(1),
  creditLedgerEvents: z.array(dbLedgerEventSchema),
  orgBalances: z.array(dbOrgBalanceSchema).min(1),
  ledgerDeltas: z.array(dbLedgerDeltaSchema).min(1),
}).strict();

const signetRecordSchema = z.object({
  recordId: nonEmpty,
  rpcRequestId: nonEmpty,
  rpcMethod: z.enum(['getrawtransaction', 'getmempoolentry', 'gettransaction']),
  schedulerExecutionId: nonEmpty,
  workerId: nonEmpty,
  txId: sha256Hex,
  batchId: nonEmpty,
  merkleRoot: sha256Hex,
  rawTxSha256: sha256Hex,
  nodeId: nonEmpty,
  network: z.literal('signet'),
  state: z.enum(['mempool', 'confirmed']),
  observedAt: isoTimestamp,
}).strict();
const signetCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('signet-rpc'),
  records: z.array(signetRecordSchema).min(1),
}).strict();

const cloudRunLifecycleSchema = z.object({
  recordId: nonEmpty,
  workerId: nonEmpty,
  event: z.enum(['started', 'heartbeat', 'stopped', 'crash-loop', 'endpoint-eviction']),
  occurredAt: isoTimestamp,
}).strict();
const cloudRunCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('cloud-run-lifecycle'),
  gcpProjectId: nonEmpty,
  workerService: nonEmpty,
  workerRevision: nonEmpty,
  region: nonEmpty,
  records: z.array(cloudRunLifecycleSchema).min(2),
}).strict();

const supervisorEventSchema = z.object({
  recordId: nonEmpty,
  event: z.enum(['started', 'heartbeat', 'stopped', 'death']),
  occurredAt: isoTimestamp,
}).strict();
const supervisorCaptureSchema = z.object({
  ...commonRawFields,
  source: z.literal('supervisor-records'),
  cleanMirror: z.object({
    attestationId: nonEmpty,
    result: z.literal('pass'),
    projectRef,
    gitBaseSha: headSha,
    gitHeadSha: headSha,
    observedAt: isoTimestamp,
  }).strict(),
  lease: z.object({
    leaseId: nonEmpty,
    state: z.literal('active'),
    holder: nonEmpty,
    acquiredAt: isoTimestamp,
    expiresAt: isoTimestamp,
  }).strict(),
  runnerId: nonEmpty,
  supervisor: nonEmpty,
  mode: z.literal('log-and-continue'),
  records: z.array(supervisorEventSchema).min(4),
}).strict();

export type SchedulerCapture = z.infer<typeof schedulerCaptureSchema>;
export type WorkerLogsCapture = z.infer<typeof workerLogsCaptureSchema>;
export type DatabaseCapture = z.infer<typeof databaseCaptureSchema>;
export type SignetCapture = z.infer<typeof signetCaptureSchema>;
export type CloudRunCapture = z.infer<typeof cloudRunCaptureSchema>;
export type SupervisorCapture = z.infer<typeof supervisorCaptureSchema>;

export interface RawCaptureTextSet {
  scheduler: string;
  workerLogs: string;
  database: string;
  signet: string;
  cloudRun: string;
  supervisor: string;
}

export interface ParsedRawCaptureSet {
  scheduler: SchedulerCapture;
  workerLogs: WorkerLogsCapture;
  database: DatabaseCapture;
  signet: SignetCapture;
  cloudRun: CloudRunCapture;
  supervisor: SupervisorCapture;
  contentDigests: RawCaptureDigests;
}

const VERIFIED_CAPTURE_PROVENANCE = new WeakMap<ParsedRawCaptureSet, ImmutableRunDeclaration>();

export interface RawCaptureDigests {
  scheduler: string;
  workerLogs: string;
  database: string;
  signet: string;
  cloudRun: string;
  supervisor: string;
}

export interface RawCaptureFileArguments {
  schedulerFile: string;
  workerLogsFile: string;
  databaseFile: string;
  signetFile: string;
  cloudRunFile: string;
  supervisorFile: string;
}

export interface LiveEvidenceExecutionEnv {
  ARKOVA_LIVE_EVIDENCE_EXECUTION?: string;
  ARKOVA_LIVE_EVIDENCE_SOAK_ID?: string;
}

export interface KnownLiveSourceCollectors {
  collectScheduler(declaration: ImmutableRunDeclaration): Promise<string>;
  collectWorkerLogs(declaration: ImmutableRunDeclaration): Promise<string>;
  collectDatabase(declaration: ImmutableRunDeclaration): Promise<string>;
  collectSignet(declaration: ImmutableRunDeclaration): Promise<string>;
  collectCloudRun(declaration: ImmutableRunDeclaration): Promise<string>;
  collectSupervisor(declaration: ImmutableRunDeclaration): Promise<string>;
}

export type KnownSourceKind = keyof RawCaptureTextSet;

export interface KnownSourceTransport {
  collect(request: {
    source: KnownSourceKind;
    declaration: RunDeclaration;
    declarationSha256: string;
  }): Promise<string>;
}

/** Concrete source-specific collector: source names and binding arguments are fixed. */
export class KnownSourceCollectorsAdapter implements KnownLiveSourceCollectors {
  constructor(
    private readonly transport: KnownSourceTransport,
    private readonly env: LiveEvidenceExecutionEnv,
  ) {}

  private async collect(source: KnownSourceKind, declaration: ImmutableRunDeclaration): Promise<string> {
    assertLiveCollectionGate(declaration, this.env);
    return this.transport.collect({
      source,
      declaration: declaration.value,
      declarationSha256: declaration.contentSha256,
    });
  }

  collectScheduler(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('scheduler', declaration); }
  collectWorkerLogs(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('workerLogs', declaration); }
  collectDatabase(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('database', declaration); }
  collectSignet(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('signet', declaration); }
  collectCloudRun(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('cloudRun', declaration); }
  collectSupervisor(declaration: ImmutableRunDeclaration): Promise<string> { return this.collect('supervisor', declaration); }
}

export class CapturedFileRawSourceCollector {
  constructor(private readonly files: RawCaptureFileArguments) {}

  async collect(): Promise<RawCaptureTextSet> {
    const [scheduler, workerLogs, database, signet, cloudRun, supervisor] = await Promise.all([
      readFile(this.files.schedulerFile, 'utf8'),
      readFile(this.files.workerLogsFile, 'utf8'),
      readFile(this.files.databaseFile, 'utf8'),
      readFile(this.files.signetFile, 'utf8'),
      readFile(this.files.cloudRunFile, 'utf8'),
      readFile(this.files.supervisorFile, 'utf8'),
    ]);
    return { scheduler, workerLogs, database, signet, cloudRun, supervisor };
  }
}

function digest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function parseJson(raw: string, label: string): unknown {
  return parseJsonRejectingDuplicateKeys(raw, label);
}

function parseStrict<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  const result = schema.safeParse(parseJson(raw, label));
  if (!result.success) throw new Error(`${label} schema rejected: ${z.prettifyError(result.error)}`);
  return result.data;
}

function time(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a timestamp.`);
  return parsed;
}

function unique<T>(values: T[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate identities.`);
}

export function assertRunDeclarationInvariants(value: RunDeclaration): void {
  if (value.gitBaseSha === value.gitHeadSha) throw new Error('Declaration git base and tested head must be distinct named commits.');
  if (time(value.soakEndedAt, 'soakEndedAt') - time(value.soakStartedAt, 'soakStartedAt') < SOAK_WALL_FLOOR_MINUTES * 60_000) {
    throw new Error('Declared soak wall window cannot contain the fixed 48h floor plus 30-minute overshoot.');
  }
  unique(value.windows.map((window) => window.scenarioId), 'declaration windows');
  const passes = value.windows.flatMap((window) => window.passes);
  unique(passes.map((pass) => pass.schedulerExecutionId), 'declaration passes');
  unique(passes.map((pass) => pass.batchId), 'declaration batch IDs');
  unique(passes.map((pass) => pass.faultWindow.id), 'declaration fault-window IDs');
  unique(passes.flatMap((pass) => pass.claims.map((claim) => claim.fingerprint)), 'declaration claim fingerprints');
  unique(value.recoveries.map((recovery) => recovery.schedulerExecutionId), 'declaration recovery executions');
  const drainExecutionIds = new Set(passes.map((pass) => pass.schedulerExecutionId));
  const faultWindowByDrainExecution = new Map(passes.map((pass) => [pass.schedulerExecutionId, pass.faultWindow.id]));
  if (value.recoveries.some((recovery) => (
    !drainExecutionIds.has(recovery.correlatedDrainExecutionId)
    || faultWindowByDrainExecution.get(recovery.correlatedDrainExecutionId) !== recovery.faultWindowId
    || drainExecutionIds.has(recovery.schedulerExecutionId)
  ))) throw new Error('Every recovery must be distinct and correlate to the exact same declared drain execution and fault window.');
  const soakStartMs = time(value.soakStartedAt, 'soakStartedAt');
  const soakEndMs = time(value.soakEndedAt, 'soakEndedAt');
  for (const pass of value.windows.flatMap((window) => window.passes)) {
    const faultStartMs = time(pass.faultWindow.startsAt, 'faultWindow.startsAt');
    const faultEndMs = time(pass.faultWindow.endsAt, 'faultWindow.endsAt');
    if (faultStartMs < soakStartMs || faultEndMs > soakEndMs || faultEndMs <= faultStartMs) {
      throw new Error('Every declared fault window must be ordered and contained by the named soak window.');
    }
    unique(pass.claims.map((claim) => claim.fingerprint), `claims for ${pass.schedulerExecutionId}`);
  }
  if (value.windows.some((window) => window.passes.some((pass) => pass.armedTrigger !== window.armedTrigger))) {
    throw new Error('Every declared pass must match its window armed trigger.');
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface EvidenceEnvelopeVerifier {
  verify(raw: unknown): ImmutableRunDeclaration;
}

interface EvidenceVerifierConfig {
  publicKeyPem: string;
  keyFingerprint: string;
}

function assertPlainVerifierConfig(config: unknown): asserts config is EvidenceVerifierConfig {
  if (!config || typeof config !== 'object' || utilTypes.isProxy(config) || Object.getPrototypeOf(config) !== Object.prototype) {
    throw new Error('Evidence verifier configuration must be a plain non-proxy data object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(config);
  if (
    Reflect.ownKeys(config).some((key) => typeof key !== 'string')
    || Object.keys(descriptors).sort().join(',') !== 'keyFingerprint,publicKeyPem'
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor) || descriptor.get || descriptor.set)
    || typeof descriptors.publicKeyPem?.value !== 'string'
    || typeof descriptors.keyFingerprint?.value !== 'string'
  ) throw new Error('Evidence verifier configuration rejects getters, unknown keys, and ambiguous values.');
}

class Ed25519EvidenceEnvelopeVerifier implements EvidenceEnvelopeVerifier {
  private readonly publicKey;
  private readonly keyFingerprint: string;

  constructor(config: EvidenceVerifierConfig) {
    this.publicKey = createPublicKey(config.publicKeyPem);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Evidence verification key must be Ed25519.');
    const actualFingerprint = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (actualFingerprint !== config.keyFingerprint) throw new Error('Evidence verification key fingerprint mismatch.');
    this.keyFingerprint = config.keyFingerprint;
  }

  verify(raw: unknown): ImmutableRunDeclaration {
    if (typeof raw !== 'string') throw new Error('Signed evidence envelope must be a primitive string.');
    const envelope = parseStrict(evidenceTrustRootSchema, raw, 'signed evidence envelope');
    if (envelope.keyFingerprint !== this.keyFingerprint) throw new Error('Signed evidence envelope names an untrusted key fingerprint.');
    const signature = Buffer.from(envelope.signatureBase64, 'base64');
    if (!verifySignature(null, Buffer.from(envelope.signedPayloadRaw), this.publicKey, signature)) {
      throw new Error('Signed evidence envelope Ed25519 signature is invalid.');
    }

    // Signature verification precedes the single semantic parse of signed bytes.
    const payload = parseStrict(evidenceSignedPayloadSchema, envelope.signedPayloadRaw, 'signed evidence payload');
    if (payload.envelopeId !== envelope.envelopeId) throw new Error('Signed envelope and payload identities differ.');
    assertRunDeclarationInvariants(payload.declaration);
    const contentSha256 = digest(JSON.stringify(payload.declaration));
    const declaration = deepFreeze({
      value: payload.declaration,
      contentSha256,
      trustRootId: envelope.envelopeId,
      trustRootSha256: digest(envelope.signedPayloadRaw),
      rawCaptureDigests: payload.rawCaptureDigests,
    });
    VERIFIED_DECLARATIONS.add(declaration);
    return declaration;
  }
}

export function createProductionEvidenceEnvelopeVerifier(): EvidenceEnvelopeVerifier {
  if (CTO_EVIDENCE_PUBLIC_KEY_PEM === null || CTO_EVIDENCE_KEY_FINGERPRINT === null) {
    throw new Error('CTO evidence verification key and fingerprint are not configured; live evidence verification is blocked.');
  }
  return new Ed25519EvidenceEnvelopeVerifier({
    publicKeyPem: CTO_EVIDENCE_PUBLIC_KEY_PEM,
    keyFingerprint: CTO_EVIDENCE_KEY_FINGERPRINT,
  });
}

export function createEvidenceEnvelopeVerifierForTest(config: unknown): EvidenceEnvelopeVerifier {
  if (process.env.NODE_ENV !== 'test') throw new Error('Evidence verification-key injection is available only in tests.');
  assertPlainVerifierConfig(config);
  return new Ed25519EvidenceEnvelopeVerifier(config);
}

export class TrustedRunDeclarationStore {
  async load(trustRootId: string): Promise<ImmutableRunDeclaration> {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(trustRootId)) throw new Error('Trust-root id is not allowlisted.');
    const path = join(DEFAULT_EVIDENCE_TRUST_ROOT, `${trustRootId}.json`);
    const verifier = createProductionEvidenceEnvelopeVerifier();
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Signed evidence envelope must be a regular file.');
      const raw = await handle.readFile('utf8');
      const declaration = verifier.verify(raw);
      if (declaration.trustRootId !== trustRootId) throw new Error('Evidence trust-root filename and content identity differ.');
      return declaration;
    } finally {
      await handle.close();
    }
  }
}

function snapshotRawCaptureTextSet(raw: RawCaptureTextSet): Readonly<RawCaptureTextSet> {
  if (!raw || typeof raw !== 'object' || utilTypes.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new Error('Raw capture set must be a plain non-proxy data object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const expectedKeys = ['cloudRun', 'database', 'scheduler', 'signet', 'supervisor', 'workerLogs'];
  if (
    Reflect.ownKeys(raw).some((key) => typeof key !== 'string')
    || Object.keys(descriptors).sort().join(',') !== expectedKeys.join(',')
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor) || descriptor.get || descriptor.set)
    || expectedKeys.some((key) => typeof descriptors[key]?.value !== 'string')
  ) throw new Error('Raw capture set rejects getters, unknown keys, and ambiguous values.');
  return Object.freeze({
    scheduler: descriptors.scheduler!.value as string,
    workerLogs: descriptors.workerLogs!.value as string,
    database: descriptors.database!.value as string,
    signet: descriptors.signet!.value as string,
    cloudRun: descriptors.cloudRun!.value as string,
    supervisor: descriptors.supervisor!.value as string,
  });
}

export function parseRawCaptureSet(
  raw: RawCaptureTextSet,
  declaration: ImmutableRunDeclaration,
): ParsedRawCaptureSet {
  if (!VERIFIED_DECLARATIONS.has(declaration)) {
    throw new Error('Raw captures require a declaration from the verified signed evidence envelope.');
  }
  const captured = snapshotRawCaptureTextSet(raw);
  const contentDigests = {
    scheduler: digest(captured.scheduler),
    workerLogs: digest(captured.workerLogs),
    database: digest(captured.database),
    signet: digest(captured.signet),
    cloudRun: digest(captured.cloudRun),
    supervisor: digest(captured.supervisor),
  };
  for (const source of Object.keys(contentDigests) as Array<keyof typeof contentDigests>) {
    if (contentDigests[source] !== declaration.rawCaptureDigests[source]) {
      throw new Error(`${source} raw export content digest does not match its trusted immutable declaration digest.`);
    }
  }
  const scheduler = parseStrict(schedulerCaptureSchema, captured.scheduler, 'cloud-scheduler raw export');
  const workerLogs = parseStrict(workerLogsCaptureSchema, captured.workerLogs, 'cloud-logging raw export');
  const database = parseStrict(databaseCaptureSchema, captured.database, 'database raw export');
  const signet = parseStrict(signetCaptureSchema, captured.signet, 'signet RPC raw export');
  const cloudRun = parseStrict(cloudRunCaptureSchema, captured.cloudRun, 'Cloud Run lifecycle raw export');
  const supervisor = parseStrict(supervisorCaptureSchema, captured.supervisor, 'supervisor raw export');
  const parsed = deepFreeze<ParsedRawCaptureSet>({
    scheduler, workerLogs, database, signet, cloudRun, supervisor, contentDigests,
  });
  VERIFIED_CAPTURE_PROVENANCE.set(parsed, declaration);
  return parsed;
}

export async function collectLiveRawSources(
  declaration: ImmutableRunDeclaration,
  collectors: KnownLiveSourceCollectors,
  env: LiveEvidenceExecutionEnv,
): Promise<{ mode: 'disabled'; reason: string } | { mode: 'captured'; raw: RawCaptureTextSet }> {
  try {
    assertLiveCollectionGate(declaration, env);
  } catch {
    return { mode: 'disabled', reason: 'live evidence collection was not explicitly enabled' };
  }
  const [scheduler, workerLogs, database, signet, cloudRun, supervisor] = await Promise.all([
    collectors.collectScheduler(declaration),
    collectors.collectWorkerLogs(declaration),
    collectors.collectDatabase(declaration),
    collectors.collectSignet(declaration),
    collectors.collectCloudRun(declaration),
    collectors.collectSupervisor(declaration),
  ]);
  return { mode: 'captured', raw: { scheduler, workerLogs, database, signet, cloudRun, supervisor } };
}

function assertLiveCollectionGate(
  declaration: ImmutableRunDeclaration,
  env: LiveEvidenceExecutionEnv,
): void {
  if (
    env.ARKOVA_LIVE_EVIDENCE_EXECUTION !== LIVE_EVIDENCE_ENABLE_VALUE
    || env.ARKOVA_LIVE_EVIDENCE_SOAK_ID !== declaration.value.soakId
  ) throw new Error('Live evidence collection was not explicitly enabled for this exact soak.');
}

function assertCommonBindings(declaration: ImmutableRunDeclaration, captures: ParsedRawCaptureSet): void {
  const expected = declaration.value;
  const sources = [
    captures.scheduler, captures.workerLogs, captures.database,
    captures.signet, captures.cloudRun, captures.supervisor,
  ];
  unique(sources.map((source) => source.exportId), 'raw source export IDs');
  for (const source of sources) {
    if (
      source.declarationSha256 !== declaration.contentSha256
      || source.rigId !== expected.rigId
      || source.soakId !== expected.soakId
      || source.gitHeadSha !== expected.gitHeadSha
      || source.imageDigest !== expected.imageDigest
    ) {
      throw new Error(`${source.source} raw export is cross-run, cross-head, cross-image, or declaration-unbound.`);
    }
    if (time(source.generatedAt, `${source.source} generatedAt`) < time(expected.soakEndedAt, 'soakEndedAt')) {
      throw new Error(`${source.source} raw export was generated before the declared soak completed.`);
    }
  }
  if (
    captures.database.projectRef !== expected.projectRef
    || captures.cloudRun.gcpProjectId !== expected.gcpProjectId
    || captures.cloudRun.workerService !== expected.workerService
    || captures.cloudRun.workerRevision !== expected.workerRevision
    || captures.cloudRun.region !== expected.region
  ) {
    throw new Error('DB or Cloud Run raw export mismatches the named rig project/service/revision/region.');
  }
}

function assertPreflightAndSupervisor(declaration: RunDeclaration, capture: SupervisorCapture): void {
  const startMs = time(declaration.soakStartedAt, 'soakStartedAt');
  const endMs = time(declaration.soakEndedAt, 'soakEndedAt');
  const cleanMs = time(capture.cleanMirror.observedAt, 'clean_mirror observedAt');
  if (
    capture.cleanMirror.attestationId !== declaration.cleanMirrorAttestationId
    || capture.cleanMirror.projectRef !== declaration.projectRef
    || capture.cleanMirror.gitBaseSha !== declaration.gitBaseSha
    || capture.cleanMirror.gitHeadSha !== declaration.gitHeadSha
    || cleanMs > startMs
  ) throw new Error('clean_mirror raw record mismatches named base/head/project or postdates the soak clock.');
  if (
    capture.lease.leaseId !== declaration.leaseId
    || time(capture.lease.acquiredAt, 'lease acquiredAt') > cleanMs
    || time(capture.lease.expiresAt, 'lease expiresAt') < endMs
  ) throw new Error('Lease raw record does not cover clean_mirror through soak completion.');

  unique(capture.records.map((record) => record.recordId), 'supervisor record IDs');
  const started = capture.records.filter((record) => record.event === 'started');
  const stopped = capture.records.filter((record) => record.event === 'stopped');
  const heartbeats = capture.records.filter((record) => record.event === 'heartbeat');
  const deaths = capture.records.filter((record) => record.event === 'death');
  if (
    capture.mode !== 'log-and-continue'
    || started.length !== 1
    || stopped.length !== 1
    || heartbeats.length < 2
    || deaths.length !== 0
    || time(started[0]!.occurredAt, 'runner start') > startMs
    || time(stopped[0]!.occurredAt, 'runner stop') < endMs
    || heartbeats.some((record) => {
      const at = time(record.occurredAt, 'runner heartbeat');
      return at < startMs || at > endMs;
    })
  ) throw new Error('Soak v2 supervisor records do not prove a continuous log-and-continue runner.');
  assertHeartbeatCadence(
    heartbeats.map((record) => record.occurredAt),
    startMs,
    endMs,
    'Soak v2 supervisor',
  );
}

interface WorkerInterval {
  workerId: string;
  start: number;
  end: number;
  countedStart: number;
  countedEnd: number;
}

function assertHeartbeatCadence(values: string[], startMs: number, endMs: number, label: string): void {
  const times = values
    .map((value) => time(value, `${label} heartbeat`))
    .filter((value) => value >= startMs && value <= endMs)
    .sort((left, right) => left - right);
  unique(times, `${label} heartbeat timestamps`);
  const points = [startMs, ...times, endMs];
  const maximumGap = MAX_HEARTBEAT_GAP_MINUTES * 60_000;
  if (points.some((point, index) => index > 0 && point - points[index - 1]! > maximumGap)) {
    throw new Error(`${label} heartbeat gap exceeds the continuous ${MAX_HEARTBEAT_GAP_MINUTES}-minute cadence.`);
  }
}

function deriveWorkerUptime(
  declaration: RunDeclaration,
  capture: CloudRunCapture,
): { uptimeMs: number; intervals: WorkerInterval[] } {
  unique(capture.records.map((record) => record.recordId), 'Cloud Run lifecycle record IDs');
  if (capture.records.some((record) => record.event === 'crash-loop' || record.event === 'endpoint-eviction')) {
    throw new Error('Crash-loop or endpoint eviction voids the worker-uptime clock.');
  }
  const startMs = time(declaration.soakStartedAt, 'soakStartedAt');
  const endMs = time(declaration.soakEndedAt, 'soakEndedAt');
  const byWorker = new Map<string, CloudRunCapture['records']>();
  for (const record of capture.records) {
    const records = byWorker.get(record.workerId) ?? [];
    records.push(record);
    byWorker.set(record.workerId, records);
  }
  let uptimeMs = 0;
  const intervals: WorkerInterval[] = [];
  for (const [workerId, records] of byWorker) {
    const starts = records.filter((record) => record.event === 'started');
    const stops = records.filter((record) => record.event === 'stopped');
    const heartbeats = records.filter((record) => record.event === 'heartbeat');
    if (starts.length !== 1 || stops.length !== 1) throw new Error(`Worker ${workerId} lacks one start/stop lifecycle pair.`);
    const start = time(starts[0]!.occurredAt, 'worker start');
    const end = time(stops[0]!.occurredAt, 'worker stop');
    if (end <= start) throw new Error('Worker lifecycle interval is not chronological.');
    const countedStart = Math.max(start, startMs);
    const countedEnd = Math.min(end, endMs);
    if (countedEnd <= countedStart) throw new Error('Worker lifecycle interval does not overlap the declared soak clock.');
    assertHeartbeatCadence(
      heartbeats.map((record) => record.occurredAt),
      countedStart,
      countedEnd,
      `Cloud Run worker ${workerId}`,
    );
    intervals.push({ workerId, start, end, countedStart, countedEnd });
    uptimeMs += countedEnd - countedStart;
  }
  intervals.sort((left, right) => left.start - right.start);
  if (intervals.some((interval, index) => index > 0 && interval.start < intervals[index - 1]!.end)) {
    throw new Error('Cloud Run worker uptime intervals overlap and would double-count the soak clock.');
  }
  if (uptimeMs < SOAK_REQUIRED_UPTIME_MINUTES * 60_000) {
    throw new Error('Cloud Run worker uptime is below the fixed 48h worker-uptime floor.');
  }
  return { uptimeMs, intervals };
}

function assertWorkerCovers(
  intervals: WorkerInterval[],
  workerId: string,
  startedAt: string,
  completedAt: string,
  label: string,
): void {
  const start = time(startedAt, `${label} start`);
  const end = time(completedAt, `${label} completion`);
  if (!intervals.some((interval) => interval.workerId === workerId && interval.start <= start && interval.end >= end)) {
    throw new Error(`${label} is not bound to the declared active Cloud Run worker identity.`);
  }
}

function expectedDrainPath(trigger: 'org-scheduler' | 'global-flush'): string {
  return trigger === 'org-scheduler' ? '/jobs/org-queue-scheduler' : '/jobs/batch-anchors?force=true';
}

function derivePassObservation(
  declaration: RunDeclaration,
  captures: ParsedRawCaptureSet,
  pass: DrainWindowExpectation['passes'][number],
): DrainPassObservation {
  const executionRows = captures.database.executions.filter((row) => row.schedulerExecutionId === pass.schedulerExecutionId);
  if (executionRows.length !== 1) throw new Error(`DB export must contain exactly one execution ${pass.schedulerExecutionId}.`);
  const execution = executionRows[0]!;
  const triggerLogs = captures.workerLogs.records.filter((record) => (
    record.event === 'trigger-fired' && record.schedulerExecutionId === pass.schedulerExecutionId
  ));
  if (triggerLogs.length !== 1) throw new Error(`Worker logs must contain one trigger firing ${pass.schedulerExecutionId}.`);
  const triggerLog = triggerLogs[0]!;
  if (
    triggerLog.batchId !== pass.batchId
    || triggerLog.trigger !== pass.armedTrigger
    || triggerLog.workerId !== execution.workerId
    || triggerLog.fingerprint !== null
    || triggerLog.orgId !== null
    || triggerLog.decision !== null
    || triggerLog.reason !== null
    || triggerLog.referenceId !== null
    || triggerLog.requiredAmount !== null
    || triggerLog.balanceBefore !== null
    || triggerLog.balanceAfter !== null
  ) throw new Error('Trigger-fired raw log carries contradictory gate fields or wrong batch/trigger.');

  const passRows = captures.database.passRows.filter((row) => row.schedulerExecutionId === pass.schedulerExecutionId);
  const transactionIds = new Set(passRows.map((row) => row.chainTxId).filter((value): value is string => value !== null));
  const transactions = captures.database.transactions.filter((row) => transactionIds.has(row.txId)).map((row) => {
    const chain = captures.signet.records.filter((record) => record.txId === row.txId);
    if (chain.length !== 1) throw new Error(`Signet export must contain one RPC result for ${row.txId}.`);
    const result = chain[0]!;
    if (
      result.batchId !== row.batchId
      || result.merkleRoot !== row.merkleRoot
      || result.rawTxSha256 !== row.signedBytesSha256
      || result.schedulerExecutionId !== pass.schedulerExecutionId
      || result.workerId !== execution.workerId
    ) throw new Error('Signet RPC result mismatches the DB transaction/root/signed bytes.');
    return {
      ...row,
      schedulerExecutionId: result.schedulerExecutionId,
      network: result.network,
      nodeId: result.nodeId,
      chainState: result.state,
      acceptedAt: result.observedAt,
    };
  });
  const gateLogs = captures.workerLogs.records.filter((record) => (
    record.event === 'credit-gate' && record.schedulerExecutionId === pass.schedulerExecutionId
  ));
  const creditGateEvents = gateLogs.map((record) => {
    if (
      record.fingerprint === null
      || record.orgId === null
      || record.decision === null
      || record.requiredAmount === null
      || record.batchId !== pass.batchId
      || record.trigger !== pass.armedTrigger
      || record.traceId !== triggerLog.traceId
      || record.workerId !== execution.workerId
    ) throw new Error('Credit-gate raw log is missing typed gate fields.');
    return {
      eventId: record.recordId,
      schedulerExecutionId: record.schedulerExecutionId,
      fingerprint: record.fingerprint,
      orgId: record.orgId,
      decision: record.decision,
      reason: record.reason,
      referenceId: record.referenceId,
      requiredAmount: record.requiredAmount,
      balanceBefore: record.balanceBefore,
      balanceAfter: record.balanceAfter,
      occurredAt: record.occurredAt,
    };
  });
  return {
    execution: {
      schedulerExecutionId: execution.schedulerExecutionId,
      armedTrigger: execution.armedTrigger,
      faultWindowId: execution.faultWindowId,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
    },
    triggerFirings: [{
      trigger: triggerLog.trigger,
      schedulerExecutionId: triggerLog.schedulerExecutionId,
      batchId: triggerLog.batchId,
      firedAt: triggerLog.occurredAt,
    }],
    pendingBefore: execution.pendingBefore,
    pendingAfter: execution.pendingAfter,
    passRows,
    transactions,
    txLeaves: captures.database.txLeaves.filter((row) => transactionIds.has(row.txId)),
    proofs: captures.database.proofs.filter((row) => transactionIds.has(row.txId)),
    creditGateEvents,
    creditLedgerEvents: captures.database.creditLedgerEvents.filter((row) => row.schedulerExecutionId === pass.schedulerExecutionId),
    orgBalances: captures.database.orgBalances.filter((row) => row.schedulerExecutionId === pass.schedulerExecutionId),
    ledgerDeltas: captures.database.ledgerDeltas.filter((row) => row.schedulerExecutionId === pass.schedulerExecutionId),
  };
}

export interface LiveEvidenceSummary {
  declarationId: string;
  declarationSha256: string;
  trustRootId: string;
  trustRootSha256: string;
  rigId: 'RIG-B1';
  soakId: string;
  gitBaseSha: string;
  gitHeadSha: string;
  imageDigest: string;
  workerUptimeMs: number;
  requiredWorkerUptimeMs: number;
  windows: DrainWindowEvidenceSummary[];
  sourceDigests: RawCaptureDigests;
  sourceExportIds: string[];
}

export function deriveAndAssertLiveEvidence(
  declaration: ImmutableRunDeclaration,
  captures: ParsedRawCaptureSet,
): LiveEvidenceSummary {
  if (!VERIFIED_DECLARATIONS.has(declaration)) {
    throw new Error('Live evidence derivation requires a declaration from the verified signed evidence envelope.');
  }
  if (VERIFIED_CAPTURE_PROVENANCE.get(captures) !== declaration) {
    throw new Error('Live evidence derivation requires a verified capture set bound to this declaration provenance.');
  }
  assertCommonBindings(declaration, captures);
  assertPreflightAndSupervisor(declaration.value, captures.supervisor);
  const workerClock = deriveWorkerUptime(declaration.value, captures.cloudRun);
  const workerUptimeMs = workerClock.uptimeMs;
  const soakStartMs = time(declaration.value.soakStartedAt, 'soakStartedAt');
  unique(captures.scheduler.records.map((record) => record.recordId), 'Scheduler record IDs');
  unique(captures.scheduler.records.map((record) => record.schedulerExecutionId), 'Scheduler execution IDs');
  const preclock = captures.scheduler.records.filter((record) => record.purpose === 'preclock');
  if (
    preclock.length !== 1
    || preclock[0]!.statusCode !== 200
    || preclock[0]!.correlatedDrainExecutionId !== null
    || preclock[0]!.faultWindowId !== null
    || time(preclock[0]!.completedAt, 'preclock completedAt') > soakStartMs
  ) throw new Error('Raw Scheduler export must prove one /jobs/* HTTP 200 before the soak clock.');
  assertWorkerCovers(
    workerClock.intervals,
    preclock[0]!.workerId,
    preclock[0]!.firedAt,
    preclock[0]!.completedAt,
    'preclock Scheduler execution',
  );

  const passDeclarations = declaration.value.windows.flatMap((window) => window.passes);
  const declaredExecutionIds = new Set(passDeclarations.map((pass) => pass.schedulerExecutionId));
  if (
    captures.database.executions.length !== passDeclarations.length
    || captures.database.executions.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
    || captures.database.passRows.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
    || captures.database.creditLedgerEvents.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
    || captures.database.orgBalances.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
    || captures.database.ledgerDeltas.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
    || captures.workerLogs.records.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
  ) throw new Error('Raw worker/DB records contain an undeclared or missing drain execution.');
  const drainSchedulerRows = captures.scheduler.records.filter((record) => record.purpose === 'drain');
  if (
    drainSchedulerRows.length !== passDeclarations.length
    || drainSchedulerRows.some((record) => !declaredExecutionIds.has(record.schedulerExecutionId))
  ) throw new Error('Scheduler raw export must cover exactly every declared drain execution.');
  const declaredRecoveryIds = new Set(declaration.value.recoveries.map((recovery) => recovery.schedulerExecutionId));
  const recoverySchedulerRows = captures.scheduler.records.filter((record) => record.purpose === 'recovery');
  if (
    recoverySchedulerRows.length !== declaration.value.recoveries.length
    || recoverySchedulerRows.some((record) => !declaredRecoveryIds.has(record.schedulerExecutionId))
  ) throw new Error('Scheduler raw export contains an undeclared recovery or omits a declared recovery execution.');
  if (captures.scheduler.records.some((record) => (
    record.gcpProjectId !== declaration.value.gcpProjectId
    || record.workerRevision !== declaration.value.workerRevision
    || time(record.completedAt, 'Scheduler completedAt') < time(record.firedAt, 'Scheduler firedAt')
  ))) throw new Error('Scheduler raw record mismatches project/revision or has invalid chronology.');
  for (const pass of passDeclarations) {
    const records = drainSchedulerRows.filter((record) => record.schedulerExecutionId === pass.schedulerExecutionId);
    const dbExecutions = captures.database.executions.filter((record) => record.schedulerExecutionId === pass.schedulerExecutionId);
    if (records.length !== 1 || dbExecutions.length !== 1) throw new Error('Scheduler and DB execution IDs must join one-to-one.');
    const record = records[0]!;
    const dbExecution = dbExecutions[0]!;
    if (
      record.gcpProjectId !== declaration.value.gcpProjectId
      || record.workerRevision !== declaration.value.workerRevision
      || record.statusCode !== 200
      || record.trigger !== pass.armedTrigger
      || record.path !== expectedDrainPath(pass.armedTrigger)
      || record.correlatedDrainExecutionId !== null
      || record.faultWindowId !== pass.faultWindow.id
      || record.workerId !== dbExecution.workerId
      || time(record.firedAt, 'Scheduler firedAt') > time(dbExecution.startedAt, 'DB execution start')
      || time(record.completedAt, 'Scheduler completedAt') < time(dbExecution.completedAt, 'DB execution completion')
    ) throw new Error('Scheduler raw record mismatches project/revision/path/trigger/200 or DB chronology.');
    assertWorkerCovers(
      workerClock.intervals,
      record.workerId,
      record.firedAt,
      record.completedAt,
      `drain Scheduler execution ${pass.schedulerExecutionId}`,
    );
  }
  for (const recovery of declaration.value.recoveries) {
    const records = recoverySchedulerRows.filter((record) => record.schedulerExecutionId === recovery.schedulerExecutionId);
    if (records.length !== 1) throw new Error('Scheduler recovery execution IDs must join one-to-one.');
    const record = records[0]!;
    const correlatedDrain = drainSchedulerRows.find((candidate) => (
      candidate.schedulerExecutionId === recovery.correlatedDrainExecutionId
    ));
    const correlatedPass = passDeclarations.find((candidate) => (
      candidate.schedulerExecutionId === recovery.correlatedDrainExecutionId
    ));
    if (
      !correlatedDrain
      || !correlatedPass
      || record.statusCode !== 200
      || record.path !== '/jobs/recover-broadcasts'
      || record.correlatedDrainExecutionId !== recovery.correlatedDrainExecutionId
      || record.faultWindowId !== recovery.faultWindowId
      || record.trigger !== correlatedPass.armedTrigger
      || time(record.firedAt, 'recovery firedAt') <= time(correlatedDrain.completedAt, 'correlated drain completedAt')
      || time(record.firedAt, 'recovery firedAt') < time(correlatedPass.faultWindow.startsAt, 'fault window startsAt')
      || time(record.completedAt, 'recovery completedAt') > time(correlatedPass.faultWindow.endsAt, 'fault window endsAt')
    ) throw new Error('Scheduler recovery raw record must be an HTTP 200 bound to its declared drain and fault window.');
    assertWorkerCovers(
      workerClock.intervals,
      record.workerId,
      record.firedAt,
      record.completedAt,
      `recovery Scheduler execution ${recovery.schedulerExecutionId}`,
    );
  }

  unique(captures.workerLogs.records.map((record) => record.recordId), 'worker log record IDs');
  unique(captures.workerLogs.records.map((record) => record.insertId), 'worker log insert IDs');
  unique(captures.signet.records.map((record) => record.recordId), 'signet record IDs');
  unique(captures.signet.records.map((record) => record.rpcRequestId), 'signet RPC request IDs');
  unique(captures.database.creditLedgerEvents.map((record) => record.eventId), 'DB ledger event IDs');
  unique(captures.database.transactions.map((record) => record.txId), 'DB transaction IDs');
  const referencedTxIds = new Set(captures.database.passRows
    .map((record) => record.chainTxId)
    .filter((value): value is string => value !== null));
  const dbTxIds = new Set(captures.database.transactions.map((record) => record.txId));
  const signetTxIds = new Set(captures.signet.records.map((record) => record.txId));
  if (
    referencedTxIds.size !== dbTxIds.size
    || [...referencedTxIds].some((txId) => !dbTxIds.has(txId))
    || signetTxIds.size !== dbTxIds.size
    || captures.signet.records.length !== dbTxIds.size
    || [...dbTxIds].some((txId) => !signetTxIds.has(txId))
    || captures.database.txLeaves.some((record) => !dbTxIds.has(record.txId))
    || captures.database.proofs.some((record) => !dbTxIds.has(record.txId))
  ) throw new Error('DB transaction, row, proof, leaf, and signet raw identities are not an exact closed set.');

  const windows = declaration.value.windows.map((window) => {
    const observations = window.passes.map((pass) => derivePassObservation(declaration.value, captures, pass));
    return assertDrainWindowObservation(window as DrainWindowExpectation, observations);
  });
  const transactionIds = windows.flatMap((window) => window.transactionIds);
  if (new Set(transactionIds).size !== transactionIds.length) {
    throw new Error('A transaction identity was reused across declared drain windows or Scheduler passes.');
  }
  return {
    declarationId: declaration.value.declarationId,
    declarationSha256: declaration.contentSha256,
    trustRootId: declaration.trustRootId,
    trustRootSha256: declaration.trustRootSha256,
    rigId: 'RIG-B1',
    soakId: declaration.value.soakId,
    gitBaseSha: declaration.value.gitBaseSha,
    gitHeadSha: declaration.value.gitHeadSha,
    imageDigest: declaration.value.imageDigest,
    workerUptimeMs,
    requiredWorkerUptimeMs: SOAK_REQUIRED_UPTIME_MINUTES * 60_000,
    windows,
    sourceDigests: captures.contentDigests,
    sourceExportIds: [
      captures.scheduler.exportId,
      captures.workerLogs.exportId,
      captures.database.exportId,
      captures.signet.exportId,
      captures.cloudRun.exportId,
      captures.supervisor.exportId,
    ],
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'trust-root-id': { type: 'string' },
      'scheduler-export': { type: 'string' },
      'worker-logs-export': { type: 'string' },
      'database-export': { type: 'string' },
      'signet-export': { type: 'string' },
      'cloud-run-export': { type: 'string' },
      'supervisor-export': { type: 'string' },
    },
  });
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required.`);
    return value;
  };
  const declaration = await new TrustedRunDeclarationStore().load(required('trust-root-id'));
  const raw = await new CapturedFileRawSourceCollector({
    schedulerFile: required('scheduler-export'),
    workerLogsFile: required('worker-logs-export'),
    databaseFile: required('database-export'),
    signetFile: required('signet-export'),
    cloudRunFile: required('cloud-run-export'),
    supervisorFile: required('supervisor-export'),
  }).collect();
  const summary = deriveAndAssertLiveEvidence(declaration, parseRawCaptureSet(raw, declaration));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`batch-drain-live-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
