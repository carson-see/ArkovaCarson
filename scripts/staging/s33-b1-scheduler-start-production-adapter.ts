/** Production Cloud Scheduler/GCS adapter for the counted RIG-B1 start. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import {
  B1_SCHEDULER_START_CONTRACT,
  type B1LockedObject,
  type B1ActivationObservation,
  type B1SchedulerJobObservation,
  type B1SchedulerStartPort,
} from './s33-b1-scheduler-start-driver';

export const B1_GCLOUD_BINARY = '/opt/homebrew/bin/gcloud';
export const B1_GCLOUD_PYTHON = '/opt/homebrew/bin/python3';
const TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface B1CommandResult {
  readonly status: 'ok' | 'not-found' | 'error';
  readonly stdout: string;
}

export interface B1CommandRunner {
  run(binary: string, args: readonly string[]): Promise<B1CommandResult>;
}

export interface B1SchedulerProductionDependencies {
  readonly command: B1CommandRunner;
  readonly now: () => Date;
  readonly makeTempDir: () => Promise<string>;
  readonly writePrivateFile: (path: string, raw: string) => Promise<void>;
  readonly removeTempDir: (path: string) => Promise<void>;
  readonly fetchHealth: (url: string, identityToken: string) => Promise<Readonly<{
    status: number;
    body: string;
  }>>;
}

const metadataSchema = z.object({
  bucket: z.literal('arkova1-s33-immutable-authority-ledger'),
  name: z.string().min(1),
  generation: z.union([z.string(), z.number()]).transform(String)
    .pipe(z.string().regex(/^[1-9][0-9]*$/u)),
  retention: z.object({
    mode: z.literal('Locked'),
    retainUntilTime: z.string().datetime({ offset: true }),
  }).passthrough(),
}).passthrough();

const schedulerSchema = z.object({
  name: z.string().min(1),
  state: z.enum(['PAUSED', 'ENABLED']),
  schedule: z.string().min(1),
  timeZone: z.string().min(1),
  attemptDeadline: z.string().min(1),
  retryConfig: z.object({
    minBackoffDuration: z.string().min(1),
    maxBackoffDuration: z.string().min(1),
    maxDoublings: z.number().int().nonnegative(),
  }).passthrough(),
  httpTarget: z.object({
    uri: z.string().url(),
    httpMethod: z.literal('POST'),
    headers: z.record(z.string(), z.string()),
    oidcToken: z.object({
      serviceAccountEmail: z.string().email(),
      audience: z.string().url(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const iamPolicySchema = z.object({
  version: z.number().int().optional(),
  etag: z.string().min(1),
  bindings: z.array(z.object({
    role: z.string().min(1),
    members: z.array(z.string().min(1)),
    condition: z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      expression: z.string().min(1),
    }).strict().optional(),
  }).strict()),
}).passthrough();

const revisionSchema = z.object({
  metadata: z.object({ labels: z.record(z.string(), z.string()) }).passthrough(),
  spec: z.object({
    serviceAccountName: z.string().email(),
    containers: z.array(z.object({ image: z.string().min(1) }).passthrough()).length(1),
  }).passthrough(),
  status: z.object({ imageDigest: z.string().min(1) }).passthrough(),
}).passthrough();

const serviceSchema = z.object({
  status: z.object({
    url: z.string().url(),
    latestReadyRevisionName: z.string().min(1),
    traffic: z.array(z.object({
      revisionName: z.string().min(1),
      percent: z.number().int().min(0).max(100),
    }).passthrough()).length(1),
  }).passthrough(),
}).passthrough();

const healthSchema = z.object({
  status: z.literal('healthy'),
  git_sha: z.string().regex(/^[0-9a-f]{40}$/u),
}).passthrough();

function parseStrict<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  const result = schema.safeParse(parseJsonRejectingDuplicateKeys(raw, label));
  if (!result.success) throw new Error(`${label} did not match the exact production schema.`);
  return result.data;
}

function exactNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('RIG-B1 production adapter observed an invalid current time.');
  }
  return value;
}

function requireOk(result: B1CommandResult, label: string): string {
  if (result.status !== 'ok') throw new Error(`${label} failed.`);
  return result.stdout;
}

export function b1CommandEnvironment(
  binary: string,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return binary === B1_GCLOUD_BINARY
    ? { ...ambient, CLOUDSDK_PYTHON: B1_GCLOUD_PYTHON }
    : ambient;
}

class NodeB1CommandRunner implements B1CommandRunner {
  async run(binary: string, args: readonly string[]): Promise<B1CommandResult> {
    return new Promise((resolve) => {
      execFile(binary, [...args], {
        encoding: 'utf8',
        shell: false,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: b1CommandEnvironment(binary),
      }, (error, stdout, stderr) => {
        if (!error) return resolve({ status: 'ok', stdout });
        const notFound = /(?:not found|no urls matched|404)/iu.test(stderr);
        resolve({ status: notFound ? 'not-found' : 'error', stdout: '' });
      });
    });
  }
}

class ProductionB1SchedulerStartAdapter implements B1SchedulerStartPort {
  constructor(private readonly dependencies: B1SchedulerProductionDependencies) {}

  now(): Date { return exactNow(this.dependencies.now); }

  private async describeObject(uri: string): Promise<B1CommandResult> {
    return this.dependencies.command.run(B1_GCLOUD_BINARY, [
      'storage', 'objects', 'describe', uri,
      `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`, '--raw', '--format=json',
    ]);
  }

  async hasStartReceipt(uri: string): Promise<boolean> {
    const result = await this.describeObject(uri);
    if (result.status === 'not-found') return false;
    if (result.status !== 'ok') throw new Error('RIG-B1 start-receipt replay check failed.');
    parseStrict(metadataSchema, result.stdout, 'RIG-B1 start-receipt metadata');
    return true;
  }

  async readLockedObject(uri: string, expectedGeneration?: string): Promise<B1LockedObject> {
    const metadata = parseStrict(
      metadataSchema,
      requireOk(await this.describeObject(uri), `Locked object metadata observation for ${uri}`),
      `Locked object metadata for ${uri}`,
    );
    if (expectedGeneration !== undefined && metadata.generation !== expectedGeneration) {
      throw new Error(`Locked object ${uri} generation differs from admission.`);
    }
    const raw = requireOk(await this.dependencies.command.run(B1_GCLOUD_BINARY, [
      'storage', 'cat', `${uri}#${metadata.generation}`,
      `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
    ]), `Locked object generation readback for ${uri}`);
    return {
      uri,
      generation: metadata.generation,
      retainUntilTime: metadata.retention.retainUntilTime,
      raw: raw.endsWith('\n') ? raw.slice(0, -1) : raw,
    };
  }

  async observeJob(
    spec: typeof B1_SCHEDULER_START_CONTRACT.jobs[number],
  ): Promise<B1SchedulerJobObservation> {
    const shortName = `${B1_SCHEDULER_START_CONTRACT.workerService}-${spec.suffix}`;
    const observed = parseStrict(
      schedulerSchema,
      requireOk(await this.dependencies.command.run(B1_GCLOUD_BINARY, [
        'scheduler', 'jobs', 'describe', shortName,
        `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
        `--location=${B1_SCHEDULER_START_CONTRACT.gcpRegion}`,
        '--format=json',
      ]), `Scheduler observation for ${shortName}`),
      `Scheduler observation for ${shortName}`,
    );
    const target = new URL(observed.httpTarget.uri);
    const audience = new URL(observed.httpTarget.oidcToken.audience);
    const cronHeaderPresent = Object.keys(observed.httpTarget.headers)
      .some((name) => name.toLowerCase() === 'x-cron-secret');
    const cronHeader = Object.entries(observed.httpTarget.headers)
      .find(([name]) => name.toLowerCase() === 'x-cron-secret')?.[1];
    if (cronHeader === undefined || cronHeader.length === 0) {
      throw new Error(`Scheduler observation for ${shortName} lacks the exact cron header value.`);
    }
    return {
      name: shortName,
      resourceName: observed.name,
      state: observed.state,
      path: `${target.pathname}${target.search}`,
      uri: target.toString(),
      schedule: observed.schedule,
      timeZone: observed.timeZone,
      attemptDeadline: observed.attemptDeadline,
      retry: {
        minBackoff: observed.retryConfig.minBackoffDuration,
        maxBackoff: observed.retryConfig.maxBackoffDuration,
        maxDoublings: observed.retryConfig.maxDoublings,
      },
      httpMethod: observed.httpTarget.httpMethod,
      oidcServiceAccountEmail: observed.httpTarget.oidcToken.serviceAccountEmail,
      oidcAudience: audience.toString().replace(/\/$/u, ''),
      cronHeaderPresent,
      cronHeaderSha256: `sha256:${createHash('sha256').update(cronHeader).digest('hex')}`,
      observedAt: this.now().toISOString(),
    };
  }

  async readSecretSha256(secretName: string, version: string): Promise<string> {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,254}$/u.test(secretName)
      || !/^[1-9][0-9]*$/u.test(version)) {
      throw new Error('RIG-B1 CRON_SECRET access requires an exact name and numeric version.');
    }
    const value = requireOk(await this.dependencies.command.run(B1_GCLOUD_BINARY, [
      'secrets', 'versions', 'access', version,
      `--secret=${secretName}`,
      `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
    ]), 'RIG-B1 exact numeric CRON_SECRET access');
    if (value.length === 0) throw new Error('RIG-B1 exact numeric CRON_SECRET is empty.');
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  }

  async observeActivation(expected: Readonly<{
    workerRevision: string;
    sourceHeadSha: string;
    imageDigest: string;
    runtimeServiceAccount: string;
    serviceUrl: string;
  }>): Promise<B1ActivationObservation> {
    const [serviceRaw, revisionRaw, token] = await Promise.all([
      this.dependencies.command.run(B1_GCLOUD_BINARY, [
        'run', 'services', 'describe', B1_SCHEDULER_START_CONTRACT.workerService,
        `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
        `--region=${B1_SCHEDULER_START_CONTRACT.gcpRegion}`,
        '--format=json',
      ]).then((result) => requireOk(result, 'RIG-B1 activation service observation')),
      this.dependencies.command.run(B1_GCLOUD_BINARY, [
        'run', 'revisions', 'describe', expected.workerRevision,
        `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
        `--region=${B1_SCHEDULER_START_CONTRACT.gcpRegion}`,
        '--format=json',
      ]).then((result) => requireOk(result, 'RIG-B1 activation revision observation')),
      this.dependencies.command.run(B1_GCLOUD_BINARY, [
        'auth', 'print-identity-token',
        `--impersonate-service-account=${B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount}`,
        `--audiences=${expected.serviceUrl}`,
        '--include-email',
      ]).then((result) => requireOk(result, 'RIG-B1 activation identity token').trim()),
    ]);
    const service = parseStrict(serviceSchema, serviceRaw, 'RIG-B1 activation service');
    const revision = parseStrict(revisionSchema, revisionRaw, 'RIG-B1 activation revision');
    const traffic = service.status.traffic[0]!;
    const digest = revision.status.imageDigest.includes('@')
      ? revision.status.imageDigest.slice(revision.status.imageDigest.lastIndexOf('@') + 1)
      : revision.status.imageDigest;
    if (service.status.url !== expected.serviceUrl
      || service.status.latestReadyRevisionName !== expected.workerRevision
      || traffic.revisionName !== expected.workerRevision
      || traffic.percent !== 100
      || revision.metadata.labels['arkova-source-head'] !== expected.sourceHeadSha
      || digest !== expected.imageDigest
      || revision.spec.serviceAccountName !== expected.runtimeServiceAccount) {
      throw new Error('RIG-B1 activation service/revision is not the exact admitted 100% traffic target.');
    }
    if (token.length === 0) throw new Error('RIG-B1 activation identity token is empty.');
    const health = await this.dependencies.fetchHealth(`${expected.serviceUrl}/health`, token);
    const body = parseStrict(healthSchema, health.body, 'RIG-B1 authenticated activation health');
    if (health.status !== 200 || body.git_sha !== expected.sourceHeadSha) {
      throw new Error('RIG-B1 authenticated activation health is not exact and healthy.');
    }
    return {
      observedAt: this.now().toISOString(),
      workerRevision: expected.workerRevision,
      sourceHeadSha: revision.metadata.labels['arkova-source-head']!,
      imageDigest: digest,
      runtimeServiceAccount: revision.spec.serviceAccountName,
      serviceUrl: service.status.url,
      healthStatusCode: 200,
      healthStatus: body.status,
      healthGitSha: body.git_sha,
    };
  }

  private invocationLeaseTitle(approvalId: string): string {
    this.assertApprovalId(approvalId);
    return `arkova-s33-b1-${createHash('sha256').update(approvalId).digest('hex').slice(0, 20)}`;
  }

  private assertApprovalId(approvalId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u.test(approvalId)) {
      throw new Error('RIG-B1 invocation lease approval id is invalid.');
    }
  }

  private async readIamPolicy(): Promise<z.infer<typeof iamPolicySchema>> {
    return parseStrict(iamPolicySchema, requireOk(await this.dependencies.command.run(
      B1_GCLOUD_BINARY,
      [
        'run', 'services', 'get-iam-policy', B1_SCHEDULER_START_CONTRACT.workerService,
        `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
        `--region=${B1_SCHEDULER_START_CONTRACT.gcpRegion}`,
        '--format=json',
      ],
    ), 'RIG-B1 service IAM policy observation'), 'RIG-B1 service IAM policy');
  }

  private async writeIamPolicy(policy: z.infer<typeof iamPolicySchema>): Promise<void> {
    const directory = await this.dependencies.makeTempDir();
    const path = join(directory, 'rig-b1-service-iam-policy.json');
    try {
      await this.dependencies.writePrivateFile(path, JSON.stringify(policy));
      requireOk(await this.dependencies.command.run(B1_GCLOUD_BINARY, [
        'run', 'services', 'set-iam-policy', B1_SCHEDULER_START_CONTRACT.workerService, path,
        `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
        `--region=${B1_SCHEDULER_START_CONTRACT.gcpRegion}`,
        '--quiet', '--format=json',
      ]), 'RIG-B1 etag-guarded service IAM policy update');
    } finally {
      await this.dependencies.removeTempDir(directory);
    }
  }

  async installInvocationLease(input: Readonly<{
    approvalId: string;
    expiresAt: string;
    authorityExpiresAt: string;
  }>): Promise<void> {
    const now = this.now().getTime();
    const expiry = Date.parse(input.expiresAt);
    const authorityExpiry = Date.parse(input.authorityExpiresAt);
    if (!Number.isFinite(expiry) || !Number.isFinite(authorityExpiry)
      || expiry <= now || expiry > now + 10 * 60_000 || expiry > authorityExpiry) {
      throw new Error('RIG-B1 invocation lease must be future, <=10 minutes, and within signed authority.');
    }
    const policy = await this.readIamPolicy();
    const member = `serviceAccount:${B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount}`;
    const title = this.invocationLeaseTitle(input.approvalId);
    if (policy.bindings.some((binding) => (
      binding.role === 'roles/run.invoker'
      && binding.members.includes(member)
      && binding.condition?.title !== title
    ))) {
      throw new Error('RIG-B1 Scheduler principal already has a non-controller Run Invoker binding.');
    }
    const expression = `request.time < timestamp("${input.expiresAt}")`;
    const retained = policy.bindings.filter((binding) => !(
      binding.role === 'roles/run.invoker'
      && binding.condition?.title === title
      && binding.members.includes(member)
    ));
    const updated = iamPolicySchema.parse({
      ...policy,
      version: 3,
      bindings: [...retained, {
        role: 'roles/run.invoker',
        members: [member],
        condition: {
          title,
          description: `RIG-B1 controller lease ${input.approvalId}`,
          expression,
        },
      }],
    });
    await this.writeIamPolicy(updated);
    const observed = await this.readIamPolicy();
    const schedulerBindings = observed.bindings.filter((binding) => (
      binding.role === 'roles/run.invoker'
      && binding.members.includes(member)
    ));
    if (schedulerBindings.length !== 1
      || schedulerBindings[0].members.length !== 1
      || schedulerBindings[0].members[0] !== member
      || schedulerBindings[0].condition?.title !== title
      || schedulerBindings[0].condition.expression !== expression) {
      throw new Error('RIG-B1 conditional Run Invoker lease readback is not the principal\'s only exact binding.');
    }
  }

  async removeInvocationLease(approvalId: string): Promise<void> {
    this.assertApprovalId(approvalId);
    const policy = await this.readIamPolicy();
    const member = `serviceAccount:${B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount}`;
    let changed = false;
    const bindings = policy.bindings.flatMap((binding) => {
      if (binding.role !== 'roles/run.invoker' || !binding.members.includes(member)) return [binding];
      changed = true;
      const members = binding.members.filter((candidate) => candidate !== member);
      return members.length === 0 ? [] : [{ ...binding, members }];
    });
    if (changed) {
      await this.writeIamPolicy(iamPolicySchema.parse({ ...policy, bindings }));
    }
    const observed = await this.readIamPolicy();
    if (observed.bindings.some((binding) => (
      binding.role === 'roles/run.invoker'
      && binding.members.includes(member)
    ))) throw new Error('RIG-B1 Scheduler principal retains Run Invoker after removal.');
  }

  async observeInvocationLeaseAbsent(approvalId: string): Promise<boolean> {
    this.assertApprovalId(approvalId);
    const policy = await this.readIamPolicy();
    const member = `serviceAccount:${B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount}`;
    return !policy.bindings.some((binding) => (
      binding.role === 'roles/run.invoker' && binding.members.includes(member)
    ));
  }

  private async schedulerStateCommand(action: 'pause' | 'resume', name: string): Promise<void> {
    requireOk(await this.dependencies.command.run(B1_GCLOUD_BINARY, [
      'scheduler', 'jobs', action, name,
      `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
      `--location=${B1_SCHEDULER_START_CONTRACT.gcpRegion}`,
      '--quiet',
    ]), `Scheduler ${action} for ${name}`);
  }

  pauseJob(name: string): Promise<void> { return this.schedulerStateCommand('pause', name); }
  resumeJob(name: string): Promise<void> { return this.schedulerStateCommand('resume', name); }

  async persistStartReceipt(uri: string, raw: string, retainUntilTime: string): Promise<void> {
    const directory = await this.dependencies.makeTempDir();
    const path = join(directory, 'rig-b1-start-receipt.json');
    try {
      await this.dependencies.writePrivateFile(path, raw);
      requireOk(await this.dependencies.command.run(B1_GCLOUD_BINARY, [
        'storage', 'cp', path, uri,
        `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
        '--if-generation-match=0', '--content-type=application/json',
        `--retain-until=${retainUntilTime}`, '--retention-mode=Locked', '--quiet',
      ]), 'RIG-B1 generation-zero locked start-receipt persistence');
    } finally {
      await this.dependencies.removeTempDir(directory);
    }
  }
}

function productionDependencies(): B1SchedulerProductionDependencies {
  return {
    command: new NodeB1CommandRunner(),
    now: () => new Date(),
    makeTempDir: () => mkdtemp(join(tmpdir(), 'arkova-b1-start-')),
    writePrivateFile: (path, raw) => writeFile(path, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    removeTempDir: (path) => rm(path, { recursive: true, force: true }),
    fetchHealth: async (url, identityToken) => {
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${identityToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: await response.text() };
    },
  };
}

export function createB1SchedulerStartProductionAdapter(): B1SchedulerStartPort {
  return new ProductionB1SchedulerStartAdapter(productionDependencies());
}

/** Test-only dependency seam; production callers always use pinned binaries. */
export function createB1SchedulerStartProductionAdapterForTest(
  dependencies: B1SchedulerProductionDependencies,
): B1SchedulerStartPort {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected B1 Scheduler dependencies are test-only.');
  return new ProductionB1SchedulerStartAdapter(dependencies);
}
