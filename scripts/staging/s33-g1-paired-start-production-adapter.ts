/** Production-only live adapter for the S3.3 RIG-G1 paired-start controller. */

import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { runAiSoakHarness, type AiSoakHarnessRunOptions } from './ai-soak-harness';
import { buildTemplatePayload } from './ai-eval/harness-core';
import { allGoldenEntries } from './ai-eval/golden';
import { parseDocVariants } from './ai-eval/corpus';
import type { WorkerIdentity } from './ai-eval/ai-client';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import {
  G1_PAIRED_START_CONTRACT,
  type S33G1AdmissionArm,
  type S33G1ArmPreparationRequest,
  type S33G1ArmStartObservation,
  type S33G1ArmStartRequest,
  type S33G1ObservedArm,
  type S33G1PairedStartPort,
  type S33G1PairedStartReceipt,
  type S33G1PreclockReadiness,
} from './s33-g1-paired-start-driver';

const GCLOUD_BINARY = '/opt/homebrew/bin/gcloud';
export const G1_GCLOUD_PYTHON = '/opt/homebrew/bin/python3';
const GIT_BINARY = '/usr/bin/git';
const moduleUrl = new URL(import.meta.url);
const SUPABASE_CLI_SCRIPT = moduleUrl.protocol === 'file:'
  ? fileURLToPath(new URL('../../node_modules/supabase/dist/supabase.js', moduleUrl))
  : resolve(process.cwd(), 'node_modules/supabase/dist/supabase.js');
const REGION = 'us-central1';
const PROJECT_ID = G1_PAIRED_START_CONTRACT.gcpProjectId;
const RECEIPT_BUCKET = 'arkova1-s33-immutable-authority-ledger';
const SESSION_POOL_SIZE = 4;
const SESSION_REFRESH_INTERVAL_MS = 45 * 60_000;
export const G1_WORKER_UPTIME_MIN = 720;
export const G1_WALL_MIN = 750;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const TEMPLATE_ROUTE = '/api/v1/ai/template';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const uuid = z.string().uuid();
const projectRef = z.string().regex(/^[a-z]{20}$/u);

const projectsSchema = z.array(z.object({
  id: projectRef,
  name: z.string().min(1),
}).passthrough());

const apiKeysSchema = z.array(z.object({
  name: z.string().min(1),
  api_key: z.string().min(1),
}).passthrough());

const serviceSchema = z.object({
  metadata: z.object({ name: z.string().min(1) }).passthrough(),
  status: z.object({
    latestReadyRevisionName: z.string().min(1),
    url: z.string().url(),
  }).passthrough(),
}).passthrough();

const revisionSchema = z.object({
  metadata: z.object({
    name: z.string().min(1).optional(),
    labels: z.record(z.string(), z.string()),
  }).passthrough(),
  spec: z.object({
    serviceAccountName: z.string().email(),
    containers: z.array(z.object({ image: z.string().min(1) }).passthrough()).length(1),
  }).passthrough(),
  status: z.object({ imageDigest: z.string().min(1) }).passthrough(),
}).passthrough();

const serviceAccountSchema = z.object({
  email: z.string().email(),
  uniqueId: z.string().regex(/^[1-9][0-9]*$/u),
}).passthrough();

const adminUserSchema = z.union([
  z.object({ id: uuid }).passthrough(),
  z.object({ user: z.object({ id: uuid }).passthrough() }).passthrough(),
]);

const sessionSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  user: z.object({ id: uuid }).passthrough(),
}).passthrough();

const jwtClaimsSchema = z.object({
  sub: uuid,
  iss: z.string().url(),
  exp: z.number().int().positive(),
}).passthrough();

const receiptMetadataSchema = z.object({
  bucket: z.literal(RECEIPT_BUCKET),
  name: z.string().min(1),
  generation: z.union([z.string(), z.number()]).transform(String)
    .pipe(z.string().regex(/^[1-9][0-9]*$/u)),
  retention: z.object({
    mode: z.literal('Locked'),
    retainUntilTime: z.string().datetime({ offset: true }),
  }).passthrough(),
}).passthrough();

const harnessSummarySchema = z.object({
  durationSec: z.number().finite().min(G1_WORKER_UPTIME_MIN * 60),
}).passthrough();

export interface S33G1CommandResult {
  readonly status: 'ok' | 'not-found' | 'error';
  readonly stdout: string;
}

export interface S33G1CommandRunner {
  run(binary: string, args: readonly string[]): Promise<S33G1CommandResult>;
}

export interface S33G1ProductionAdapterDependencies {
  readonly command: S33G1CommandRunner;
  readonly fetch: typeof fetch;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly randomSecret: () => string;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly runHarness: (options: AiSoakHarnessRunOptions) => Promise<unknown>;
  readonly reportBackgroundFailure: (rigId: string, error: unknown) => void;
}

interface PreparedIdentity {
  readonly userId: string;
  readonly label: string;
  readonly initialSessionEstablishedAt: string;
  refreshRotationVerifiedAt: string;
  refreshToken: string;
  readonly workerIdentity: WorkerIdentity;
}

interface PreparedArm {
  readonly request: S33G1ArmPreparationRequest;
  readonly supabaseUrl: string;
  readonly publicKey: string;
  readonly serviceRoleKey: string;
  readonly identities: PreparedIdentity[];
}

interface RunningArm {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

function parseStrict<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  const result = schema.safeParse(parseJsonRejectingDuplicateKeys(raw, label));
  if (!result.success) throw new Error(`${label} did not match its strict production schema.`);
  return result.data;
}

function requireOk(result: S33G1CommandResult, label: string): string {
  if (result.status !== 'ok') throw new Error(`${label} failed.`);
  return result.stdout;
}

function exactNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('RIG-G1 production adapter observed an invalid current time.');
  }
  return value;
}

function imageDigestFromReference(value: string): string {
  const marker = value.lastIndexOf('@sha256:');
  const digest = marker >= 0 ? value.slice(marker + 1) : value;
  if (!sha256.safeParse(digest).success) {
    throw new Error('Cloud Run revision did not expose one immutable image digest.');
  }
  return digest;
}

function parseJwtClaims(token: string, expectedUserId: string, supabaseUrl: string, now: Date): void {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) throw new Error('Supabase returned a malformed access token.');
  let claims: z.infer<typeof jwtClaimsSchema>;
  try {
    claims = jwtClaimsSchema.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    throw new Error('Supabase returned an access token with invalid claims.');
  }
  const expectedIssuer = `${supabaseUrl.replace(/\/$/u, '')}/auth/v1`;
  if (claims.sub !== expectedUserId || claims.iss !== expectedIssuer
    || claims.exp * 1000 <= now.getTime()) {
    throw new Error('Supabase access token is not bound to the exact ephemeral user/project or is expired.');
  }
}

function userIdFromAdminResponse(value: z.infer<typeof adminUserSchema>): string {
  if ('id' in value && typeof value.id === 'string') return value.id;
  return (value as { user: { id: string } }).user.id;
}

function receiptObject(receiptId: string): { uri: string; name: string } {
  const digest = createHash('sha256').update(receiptId, 'utf8').digest('hex');
  const name = `s33/g1/paired-start-receipts/${digest}.json`;
  return { name, uri: `gs://${RECEIPT_BUCKET}/${name}` };
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function g1CommandEnvironment(
  binary: string,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return binary === GCLOUD_BINARY
    ? { ...ambient, CLOUDSDK_PYTHON: G1_GCLOUD_PYTHON }
    : ambient;
}

class NodeCommandRunner implements S33G1CommandRunner {
  async run(binary: string, args: readonly string[]): Promise<S33G1CommandResult> {
    return new Promise((resolve) => {
      execFile(binary, [...args], {
        encoding: 'utf8',
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        env: g1CommandEnvironment(binary),
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ status: 'ok', stdout });
          return;
        }
        const missing = /(?:not found|no urls matched|404)/iu.test(stderr);
        resolve({ status: missing ? 'not-found' : 'error', stdout: '' });
      });
    });
  }
}

class S33G1ProductionPairedStartAdapter implements S33G1PairedStartPort {
  private readonly prepared = new Map<S33G1AdmissionArm['rig_id'], PreparedArm>();
  private readonly running = new Map<S33G1AdmissionArm['rig_id'], RunningArm>();
  private readonly receiptGenerations = new Map<string, string>();
  private approvalExpiresAt: string | undefined;

  constructor(private readonly dependencies: S33G1ProductionAdapterDependencies) {}

  now(): Date { return exactNow(this.dependencies.now); }

  async resolveCandidateTreeSha(headSha: string): Promise<string> {
    if (!gitSha.safeParse(headSha).success) throw new Error('Candidate HEAD is not an immutable Git SHA.');
    const raw = requireOk(await this.dependencies.command.run(
      GIT_BINARY,
      ['rev-parse', `${headSha}^{tree}`],
    ), 'Exact candidate tree resolution').trim();
    if (!gitSha.safeParse(raw).success) throw new Error('Exact candidate tree resolution returned no tree SHA.');
    return raw;
  }

  async observeArm(arm: S33G1AdmissionArm): Promise<S33G1ObservedArm> {
    const projects = parseStrict(projectsSchema, requireOk(await this.dependencies.command.run(
      process.execPath,
      [SUPABASE_CLI_SCRIPT, 'projects', 'list', '--output', 'json'],
    ), 'Supabase project observation'), 'Supabase project observation');
    if (projects.filter((project) => project.id === arm.supabase_project_ref
      && project.name === arm.supabase_project_name).length !== 1) {
      throw new Error(`${arm.rig_id} exact Supabase project binding was not observed once.`);
    }

    const service = parseStrict(serviceSchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['run', 'services', 'describe', arm.service, '--project', PROJECT_ID, '--region', REGION, '--format=json'],
    ), 'Cloud Run service observation'), 'Cloud Run service observation');
    if (service.metadata.name !== arm.service || service.status.latestReadyRevisionName !== arm.revision
      || service.status.url !== arm.url) {
      throw new Error(`${arm.rig_id} Cloud Run service/revision/URL differs from admission.`);
    }

    const revision = parseStrict(revisionSchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['run', 'revisions', 'describe', arm.revision, '--project', PROJECT_ID, '--region', REGION, '--format=json'],
    ), 'Cloud Run revision observation'), 'Cloud Run revision observation');
    const imageDigest = imageDigestFromReference(revision.status.imageDigest);
    const sourceHeadSha = revision.metadata.labels['arkova-source-head'];
    if (revision.spec.serviceAccountName !== arm.runtime_service_account
      || sourceHeadSha === undefined || !gitSha.safeParse(sourceHeadSha).success) {
      throw new Error(`${arm.rig_id} revision provenance/runtime binding is invalid.`);
    }

    const runtime = parseStrict(serviceAccountSchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['iam', 'service-accounts', 'describe', arm.runtime_service_account, '--project', PROJECT_ID, '--format=json'],
    ), 'Runtime service-account observation'), 'Runtime service-account observation');
    if (runtime.email !== arm.runtime_service_account
      || runtime.uniqueId !== arm.runtime_service_account_unique_id) {
      throw new Error(`${arm.rig_id} runtime identity unique ID differs from admission.`);
    }

    const cleanMirrorBytes = await this.dependencies.readFile(arm.clean_mirror.artifact);
    const cleanMirrorAttestationId = `sha256:${createHash('sha256').update(cleanMirrorBytes).digest('hex')}`;
    if (cleanMirrorAttestationId !== arm.clean_mirror.attestation_id) {
      throw new Error(`${arm.rig_id} clean-mirror artifact bytes differ from admission.`);
    }

    return {
      rigId: arm.rig_id,
      supabaseProjectName: arm.supabase_project_name,
      supabaseProjectRef: arm.supabase_project_ref,
      service: arm.service,
      runtimeServiceAccount: runtime.email,
      runtimeServiceAccountUniqueId: runtime.uniqueId,
      revision: service.status.latestReadyRevisionName,
      url: service.status.url,
      imageDigest,
      sourceHeadSha,
      cleanMirrorAttestationId,
      runId: arm.run_id,
      queue: arm.queue,
    };
  }

  private async projectKeys(ref: string): Promise<{ publicKey: string; serviceRoleKey: string }> {
    const values = parseStrict(apiKeysSchema, requireOk(await this.dependencies.command.run(
      process.execPath,
      [SUPABASE_CLI_SCRIPT, 'projects', 'api-keys', '--project-ref', ref, '--output', 'json'],
    ), 'Supabase project-key retrieval'), 'Supabase project-key retrieval');
    const publicKey = values.find(({ name }) => name === 'anon' || name === 'publishable')?.api_key;
    const serviceRoleKey = values.find(({ name }) => name === 'service_role' || name === 'secret')?.api_key;
    if (publicKey === undefined || serviceRoleKey === undefined || publicKey === serviceRoleKey) {
      throw new Error('Supabase did not return distinct public and service-role keys for the exact project.');
    }
    return { publicKey, serviceRoleKey };
  }

  private async authJson<T>(
    schema: z.ZodType<T>,
    url: string,
    init: RequestInit,
    expectedStatus: number,
    label: string,
  ): Promise<T> {
    const response = await this.dependencies.fetch(url, init);
    const raw = await response.text();
    if (response.status !== expectedStatus) throw new Error(`${label} returned HTTP ${response.status}.`);
    return parseStrict(schema, raw, label);
  }

  private async createIdentity(
    request: S33G1ArmPreparationRequest,
    index: number,
    supabaseUrl: string,
    publicKey: string,
    serviceRoleKey: string,
  ): Promise<PreparedIdentity> {
    const label = `${request.arm.rig_id.toLowerCase()}-user-${index + 1}`;
    const email = `arkova-s33-g1-${request.arm.rig_id.toLowerCase()}-${this.dependencies.randomId()}@example.invalid`;
    const password = this.dependencies.randomSecret();
    const commonHeaders = { 'Content-Type': 'application/json', apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
    const created = await this.authJson(
      adminUserSchema,
      `${supabaseUrl}/auth/v1/admin/users`,
      { method: 'POST', headers: commonHeaders, body: JSON.stringify({ email, password, email_confirm: true }) },
      200,
      `${request.arm.rig_id} ephemeral-user creation`,
    );
    const userId = userIdFromAdminResponse(created);
    try {
      const initial = await this.authJson(
        sessionSchema,
        `${supabaseUrl}/auth/v1/token?grant_type=password`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: publicKey }, body: JSON.stringify({ email, password }) },
        200,
        `${request.arm.rig_id} initial session`,
      );
      const initialAt = exactNow(this.dependencies.now);
      if (initial.user.id !== userId) throw new Error(`${request.arm.rig_id} initial session changed exact user identity.`);
      parseJwtClaims(initial.access_token, userId, supabaseUrl, initialAt);

      const refreshed = await this.authJson(
        sessionSchema,
        `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: publicKey }, body: JSON.stringify({ refresh_token: initial.refresh_token }) },
        200,
        `${request.arm.rig_id} refresh rotation`,
      );
      const refreshedAt = exactNow(this.dependencies.now);
      if (refreshed.user.id !== userId) throw new Error(`${request.arm.rig_id} refresh rotation changed exact user identity.`);
      parseJwtClaims(refreshed.access_token, userId, supabaseUrl, refreshedAt);
      return {
        userId,
        label,
        initialSessionEstablishedAt: initialAt.toISOString(),
        refreshRotationVerifiedAt: refreshedAt.toISOString(),
        refreshToken: refreshed.refresh_token,
        workerIdentity: { label, jwt: refreshed.access_token },
      };
    } catch (error) {
      const response = await this.dependencies.fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      });
      if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
        throw new AggregateError(
          [error, new Error(`${request.arm.rig_id} partial-user cleanup returned HTTP ${response.status}.`)],
          `${request.arm.rig_id} session preparation and partial-user cleanup both failed.`,
        );
      }
      throw error;
    }
  }

  private async deleteUsers(state: PreparedArm): Promise<void> {
    const results = await Promise.allSettled(state.identities.map(async ({ userId }) => {
      const response = await this.dependencies.fetch(`${state.supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { apikey: state.serviceRoleKey, Authorization: `Bearer ${state.serviceRoleKey}` },
      });
      if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
        throw new Error(`${state.request.arm.rig_id} ephemeral-user cleanup returned HTTP ${response.status}.`);
      }
    }));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) throw new Error(`${state.request.arm.rig_id} could not delete every ephemeral soak user.`);
  }

  private async probeAppBoundary(state: PreparedArm): Promise<S33G1PreclockReadiness['appBoundary']> {
    const body = JSON.stringify(buildTemplatePayload(allGoldenEntries()[0]!));
    const probe = async (authorization?: string): Promise<number> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authorization !== undefined) headers.Authorization = authorization;
      const response = await this.dependencies.fetch(`${state.request.arm.url}${TEMPLATE_ROUTE}`, {
        method: 'POST', headers, body,
      });
      await response.arrayBuffer();
      return response.status;
    };
    const valid = state.identities[0]!;
    const [unauthenticatedHttpStatus, invalidBearerHttpStatus, validExactUserHttpStatus] = await Promise.all([
      probe(),
      probe('Bearer arkova-invalid-g1-preclock-token'),
      probe(`Bearer ${valid.workerIdentity.jwt}`),
    ]);
    if (unauthenticatedHttpStatus !== 401 || invalidBearerHttpStatus !== 401
      || validExactUserHttpStatus !== 200) {
      throw new Error(`${state.request.arm.rig_id} live app boundary did not prove exact 401/401/200 behavior.`);
    }
    return {
      route: TEMPLATE_ROUTE,
      cloudRunIngress: 'ALLOW_UNAUTHENTICATED_APP_AUTH_REQUIRED',
      unauthenticatedHttpStatus: 401,
      invalidBearerHttpStatus: 401,
      validExactUserHttpStatus: 200,
      validExactUserId: valid.userId,
    };
  }

  async prepareArm(request: S33G1ArmPreparationRequest): Promise<S33G1PreclockReadiness> {
    if (this.prepared.has(request.arm.rig_id) || this.running.has(request.arm.rig_id)) {
      throw new Error(`${request.arm.rig_id} session preparation is not replayable.`);
    }
    const supabaseUrl = `https://${request.arm.supabase_project_ref}.supabase.co`;
    const { publicKey, serviceRoleKey } = await this.projectKeys(request.arm.supabase_project_ref);
    const identities: PreparedIdentity[] = [];
    const state: PreparedArm = { request, supabaseUrl, publicKey, serviceRoleKey, identities };
    this.prepared.set(request.arm.rig_id, state);
    try {
      for (let index = 0; index < SESSION_POOL_SIZE; index += 1) {
        identities.push(await this.createIdentity(request, index, supabaseUrl, publicKey, serviceRoleKey));
      }
      const appBoundary = await this.probeAppBoundary(state);
      const verifiedAt = exactNow(this.dependencies.now).toISOString();
      const expiresAt = request.admission.g1.spend_approval.expiresAt;
      if (this.approvalExpiresAt !== undefined && this.approvalExpiresAt !== expiresAt) {
        throw new Error('G1 arms do not share one exact CTO approval expiration.');
      }
      this.approvalExpiresAt = expiresAt;
      return {
        status: 'PRECLOCK_AUTH_READY',
        rigId: request.arm.rig_id,
        supabaseProjectRef: request.arm.supabase_project_ref,
        service: request.arm.service,
        revision: request.arm.revision,
        url: request.arm.url,
        imageDigest: request.admission.image_digest,
        sourceHeadSha: request.admission.declared_source_head,
        runtimeServiceAccount: request.arm.runtime_service_account,
        appBoundary,
        sessionPool: {
          minimumRequired: 4,
          secretPersistence: 'NONE',
          refreshRotationCount: identities.length,
          identities: identities.map((identity) => ({
            userId: identity.userId,
            label: identity.label,
            initialSessionEstablishedAt: identity.initialSessionEstablishedAt,
            refreshRotationVerifiedAt: identity.refreshRotationVerifiedAt,
          })),
        },
        verifiedAt,
      };
    } catch (error) {
      try { await this.deleteUsers(state); } catch (cleanupError) {
        this.prepared.delete(request.arm.rig_id);
        throw new AggregateError([error, cleanupError], `${request.arm.rig_id} preparation and cleanup both failed.`);
      }
      this.prepared.delete(request.arm.rig_id);
      throw error;
    }
  }

  private async refreshIdentity(state: PreparedArm, identity: PreparedIdentity): Promise<void> {
    const refreshed = await this.authJson(
      sessionSchema,
      `${state.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: state.publicKey },
        body: JSON.stringify({ refresh_token: identity.refreshToken }),
      },
      200,
      `${state.request.arm.rig_id} scheduled refresh rotation`,
    );
    const refreshedAt = exactNow(this.dependencies.now);
    if (refreshed.user.id !== identity.userId) {
      throw new Error(`${state.request.arm.rig_id} scheduled refresh changed exact user identity.`);
    }
    parseJwtClaims(refreshed.access_token, identity.userId, state.supabaseUrl, refreshedAt);
    identity.refreshToken = refreshed.refresh_token;
    identity.workerIdentity.jwt = refreshed.access_token;
    identity.refreshRotationVerifiedAt = refreshedAt.toISOString();
  }

  private async refreshUntilStopped(state: PreparedArm, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.dependencies.sleep(SESSION_REFRESH_INTERVAL_MS, signal);
      if (signal.aborted) return;
      await Promise.all(state.identities.map((identity) => this.refreshIdentity(state, identity)));
    }
  }

  async startArm(request: S33G1ArmStartRequest): Promise<S33G1ArmStartObservation> {
    const state = this.prepared.get(request.arm.rig_id);
    if (state === undefined || state.request.arm.supabase_project_ref !== request.arm.supabase_project_ref) {
      throw new Error(`${request.arm.rig_id} has no exact prepared in-memory session pool.`);
    }
    const preparedUserIds = state.identities.map(({ userId }) => userId);
    const admittedUserIds = request.preclockReadiness.sessionPool.identities.map(({ userId }) => userId);
    if (JSON.stringify(preparedUserIds) !== JSON.stringify(admittedUserIds)
      || request.preclockReadiness.appBoundary.validExactUserId !== preparedUserIds[0]) {
      throw new Error(`${request.arm.rig_id} start readiness differs from its exact in-memory session pool.`);
    }
    const controller = new AbortController();
    const evidencePath = `docs/staging/s33-g1/${request.arm.run_id}-ai-soak.json`;
    let harnessReady = false;
    const harness = this.dependencies.runHarness({
      apiBase: request.arm.url,
      identities: state.identities.map(({ workerIdentity }) => workerIdentity),
      durationMin: G1_WORKER_UPTIME_MIN,
      ratePerHour: 5_000,
      endpoints: ['extract', 'template', 'tags'],
      variants: parseDocVariants(undefined),
      timeoutMs: 10_000,
      rotateIp: true,
      evidencePath,
      signal: controller.signal,
      onReady: () => { harnessReady = true; },
    }).then((summary) => {
      if (!controller.signal.aborted && !harnessSummarySchema.safeParse(summary).success) {
        throw new Error(`${request.arm.rig_id} harness ended before 720 worker-up minutes.`);
      }
    }).catch((error) => {
      controller.abort();
      throw error;
    });
    if (!harnessReady) {
      controller.abort();
      await harness;
      throw new Error(`${request.arm.rig_id} in-process harness returned without opening its load clock.`);
    }
    const wall = (async () => {
      await this.dependencies.sleep(G1_WALL_MIN * 60_000, controller.signal);
      if (controller.signal.aborted) return;
      await harness;
      controller.abort();
    })();
    const refresh = this.refreshUntilStopped(state, controller.signal).catch((error) => {
      controller.abort();
      throw error;
    });
    const done = Promise.all([harness, wall, refresh])
      .then(() => undefined)
      .finally(async () => {
        controller.abort();
        await this.deleteUsers(state);
        this.prepared.delete(request.arm.rig_id);
        this.running.delete(request.arm.rig_id);
      });
    this.running.set(request.arm.rig_id, { controller, done });
    void done.catch((error) => this.dependencies.reportBackgroundFailure(request.arm.rig_id, error));
    const startedAt = exactNow(this.dependencies.now).toISOString();
    return {
      rigId: request.arm.rig_id,
      runId: request.arm.run_id,
      queue: request.arm.queue,
      sessionIdentity: `ephemeral-supabase-pool:${request.arm.rig_id}:4`,
      startedAt,
      evidencePath,
      logPath: `stdout://arkova-s33-g1/${request.arm.run_id}`,
    };
  }

  async stopArm(observation: S33G1ArmStartObservation): Promise<void> {
    const running = this.running.get(observation.rigId);
    if (running === undefined) return;
    running.controller.abort();
    await running.done;
  }

  async cleanupArmPreparation(arm: S33G1AdmissionArm): Promise<void> {
    const running = this.running.get(arm.rig_id);
    if (running !== undefined) {
      running.controller.abort();
      await running.done;
      return;
    }
    const state = this.prepared.get(arm.rig_id);
    if (state === undefined) return;
    await this.deleteUsers(state);
    this.prepared.delete(arm.rig_id);
  }

  async loadStartReceipt(receiptId: string): Promise<unknown | null> {
    const { uri } = receiptObject(receiptId);
    const generation = this.receiptGenerations.get(receiptId);
    const result = await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['storage', 'cat', generation === undefined ? uri : `${uri}#${generation}`, '--project', PROJECT_ID],
    );
    if (result.status === 'not-found') return null;
    return parseJsonRejectingDuplicateKeys(requireOk(result, 'Immutable paired-start receipt load'), 'Immutable paired-start receipt');
  }

  async persistStartReceipt(receipt: S33G1PairedStartReceipt): Promise<void> {
    const expiresAt = this.approvalExpiresAt;
    if (expiresAt === undefined || Date.parse(expiresAt) <= exactNow(this.dependencies.now).getTime()) {
      throw new Error('Cannot persist a paired-start receipt without active exact CTO retention authority.');
    }
    const { uri, name } = receiptObject(receipt.receiptId);
    const directory = await mkdtemp(join(tmpdir(), 'arkova-g1-paired-start-'));
    const path = join(directory, 'receipt.json');
    try {
      await writeFile(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      requireOk(await this.dependencies.command.run(GCLOUD_BINARY, [
        'storage', 'cp', path, uri,
        '--project', PROJECT_ID,
        '--if-generation-match=0',
        '--content-type=application/json',
        `--retain-until=${expiresAt}`,
        '--retention-mode=Locked',
        '--quiet',
      ]), 'Generation-zero paired-start receipt create');
      const metadata = parseStrict(receiptMetadataSchema, requireOk(await this.dependencies.command.run(
        GCLOUD_BINARY,
        ['storage', 'objects', 'describe', uri, '--project', PROJECT_ID, '--raw', '--format=json'],
      ), 'Immutable paired-start receipt metadata'), 'Immutable paired-start receipt metadata');
      if (metadata.name !== name || Date.parse(metadata.retention.retainUntilTime) < Date.parse(expiresAt)) {
        throw new Error('Immutable paired-start receipt retention/provenance did not re-observe exactly.');
      }
      this.receiptGenerations.set(receipt.receiptId, metadata.generation);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function productionDependencies(): S33G1ProductionAdapterDependencies {
  return {
    command: new NodeCommandRunner(),
    fetch,
    readFile,
    now: () => new Date(),
    randomId: randomUUID,
    randomSecret: () => randomBytes(32).toString('base64url'),
    sleep: abortableSleep,
    runHarness: runAiSoakHarness,
    reportBackgroundFailure: (rigId, error) => {
      console.error(`::error::${rigId} in-process G1 soak failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
    },
  };
}

export function createS33G1ProductionPairedStartAdapter(): S33G1PairedStartPort {
  return new S33G1ProductionPairedStartAdapter(productionDependencies());
}

/** Test-only seam; production callers cannot substitute command/network authority. */
export function createS33G1ProductionPairedStartAdapterForTest(
  dependencies: S33G1ProductionAdapterDependencies,
): S33G1PairedStartPort {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected G1 production dependencies are test-only.');
  return new S33G1ProductionPairedStartAdapter(dependencies);
}
