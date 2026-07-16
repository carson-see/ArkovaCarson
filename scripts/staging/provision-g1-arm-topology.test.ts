import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const provisioner = resolve(here, 'provision-isolated-rig.sh');
const teardown = resolve(here, 'teardown-isolated-rig.sh');
const provisionerSource = readFileSync(provisioner, 'utf8');
const repoRoot = resolve(here, '../..');
const repoHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const repoBase = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const stubRoots: string[] = [];

afterAll(() => {
  for (const root of stubRoots) rmSync(root, { force: true, recursive: true });
});

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
  STAGING_G1_PAIRED_CADENCE_MIN: '30',
  STAGING_G1_STOP_AUTHORITY: 'founders-cto-rte',
  STAGING_G1_TEARDOWN_OWNER: 'lane-4-sm',
  STAGING_GEMINI_TUNED_MODEL:
    'projects/arkova1/locations/us-central1/endpoints/123456789',
  STAGING_RIG_ID: 'RIG-G1',
  STAGING_TIER: 'T2',
  STAGING_REQUIRED_UPTIME_MIN: '2880',
  STAGING_REQUIRED_WALL_MIN: '2910',
};

function g1DryRun(env: Record<string, string> = {}): RunResult {
  return run(provisioner, ['--name', 's33-g1', '--profile', 'gemini'], {
    ...g1Env,
    ...env,
  });
}

const pinnedImageDigest = `sha256:${'d'.repeat(64)}`;
const pinnedImage = `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@${pinnedImageDigest}`;
const endpointModel = 'projects/arkova1/locations/us-central1/models/6611494259700793344';

interface G1FaultRun {
  code: number;
  out: string;
  gcloudCalls: string[];
  npxCalls: string[];
  state: Record<string, unknown> | null;
}

function runG1ApplyFault(options: {
  endpoint?: Record<string, unknown>;
  failDeployAt?: number;
  failTunedRevisionDescribe?: boolean;
} = {}): G1FaultRun {
  const root = mkdtempSync(join(tmpdir(), 'g1-provision-fault-'));
  stubRoots.push(root);
  const gcloudLog = join(root, 'gcloud.log');
  const npxLog = join(root, 'npx.log');
  const deployCount = join(root, 'deploy-count');
  const artifactDir = join(root, 'artifacts');
  const statePath = join(artifactDir, 'isolated-rig-provision-s33-g1.json');
  writeFileSync(gcloudLog, '');
  writeFileSync(npxLog, '');

  const baseEnv = {
    NODE_ENV: 'production',
    ENABLE_AI_FRAUD: 'false',
    ENABLE_AI_REPORTS: 'false',
    CORS_ALLOWED_ORIGINS: 'https://app.arkova.ai',
    FRONTEND_URL: 'https://app.arkova.ai',
    USE_MOCKS: 'true',
    ENABLE_PROD_NETWORK_ANCHORING: 'false',
    GEMINI_MODEL: 'gemini-2.5-flash',
    DISABLE_ALL_IN_PROCESS_CRON: 'true',
    DISABLE_IN_PROCESS_ANCHOR_CRON: 'true',
    ENABLE_QUEUE_REMINDERS: 'false',
    ENABLE_RULES_ENGINE: 'false',
    ENABLE_RULE_ACTION_DISPATCHER: 'false',
  };
  const secretNames = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'API_KEY_HMAC_SECRET',
    'CRON_SECRET',
    'GEMINI_API_KEY',
  ];
  const revision = (env: Record<string, string>) => JSON.stringify({
    metadata: { labels: { 'arkova-source-head': repoHead } },
    spec: {
      containers: [{
        image: pinnedImage,
        env: [
          ...Object.entries(env).map(([name, value]) => ({ name, value })),
          ...secretNames.map((name) => ({
            name,
            valueSource: { secretKeyRef: { secret: `stub-${name.toLowerCase()}`, version: 'latest' } },
          })),
        ],
      }],
    },
    status: { imageDigest: pinnedImageDigest },
  });
  const publicRevision = revision(baseEnv);
  const tunedRevision = revision({
    ...baseEnv,
    GEMINI_TUNED_MODEL: g1Env.STAGING_GEMINI_TUNED_MODEL,
    GEMINI_V6_PROMPT: 'true',
  });
  const endpoint = JSON.stringify(options.endpoint ?? {
    deployedModels: [{ id: 'v6-deployment', model: endpointModel }],
    trafficSplit: { 'v6-deployment': 100 },
  });
  const verifiedApproval = JSON.stringify({
    status: 'VERIFIED',
    sourceReference: 'ari:cloud:confluence:tenant:page/123456',
    immutableRevisionId: 'revision-42',
    canonicalSha256: `sha256:${'1'.repeat(64)}`,
    approverIdentity: 'approved-founder',
    approverRole: 'founder',
    authorityRosterRootSha256: `sha256:${'2'.repeat(64)}`,
    candidateSourceHeadSha: repoHead,
    candidateImageDigest: pinnedImageDigest,
    isolatedSupabaseProjectCount: 3,
    isolatedSupabaseProjectMonthlyEachUsd: 10,
    isolatedSupabaseProjectsMonthlyTotalUsd: 30,
    g1VariableComputeModelCapUsd: 120,
    s33TotalCapUsd: 200,
    ownerIdentity: 'lane-4-sm',
    expiresAt: '2026-07-20T00:00:00Z',
    raci: {
      responsibleIdentity: 'lane-4-sm',
      accountableIdentity: 'approved-founder',
      consultedIdentities: ['cto'],
      informedIdentities: ['rte'],
    },
    approvalVerifiedAt: '2026-07-15T20:00:00Z',
    verifierIdentity: 'release-verifier',
    verificationMethod: 'ed25519-pinned-authority-roster',
    runtimeVerifiedAt: '2026-07-15T20:01:00.000Z',
    trustRootKeyFingerprint: '3'.repeat(64),
  });

  writeFileSync(join(root, 'git'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "fetch" || "$1" == "ls-files" || "$1" == "cat-file" || "$1" == "diff" ]]; then exit 0; fi
if [[ "$1" == "merge-base" && "\${2:-}" == "--is-ancestor" ]]; then exit 0; fi
if [[ "$1" == "merge-base" ]]; then printf '%s\\n' '${repoBase}'; exit 0; fi
exec '${realGit}' "$@"
`);
  chmodSync(join(root, 'git'), 0o755);

  writeFileSync(join(root, 'npx'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${npxLog}'
if [[ "$1" == "tsx" && "$2" == "scripts/staging/s33-g1-spend-approval.ts" ]]; then
  printf '%s\\n' '${verifiedApproval}'
  exit 0
fi
if [[ "$1" == "supabase" && "$2" == "projects" && "$3" == "create" ]]; then
  printf '%s\\n' '{"id":"abcdefghijklmnopqrst"}'
  exit 0
fi
if [[ "$1" == "supabase" ]]; then exit 0; fi
echo "unexpected npx call: $*" >&2
exit 64
`);
  chmodSync(join(root, 'npx'), 0o755);

  writeFileSync(join(root, 'gcloud'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${gcloudLog}'
if [[ "$1" == "artifacts" && "$2" == "docker" ]]; then
  printf '%s\\n' '${pinnedImage}'
  exit 0
fi
if [[ "$1" == "ai" && "$2" == "endpoints" && "$3" == "describe" ]]; then
  printf '%s\\n' '${endpoint}'
  exit 0
fi
if [[ "$1" == "run" && "$2" == "deploy" ]]; then
  count=0
  [[ ! -f '${deployCount}' ]] || count="$(cat '${deployCount}')"
  count=$((count + 1))
  printf '%s' "$count" > '${deployCount}'
  if [[ "$count" == '${options.failDeployAt ?? 0}' ]]; then
    echo 'injected G1 deploy failure' >&2
    exit 43
  fi
  exit 0
fi
if [[ "$1" == "run" && "$2" == "services" && "$3" == "describe" ]]; then
  service="$4"
  if [[ "$*" == *"status.latestReadyRevisionName"* ]]; then
    printf '%s-revision\\n' "$service"
  else
    printf 'https://%s.example.run.app\\n' "$service"
  fi
  exit 0
fi
if [[ "$1" == "run" && "$2" == "revisions" && "$3" == "describe" ]]; then
  if [[ "$4" == *'-tuned-staging-revision' ]]; then
    if [[ '${options.failTunedRevisionDescribe ? 'true' : 'false'}' == 'true' ]]; then
      echo 'injected tuned revision verification failure' >&2
      exit 44
    fi
    printf '%s\\n' '${tunedRevision}'
  else
    printf '%s\\n' '${publicRevision}'
  fi
  exit 0
fi
exit 0
`);
  chmodSync(join(root, 'gcloud'), 0o755);

  const env = {
    ...process.env,
    ...g1Env,
    PATH: `${root}:${process.env.PATH ?? ''}`,
    CONFIRM_PROVISION: 's33-g1',
    CONFIRM_REAL_CONFIG: 'gemini',
    CONFIRM_POST_W3_PROVISION: 'RIG-G1',
    GITHUB_SHA: repoHead,
    BASE_SHA: repoBase,
    STAGING_SOURCE_HEAD_SHA: repoHead,
    STAGING_PINNED_IMAGE: pinnedImage,
    STAGING_SOAK_ID: 'soak-s33-g1',
    STAGING_LEASE_ID: 'lease-s33-g1',
    STAGING_NEW_SUPABASE_DB_PASSWORD: 'stub-password-not-real',
    STAGING_NEW_SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role-not-real',
    STAGING_CHANGED_BEHAVIOR: 'RIG-G1 paired public/v6 external experiment',
    STAGING_G1_SPEND_APPROVAL_ARTIFACT: join(root, 'approval-envelope.json'),
    STAGING_ADMISSION_DIR: artifactDir,
  };
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', [provisioner, '--name', 's33-g1', '--profile', 'gemini', '--apply'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
    code = failure.status ?? 1;
    out = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
  return {
    code,
    out,
    gcloudCalls: readFileSync(gcloudLog, 'utf8').trim().split('\n').filter(Boolean),
    npxCalls: readFileSync(npxLog, 'utf8').trim().split('\n').filter(Boolean),
    state: existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null,
  };
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
    expect(result.out.match(/DISABLE_ALL_IN_PROCESS_CRON=true/g)?.length).toBeGreaterThanOrEqual(2);
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
      tier: 'T2_CUSTOM',
      required_worker_uptime_min: 2880,
      required_wall_min: 2910,
      paired_cadence_max_min: 30,
      execution_state: 'PAUSED',
      background_execution: 'disabled',
      owner: '<from-verified-approval-record>',
      expires_at: '<from-verified-approval-record>',
      stop_authority: 'founders-cto-rte',
      teardown_owner: 'lane-4-sm',
      budget: {
        s33_total_cap_usd: null,
        g1_variable_compute_model_cap_usd: null,
        isolated_supabase_project_count: 3,
        isolated_supabase_project_monthly_each_usd: 10,
        isolated_supabase_projects_monthly_total_usd: 30,
      },
      spend_approval: {
        status: 'UNCONFIGURED',
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
    expect(provisionerSource).toContain('(.deployedModels | type == "array" and length == 1)');
    expect(provisionerSource).toContain('.deployedModels[0].model == $expected');
    expect(provisionerSource).toContain('(.deployedModels[0].id as $deployed_model_id');
    expect(provisionerSource).toContain('(.trafficSplit | keys) == [$deployed_model_id]');
    expect(provisionerSource).toContain('.trafficSplit[$deployed_model_id] == 100');
    expect(provisionerSource).toContain('verify_g1_candidate_endpoint_binding');
  });

  it.each([
    [
      'an extra deployment',
      {
        deployedModels: [
          { id: 'v6-deployment', model: endpointModel },
          { id: 'extra', model: 'projects/arkova1/locations/us-central1/models/999' },
        ],
        trafficSplit: { 'v6-deployment': 100 },
      },
    ],
    [
      'a missing deployed-model id',
      { deployedModels: [{ model: endpointModel }], trafficSplit: { 'v6-deployment': 100 } },
    ],
    [
      'a non-exclusive traffic split',
      {
        deployedModels: [{ id: 'v6-deployment', model: endpointModel }],
        trafficSplit: { 'v6-deployment': 99, extra: 1 },
      },
    ],
  ])('rejects endpoint readiness with %s before mutation', (_label, endpoint) => {
    const result = runG1ApplyFault({ endpoint });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/endpoint|sole|traffic|ready/i);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
  });

  it.each([
    ['corpus digest', 'STAGING_G1_CORPUS_DIGEST'],
    ['control run id', 'STAGING_G1_CONTROL_RUN_ID'],
    ['tuned queue', 'STAGING_G1_TUNED_QUEUE'],
    ['paired cadence', 'STAGING_G1_PAIRED_CADENCE_MIN'],
  ])('fails closed when %s is absent', (_label, key) => {
    const result = g1DryRun({ [key]: '' });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(new RegExp(key, 'i'));
    expect(result.out).not.toContain('gcloud run deploy');
  });

  it.each([
    ['T3 masquerade', { STAGING_TIER: 'T3' }],
    ['short worker clock', { STAGING_REQUIRED_UPTIME_MIN: '2879' }],
    ['short wall clock', { STAGING_REQUIRED_WALL_MIN: '2909' }],
    ['slow pairing cadence', { STAGING_G1_PAIRED_CADENCE_MIN: '31' }],
  ])('rejects an invalid custom-T2 contract: %s', (_label, env) => {
    const result = g1DryRun(env);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/RIG-G1|T2|2880|2910|cadence/i);
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

  it('requires a separately verified immutable approval artifact before any live mutation', () => {
    const result = run(provisioner, ['--name', 's33-g1', '--profile', 'gemini', '--apply'], {
      ...g1Env,
      CONFIRM_PROVISION: 's33-g1',
      CONFIRM_REAL_CONFIG: 'gemini',
      CONFIRM_POST_W3_PROVISION: 'RIG-G1',
      STAGING_G1_SPEND_APPROVAL_ARTIFACT: '/tmp/caller-authored-approval.json',
      STAGING_G1_SPEND_AUTHORITY_ID: 'caller-self-attestation',
      CONFIRM_G1_SPEND_AUTHORITY: 'caller-self-attestation',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/approval|trust root|UNCONFIGURED|immutable|STAGING_NEW_SUPABASE_DB_PASSWORD/i);
    expect(result.out).not.toContain('projects create');
    expect(result.out).not.toContain('gcloud run deploy');
  });

  it('declares both deterministic service cleanup candidates before cloud mutation', () => {
    expect(provisionerSource).toContain('pre_mutation_cleanup_plan_persisted');
    expect(provisionerSource).toContain('cloud_run_service_candidates');
    expect(provisionerSource).toContain('cloud_run_delete_commands');
    expect(provisionerSource.indexOf('pre_mutation_cleanup_plan_persisted'))
      .toBeLessThan(provisionerSource.indexOf('"${CREATE_CMD[@]}" --db-password'));
  });

  it.each([
    ['second arm deploy', { failDeployAt: 2 }],
    ['second arm provenance verification', { failTunedRevisionDescribe: true }],
  ])('preserves both cleanup candidates when the %s fails', (_label, fault) => {
    const result = runG1ApplyFault(fault);
    expect(result.code).not.toBe(0);
    expect(
      result.gcloudCalls.filter((call) => call.startsWith('run deploy ')),
      result.out,
    ).toHaveLength(2);
    expect(result.state).not.toBeNull();
    expect(result.state).toMatchObject({ status: 'blocked_after_project_create' });
    const cleanup = result.state!.cleanup as {
      cloud_run_service_candidates: string[];
      cloud_run_delete_commands: string[];
      teardown_command: string;
    };
    expect(cleanup.cloud_run_service_candidates).toEqual([
      'arkova-worker-s33-g1-public-staging',
      'arkova-worker-s33-g1-tuned-staging',
    ]);
    expect(cleanup.cloud_run_delete_commands).toHaveLength(2);
    expect(cleanup.cloud_run_delete_commands[0]).toContain('arkova-worker-s33-g1-public-staging');
    expect(cleanup.cloud_run_delete_commands[1]).toContain('arkova-worker-s33-g1-tuned-staging');
    expect(cleanup.teardown_command).toContain('--project-ref abcdefghijklmnopqrst');
    expect(cleanup.teardown_command).toContain('--service arkova-worker-s33-g1-public-staging');
    expect(cleanup.teardown_command).toContain('--service arkova-worker-s33-g1-tuned-staging');
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
