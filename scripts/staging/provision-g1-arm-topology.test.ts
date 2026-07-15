import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const provisioner = resolve(here, 'provision-isolated-rig.sh');
const teardown = resolve(here, 'teardown-isolated-rig.sh');
const provisionerSource = readFileSync(provisioner, 'utf8');

interface RunResult {
  code: number;
  out: string;
}

function run(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  try {
    return {
      code: 0,
      out: execFileSync('bash', [script, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      code: failure.status ?? 1,
      out: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

const g1Env = {
  STAGING_G1_CORPUS_DIGEST: `sha256:${'a'.repeat(64)}`,
  STAGING_G1_CONTROL_RUN_ID: 's33-g1-control-v6',
  STAGING_G1_TUNED_RUN_ID: 's33-g1-tuned-v6',
  STAGING_G1_CONTROL_QUEUE: 's33-g1-control-queue',
  STAGING_G1_TUNED_QUEUE: 's33-g1-tuned-queue',
  STAGING_G1_OWNER: 'lane-4-sm',
  STAGING_G1_EXPIRES_AT: '2026-07-20T00:00:00Z',
  STAGING_G1_STOP_AUTHORITY: 'founders-cto-rte',
  STAGING_G1_TEARDOWN_OWNER: 'lane-4-sm',
  STAGING_G1_SPEND_AUTHORITY_ID: 'founder-approval-pending',
  STAGING_S33_COST_CAP_USD: '200',
  STAGING_G1_COMPUTE_MODEL_CAP_USD: '120',
  STAGING_RIG_PROJECT_MONTHLY_USD: '10',
  STAGING_GEMINI_TUNED_MODEL:
    'projects/arkova1/locations/us-central1/endpoints/123456789',
  STAGING_RIG_ID: 'RIG-G1',
  STAGING_TIER: 'T3',
  STAGING_REQUIRED_UPTIME_MIN: '2880',
  STAGING_REQUIRED_WALL_MIN: '2910',
};

function g1DryRun(env: Record<string, string> = {}): RunResult {
  return run(provisioner, ['--name', 's33-g1', '--profile', 'gemini'], {
    ...g1Env,
    ...env,
  });
}

describe('RIG-G1 public/control and tuned arm topology', () => {
  it('plans exactly two independently addressable services on the same immutable image', () => {
    const result = g1DryRun();
    expect(result.code, result.out).toBe(0);

    const deploys = result.out
      .split('\n')
      .filter((line) => line.startsWith('+ gcloud run deploy '));
    expect(deploys).toHaveLength(2);
    expect(deploys[0]).toContain('arkova-worker-s33-g1-public-staging');
    expect(deploys[1]).toContain('arkova-worker-s33-g1-tuned-staging');
    expect(deploys.every((line) => line.includes('--min-instances=0'))).toBe(true);
    expect(deploys.every((line) => line.includes('--max-instances=2'))).toBe(true);
    expect(deploys.every((line) => line.includes('--no-allow-unauthenticated'))).toBe(true);
  });

  it('keeps the public arm on the production prompt and pins only the tuned arm to v6', () => {
    const result = g1DryRun();
    expect(result.code, result.out).toBe(0);
    const deploys = result.out
      .split('\n')
      .filter((line) => line.startsWith('+ gcloud run deploy '));

    expect(deploys[0]).toContain('GEMINI_MODEL=gemini-2.5-flash');
    expect(deploys[0]).not.toContain('GEMINI_TUNED_MODEL');
    expect(deploys[0]).not.toContain('GEMINI_V6_PROMPT');
    expect(deploys[1]).toContain(
      'GEMINI_TUNED_MODEL=projects/arkova1/locations/us-central1/endpoints/123456789',
    );
    expect(deploys[1]).toContain('GEMINI_V6_PROMPT=true');
    expect(deploys.join('\n')).not.toContain('GEMINI_TUNED_RESPONSE_SCHEMA=');
  });

  it('disables colliding background execution and leaves Scheduler non-applicable', () => {
    const result = g1DryRun();
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toContain('gcloud scheduler jobs create');
    expect(result.out).not.toContain('gcloud scheduler jobs resume');
    expect(result.out.match(/DISABLE_IN_PROCESS_ANCHOR_CRON=true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(result.out.match(/ENABLE_QUEUE_REMINDERS=false/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('binds immutable inputs, distinct run/queue identities, lifecycle, budget, and teardown', () => {
    const result = g1DryRun();
    expect(result.code, result.out).toBe(0);
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    expect(line).toBeTruthy();
    const admission = JSON.parse(line!.slice('ADMISSION_JSON='.length));

    expect(admission.g1).toMatchObject({
      candidate_model: 'models/6611494259700793344',
      candidate_model_resource:
        'projects/arkova1/locations/us-central1/models/6611494259700793344',
      corpus_digest: g1Env.STAGING_G1_CORPUS_DIGEST,
      execution_state: 'PAUSED',
      background_execution: 'disabled',
      owner: 'lane-4-sm',
      expires_at: '2026-07-20T00:00:00Z',
      stop_authority: 'founders-cto-rte',
      teardown_owner: 'lane-4-sm',
      budget: {
        s33_cost_cap_usd: 200,
        compute_model_cap_usd: 120,
        project_monthly_usd: 10,
        spend_authority_id: 'founder-approval-pending',
      },
    });
    expect(admission.g1.arms).toEqual([
      expect.objectContaining({
        arm: 'public_control',
        run_id: 's33-g1-control-v6',
        queue: 's33-g1-control-queue',
        service: 'arkova-worker-s33-g1-public-staging',
        gemini_model: 'gemini-2.5-flash',
        gemini_tuned_model: '<unset>',
        gemini_v6_prompt: '<unset>',
      }),
      expect.objectContaining({
        arm: 'tuned_v6',
        run_id: 's33-g1-tuned-v6',
        queue: 's33-g1-tuned-queue',
        service: 'arkova-worker-s33-g1-tuned-staging',
        gemini_tuned_model: g1Env.STAGING_GEMINI_TUNED_MODEL,
        gemini_v6_prompt: 'true',
      }),
    ]);
    expect(admission.g1.teardown.command).toContain('--rig-name s33-g1');
    expect(admission.g1.teardown.command).toContain(
      '--service arkova-worker-s33-g1-public-staging',
    );
    expect(admission.g1.teardown.command).toContain(
      '--service arkova-worker-s33-g1-tuned-staging',
    );
    expect(admission.g1.shared_inputs.supabase_project_ref).toBe('<captured-from-step-1>');
  });

  it('re-observes the Vertex endpoint and proves the exact candidate deployment before mutation', () => {
    expect(provisionerSource).toContain('gcloud ai endpoints describe "$G1_ENDPOINT_ID"');
    expect(provisionerSource).toContain('.deployedModels[]? | select(.model == $expected)');
    expect(provisionerSource).toContain('verify_g1_candidate_endpoint_binding');
  });

  it.each([
    ['corpus digest', 'STAGING_G1_CORPUS_DIGEST'],
    ['control run id', 'STAGING_G1_CONTROL_RUN_ID'],
    ['tuned queue', 'STAGING_G1_TUNED_QUEUE'],
    ['expiry', 'STAGING_G1_EXPIRES_AT'],
    ['compute/model cap', 'STAGING_G1_COMPUTE_MODEL_CAP_USD'],
  ])('fails closed when %s is absent', (_label, key) => {
    const result = g1DryRun({ [key]: '' });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(new RegExp(key, 'i'));
    expect(result.out).not.toContain('gcloud run deploy');
  });

  it('fails closed when arm run IDs or queue identities collide', () => {
    const duplicateRun = g1DryRun({
      STAGING_G1_TUNED_RUN_ID: g1Env.STAGING_G1_CONTROL_RUN_ID,
    });
    expect(duplicateRun.code).not.toBe(0);
    expect(duplicateRun.out).toMatch(/run.*distinct/i);

    const duplicateQueue = g1DryRun({
      STAGING_G1_TUNED_QUEUE: g1Env.STAGING_G1_CONTROL_QUEUE,
    });
    expect(duplicateQueue.code).not.toBe(0);
    expect(duplicateQueue.out).toMatch(/queue.*distinct/i);
  });

  it('requires a separate post-Wave-3 and spend-authority gate before any live mutation', () => {
    const result = run(provisioner, ['--name', 's33-g1', '--profile', 'gemini', '--apply'], {
      ...g1Env,
      CONFIRM_PROVISION: 's33-g1',
      CONFIRM_REAL_CONFIG: 'gemini',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/CONFIRM_POST_W3_PROVISION=RIG-G1/);
    expect(result.out).not.toContain('projects create');
    expect(result.out).not.toContain('gcloud run deploy');
  });
});

describe('unbound RIG-R profile', () => {
  it('rejects RIG-R instead of guessing a service/profile mapping', () => {
    const result = run(provisioner, ['--name', 's33-r', '--profile', 'mock'], {
      STAGING_RIG_ID: 'RIG-R',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/RIG-R.*CTO.*profile binding/i);
    expect(result.out).not.toContain('projects create');
  });
});

describe('multi-service G1 teardown', () => {
  it('deletes both arm services but reclaims the shared project and secrets once', () => {
    const result = run(teardown, [
      '--project-ref',
      'abcdefghijklmnopqrst',
      '--rig-name',
      's33-g1',
      '--service',
      'arkova-worker-s33-g1-public-staging',
      '--service',
      'arkova-worker-s33-g1-tuned-staging',
    ]);
    expect(result.code, result.out).toBe(0);
    expect(result.out.match(/gcloud run services delete/g)).toHaveLength(2);
    expect(result.out.match(/supabase-url-s33-g1-staging/g)).toHaveLength(1);
    expect(result.out.match(/supabase-service-role-key-s33-g1-staging/g)).toHaveLength(1);
    expect(result.out.match(/supabase projects delete/g)).toHaveLength(1);
  });
});
