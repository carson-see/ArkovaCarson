/** Production composition for the foreground RIG-B1 soak supervisor. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  KnownSourceCollectorsAdapter,
  LIVE_EVIDENCE_ENABLE_VALUE,
  collectLiveRawSources,
  rigB1InfrastructureSchema,
  runDeclarationSchema,
  validateUnsignedLiveEvidenceForSigning,
  type ImmutableRunDeclaration,
  type KnownSourceTransport,
  type RawCaptureDigests,
  type RunDeclaration,
} from './batch-drain-live-evidence';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import {
  B1_SCHEDULER_START_CONTRACT,
  type B1SchedulerJobObservation,
  type B1SchedulerStartPort,
  type B1SchedulerStartReceipt,
} from './s33-b1-scheduler-start-driver';
import { createB1SchedulerStartProductionAdapter } from './s33-b1-scheduler-start-production-adapter';
import {
  assertGenuineS33B1Wave3ScenarioMaterial,
  buildS33B1Wave3LiveScenarioPlan,
  executeS33B1Wave3LiveScenarios,
  resolveS33B1Wave3ScenarioCapture,
  type S33B1Wave3LiveScenarioMaterial,
  type S33B1Wave3LiveScenarioPort,
} from './s33-b1-wave3-live-scenario-executor';
import {
  createS33B1Wave3KnownSourceTransport,
  createS33B1Wave3LiveScenarioProductionPort,
} from './s33-b1-wave3-live-scenario-production-adapter';
import {
  type B1FinalizedSoakEvidence,
  type B1SoakSupervisorPort,
  type B1SupervisorContext,
  type B1SupervisorHeartbeatObservation,
  type B1SupervisorJournalRecord,
} from './s33-b1-soak-supervisor';

const MINUTE_MS = 60_000;
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const projectRef = z.string().regex(/^[a-z]{20}$/u);
const admissionInfrastructureSchema = z.object({
  secretReferences: z.array(z.object({ env: z.string() }).passthrough()),
}).passthrough();

const admissionSchema = z.object({
  base_sha: z.string().regex(/^[0-9a-f]{40}$/u),
  sha: z.string().regex(/^[0-9a-f]{40}$/u),
  image_digest: sha256,
  deployed_revision: boundedId,
  tag_url: z.string().url(),
  gcp_project_id: z.literal(B1_SCHEDULER_START_CONTRACT.gcpProjectId),
  region: z.literal(B1_SCHEDULER_START_CONTRACT.gcpRegion),
  supabase_project_ref: projectRef,
  cloud_run_service: z.literal(B1_SCHEDULER_START_CONTRACT.workerService),
  soak_id: boundedId,
  lease_id: boundedId,
  owner: z.string().min(1),
  clean_mirror_attestation_id: sha256,
  clean_mirror: z.object({ verified_at: timestamp }).passthrough(),
  infrastructure: admissionInfrastructureSchema,
}).passthrough();

const receiptSchema = z.object({
  activationId: boundedId,
  authority: z.object({ runHardStopAt: timestamp }).passthrough(),
  candidate: z.object({ sourceHeadSha: z.string(), workerImageDigest: sha256 }).passthrough(),
  run: z.object({ soakId: boundedId, leaseId: boundedId, startedAt: timestamp }).passthrough(),
  scheduler: z.object({
    serviceUrl: z.string().url(),
    jobs: z.array(z.unknown()).length(6),
  }).passthrough(),
}).passthrough();

const declarationWindowSchema = runDeclarationSchema.shape.windows.element;
const recoverySchema = runDeclarationSchema.shape.recoveries.element;
const executionArtifactSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.execution-capture/v1'),
  captureId: sha256,
  scenarioId: boundedId,
  schedulerExecutionId: sha256,
  faultWindowId: boundedId,
  declarationWindow: declarationWindowSchema,
  recoveries: z.array(recoverySchema),
}).passthrough();

function digestHex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function digestId(raw: string): string {
  return `sha256:${digestHex(raw)}`;
}

function strictParse(raw: string, label: string): unknown {
  return parseJsonRejectingDuplicateKeys(raw, label);
}

function projectEvidenceInfrastructure(
  infrastructure: z.infer<typeof admissionInfrastructureSchema>,
): z.infer<typeof rigB1InfrastructureSchema> {
  return rigB1InfrastructureSchema.parse(infrastructure);
}

export interface B1SupervisorProcessRunner {
  run(input: Readonly<{
    binary: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>): Promise<void>;
}

export interface B1SoakSupervisorProductionDependencies {
  readonly scheduler: B1SchedulerStartPort;
  readonly scenario: S33B1Wave3LiveScenarioPort;
  readonly evidenceTransport: KnownSourceTransport;
  readonly process: B1SupervisorProcessRunner;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly liveEvidenceEnv: Readonly<{
    ARKOVA_LIVE_EVIDENCE_EXECUTION?: string;
    ARKOVA_LIVE_EVIDENCE_SOAK_ID?: string;
  }>;
}

class NodeSupervisorProcessRunner implements B1SupervisorProcessRunner {
  async run(input: Readonly<{
    binary: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile(input.binary, [...input.args], {
        shell: false,
        env: input.env,
        timeout: 30 * MINUTE_MS,
        maxBuffer: 16 * 1024 * 1024,
      }, (error) => error === null ? resolve() : reject(error));
    });
  }
}

function assertJobMatchesStartedReceipt(
  observed: B1SchedulerJobObservation,
  started: B1SchedulerJobObservation,
  expectedState: 'ENABLED' | 'PAUSED',
): void {
  const normalized = { ...observed, state: started.state, observedAt: started.observedAt };
  if (observed.state !== expectedState || !isDeepStrictEqual(normalized, started)) {
    throw new Error(`RIG-B1 production supervisor observed Scheduler drift for ${started.name}.`);
  }
}

function declarationFromGenuineMaterial(
  admissionRaw: string,
  receipt: B1SchedulerStartReceipt,
  soakStartedAt: string,
  soakEndedAt: string,
  scenarioMaterial: unknown,
): RunDeclaration {
  const admission = admissionSchema.parse(strictParse(admissionRaw, 'RIG-B1 evidence admission'));
  const parsedReceipt = receiptSchema.parse(receipt);
  assertGenuineS33B1Wave3ScenarioMaterial(scenarioMaterial, {
    admissionSha256: digestId(admissionRaw),
    receiptSha256: digestId(JSON.stringify(receipt)),
    sourceHeadSha: admission.sha,
    imageDigest: admission.image_digest,
    soakId: admission.soak_id,
    leaseId: admission.lease_id,
  });
  const material = scenarioMaterial as S33B1Wave3LiveScenarioMaterial;
  const windows: Array<z.infer<typeof declarationWindowSchema>> = [];
  const recoveries: Array<z.infer<typeof recoverySchema>> = [];
  for (const handle of material.captures) {
    const { scenario, observation } = resolveS33B1Wave3ScenarioCapture(handle);
    const artifact = executionArtifactSchema.parse(strictParse(
      observation.evidenceArtifactRaw,
      `RIG-B1 persisted execution capture ${handle.executionSlot}`,
    ));
    const passes = artifact.declarationWindow.passes;
    const passIdentities = passes.map((pass) => (
      pass.outcome === 'broadcast' ? `broadcast:${pass.batchId}` : `no-broadcast:${pass.outcomeId}`
    ));
    if (artifact.captureId !== handle.captureId
      || artifact.scenarioId !== scenario.scenarioId
      || artifact.schedulerExecutionId !== observation.schedulerExecutionId
      || artifact.faultWindowId !== scenario.faultWindowId
      || artifact.declarationWindow.scenarioId !== scenario.scenarioId
      || passes.length === 0
      || passes.some((pass) => (
        pass.schedulerExecutionId !== observation.schedulerExecutionId
        || pass.faultWindow.id !== scenario.faultWindowId
      ))
      || new Set(passIdentities).size !== passes.length) {
      throw new Error('RIG-B1 declaration facts differ from the genuine persisted execution capture.');
    }
    windows.push(artifact.declarationWindow);
    recoveries.push(...artifact.recoveries);
  }
  return runDeclarationSchema.parse({
    schemaVersion: 1,
    declarationId: `rig-b1-${parsedReceipt.activationId}`,
    gitBaseSha: admission.base_sha,
    gitHeadSha: admission.sha,
    imageDigest: admission.image_digest,
    rigId: 'RIG-B1',
    gcpProjectId: admission.gcp_project_id,
    projectRef: admission.supabase_project_ref,
    soakId: admission.soak_id,
    leaseId: admission.lease_id,
    cleanMirrorAttestationId: admission.clean_mirror_attestation_id,
    workerService: admission.cloud_run_service,
    workerRevision: admission.deployed_revision,
    region: admission.region,
    infrastructure: projectEvidenceInfrastructure(admission.infrastructure),
    soakStartedAt,
    soakEndedAt,
    recoveries,
    windows,
  });
}

class ProductionB1SoakSupervisorAdapter implements B1SoakSupervisorPort {
  private readonly admission: z.infer<typeof admissionSchema>;
  private readonly receipt: z.infer<typeof receiptSchema>;
  private activeScenario: Promise<S33B1Wave3LiveScenarioMaterial> | undefined;

  constructor(
    private readonly context: B1SupervisorContext,
    private readonly dependencies: B1SoakSupervisorProductionDependencies,
  ) {
    this.admission = admissionSchema.parse(strictParse(
      context.admissionRaw,
      'RIG-B1 production supervisor admission',
    ));
    this.receipt = receiptSchema.parse(context.receipt);
  }

  now(): Date { return this.dependencies.now(); }
  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return this.dependencies.sleep(milliseconds, signal);
  }

  private journalUri(file: string): string {
    return `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/supervisor-journals/${this.receipt.activationId}/${file}`;
  }

  private async persistAndVerify(uri: string, raw: string): Promise<void> {
    await this.dependencies.scheduler.persistStartReceipt(
      uri,
      raw,
      this.receipt.authority.runHardStopAt,
    );
    const locked = await this.dependencies.scheduler.readLockedObject(uri);
    if (locked.uri !== uri
      || locked.raw !== raw
      || Date.parse(locked.retainUntilTime) < Date.parse(this.receipt.authority.runHardStopAt)) {
      throw new Error('RIG-B1 supervisor journal Locked readback differs.');
    }
  }

  async createJournal(input: Readonly<{
    admissionSha256: string;
    receiptSha256: string;
    soakId: string;
  }>): Promise<void> {
    const raw = JSON.stringify({
      schemaVersion: 'arkova.s33.rig-b1.supervisor-journal/v1',
      activationId: this.receipt.activationId,
      admissionSha256: input.admissionSha256,
      receiptSha256: input.receiptSha256,
      soakId: input.soakId,
      runHardStopAt: this.receipt.authority.runHardStopAt,
    });
    await this.persistAndVerify(this.journalUri('manifest.json'), raw);
  }

  appendJournal(record: B1SupervisorJournalRecord): Promise<void> {
    return this.persistAndVerify(this.journalUri(`${record.recordId}.json`), JSON.stringify(record));
  }

  async observeHeartbeat(): Promise<B1SupervisorHeartbeatObservation> {
    const activation = await this.dependencies.scheduler.observeActivation({
      workerRevision: this.admission.deployed_revision,
      sourceHeadSha: this.admission.sha,
      imageDigest: this.admission.image_digest,
      runtimeServiceAccount: B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount,
      serviceUrl: this.admission.tag_url,
    });
    const schedulerJobs = await Promise.all(B1_SCHEDULER_START_CONTRACT.jobs.map((spec) => (
      this.dependencies.scheduler.observeJob(spec)
    )));
    schedulerJobs.forEach((job, index) => {
      const started = this.context.receipt.scheduler.jobs[index];
      if (started === undefined) throw new Error('RIG-B1 start receipt omits a Scheduler job.');
      assertJobMatchesStartedReceipt(job, started, 'ENABLED');
    });
    return {
      ...activation,
      workerId: activation.workerRevision,
      schedulerJobs,
    };
  }

  renewInvocationLease(input: Readonly<{
    activationId: string;
    expiresAt: string;
    runHardStopAt: string;
    heartbeatObservedAt: string;
  }>): Promise<void> {
    if (input.activationId !== this.receipt.activationId
      || input.runHardStopAt !== this.receipt.authority.runHardStopAt) {
      throw new Error('RIG-B1 heartbeat lease renewal differs from signed START authority.');
    }
    return this.dependencies.scheduler.installInvocationLease({
      approvalId: input.activationId,
      expiresAt: input.expiresAt,
      authorityExpiresAt: input.runHardStopAt,
    });
  }

  removeInvocationLease(activationId: string): Promise<void> {
    return this.dependencies.scheduler.removeInvocationLease(activationId);
  }

  executeLiveScenarios(input: Readonly<{
    admissionRaw: string;
    receipt: B1SchedulerStartReceipt;
    signal: AbortSignal;
  }>): Promise<unknown> {
    if (this.activeScenario !== undefined) {
      throw new Error('RIG-B1 production supervisor refuses a second live scenario executor.');
    }
    const plan = buildS33B1Wave3LiveScenarioPlan({
      planId: `b1-wave3-${digestHex(JSON.stringify(input.receipt)).slice(0, 24)}`,
      runId: this.receipt.activationId,
      startApprovalId: this.receipt.activationId,
      admissionSha256: digestId(input.admissionRaw),
      receiptSha256: digestId(JSON.stringify(input.receipt)),
      gitHeadSha: this.admission.sha,
      imageDigest: this.admission.image_digest,
      soakId: this.admission.soak_id,
      runLeaseId: this.admission.lease_id,
      workerRevision: this.admission.deployed_revision,
      serviceAudience: this.admission.tag_url,
      authorityExpiresAt: this.receipt.authority.runHardStopAt,
      runHardStopAt: this.receipt.authority.runHardStopAt,
    });
    const active = executeS33B1Wave3LiveScenarios(plan, this.dependencies.scenario, input.signal);
    this.activeScenario = active;
    return active;
  }

  async abortAndAwaitLiveScenarios(input: Readonly<{
    reason: unknown;
    runHardStopAt: string;
  }>): Promise<void> {
    const active = this.activeScenario;
    if (active === undefined) return;
    try { await active; } catch { /* executor returns only after its own abort/idle/cleanup proof */ }
    const deadline = new Date(Math.min(
      this.now().getTime() + 5 * MINUTE_MS,
      Date.parse(input.runHardStopAt),
    )).toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('RIG-B1 scenario idle proof exceeded its cleanup deadline.')),
      Math.max(0, Date.parse(deadline) - this.now().getTime()),
    );
    try {
      await this.dependencies.scenario.abortAndAwaitIdle({
        reason: input.reason instanceof Error ? input.reason.message : 'supervisor abort',
        deadline,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  assertGenuineScenarioMaterial(input: Readonly<{
    material: unknown;
    admissionSha256: string;
    receiptSha256: string;
    sourceHeadSha: string;
    imageDigest: string;
    soakId: string;
    leaseId: string;
  }>): void {
    assertGenuineS33B1Wave3ScenarioMaterial(input.material, input);
  }

  async finalizeEvidence(input: Readonly<{
    admissionRaw: string;
    receipt: B1SchedulerStartReceipt;
    heartbeats: readonly B1SupervisorHeartbeatObservation[];
    soakStartedAt: string;
    soakEndedAt: string;
    scenarioMaterial: unknown;
  }>): Promise<B1FinalizedSoakEvidence> {
    const declaration = declarationFromGenuineMaterial(
      input.admissionRaw,
      input.receipt,
      input.soakStartedAt,
      input.soakEndedAt,
      input.scenarioMaterial,
    );
    const unsigned: ImmutableRunDeclaration = Object.freeze({
      value: declaration,
      contentSha256: digestHex(JSON.stringify(declaration)),
      trustRootId: 'UNSIGNED-PRODUCTION-COLLECTION',
      trustRootSha256: '',
      rawCaptureDigests: Object.freeze({
        scheduler: '', workerLogs: '', database: '', signet: '', cloudRun: '', supervisor: '',
      }) as RawCaptureDigests,
    });
    const collectors = new KnownSourceCollectorsAdapter(
      this.dependencies.evidenceTransport,
      this.dependencies.liveEvidenceEnv,
    );
    const collected = await collectLiveRawSources(
      unsigned,
      collectors,
      this.dependencies.liveEvidenceEnv,
    );
    if (collected.mode !== 'captured') {
      throw new Error('RIG-B1 six-source live evidence collection is not explicitly enabled.');
    }
    const validated = validateUnsignedLiveEvidenceForSigning(declaration, collected.raw);
    return Object.freeze({
      declaration: validated.declaration,
      declarationSha256: validated.declarationSha256,
      raw: collected.raw,
      rawCaptureDigests: validated.rawCaptureDigests,
    });
  }

  async pauseAndVerifyAllSix(): Promise<void> {
    await Promise.all(B1_SCHEDULER_START_CONTRACT.jobs.map((spec) => (
      this.dependencies.scheduler.pauseJob(
        `${B1_SCHEDULER_START_CONTRACT.workerService}-${spec.suffix}`,
      )
    )));
    const observed = await Promise.all(B1_SCHEDULER_START_CONTRACT.jobs.map((spec) => (
      this.dependencies.scheduler.observeJob(spec)
    )));
    observed.forEach((job, index) => {
      const started = this.context.receipt.scheduler.jobs[index];
      if (started === undefined) throw new Error('RIG-B1 start receipt omits a Scheduler job.');
      assertJobMatchesStartedReceipt(job, started, 'PAUSED');
    });
  }

  canonicalTeardown(context: B1SupervisorContext): Promise<void> {
    const script = fileURLToPath(new URL('./teardown-isolated-rig.sh', import.meta.url));
    return this.dependencies.process.run({
      binary: '/bin/bash',
      args: [
        script,
        '--project-ref', this.admission.supabase_project_ref,
        '--service', B1_SCHEDULER_START_CONTRACT.workerService,
        '--rig-name', B1_SCHEDULER_START_CONTRACT.rigName,
        '--rig-id', B1_SCHEDULER_START_CONTRACT.rigId,
        '--b1-approval-artifact', context.provisionApprovalArtifactPath,
        '--gcp-project', B1_SCHEDULER_START_CONTRACT.gcpProjectId,
        '--gcp-region', B1_SCHEDULER_START_CONTRACT.gcpRegion,
        '--apply',
      ],
      env: { ...process.env, CONFIRM_TEARDOWN: this.admission.supabase_project_ref },
    });
  }
}

function productionDependencies(): B1SoakSupervisorProductionDependencies {
  return {
    scheduler: createB1SchedulerStartProductionAdapter(),
    scenario: createS33B1Wave3LiveScenarioProductionPort(),
    evidenceTransport: createS33B1Wave3KnownSourceTransport(),
    process: new NodeSupervisorProcessRunner(),
    now: () => new Date(),
    sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
    }),
    liveEvidenceEnv: {
      ARKOVA_LIVE_EVIDENCE_EXECUTION: process.env.ARKOVA_LIVE_EVIDENCE_EXECUTION,
      ARKOVA_LIVE_EVIDENCE_SOAK_ID: process.env.ARKOVA_LIVE_EVIDENCE_SOAK_ID,
    },
  };
}

export function createB1SoakSupervisorProductionAdapter(
  context: B1SupervisorContext,
): B1SoakSupervisorPort {
  return new ProductionB1SoakSupervisorAdapter(context, productionDependencies());
}

/** Test-only factory; production dependencies are otherwise fixed. */
export function createB1SoakSupervisorProductionAdapterForTest(
  context: B1SupervisorContext,
  dependencies: B1SoakSupervisorProductionDependencies,
): B1SoakSupervisorPort {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected B1 supervisor dependencies are test-only.');
  return new ProductionB1SoakSupervisorAdapter(context, dependencies);
}

export { LIVE_EVIDENCE_ENABLE_VALUE };
