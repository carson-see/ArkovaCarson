import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type { AiSoakHarnessRunOptions } from './ai-soak-harness';
import {
  G1_WALL_MIN,
  G1_WORKER_UPTIME_MIN,
  G1_GCLOUD_PYTHON,
  createS33G1ProductionPairedStartAdapterForTest,
  g1CommandEnvironment,
  type S33G1CommandResult,
  type S33G1CommandRunner,
  type S33G1ProductionAdapterDependencies,
} from './s33-g1-paired-start-production-adapter';
import type {
  S33G1AdmissionArm,
  S33G1ArmPreparationRequest,
  S33G1ArmStartRequest,
  S33G1PairedStartAdmission,
  S33G1PairedStartReceipt,
} from './s33-g1-paired-start-driver';

const nowIso = '2026-07-16T18:00:00.000Z';
const headSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const projectRef = 'abcdefghijklmnopqrst';

function arm(): S33G1AdmissionArm {
  return {
    rig_id: 'RIG-G1-A',
    arm: 'public_control',
    supabase_project_name: 'arkova-soak-s33-g1-a',
    supabase_project_ref: projectRef,
    service: 'arkova-worker-s33-g1-a-staging',
    runtime_service_account: 's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com',
    runtime_service_account_unique_id: '10001',
    revision: 'arkova-worker-s33-g1-a-staging-00001',
    url: 'https://g1-a.example.run.app',
    run_id: 's33-g1-control-v6',
    queue: 's33-g1-control-queue',
    queue_binding: 'external_harness',
    clean_mirror: {
      artifact: 'docs/staging/s33-g1/a.json',
      attestation_id: `sha256:${'1'.repeat(64)}`,
      verified_at: nowIso,
    },
    vertex_endpoint: null,
    authenticated_capability_probe: { status: 'NOT_APPLICABLE' },
  } as S33G1AdmissionArm;
}

function admission(input: S33G1AdmissionArm): S33G1PairedStartAdmission {
  return {
    image_digest: imageDigest,
    declared_source_head: headSha,
    g1: {
      spend_approval: { expiresAt: '2026-07-20T00:00:00.000Z' },
      arms: [input],
    },
  } as unknown as S33G1PairedStartAdmission;
}

function preparationRequest(): S33G1ArmPreparationRequest {
  const input = arm();
  return {
    admission: admission(input),
    arm: input,
    observed: {
      rigId: input.rig_id,
      supabaseProjectName: input.supabase_project_name,
      supabaseProjectRef: input.supabase_project_ref,
      service: input.service,
      runtimeServiceAccount: input.runtime_service_account,
      runtimeServiceAccountUniqueId: input.runtime_service_account_unique_id,
      revision: input.revision,
      url: input.url,
      imageDigest,
      sourceHeadSha: headSha,
      cleanMirrorAttestationId: input.clean_mirror.attestation_id,
      runId: input.run_id,
      queue: input.queue,
    },
    candidateTreeSha: treeSha,
  };
}

function accessToken(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    iss: `https://${projectRef}.supabase.co/auth/v1`,
    exp: Math.floor(Date.parse('2026-07-20T00:00:00.000Z') / 1000),
  })).toString('base64url');
  return `${header}.${payload}.fixture-signature`;
}

class AuthFetchFixture {
  readonly calls: Array<{ url: string; method: string; authorization?: string }> = [];
  readonly deletedUserIds: string[] = [];
  readonly usersByEmail = new Map<string, string>();
  failFirstPassword = false;
  private userSequence = 0;

  readonly fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    this.calls.push({ url, method, authorization: headers.get('authorization') ?? undefined });
    if (url.endsWith('/auth/v1/admin/users') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { email: string };
      this.userSequence += 1;
      const userId = `11111111-1111-4111-8111-${String(this.userSequence).padStart(12, '0')}`;
      this.usersByEmail.set(body.email, userId);
      return new Response(JSON.stringify({ id: userId }), { status: 200 });
    }
    if (url.includes('grant_type=password')) {
      if (this.failFirstPassword) {
        this.failFirstPassword = false;
        return new Response('{}', { status: 500 });
      }
      const body = JSON.parse(String(init?.body)) as { email: string };
      const userId = this.usersByEmail.get(body.email)!;
      return new Response(JSON.stringify({
        access_token: accessToken(userId), refresh_token: `refresh-${userId}`, user: { id: userId }, expires_in: 3600,
      }), { status: 200 });
    }
    if (url.includes('grant_type=refresh_token')) {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      const userId = body.refresh_token.replace(/^refresh-/u, '').replace(/^rotated-/u, '');
      return new Response(JSON.stringify({
        access_token: accessToken(userId), refresh_token: `rotated-${userId}`, user: { id: userId }, expires_in: 3600,
      }), { status: 200 });
    }
    if (url.includes('/auth/v1/admin/users/') && method === 'DELETE') {
      this.deletedUserIds.push(url.slice(url.lastIndexOf('/') + 1));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/api/v1/ai/template')) {
      const authorization = headers.get('authorization');
      return new Response('{}', {
        status: authorization?.startsWith('Bearer ey') === true ? 200 : 401,
      });
    }
    throw new Error(`Unexpected fixture request: ${method} ${url}`);
  }) as typeof fetch;
}

class KeyCommandRunner implements S33G1CommandRunner {
  readonly calls: Array<{ binary: string; args: readonly string[] }> = [];

  async run(binary: string, args: readonly string[]): Promise<S33G1CommandResult> {
    this.calls.push({ binary, args });
    if (args.includes('api-keys')) {
      return {
        status: 'ok',
        stdout: JSON.stringify([
          { name: 'anon', api_key: 'fixture-public-key' },
          { name: 'service_role', api_key: 'fixture-service-role-key' },
        ]),
      };
    }
    return { status: 'error', stdout: '' };
  }
}

interface ControlledSleep {
  readonly milliseconds: number;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
}

function dependencies(
  auth: AuthFetchFixture,
  command: S33G1CommandRunner = new KeyCommandRunner(),
  runHarness: S33G1ProductionAdapterDependencies['runHarness'] = async (options) => {
    options.onReady?.();
    return { durationSec: G1_WORKER_UPTIME_MIN * 60 };
  },
): { value: S33G1ProductionAdapterDependencies; sleeps: ControlledSleep[] } {
  const sleeps: ControlledSleep[] = [];
  return {
    sleeps,
    value: {
      command,
      fetch: auth.fetch,
      readFile: async () => Buffer.from('fixture-clean-mirror'),
      now: () => new Date(nowIso),
      randomId: (() => { let value = 0; return () => `fixture-${++value}`; })(),
      randomSecret: () => 'fixture-password-that-is-never-persisted',
      sleep: async (milliseconds, signal) => new Promise<void>((resolve) => {
        const entry = { milliseconds, signal, resolve };
        sleeps.push(entry);
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      }),
      runHarness,
      reportBackgroundFailure: vi.fn(),
    },
  };
}

describe('S3.3 G1 production paired-start adapter', () => {
  it('pins the locally required Cloud SDK Python without changing non-gcloud command environments', () => {
    const ambient = { CLOUDSDK_PYTHON: '/caller/substitution', HOME: '/fixture/home' };
    expect(g1CommandEnvironment('/opt/homebrew/bin/gcloud', ambient)).toEqual({
      CLOUDSDK_PYTHON: G1_GCLOUD_PYTHON,
      HOME: '/fixture/home',
    });
    expect(g1CommandEnvironment('/usr/bin/git', ambient)).toBe(ambient);
  });

  it('re-observes the exact Supabase project, Cloud Run revision provenance, runtime unique ID, and clean-mirror bytes', async () => {
    const input = arm();
    const cleanMirror = Buffer.from('fixture-clean-mirror');
    input.clean_mirror.attestation_id = `sha256:${createHash('sha256').update(cleanMirror).digest('hex')}`;
    const command: S33G1CommandRunner = {
      async run(_binary, args) {
        if (args.includes('list')) return {
          status: 'ok', stdout: JSON.stringify([{ id: projectRef, name: input.supabase_project_name }]),
        };
        if (args[0] === 'run' && args[1] === 'services') return {
          status: 'ok',
          stdout: JSON.stringify({
            metadata: { name: input.service },
            status: { latestReadyRevisionName: input.revision, url: input.url },
          }),
        };
        if (args[0] === 'run' && args[1] === 'revisions') return {
          status: 'ok',
          stdout: JSON.stringify({
            metadata: { name: input.revision, labels: { 'arkova-source-head': headSha } },
            spec: {
              serviceAccountName: input.runtime_service_account,
              containers: [{ image: `repo/worker@${imageDigest}` }],
            },
            status: { imageDigest: `repo/worker@${imageDigest}` },
          }),
        };
        if (args[0] === 'iam') return {
          status: 'ok',
          stdout: JSON.stringify({
            email: input.runtime_service_account,
            uniqueId: input.runtime_service_account_unique_id,
          }),
        };
        return { status: 'error', stdout: '' };
      },
    };
    const auth = new AuthFetchFixture();
    const fixture = dependencies(auth, command);
    const adapter = createS33G1ProductionPairedStartAdapterForTest({
      ...fixture.value,
      readFile: async () => cleanMirror,
    });
    await expect(adapter.observeArm(input)).resolves.toEqual({
      rigId: input.rig_id,
      supabaseProjectName: input.supabase_project_name,
      supabaseProjectRef: input.supabase_project_ref,
      service: input.service,
      runtimeServiceAccount: input.runtime_service_account,
      runtimeServiceAccountUniqueId: input.runtime_service_account_unique_id,
      revision: input.revision,
      url: input.url,
      imageDigest,
      sourceHeadSha: headSha,
      cleanMirrorAttestationId: input.clean_mirror.attestation_id,
      runId: input.run_id,
      queue: input.queue,
    });
  });

  it('proves four refresh-rotated users and keeps the controller alive for the 750-minute wall after 720 worker minutes', async () => {
    const auth = new AuthFetchFixture();
    const runHarness = vi.fn(async (options: AiSoakHarnessRunOptions) => {
      expect(options.durationMin).toBe(G1_WORKER_UPTIME_MIN);
      expect(options.identities).toHaveLength(4);
      options.onReady?.();
      return { durationSec: G1_WORKER_UPTIME_MIN * 60 };
    });
    const fixture = dependencies(auth, undefined, runHarness);
    const adapter = createS33G1ProductionPairedStartAdapterForTest(fixture.value);
    const prepared = await adapter.prepareArm(preparationRequest());
    expect(prepared.sessionPool).toMatchObject({
      minimumRequired: 4,
      secretPersistence: 'NONE',
      refreshRotationCount: 4,
    });
    expect(prepared.sessionPool.identities).toHaveLength(4);
    expect(prepared.appBoundary).toMatchObject({
      unauthenticatedHttpStatus: 401,
      invalidBearerHttpStatus: 401,
      validExactUserHttpStatus: 200,
    });
    expect(JSON.stringify(prepared)).not.toMatch(/fixture-(?:password|service-role)|access_token|refresh_token/u);

    const request = { ...preparationRequest(), preclockReadiness: prepared } as S33G1ArmStartRequest;
    await adapter.startArm(request);
    await vi.waitFor(() => expect(runHarness).toHaveBeenCalledOnce());
    expect(fixture.sleeps.map(({ milliseconds }) => milliseconds)).toEqual(expect.arrayContaining([
      45 * 60_000,
      G1_WALL_MIN * 60_000,
    ]));
    expect(auth.deletedUserIds).toHaveLength(0);
    const wall = fixture.sleeps.find(({ milliseconds }) => milliseconds === G1_WALL_MIN * 60_000)!;
    expect(wall.signal.aborted).toBe(false);

    wall.resolve();
    await vi.waitFor(() => expect(auth.deletedUserIds).toHaveLength(4));
    expect(wall.signal.aborted).toBe(true);
  });

  it('compensates the exact just-created user when initial session establishment fails before pool registration', async () => {
    const auth = new AuthFetchFixture();
    auth.failFirstPassword = true;
    const fixture = dependencies(auth);
    const adapter = createS33G1ProductionPairedStartAdapterForTest(fixture.value);
    await expect(adapter.prepareArm(preparationRequest())).rejects.toThrow(/initial session.*HTTP 500/i);
    expect(auth.deletedUserIds).toEqual(['11111111-1111-4111-8111-000000000001']);
    expect(auth.calls.filter(({ method }) => method === 'DELETE')).toHaveLength(1);
  });

  it('creates and reloads the receipt with generation zero and per-object Locked retention', async () => {
    const auth = new AuthFetchFixture();
    let persistedRaw = '';
    let receiptUri = '';
    const calls: Array<readonly string[]> = [];
    const command: S33G1CommandRunner = {
      async run(_binary, args) {
        calls.push(args);
        if (args.includes('api-keys')) {
          return {
            status: 'ok',
            stdout: JSON.stringify([
              { name: 'anon', api_key: 'fixture-public-key' },
              { name: 'service_role', api_key: 'fixture-service-role-key' },
            ]),
          };
        }
        if (args[0] === 'storage' && args[1] === 'cp') {
          persistedRaw = await readFile(args[2]!, 'utf8');
          receiptUri = args[3]!;
          return { status: 'ok', stdout: '' };
        }
        if (args[0] === 'storage' && args[1] === 'objects') {
          return {
            status: 'ok',
            stdout: JSON.stringify({
              bucket: 'arkova1-s33-immutable-authority-ledger',
              name: receiptUri.replace('gs://arkova1-s33-immutable-authority-ledger/', ''),
              generation: '7',
              retention: { mode: 'Locked', retainUntilTime: '2026-07-20T00:00:00.000Z' },
            }),
          };
        }
        if (args[0] === 'storage' && args[1] === 'cat') return { status: 'ok', stdout: persistedRaw };
        return { status: 'error', stdout: '' };
      },
    };
    const fixture = dependencies(auth, command);
    const adapter = createS33G1ProductionPairedStartAdapterForTest(fixture.value);
    const readiness = await adapter.prepareArm(preparationRequest());
    const receipt = {
      schemaVersion: 'arkova.s33.g1.paired-start-receipt/v1',
      receiptId: 'g1-paired-start:approval:soak:lease',
      preclockReadiness: [readiness, readiness],
    } as unknown as S33G1PairedStartReceipt;
    await adapter.persistStartReceipt(receipt);
    await expect(adapter.loadStartReceipt(receipt.receiptId)).resolves.toEqual(receipt);
    const cp = calls.find((args) => args[0] === 'storage' && args[1] === 'cp')!;
    expect(cp).toEqual(expect.arrayContaining([
      '--if-generation-match=0',
      '--retention-mode=Locked',
      '--retain-until=2026-07-20T00:00:00.000Z',
    ]));
    const cat = calls.find((args) => args[0] === 'storage' && args[1] === 'cat')!;
    expect(cat[2]).toMatch(/#7$/u);
    await adapter.cleanupArmPreparation(preparationRequest().arm, 'paired-start-failure');
  });
});
