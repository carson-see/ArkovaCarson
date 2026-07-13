import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SCRUM-2673 (L2-S2a) — real-config parameterization of provision-isolated-rig.sh.
 *
 * ROOT CAUSE this fixes: the provisioner hardcoded USE_MOCKS=true /
 * ENABLE_PROD_NETWORK_ANCHORING=false with no override + no Cloud Scheduler, so
 * it could ONLY ever build MOCK rigs — useless for a real *behavioral* soak of
 * the chain / gemini / batch-anchor / classifier surfaces. A rig on mocks that
 * never fires cron cannot exercise any PR's changed path → health-only evidence →
 * fails §1.12 + the Staging Soak Evidence Gate.
 *
 * Two kinds of test here:
 *   1. STRUCTURAL — read the script text and pin the override plumbing invariants
 *      (safe-by-default, per-profile deltas, Scheduler wiring, deny-list intact).
 *   2. BEHAVIORAL (dry-run) — actually invoke the script with `--profile …` in
 *      dry-run (mutates nothing; --apply is NOT passed) and assert on the emitted
 *      plan. Dry-run is the DEFAULT and prints every command it WOULD run, so the
 *      emitted plan is a faithful contract of the real deploy env.
 *
 * No infra is created: every invocation omits --apply, so run_cmd only prints.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, 'provision-isolated-rig.sh');
const REPO_ROOT = resolve(here, '../..');
const REPO_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).trim();
const REPO_BASE = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).trim();
const script = readFileSync(SCRIPT, 'utf8');

const REQUIRED_PREFLIGHT_CHECK_NAMES = [
  'staging_only_rows',
  'duplicate_names',
  'duplicate_versions',
  'known_artifacts',
  'submitted_anchors',
  'prod_divergence',
] as const;

const VALID_PREFLIGHT_REPORT = {
  environment_type: 'clean_mirror',
  staging_project_ref: 'abcdefghijklmnopqrst',
  timestamp: '2026-07-13T12:00:00.000Z',
  checks: REQUIRED_PREFLIGHT_CHECK_NAMES.map((name) => ({
    name,
    passed: true,
    details: name === 'staging_only_rows' ? 'secret-looking-diagnostic-must-not-persist' : '',
  })),
  artifact_rows: [],
  missing_from_staging: [],
  extra_vs_prod: [],
};

/** Run the provisioner in dry-run (no --apply → no side effects) and capture stdout+stderr. */
function dryRun(args: string[], env: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

describe('provision-isolated-rig.sh — profile flag + safe default', () => {
  it('accepts a --profile flag', () => {
    expect(script).toMatch(/--profile\)/);
  });

  it('defaults to the mock profile (safe-by-default) when --profile is omitted', () => {
    const { out, code } = dryRun(['--name', 's0-s2a-defaults']);
    expect(code).toBe(0);
    expect(out).toMatch(/profile:\s+mock/);
    // The emitted worker deploy must still carry the mock deltas by default.
    expect(out).toMatch(/USE_MOCKS=true/);
    expect(out).toMatch(/ENABLE_PROD_NETWORK_ANCHORING=false/);
  });

  it('rejects an unknown profile', () => {
    const { code, out } = dryRun(['--name', 's0-s2a-bad', '--profile', 'wat']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/profile/i);
  });

  it('enumerates the supported profiles (mock, chain, gemini)', () => {
    // The validation case list must name every supported profile.
    expect(script).toMatch(/\bmock\b/);
    expect(script).toMatch(/\bchain\b/);
    expect(script).toMatch(/\bgemini\b/);
  });
});

describe('provision-isolated-rig.sh — chain profile real anchoring overrides', () => {
  it('flips USE_MOCKS off and enables prod-network anchoring for the chain profile', () => {
    const { out, code } = dryRun(['--name', 's0-s2a-chain', '--profile', 'chain']);
    expect(code).toBe(0);
    expect(out).toMatch(/USE_MOCKS=false/);
    expect(out).toMatch(/ENABLE_PROD_NETWORK_ANCHORING=true/);
    // A real signer + KMS provider must be wired, or config.ts fails closed at boot
    // (superRefine: mainnet anchoring requires KMS_PROVIDER + a signer).
    expect(out).toMatch(/KMS_PROVIDER=/);
  });

  it('wires the GetBlock RPC + WIF signer secrets for the chain profile', () => {
    const { out } = dryRun(['--name', 's0-s2a-chain', '--profile', 'chain']);
    // GetBlock broadcast/UTXO + WIF signer come from Secret Manager, never inline.
    expect(out).toMatch(/BITCOIN_RPC_URL=/);
    expect(out).toMatch(/BITCOIN_RPC_AUTH=/);
    expect(out).toMatch(/BITCOIN_TREASURY_WIF=/);
    // Never a raw WIF/RPC literal in the script or the emitted plan.
    expect(out).toMatch(/:latest/);
  });

  it('never inlines a raw treasury WIF or RPC credential (secret-manager only)', () => {
    // WIF is base58 (K/L/5-prefixed, ~51-52 chars); assert no such literal in source.
    expect(script).not.toMatch(/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/);
    // No inline getblock access token (hex-ish long token) hardcoded.
    expect(script).not.toMatch(/getblock\.io\/[0-9a-f]{16,}/i);
  });
});

describe('provision-isolated-rig.sh — gemini profile model/prompt overrides', () => {
  it('wires GEMINI_TUNED_MODEL + GEMINI_V6_PROMPT + GEMINI_API_KEY for the gemini profile', () => {
    const { out, code } = dryRun(['--name', 's0-s2a-gemini', '--profile', 'gemini']);
    expect(code).toBe(0);
    expect(out).toMatch(/GEMINI_TUNED_MODEL=/);
    expect(out).toMatch(/GEMINI_V6_PROMPT=/);
    expect(out).toMatch(/GEMINI_API_KEY=/);
    // gemini rig still has no real chain exposure — mocks stay on, anchoring off.
    expect(out).toMatch(/USE_MOCKS=true/);
    expect(out).toMatch(/ENABLE_PROD_NETWORK_ANCHORING=false/);
  });

  it('defaults the v6 prompt selector to the exact activation value true', () => {
    const { out, code } = dryRun(['--name', 's0-s2a-gemini', '--profile', 'gemini']);
    expect(code).toBe(0);
    expect(out).toMatch(/GEMINI_V6_PROMPT=true/);
    expect(out).not.toMatch(/GEMINI_V6_PROMPT=v6(?:,|\s|$)/);
  });
});

describe('provision-isolated-rig.sh — every rig gets boot-critical secrets', () => {
  it('wires Stripe + HMAC + cron + FRONTEND_URL on ALL profiles so config.ts Zod does not crash-loop', () => {
    for (const profile of ['mock', 'chain', 'gemini']) {
      const { out, code } = dryRun(['--name', `s0-s2a-${profile}`, '--profile', profile]);
      expect(code, `profile ${profile} should dry-run cleanly`).toBe(0);
      // config.ts: STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET are always required.
      expect(out, `profile ${profile}: stripe secret`).toMatch(/STRIPE_SECRET_KEY=/);
      expect(out, `profile ${profile}: stripe webhook`).toMatch(/STRIPE_WEBHOOK_SECRET=/);
      // production superRefine: API_KEY_HMAC_SECRET, a cron auth method, FRONTEND_URL.
      expect(out, `profile ${profile}: hmac`).toMatch(/API_KEY_HMAC_SECRET=/);
      expect(out, `profile ${profile}: cron`).toMatch(/CRON_SECRET=/);
      expect(out, `profile ${profile}: frontend`).toMatch(/FRONTEND_URL=/);
    }
  });
});

describe('provision-isolated-rig.sh — Cloud Scheduler wiring (node-cron does not fire on throttled Cloud Run)', () => {
  it('emits Cloud Scheduler job creation targeting /jobs/* for non-mock profiles', () => {
    const { out } = dryRun(['--name', 's0-s2a-chain', '--profile', 'chain']);
    // node-cron silently no-ops on a min-instances=0 Cloud Run service; the rig
    // MUST be driven by Cloud Scheduler POSTing to the worker's /jobs/* endpoints.
    expect(out).toMatch(/gcloud scheduler jobs create/);
    expect(out).toMatch(/\/jobs\//);
  });

  it('the Scheduler POST carries the cron auth secret (X-Cron-Secret) + OIDC identity', () => {
    const { out } = dryRun(['--name', 's0-s2a-chain', '--profile', 'chain']);
    // The worker's /jobs/* routes require cron auth; the Scheduler job must attach it.
    expect(out).toMatch(/X-Cron-Secret|--oidc-service-account-email|--oidc-token-audience/);
    // Dry-run must show a LABELED redaction placeholder (never a real secret).
    // L2-S2a-FIX changed the format from the old bare <redacted> to the
    // self-documenting <redacted:${CRON_SECRET_SECRET}> emitted by
    // run_cmd_cron_redacted (%q may prefix "<" with a backslash).
    expect(out).toMatch(/X-Cron-Secret=\\?<redacted:/);
  });

  it('does NOT create Scheduler jobs for the pure-mock profile (no behavioral cron to drive)', () => {
    const { out } = dryRun(['--name', 's0-s2a-defaults', '--profile', 'mock']);
    expect(out).not.toMatch(/gcloud scheduler jobs create/);
  });
});

describe('provision-isolated-rig.sh — admission JSON contract', () => {
  it('emits structured admission JSON with driver identity and T3 duration', () => {
    const { out, code } = dryRun(
      ['--name', 'pr1408chainreal', '--profile', 'chain'],
      {
        GITHUB_SHA: '4f6f9201a5af181ae3699a576969982e9f9b91dd',
        BASE_SHA: '51615226f87001af2081b4637866e70ab2faf3e0',
        ADMISSION_GENERATED_AT: '2026-07-09T00:00:00Z',
      },
    );
    expect(code).toBe(0);
    const line = out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    expect(line).toBeTruthy();
    const json = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(json).toMatchObject({
      kind: 'isolated_rig_admission',
      tier: 'T3',
      duration_min: 2880,
      sha: '4f6f9201a5af181ae3699a576969982e9f9b91dd',
      base_sha: '51615226f87001af2081b4637866e70ab2faf3e0',
      driver_path: 'services/worker/scripts/pr1408-chain-resilience-driver.ts',
    });
    expect(json.driver_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(json.changed_behavior).toMatch(/PR #1408 chain resilience/);
    expect(json.stop_conditions).toContain('driver_path or driver_sha256 mismatch');
  });

  it('apply path has fail-closed secret checks, Supabase secret creation, clean preflight, and driver requirements', () => {
    expect(script).toMatch(/require_gcloud_secret "\$GETBLOCK_RPC_URL_SECRET"/);
    expect(script).toMatch(/require_gcloud_secret "\$GETBLOCK_RPC_AUTH_SECRET"/);
    expect(script).toMatch(/require_gcloud_secret "\$TREASURY_WIF_SECRET"/);
    expect(script).toMatch(/ensure_secret_with_value "\$SUPABASE_URL_SECRET_NAME"/);
    expect(script).toMatch(/supabase projects api-keys/);
    expect(script).toMatch(/strict environment_type=clean_mirror schema/);
    expect(script).toMatch(/STAGING_CHANGED_BEHAVIOR/);
    expect(script).toMatch(/DRIVER_PATH/);
  });
});

describe('provision-isolated-rig.sh — safety model preserved under the new overrides', () => {
  it('still hard-denies the prod + shared-staging refs', () => {
    expect(script).toMatch(/vzwyaatejekddvltxyye/);
    expect(script).toMatch(/ujtlwnoqfhtitcmsnrpq/);
    expect(script).toMatch(/deny\s/);
  });

  it('still requires --apply + CONFIRM_PROVISION for any live run (real config never auto-applies)', () => {
    expect(script).toMatch(/CONFIRM_PROVISION/);
    // A --profile chain run WITHOUT --apply must remain a dry-run (mutates nothing).
    const { out, code } = dryRun(['--name', 's0-s2a-chain', '--profile', 'chain']);
    expect(code).toBe(0);
    expect(out).toMatch(/DRY-RUN/);
  });

  it('requires a Supabase DB password for live project creation and never prints it', () => {
    const { code, out } = dryRun(
      ['--name', 's0-s2a-mock', '--profile', 'mock', '--apply'],
      { CONFIRM_PROVISION: 's0-s2a-mock' },
    );
    expect(code).not.toBe(0);
    expect(out).toMatch(/STAGING_NEW_SUPABASE_DB_PASSWORD/);

    const dry = dryRun(['--name', 's0-s2a-mock', '--profile', 'mock']);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/--db-password/);
    expect(dry.out).toMatch(/<redacted:STAGING_NEW_SUPABASE_DB_PASSWORD>/);
    expect(dry.out).not.toMatch(/test-db-password/);
  });

  it('refuses --apply for a real (non-mock) profile without an explicit real-config acknowledgement', () => {
    // Real anchoring/gemini rigs touch real credentials + (chain) real Bitcoin;
    // an --apply on a non-mock profile must require an extra explicit ack so a
    // real-money rig is never provisioned by a bare CONFIRM_PROVISION alone.
    const { code, out } = dryRun(
      ['--name', 's0-s2a-chain', '--profile', 'chain', '--apply'],
      { CONFIRM_PROVISION: 's0-s2a-chain' },
    );
    expect(code).not.toBe(0);
    expect(out).toMatch(/CONFIRM_REAL_CONFIG|real-config|non-mock/i);
  });
});

/**
 * L2-S2a-FIX (Sprint 3.3) — Step-4 Scheduler COMMAND VALIDITY.
 *
 * The merged SCRUM-2673 tests above regex-match the dry-run TEXT, which let
 * three stacked apply-mode defects through:
 *   1. `gcloud scheduler jobs create http` was invoked with --update-headers —
 *      an update-verb flag the create verb does not support → the command
 *      errors under --apply and NO Scheduler job is ever created.
 *   2. WORKER_URL carried a literal "<hash>" placeholder instead of the URL
 *      resolved from the deployed service (resolve_cloud_run_url()).
 *   3. The X-Cron-Secret header carried the literal "<from-…>" placeholder —
 *      never fetched from Secret Manager → cronAuth 401s every POST.
 *
 * These tests run the script in --apply mode against a FULLY STUBBED PATH
 * (gcloud + npx are shell stubs that log their argv and answer canned JSON),
 * so the assertions are on the EXACT argv the script executes — command
 * validity, not echo text. No real infra is touched: every binary with a
 * side effect is a stub.
 */

const STUB_CRON_SECRET = 'stub-cron-secret-value-8f3a17';
const STUB_SERVICE_URL = 'https://arkova-worker-stub.example.run.app';
const STUB_REVISION = 'arkova-worker-stub-00001-abc';
const STUB_IMAGE_DIGEST =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const STUB_IMAGE_REF =
  `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@${STUB_IMAGE_DIGEST}`;

interface ApplyRunResult {
  out: string;
  code: number;
  gcloudCalls: string[];
  npxCalls: string[];
  callOrder: string[];
  artifactDir: string;
}

interface ApplyRunOptions {
  imageRef?: string | null;
  deployedImageRef?: string;
  resolvedImageDigest?: string;
  sourceHead?: string | null;
  githubSha?: string | null;
  soakId?: string | null;
  tunedModel?: string;
  preflightPayload?: string;
  schedulerStateAfterPreflight?: 'PAUSED' | 'ENABLED' | 'MISSING';
  deployedEnvOverrides?: Record<string, string>;
  deployedEnvAdditions?: Record<string, string>;
  env?: Record<string, string>;
}

const stubDirs: string[] = [];

/** Run the provisioner with --apply against a stubbed gcloud/npx PATH. */
function applyRunStubbed(
  name: string,
  profile: string,
  options: ApplyRunOptions = {},
): ApplyRunResult {
  const stubDir = mkdtempSync(join(tmpdir(), 'provision-step4-stub-'));
  stubDirs.push(stubDir);
  const logFile = join(stubDir, 'gcloud-calls.log');
  const npxLogFile = join(stubDir, 'npx-calls.log');
  const orderLogFile = join(stubDir, 'call-order.log');
  const schedulerStateDir = join(stubDir, 'scheduler-state');
  const artifactDir = join(stubDir, 'artifacts');
  writeFileSync(logFile, '');
  writeFileSync(npxLogFile, '');
  writeFileSync(orderLogFile, '');

  const tunedModel =
    options.tunedModel ?? 'projects/arkova1/locations/us-central1/endpoints/6611494259700793344';
  const deployedEnv: Record<string, string> = {
    NODE_ENV: 'production',
    ENABLE_AI_FRAUD: 'false',
    ENABLE_AI_REPORTS: 'false',
    CORS_ALLOWED_ORIGINS: 'https://app.arkova.ai',
    FRONTEND_URL: options.env?.STAGING_FRONTEND_URL ?? 'https://app.arkova.ai',
    USE_MOCKS: profile === 'chain' ? 'false' : 'true',
    ENABLE_PROD_NETWORK_ANCHORING: profile === 'chain' ? 'true' : 'false',
    ...(profile === 'chain'
      ? {
          KMS_PROVIDER: options.env?.STAGING_KMS_PROVIDER ?? 'gcp',
          BITCOIN_NETWORK: options.env?.STAGING_BITCOIN_NETWORK ?? 'mainnet',
          BITCOIN_UTXO_PROVIDER: options.env?.STAGING_BITCOIN_UTXO_PROVIDER ?? 'getblock',
        }
      : {}),
    ...(profile === 'gemini'
      ? {
          GEMINI_TUNED_MODEL: tunedModel,
          GEMINI_V6_PROMPT: options.env?.STAGING_GEMINI_V6_PROMPT ?? 'true',
        }
      : {}),
    ...options.deployedEnvOverrides,
    ...options.deployedEnvAdditions,
  };
  const revisionPayload = JSON.stringify({
    metadata: { labels: { 'arkova-source-head': options.sourceHead ?? REPO_HEAD } },
    spec: {
      containers: [
        {
          image: options.deployedImageRef ?? STUB_IMAGE_REF,
          env: Object.entries(deployedEnv).map(([name, value]) => ({ name, value })),
        },
      ],
    },
    status: { imageDigest: options.resolvedImageDigest ?? STUB_IMAGE_DIGEST },
  });

  writeFileSync(
    join(stubDir, 'gcloud'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logFile}"
printf 'gcloud %s\\n' "$*" >> "${orderLogFile}"
if [[ "$1" == "run" && "$2" == "services" && "$3" == "describe" ]]; then
  if [[ "$*" == *"status.latestReadyRevisionName"* ]]; then
    echo '${STUB_REVISION}'
  else
    echo '${STUB_SERVICE_URL}'
  fi
  exit 0
fi
if [[ "$1" == "run" && "$2" == "revisions" && "$3" == "describe" ]]; then
  echo '${revisionPayload}'
  exit 0
fi
if [[ "$1" == "secrets" && "$2" == "versions" && "$3" == "access" ]]; then
  echo '${STUB_CRON_SECRET}'
  exit 0
fi
if [[ "$1" == "scheduler" && "$2" == "jobs" && "$3" == "pause" ]]; then
  mkdir -p '${schedulerStateDir}'
  printf 'PAUSED' > '${schedulerStateDir}/'$4
  exit 0
fi
if [[ "$1" == "scheduler" && "$2" == "jobs" && "$3" == "resume" ]]; then
  mkdir -p '${schedulerStateDir}'
  printf 'ENABLED' > '${schedulerStateDir}/'$4
  exit 0
fi
if [[ "$1" == "scheduler" && "$2" == "jobs" && "$3" == "describe" ]]; then
  cat '${schedulerStateDir}/'$4
  exit 0
fi
exit 0
`,
  );
  chmodSync(join(stubDir, 'gcloud'), 0o755);

  writeFileSync(
    join(stubDir, 'npx'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${npxLogFile}"
printf 'npx %s\\n' "$*" >> "${orderLogFile}"
if [[ "$1" == "supabase" && "$2" == "projects" && "$3" == "create" ]]; then
  echo '{"id":"abcdefghijklmnopqrst"}'
  exit 0
fi
if [[ "$1" == "supabase" ]]; then
  exit 0
fi
if [[ "$1" == "tsx" && "$2" == "scripts/ci/staging-honesty-preflight.ts" ]]; then
  ${options.schedulerStateAfterPreflight === 'ENABLED' ? `for state in '${schedulerStateDir}'/*; do printf 'ENABLED' > "$state"; done` : ':'}
  ${options.schedulerStateAfterPreflight === 'MISSING' ? `rm -f '${schedulerStateDir}'/*` : ':'}
  echo '${options.preflightPayload ?? JSON.stringify(VALID_PREFLIGHT_REPORT)}'
  exit 0
fi
echo "unexpected npx call: $*" >&2
exit 64
`,
  );
  chmodSync(join(stubDir, 'npx'), 0o755);

  const env: Record<string, string> = {
    PATH: `${stubDir}:${process.env.PATH ?? ''}`,
    CONFIRM_PROVISION: name,
    CONFIRM_REAL_CONFIG: profile,
    GITHUB_SHA: options.githubSha ?? REPO_HEAD,
    BASE_SHA: REPO_BASE,
    STAGING_ADMISSION_DIR: artifactDir,
    USER: 'rig-owner',
    // Apply-mode preconditions carried in by the concurrent main pipeline
    // (Supabase project create + per-rig runtime secrets + changed-behavior
    // admission). The Step-4 stub run must satisfy them to reach Step 4 and
    // run to completion; none of these touch real infra (project create / link /
    // push / api-keys all resolve through the npx stub above).
    STAGING_NEW_SUPABASE_DB_PASSWORD: 'stub-db-password-not-real',
    STAGING_NEW_SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role-key-not-real',
    STAGING_CHANGED_BEHAVIOR:
      'L2-S2a-FIX Step-4 Scheduler command validity under --apply (stubbed)',
  };
  if (options.imageRef !== null) env.STAGING_PINNED_IMAGE = options.imageRef ?? STUB_IMAGE_REF;
  if (options.sourceHead !== null) env.STAGING_SOURCE_HEAD_SHA = options.sourceHead ?? REPO_HEAD;
  if (options.soakId !== null) env.STAGING_SOAK_ID = options.soakId ?? `soak-${name}`;
  if (profile === 'gemini') {
    env.STAGING_GEMINI_TUNED_MODEL = tunedModel;
  }
  Object.assign(env, options.env ?? {});

  let out = '';
  let code = 0;
  try {
    out = execFileSync('bash', [SCRIPT, '--name', name, '--profile', profile, '--apply'], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    code = err.status ?? 1;
  }

  const gcloudCalls = readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  const npxCalls = readFileSync(npxLogFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  const callOrder = readFileSync(orderLogFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  return { out, code, gcloudCalls, npxCalls, callOrder, artifactDir };
}

afterAll(() => {
  for (const dir of stubDirs) rmSync(dir, { recursive: true, force: true });
});

describe('provision-isolated-rig.sh — Step-4 Scheduler command validity under --apply (L2-S2a-FIX)', () => {
  const result = applyRunStubbed('s2afix-chain', 'chain');
  const schedulerCreates = result.gcloudCalls.filter((c) =>
    c.startsWith('scheduler jobs create http'),
  );

  it('apply run completes cleanly against the stubbed infra', () => {
    expect(result.code, result.out).toBe(0);
  });

  it('creates Scheduler jobs with the create-verb --headers flag, never --update-headers', () => {
    expect(schedulerCreates.length).toBeGreaterThan(0);
    for (const call of schedulerCreates) {
      expect(call, 'create verb must use --headers').toContain('--headers=');
      expect(call, '--update-headers is an update-verb flag; create rejects it').not.toContain(
        '--update-headers',
      );
    }
  });

  it('resolves WORKER_URL from the deployed service — no literal <hash> placeholder in any executed --uri', () => {
    for (const call of schedulerCreates) {
      expect(call).not.toContain('<hash>');
      expect(call).toContain(`--uri=${STUB_SERVICE_URL}/jobs/`);
      expect(call).toContain(`--oidc-token-audience=${STUB_SERVICE_URL}`);
    }
  });

  it('fetches the cron secret from Secret Manager at apply time and passes the REAL value to cronAuth', () => {
    expect(
      result.gcloudCalls.some(
        (c) => c.startsWith('secrets versions access latest') && c.includes('--secret=cron-secret'),
      ),
      'must fetch the cron secret value via gcloud secrets versions access',
    ).toBe(true);
    for (const call of schedulerCreates) {
      expect(call, 'the executed header must carry the fetched secret value').toContain(
        `X-Cron-Secret=${STUB_CRON_SECRET}`,
      );
      expect(call, 'the <from-…> placeholder must never reach an executed command').not.toContain(
        '<from-',
      );
    }
  });

  it('never prints the cron secret value to stdout/stderr (redacted in the emitted plan)', () => {
    expect(result.out).not.toContain(STUB_CRON_SECRET);
  });

  it('chain profile arms the org-scoped drain: org-queue-scheduler Scheduler job is created (CTO R3)', () => {
    const orgQueue = schedulerCreates.find((c) =>
      c.includes('arkova-worker-s2afix-chain-staging-org-queue-scheduler'),
    );
    expect(orgQueue, 'chain SCHEDULER_JOBS must include org-queue-scheduler').toBeDefined();
    expect(orgQueue).toContain(`--uri=${STUB_SERVICE_URL}/jobs/org-queue-scheduler`);
  });

  it('deploys only the declared digest ref and stamps the declared source HEAD on the revision', () => {
    const deploy = result.gcloudCalls.find((call) => call.startsWith('run deploy '));
    expect(deploy).toContain(`--image=${STUB_IMAGE_REF}`);
    expect(deploy).toContain(`--labels=arkova-source-head=${REPO_HEAD}`);
  });

  it('re-reads the deployed revision and verifies its image digest and source-HEAD label', () => {
    expect(
      result.gcloudCalls.some(
        (call) =>
          call.startsWith(`run revisions describe ${STUB_REVISION}`) &&
          call.includes('--format=json'),
      ),
    ).toBe(true);
  });

  it('immediately pauses every created Scheduler job and verifies PAUSED before continuing', () => {
    for (const create of schedulerCreates) {
      const jobName = create.split(' ')[4];
      expect(create).toContain('--schedule=0 0 31 2 *');
      const createIndex = result.callOrder.indexOf(`gcloud ${create}`);
      const pauseIndex = result.callOrder.findIndex(
        (entry) => entry.startsWith(`gcloud scheduler jobs pause ${jobName} `),
      );
      const verifyIndex = result.callOrder.findIndex(
        (entry) =>
          entry.startsWith(`gcloud scheduler jobs describe ${jobName} `) &&
          entry.includes('value(state)'),
      );
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(pauseIndex).toBe(createIndex + 1);
      expect(verifyIndex).toBe(pauseIndex + 1);
    }
  });

  it('keeps Scheduler paused through seed + clean_mirror, then resumes and verifies ENABLED', () => {
    const lastPausedVerification = Math.max(
      ...result.callOrder
        .map((entry, index) =>
          entry.startsWith('gcloud scheduler jobs describe ') && entry.includes('value(state)')
            ? index
            : -1,
        )
        .filter((index) => index >= 0)
        .slice(0, schedulerCreates.length),
    );
    const seedIndex = result.callOrder.findIndex((entry) =>
      entry.startsWith('npx supabase db query --linked --file '),
    );
    const preflightIndex = result.callOrder.findIndex((entry) =>
      entry.startsWith('npx tsx scripts/ci/staging-honesty-preflight.ts '),
    );
    const firstResumeIndex = result.callOrder.findIndex((entry) =>
      entry.startsWith('gcloud scheduler jobs resume '),
    );
    expect(lastPausedVerification).toBeLessThan(seedIndex);
    expect(seedIndex).toBeLessThan(preflightIndex);
    expect(preflightIndex).toBeLessThan(firstResumeIndex);

    const resumes = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '));
    const cadenceUpdates = result.gcloudCalls.filter((call) =>
      call.startsWith('scheduler jobs update http '),
    );
    expect(resumes).toHaveLength(schedulerCreates.length);
    expect(cadenceUpdates).toHaveLength(schedulerCreates.length);
    for (const resume of resumes) {
      const jobName = resume.split(' ')[3];
      const resumeIndex = result.callOrder.indexOf(`gcloud ${resume}`);
      const cadenceUpdateIndex = result.callOrder.findIndex(
        (entry) =>
          entry.startsWith(`gcloud scheduler jobs update http ${jobName} `) &&
          entry.includes('--schedule=*/5 * * * *'),
      );
      expect(cadenceUpdateIndex).toBeGreaterThan(preflightIndex);
      expect(cadenceUpdateIndex).toBeLessThan(resumeIndex);
      const enabledVerification = result.callOrder.findIndex(
        (entry, index) =>
          index > resumeIndex &&
          entry.startsWith(`gcloud scheduler jobs describe ${jobName} `) &&
          entry.includes('value(state)'),
      );
      expect(enabledVerification).toBe(resumeIndex + 1);
    }
  });

  it('emits admission v2 with provenance, non-secret critical config, preflight artifact, Scheduler state, and soak id', () => {
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    expect(line).toBeTruthy();
    const json = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(json).toMatchObject({
      schema_version: 2,
      profile: 'chain',
      soak_id: 'soak-s2afix-chain',
      declared_source_head: REPO_HEAD,
      deployed_revision: STUB_REVISION,
      deployed_image_digest: STUB_IMAGE_DIGEST,
      deployed_source_head: REPO_HEAD,
      clean_mirror: {
        result: 'environment_type=clean_mirror',
        artifact: `${result.artifactDir}/clean-mirror-preflight-s2afix-chain.json`,
      },
      scheduler: {
        applicable: true,
        paused_through_clean_mirror: true,
        state: 'resumed_after_clean_mirror',
      },
      critical_config: {
        use_mocks: 'false',
        enable_prod_network_anchoring: 'true',
        bitcoin_network: 'mainnet',
        bitcoin_utxo_provider: 'getblock',
        kms_provider: 'gcp',
        gemini_tuned_model: '',
        gemini_v6_prompt: '',
        gemini_tuned_response_schema: '<unset>',
      },
    });
    expect(json.clean_mirror.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readFileSync(json.clean_mirror.artifact, 'utf8')).toContain('clean_mirror');
  });
});

describe('provision-isolated-rig.sh — admission pre-mutation guards', () => {
  it.each([
    ['missing explicit image', { imageRef: null }, /immutable|digest|image/i],
    [
      'mutable image tag',
      {
        imageRef:
          'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:mutable',
      },
      /immutable|digest|image/i,
    ],
    [
      'declared source mismatch',
      { sourceHead: 'dddddddddddddddddddddddddddddddddddddddd' },
      /source|HEAD|SHA|mismatch/i,
    ],
    ['missing soak id', { soakId: null }, /soak[_ -]?id/i],
  ] as const)('rejects %s before any infrastructure mutation', (_label, options, message) => {
    const result = applyRunStubbed(`guard-${String(_label).replace(/\s+/g, '-').slice(0, 20)}`, 'mock', options);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(message);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
    expect(result.gcloudCalls.some((call) => call.startsWith('scheduler jobs create '))).toBe(false);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
  });

  it('rejects a bare Gemini model label before project creation', () => {
    const result = applyRunStubbed('guard-gemini-model', 'gemini', {
      tunedModel: 'nessie-golden-v6',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/approved GCP project|canonical resource/i);
    expect(result.gcloudCalls).toEqual([]);
    expect(result.npxCalls).toEqual([]);
  });

  it('rejects a malformed full Gemini resource before project creation', () => {
    const result = applyRunStubbed('guard-gemini-resource', 'gemini', {
      tunedModel: 'projects/arkova 1/locations/us-central1/endpoints/6611494259700793344',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/approved GCP project|canonical resource/i);
    expect(result.gcloudCalls).toEqual([]);
    expect(result.npxCalls).toEqual([]);
  });

  it.each([
    [
      'foreign project',
      'projects/foreign-project/locations/us-central1/endpoints/6611494259700793344',
      {},
    ],
    [
      'foreign project even when the requested deployment project follows it',
      'projects/foreign-project/locations/us-central1/endpoints/6611494259700793344',
      { STAGING_GCP_PROJECT: 'foreign-project' },
    ],
    [
      'unapproved requested deployment project',
      'projects/arkova1/locations/us-central1/endpoints/6611494259700793344',
      { STAGING_GCP_PROJECT: 'foreign-project' },
    ],
    [
      'wrong region',
      'projects/arkova1/locations/europe-west1/endpoints/6611494259700793344',
      {},
    ],
    [
      'model resource',
      'projects/arkova1/locations/us-central1/models/6611494259700793344',
      {},
    ],
    [
      'publisher model resource',
      'projects/arkova1/locations/us-central1/publishers/google/models/gemini-2.5-pro',
      {},
    ],
    [
      'alphabetic endpoint id',
      'projects/arkova1/locations/us-central1/endpoints/endpoint-alpha',
      {},
    ],
    ['empty endpoint id', 'projects/arkova1/locations/us-central1/endpoints/', {}],
    [
      'trailing slash',
      'projects/arkova1/locations/us-central1/endpoints/6611494259700793344/',
      {},
    ],
    [
      'query suffix',
      'projects/arkova1/locations/us-central1/endpoints/6611494259700793344?alt=json',
      {},
    ],
  ])('rejects a non-canonical Gemini endpoint (%s) before any mutation', (_label, tunedModel, env) => {
    const result = applyRunStubbed(
      `gcanon-${String(_label).replace(/\s+/g, '-').slice(0, 12)}`,
      'gemini',
      { tunedModel, env },
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/live gemini provision/i);
    expect(result.gcloudCalls).toEqual([]);
    expect(result.npxCalls).toEqual([]);
  });

  it('binds a canonical Gemini endpoint to the configured approved project identity', () => {
    const result = applyRunStubbed('guard-gemini-approved-project', 'gemini', {
      tunedModel: 'projects/approved-s33/locations/us-central1/endpoints/1234567890',
      env: {
        STAGING_APPROVED_GCP_PROJECT: 'approved-s33',
        STAGING_GCP_PROJECT: 'approved-s33',
      },
    });

    expect(result.code, result.out).toBe(0);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(true);
  });

  it('rejects GEMINI_V6_PROMPT values other than exact true before project creation', () => {
    const result = applyRunStubbed('guard-gemini-prompt', 'gemini', {
      env: { STAGING_GEMINI_V6_PROMPT: 'false' },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/GEMINI_V6_PROMPT.+true/i);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
  });

  it.each([
    ['comma', 'https://app.arkova.ai,GEMINI_TUNED_RESPONSE_SCHEMA=bleed'],
    ['newline', 'https://app.arkova.ai\nGEMINI_TUNED_RESPONSE_SCHEMA=bleed'],
    ['control', `https://app.arkova.ai${String.fromCharCode(1)}bleed`],
  ])('rejects %s-delimited gcloud env injection before project creation', (_label, value) => {
    const result = applyRunStubbed(`guard-env-${_label}`, 'mock', {
      env: { STAGING_FRONTEND_URL: value },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/environment|delimiter|control/i);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
  });

  it.each([
    ['T0', '2880', REPO_BASE, /tier|T0/i],
    ['T1', '119', REPO_BASE, /duration|120|minimum/i],
    ['T2', '719', REPO_BASE, /duration|720|minimum/i],
    ['T3', '0', REPO_BASE, /duration|2880|positive/i],
    ['T3', '2879', REPO_BASE, /duration|2880|minimum/i],
    ['T3', '02880', REPO_BASE, /duration|integer|canonical/i],
    ['T3', '2880', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', /base|commit|merge-base/i],
    ['T3', '2880', REPO_HEAD, /base|merge-base|ancestor/i],
  ])(
    'rejects untruthful apply metadata tier=%s duration=%s base=%s before mutation',
    (tier, duration, baseSha, message) => {
      const result = applyRunStubbed(`guard-metadata-${tier.toLowerCase()}-${duration}`, 'mock', {
        env: { STAGING_TIER: tier, STAGING_DURATION_MIN: duration, BASE_SHA: baseSha },
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(message);
      expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
    },
  );

  it('accepts the exact constitutional T1 two-hour floor', () => {
    const result = applyRunStubbed('guard-tier-t1-floor', 'mock', {
      env: { STAGING_TIER: 'T1', STAGING_DURATION_MIN: '120', BASE_SHA: REPO_BASE },
    });
    expect(result.code, result.out).toBe(0);
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    const admission = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(admission).toMatchObject({ tier: 'T1', duration_min: 120 });
  });
});

describe('provision-isolated-rig.sh — failed preflight leaves Scheduler paused', () => {
  const result = applyRunStubbed('paused-on-failure', 'chain', {
    preflightPayload: '{"checks":[]}',
  });

  it('fails closed after clean_mirror rejection', () => {
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/environment_type/);
  });

  it('pauses every created job and never resumes any job', () => {
    const creates = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs create http '));
    const pauses = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs pause '));
    const updates = result.gcloudCalls.filter((call) =>
      call.startsWith('scheduler jobs update http '),
    );
    const resumes = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '));
    expect(creates.length).toBeGreaterThan(0);
    expect(pauses).toHaveLength(creates.length);
    expect(updates).toHaveLength(0);
    expect(resumes).toHaveLength(0);
  });
});

describe('provision-isolated-rig.sh — post-preflight Scheduler invariant', () => {
  it.each(['ENABLED', 'MISSING'] as const)(
    'fails when a trigger is %s after clean_mirror and never updates cadence or resumes',
    (schedulerStateAfterPreflight) => {
      const result = applyRunStubbed(`post-preflight-${schedulerStateAfterPreflight.toLowerCase()}`, 'chain', {
        schedulerStateAfterPreflight,
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/Scheduler|PAUSED|state/i);
      expect(
        result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs update http ')),
      ).toHaveLength(0);
      expect(result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '))).toHaveLength(0);
    },
  );
});

describe('provision-isolated-rig.sh — truthful observed provenance and config', () => {
  it('accepts a tag-form spec image only when status.imageDigest resolves to the requested digest', () => {
    const result = applyRunStubbed('resolved-digest', 'mock', {
      deployedImageRef:
        'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:immutable-build-tag',
    });
    expect(result.code, result.out).toBe(0);
    expect(
      result.gcloudCalls.some(
        (call) => call.startsWith(`run revisions describe ${STUB_REVISION}`) && call.includes('--format=json'),
      ),
    ).toBe(true);
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    const admission = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(admission.deployed_image_ref).toContain(':immutable-build-tag');
    expect(admission.deployed_image_digest).toBe(STUB_IMAGE_DIGEST);
  });

  it('rejects a mismatched resolved status.imageDigest', () => {
    const result = applyRunStubbed('bad-resolved-digest', 'mock', {
      resolvedImageDigest: `sha256:${'d'.repeat(64)}`,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/image digest mismatch/i);
  });

  it.each([
    ['wrong critical value', { USE_MOCKS: 'true' }],
    ['schema bleed', { GEMINI_TUNED_RESPONSE_SCHEMA: 'bleed' }],
  ])('rejects deployed revision env with %s', (_label, deployedEnvAdditions) => {
    const result = applyRunStubbed(`bad-env-${_label.replace(/\s+/g, '-')}`, 'chain', {
      deployedEnvAdditions,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/deployed revision|environment|GEMINI_TUNED_RESPONSE_SCHEMA/i);
    expect(result.out).not.toContain('ADMISSION_JSON=');
  });

  it('forces apply admission to the captured project ref even when a caller supplies an override', () => {
    const result = applyRunStubbed('captured-project-ref', 'mock', {
      env: { ADMISSION_SUPABASE_PROJECT_REF: 'prod-project-ref' },
    });
    expect(result.code, result.out).toBe(0);
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    const admission = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(admission.supabase_project_ref).toBe('abcdefghijklmnopqrst');
  }, 15_000);
});

describe('provision-isolated-rig.sh — strict clean_mirror evidence schema', () => {
  const validReport = VALID_PREFLIGHT_REPORT;

  it.each([
    ['wrong project', { ...validReport, staging_project_ref: 'vzwyaatejekddvltxyye' }],
    ['malformed timestamp', { ...validReport, timestamp: 'not-a-timestamp' }],
    ['unknown secret field', { ...validReport, service_role_key: 'secret-sentinel-must-not-leak' }],
  ])('rejects %s without emitting raw preflight data', (_label, payload) => {
    const result = applyRunStubbed(`preflight-${_label.replace(/\s+/g, '-')}`, 'mock', {
      preflightPayload: JSON.stringify(payload),
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/preflight|schema|project|timestamp/i);
    expect(result.out).not.toContain('secret-sentinel-must-not-leak');
    expect(result.out).not.toContain('ADMISSION_JSON=');
  });

  it.each([
    ['empty', 'empty checks', { ...validReport, checks: [] }],
    [
      'unknown',
      'unknown check',
      {
        ...validReport,
        checks: [...validReport.checks, { name: 'not-a-real-check', passed: true, details: '' }],
      },
    ],
    [
      'duplicate',
      'duplicate check',
      {
        ...validReport,
        checks: [
          ...validReport.checks,
          { name: 'staging_only_rows', passed: true, details: '' },
        ],
      },
    ],
  ])('rejects %s instead of trusting a hollow clean_mirror verdict', (id, _label, payload) => {
    const result = applyRunStubbed(`preflight-hollow-${id}`, 'mock', {
      preflightPayload: JSON.stringify(payload),
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/preflight|schema|checks/i);
    expect(result.out).not.toContain('ADMISSION_JSON=');
  });

  it('persists only allowlisted evidence and binds the captured project/timestamp', () => {
    const result = applyRunStubbed('preflight-sanitized', 'mock', {
      preflightPayload: JSON.stringify(validReport),
    });
    expect(result.code, result.out).toBe(0);
    const artifactPath = join(result.artifactDir, 'clean-mirror-preflight-preflight-sanitized.json');
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    expect(artifact).toEqual({
      environment_type: 'clean_mirror',
      staging_project_ref: 'abcdefghijklmnopqrst',
      timestamp: '2026-07-13T12:00:00.000Z',
      checks: REQUIRED_PREFLIGHT_CHECK_NAMES.map((name) => ({ name, passed: true })),
      artifact_rows: [],
      missing_from_staging: [],
      extra_vs_prod: [],
    });
    expect(readFileSync(artifactPath, 'utf8')).not.toContain('secret-looking-diagnostic');
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    const admission = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(admission.supabase_project_ref).toBe('abcdefghijklmnopqrst');
    expect(admission.clean_mirror.verified_at).toBe('2026-07-13T12:00:00.000Z');
  });
});

describe('provision-isolated-rig.sh — valid Gemini admission', () => {
  const endpoint = 'projects/arkova1/locations/us-central1/endpoints/6611494259700793344';
  const result = applyRunStubbed('admit-gemini', 'gemini', { tunedModel: endpoint });

  it('accepts a full endpoint resource and records exact non-secret prompt/schema values', () => {
    expect(result.code, result.out).toBe(0);
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    expect(line).toBeTruthy();
    const json = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(json.critical_config).toMatchObject({
      gemini_tuned_model: endpoint,
      gemini_v6_prompt: 'true',
      gemini_tuned_response_schema: '<unset>',
      use_mocks: 'true',
      enable_prod_network_anchoring: 'false',
    });
  });
});

describe('provision-isolated-rig.sh — Step-4 dry-run placeholders are labeled, not defect literals', () => {
  it('the chain-profile dry-run plan carries no literal <hash> URL and no <from-…> cron header', () => {
    const { out, code } = dryRun(['--name', 's2afix-dry', '--profile', 'chain']);
    expect(code).toBe(0);
    expect(out).not.toContain('<hash>');
    // Dry-run shows a clearly-labeled <redacted:…> placeholder for the secret,
    // but never the old defect literal that leaked into executed commands.
    // (%q escaping may prefix "<" with a backslash in the emitted plan.)
    expect(out).not.toMatch(/X-Cron-Secret=\\?<from-/);
  });
});
