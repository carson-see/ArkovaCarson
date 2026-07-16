import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReport,
  type PreflightReport,
} from '../ci/staging-honesty-preflight';

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
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const script = readFileSync(SCRIPT, 'utf8');
const stagingAgents = readFileSync(resolve(here, 'agents.md'), 'utf8');
const TEAM1_ADMISSION_PROVENANCE_RULE =
  '- Team1 accepts Team2 admission v2 only for Supabase organization `byhkazrpmivhcsuqjtva`, with `source_head_image_ref` pinned to the exact full-SHA tag in `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker` and `source_head_image_digest` equal to both input and deployed image digests. The input and deployed image refs must also be digest pins in that exact approved repository. The committed RIG-B1 fixture mirrors that producer packet; missing, malformed, cross-project, cross-repository, stale-head, or digest-mismatched provenance fails closed.';
const CANONICAL_CROSS_LANE_AGENTS_SHA256 =
  'cf8d4a9757b8f000290fe9807d9ba688f959817b2678bb7df2122bda7ec92acd';
const INTEGRATED_B1_PUBLIC_AUTHORITY_BINDING =
  'Production verification is code-bound to public key `arkova.s33.b1-evidence.ed25519.v1`, its SPKI fingerprint, operator, activation, and canonical genesis-roster root; envelopes must name that exact key id.';

// Apply-mode cases launch many short-lived git/gcloud/npx shell stubs. They
// finish in ~1s focused but can exceed Vitest's 5s default when the full
// 25-file staging suite runs concurrently on a loaded developer host.
vi.setConfig({ testTimeout: 20_000 });

// A wedged synchronous child must fail before Vitest's 20s budget so the test
// runner can report the actual subprocess timeout instead of hanging until the
// enclosing test is killed. Keep the default generous enough for the existing
// loaded-host/contention cases; the regression below injects a much smaller
// deadline without weakening those cases.
const PROVISION_CHILD_TIMEOUT_MS = 15_000;
const CHILD_TIMEOUT_EXIT_CODE = 124;

describe('scripts/staging/agents.md — exact cross-lane semantic union', () => {
  it('retains the complete 14-section body shared by both current lane heads', () => {
    const headings = stagingAgents.match(/^## .+$/gm) ?? [];
    expect(headings).toHaveLength(14);
    expect(new Set(headings).size).toBe(14);
    expect(createHash('sha256').update(stagingAgents).digest('hex')).toBe(
      CANONICAL_CROSS_LANE_AGENTS_SHA256,
    );
  });

  it('retains Team 1 admission provenance exactly once, beyond heading-count coverage', () => {
    expect(stagingAgents.split(TEAM1_ADMISSION_PROVENANCE_RULE)).toHaveLength(2);
  });

  it('retains the integrated B1 public-authority activation instead of the pre-activation null root', () => {
    expect(stagingAgents.split(INTEGRATED_B1_PUBLIC_AUTHORITY_BINDING)).toHaveLength(2);
    expect(stagingAgents).not.toContain(
      'The production verification key and SPKI fingerprint are code-owned and deliberately null',
    );
  });
});

interface SyncRunResult {
  out: string;
  code: number;
  timedOut: boolean;
  errorCode?: string;
}

function boundedChildTimeoutMs(requestedTimeoutMs: number): number {
  if (
    !Number.isInteger(requestedTimeoutMs) ||
    requestedTimeoutMs <= 0 ||
    requestedTimeoutMs > PROVISION_CHILD_TIMEOUT_MS
  ) {
    throw new Error(
      `child timeout must be an integer in 1..${PROVISION_CHILD_TIMEOUT_MS}ms; got ${requestedTimeoutMs}`,
    );
  }
  return requestedTimeoutMs;
}

function normalizeSyncRunFailure(error: unknown, timeoutMs: number): SyncRunResult {
  const err = error as {
    status?: number | null;
    code?: string;
    stdout?: unknown;
    stderr?: unknown;
  };
  const timedOut = err.code === 'ETIMEDOUT';
  const code = timedOut
    ? CHILD_TIMEOUT_EXIT_CODE
    : typeof err.status === 'number' && err.status !== 0
      ? err.status
      : 1;
  const stdout = err.stdout == null ? '' : String(err.stdout);
  const stderr = err.stderr == null ? '' : String(err.stderr);
  const timeoutDiagnostic = timedOut
    ? `ERROR: provisioner child ETIMEDOUT after ${timeoutMs}ms (reported code ${code}).\n`
    : '';
  return {
    out: `${stdout}${stderr}${timeoutDiagnostic}`,
    code,
    timedOut,
    errorCode: typeof err.code === 'string' ? err.code : undefined,
  };
}

const VALID_PREFLIGHT_REPORT: PreflightReport = {
  ...buildReport({
    projectRef: 'abcdefghijklmnopqrst',
    migrationRows: [{ version: '00000000000000', name: 'baseline_at_main_HEAD' }],
    submittedAnchorCount: 1,
    prodVersions: ['00000000000000'],
  }),
  timestamp: '2026-07-13T12:00:00.000Z',
};
VALID_PREFLIGHT_REPORT.checks[0].details = 'secret-looking-diagnostic-must-not-persist';
const REQUIRED_PREFLIGHT_CHECK_NAMES = VALID_PREFLIGHT_REPORT.checks.map(({ name }) => name);

/** Run the provisioner in dry-run (no --apply → no side effects) and capture stdout+stderr. */
function dryRun(
  args: string[],
  env: Record<string, string> = {},
  requestedChildTimeoutMs = PROVISION_CHILD_TIMEOUT_MS,
): SyncRunResult {
  const childTimeoutMs = boundedChildTimeoutMs(requestedChildTimeoutMs);
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: childTimeoutMs,
      killSignal: 'SIGKILL',
    });
    return { out, code: 0, timedOut: false };
  } catch (e) {
    return normalizeSyncRunFailure(e, childTimeoutMs);
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
    expect(script).toMatch(/--rig-id/);
    expect(script).toMatch(/--lease-id/);
    expect(script).toMatch(/--required-uptime-min/);
    expect(script).toMatch(/--required-wall-min/);
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
const RIG_B1_ISOLATED_INPUTS = {
  STAGING_GETBLOCK_RPC_URL_SECRET: 's33-rig-b1-bitcoin-rpc-url',
  STAGING_GETBLOCK_RPC_AUTH_SECRET: 's33-rig-b1-bitcoin-rpc-auth',
  STAGING_TREASURY_WIF_SECRET: 'rig-b1-wif-name',
  STAGING_STRIPE_SECRET_KEY_SECRET: 's33-rig-b1-stripe-secret-key',
  STAGING_STRIPE_WEBHOOK_SECRET_SECRET: 's33-rig-b1-stripe-webhook-secret',
  STAGING_API_KEY_HMAC_SECRET_SECRET: 'rig-b1-hmac-name',
  STAGING_CRON_SECRET_SECRET: 'rig-b1-cron-name',
  STAGING_RUNTIME_SA_EMAIL: 's33-rig-b1-runtime@arkova1.iam.gserviceaccount.com',
  STAGING_CRON_OIDC_SA: 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com',
} as const;
const RIG_B1_APPLY_ENV = {
  ...RIG_B1_ISOLATED_INPUTS,
  STAGING_BITCOIN_NETWORK: 'signet',
  STAGING_TIER: 'T3',
  STAGING_DURATION_MIN: '2880',
  STAGING_REQUIRED_WALL_MIN: '2910',
} as const;
const FORCE_ACCELERATED_RIG_B1_ENV = {
  ...RIG_B1_APPLY_ENV,
  STAGING_SCHEDULER_ACTIVATION_MODE: 'FORCE_ACCELERATED_RIG_ONLY',
  CONFIRM_SCHEDULER_ACTIVATION: 'FORCE_ACCELERATED_RIG_ONLY',
} as const;

interface ApplyRunResult extends SyncRunResult {
  gcloudCalls: string[];
  npxCalls: string[];
  callOrder: string[];
  gitCalls: string[];
  artifactDir: string;
  admissionArtifactPath: string;
  schedulerStates: Record<string, string>;
}

interface ApplyRunOptions {
  imageRef?: string | null;
  projectRef?: string;
  deployedImageRef?: string;
  resolvedImageDigest?: string;
  sourceHead?: string | null;
  githubSha?: string | null;
  soakId?: string | null;
  rigId?: string | null;
  leaseId?: string | null;
  tunedModel?: string;
  preflightPayload?: string;
  schedulerStateAfterPreflight?: 'PAUSED' | 'ENABLED' | 'MISSING';
  deployedEnvOverrides?: Record<string, string>;
  deployedEnvAdditions?: Record<string, string>;
  sourceImageDigest?: string;
  gitFetchFails?: boolean;
  useUntrackedDriver?: boolean;
  schedulerUpdateFailsAt?: number;
  schedulerResumeFailsAt?: number;
  schedulerEnabledVerificationFailsAt?: number;
  blockAdmissionArtifactPath?: boolean;
  failFinalStatePersistence?: boolean;
  b1InvokerGrantFails?: boolean;
  childTimeoutMs?: number;
  env?: Record<string, string>;
}

const stubDirs: string[] = [];

interface ApplyGitFixture {
  parent: string;
  repo: string;
  script: string;
  origin: string;
  head: string;
  base: string;
  nonBaseAncestor: string;
}

function createApplyGitFixture(): ApplyGitFixture {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'provision-git-fixture-')));
  const repo = join(parent, 'repo');
  const origin = join(parent, 'origin.git');
  const fixtureScript = join(repo, 'scripts/staging/provision-isolated-rig.sh');
  const fixtureDriver = join(repo, 'services/worker/scripts/pr1408-chain-resilience-driver.ts');
  const trustedGitPath = '/usr/bin/git';
  const trustedGitSha256 = createHash('sha256')
    .update(readFileSync(trustedGitPath))
    .digest('hex');
  const trustedGitVersion = execFileSync(trustedGitPath, ['--version'], {
    encoding: 'utf8',
  }).trim();
  const fixtureSource = script
    .replace(/TRUSTED_GIT_PATH="[^"]+"/, `TRUSTED_GIT_PATH="${trustedGitPath}"`)
    .replace(/TRUSTED_GIT_SHA256="[0-9a-f]+"/, `TRUSTED_GIT_SHA256="${trustedGitSha256}"`)
    .replace(/TRUSTED_GIT_VERSION="[^"]+"/, `TRUSTED_GIT_VERSION="${trustedGitVersion}"`)
    .replace(/TRUSTED_GIT_ORIGIN_URL="[^"]+"/, `TRUSTED_GIT_ORIGIN_URL="${origin}"`)
    .replace('GIT_ALLOW_PROTOCOL=https', 'GIT_ALLOW_PROTOCOL=file');

  mkdirSync(dirname(fixtureScript), { recursive: true });
  mkdirSync(dirname(fixtureDriver), { recursive: true });
  execFileSync(trustedGitPath, ['init', '--quiet', '--initial-branch=main', repo]);
  execFileSync(trustedGitPath, ['-C', repo, 'config', 'user.name', 'Provision Fixture']);
  execFileSync(trustedGitPath, ['-C', repo, 'config', 'user.email', 'fixture@arkova.invalid']);
  writeFileSync(join(repo, 'FIXTURE.md'), 'initial fixture history\n');
  execFileSync(trustedGitPath, ['-C', repo, 'add', '--', 'FIXTURE.md']);
  execFileSync(trustedGitPath, ['-C', repo, 'commit', '--quiet', '-m', 'fixture root']);
  const nonBaseAncestor = execFileSync(trustedGitPath, ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  writeFileSync(fixtureDriver, readFileSync(resolve(REPO_ROOT,
    'services/worker/scripts/pr1408-chain-resilience-driver.ts')));
  execFileSync(trustedGitPath, ['-C', repo, 'add', '--', fixtureDriver]);
  execFileSync(trustedGitPath, ['-C', repo, 'commit', '--quiet', '-m', 'fixture base']);
  const base = execFileSync(trustedGitPath, ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync(trustedGitPath, ['init', '--quiet', '--bare', origin]);
  execFileSync(trustedGitPath, ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync(trustedGitPath, ['-C', repo, 'push', '--quiet', '-u', 'origin', 'main']);

  writeFileSync(fixtureScript, fixtureSource);
  chmodSync(fixtureScript, 0o755);
  execFileSync(trustedGitPath, ['-C', repo, 'add', '--', fixtureScript]);
  execFileSync(trustedGitPath, ['-C', repo, 'commit', '--quiet', '-m', 'fixture candidate']);
  const head = execFileSync(trustedGitPath, ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  return { parent, repo, script: fixtureScript, origin, head, base, nonBaseAncestor };
}

const APPLY_FIXTURE = createApplyGitFixture();
stubDirs.push(APPLY_FIXTURE.parent);

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
  const gitLogFile = join(stubDir, 'git-calls.log');
  const schedulerStateDir = join(stubDir, 'scheduler-state');
  const schedulerConfigDir = join(stubDir, 'scheduler-config');
  const artifactDir = join(stubDir, 'artifacts');
  const admissionArtifactPath = join(artifactDir, `isolated-rig-admission-${name}.json`);
  const provisionStatePath = join(artifactDir, `isolated-rig-provision-${name}.json`);
  const updateCountFile = join(stubDir, 'scheduler-update-count');
  const resumeCountFile = join(stubDir, 'scheduler-resume-count');
  const enabledDescribeCountFile = join(stubDir, 'scheduler-enabled-describe-count');
  const finalSchedulerJobSuffix = profile === 'gemini'
    ? 'classify-proof-backcatalog'
    : options.rigId === 'RIG-B1'
      ? 'recover-broadcasts'
      : 'org-queue-scheduler';
  writeFileSync(logFile, '');
  writeFileSync(npxLogFile, '');
  writeFileSync(orderLogFile, '');
  writeFileSync(gitLogFile, '');
  if (options.blockAdmissionArtifactPath) {
    mkdirSync(admissionArtifactPath, { recursive: true });
  }

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
  const deployedSecretNames = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'API_KEY_HMAC_SECRET',
    'CRON_SECRET',
    ...(profile === 'chain'
      ? ['BITCOIN_RPC_URL', 'BITCOIN_RPC_AUTH', 'BITCOIN_TREASURY_WIF']
      : []),
    ...(profile === 'gemini' ? ['GEMINI_API_KEY'] : []),
  ];
  const revisionPayload = JSON.stringify({
    metadata: { labels: { 'arkova-source-head': options.sourceHead ?? APPLY_FIXTURE.head } },
    spec: {
      containers: [
        {
          image: options.deployedImageRef ?? STUB_IMAGE_REF,
          env: [
            ...Object.entries(deployedEnv).map(([name, value]) => ({ name, value })),
            ...deployedSecretNames.map((name) => ({
              name,
              valueSource: { secretKeyRef: { secret: `stub-${name.toLowerCase()}`, version: 'latest' } },
            })),
          ],
        },
      ],
    },
    status: { imageDigest: options.resolvedImageDigest ?? STUB_IMAGE_DIGEST },
  });

  writeFileSync(
    join(stubDir, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${gitLogFile}"
if [[ "$1" == "fetch" ]]; then
  ${options.gitFetchFails ? 'exit 1' : 'exit 0'}
fi
exec "${REAL_GIT}" "$@"
`,
  );
  chmodSync(join(stubDir, 'git'), 0o755);

  writeFileSync(
    join(stubDir, 'gcloud'),
	    `#!/usr/bin/env bash
	set -euo pipefail
	write_scheduler_config() {
	  local job_name="$1"
	  shift
	  local schedule='' time_zone='' attempt_deadline='' min_backoff='' max_backoff='' max_doublings=''
	  local arg
	  for arg in "$@"; do
	    case "$arg" in
	      --schedule=*) schedule="\${arg#--schedule=}" ;;
	      --time-zone=*) time_zone="\${arg#--time-zone=}" ;;
	      --attempt-deadline=*) attempt_deadline="\${arg#--attempt-deadline=}" ;;
	      --min-backoff=*) min_backoff="\${arg#--min-backoff=}" ;;
	      --max-backoff=*) max_backoff="\${arg#--max-backoff=}" ;;
	      --max-doublings=*) max_doublings="\${arg#--max-doublings=}" ;;
	    esac
	  done
	  mkdir -p '${schedulerConfigDir}'
	  printf '{"schedule":"%s","timeZone":"%s","attemptDeadline":"%s","retryConfig":{"minBackoffDuration":"%s","maxBackoffDuration":"%s","maxDoublings":%s}}\n' \
	    "$schedule" "$time_zone" "$attempt_deadline" "$min_backoff" "$max_backoff" "$max_doublings" \
	    > '${schedulerConfigDir}/'"$job_name"
	}
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
if [[ "$1" == "run" && "$2" == "services" && "$3" == "add-iam-policy-binding" ]]; then
  if [[ '${options.b1InvokerGrantFails ? 'true' : 'false'}' == 'true' ]]; then
    echo 'injected B1 service invoker grant failure' >&2
    exit 48
  fi
  exit 0
fi
if [[ "$1" == "run" && "$2" == "revisions" && "$3" == "describe" ]]; then
  echo '${revisionPayload}'
  exit 0
fi
if [[ "$1" == "artifacts" && "$2" == "docker" && "$3" == "images" && "$4" == "describe" ]]; then
  echo 'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@${options.sourceImageDigest ?? STUB_IMAGE_DIGEST}'
  exit 0
fi
	if [[ "$1" == "secrets" && "$2" == "versions" && "$3" == "access" ]]; then
  echo '${STUB_CRON_SECRET}'
	  exit 0
	fi
	if [[ "$1" == "scheduler" && "$2" == "jobs" && "$3" == "create" ]]; then
	  write_scheduler_config "$5" "$@"
	  exit 0
	fi
	if [[ "$1" == "scheduler" && "$2" == "jobs" && "$3" == "pause" ]]; then
  mkdir -p '${schedulerStateDir}'
  printf 'PAUSED' > '${schedulerStateDir}/'$4
  exit 0
fi
if [[ "$1" == "scheduler" && "$2" == "jobs" && "$3" == "update" ]]; then
  update_count=0
  if [[ -f '${updateCountFile}' ]]; then update_count="$(cat '${updateCountFile}')"; fi
  update_count=$((update_count + 1))
  printf '%s' "$update_count" > '${updateCountFile}'
  if [[ "$update_count" == '${options.schedulerUpdateFailsAt ?? 0}' ]]; then
    echo 'injected Scheduler update failure rc=41' >&2
	    exit 41
	  fi
	  write_scheduler_config "$5" "$@"
	  exit 0
fi
if [[ "$1" == "scheduler" && "$2" == "jobs" && "$3" == "resume" ]]; then
  mkdir -p '${schedulerStateDir}'
  resume_count=0
  if [[ -f '${resumeCountFile}' ]]; then resume_count="$(cat '${resumeCountFile}')"; fi
  resume_count=$((resume_count + 1))
  printf '%s' "$resume_count" > '${resumeCountFile}'
  if [[ "$resume_count" == '${options.schedulerResumeFailsAt ?? 0}' ]]; then
    echo 'injected Scheduler resume failure rc=42' >&2
    exit 42
  fi
  printf 'ENABLED' > '${schedulerStateDir}/'$4
  exit 0
fi
	if [[ "$1" == "scheduler" && "$2" == "jobs" && "$3" == "describe" ]]; then
	  if [[ "$*" == *"--format=json(schedule,timeZone,attemptDeadline,retryConfig)"* ]]; then
	    cat '${schedulerConfigDir}/'$4
	    exit 0
	  fi
	  scheduler_state="$(cat '${schedulerStateDir}/'$4)"
  if [[ "$scheduler_state" == 'ENABLED' ]]; then
    enabled_describe_count=0
    if [[ -f '${enabledDescribeCountFile}' ]]; then enabled_describe_count="$(cat '${enabledDescribeCountFile}')"; fi
    enabled_describe_count=$((enabled_describe_count + 1))
    printf '%s' "$enabled_describe_count" > '${enabledDescribeCountFile}'
    if [[ "$enabled_describe_count" == '${options.schedulerEnabledVerificationFailsAt ?? 0}' ]]; then
      printf 'PAUSED\n'
      exit 0
    fi
  fi
  if [[ '${options.failFinalStatePersistence ? 'true' : 'false'}' == 'true' \
    && "$scheduler_state" == 'ENABLED' && "$4" == *'-${finalSchedulerJobSuffix}' ]]; then
    rm -f '${provisionStatePath}'
    mkdir -p '${provisionStatePath}'
  fi
  printf '%s\n' "$scheduler_state"
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
  echo '{"id":"${options.projectRef ?? 'abcdefghijklmnopqrst'}"}'
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
    GITHUB_SHA: options.githubSha ?? APPLY_FIXTURE.head,
    BASE_SHA: APPLY_FIXTURE.base,
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
    STAGING_RIG_ID: options.rigId === null ? '' : (options.rigId ?? `rig-${name}`),
    STAGING_LEASE_ID: options.leaseId === null ? '' : (options.leaseId ?? `lease-${name}`),
  };
  if (options.useUntrackedDriver) {
    const untrackedDriver = join(stubDir, 'untracked-driver.ts');
    writeFileSync(untrackedDriver, 'export const untracked = true;\n');
    env.STAGING_DRIVER_PATH = untrackedDriver;
  }
  if (options.imageRef !== null) env.STAGING_PINNED_IMAGE = options.imageRef ?? STUB_IMAGE_REF;
  if (options.sourceHead !== null) {
    env.STAGING_SOURCE_HEAD_SHA = options.sourceHead ?? APPLY_FIXTURE.head;
  }
  if (options.soakId !== null) env.STAGING_SOAK_ID = options.soakId ?? `soak-${name}`;
  if (profile === 'gemini') {
    env.STAGING_GEMINI_TUNED_MODEL = tunedModel;
  }
  Object.assign(env, options.env ?? {});

  let out = '';
  let code = 0;
  let timedOut = false;
  let errorCode: string | undefined;
  const childTimeoutMs = boundedChildTimeoutMs(
    options.childTimeoutMs ?? PROVISION_CHILD_TIMEOUT_MS,
  );
  try {
    if (options.gitFetchFails) renameSync(APPLY_FIXTURE.origin, `${APPLY_FIXTURE.origin}.unavailable`);
    out = execFileSync('bash', [APPLY_FIXTURE.script, '--name', name, '--profile', profile, '--apply'], {
      cwd: APPLY_FIXTURE.repo,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: childTimeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (e) {
    const failure = normalizeSyncRunFailure(e, childTimeoutMs);
    out = failure.out;
    code = failure.code;
    timedOut = failure.timedOut;
    errorCode = failure.errorCode;
  } finally {
    if (options.gitFetchFails && existsSync(`${APPLY_FIXTURE.origin}.unavailable`)) {
      renameSync(`${APPLY_FIXTURE.origin}.unavailable`, APPLY_FIXTURE.origin);
    }
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
  const gitCalls = readFileSync(gitLogFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  const schedulerStates = existsSync(schedulerStateDir)
    ? Object.fromEntries(readdirSync(schedulerStateDir).map((jobName) => [
        jobName,
        readFileSync(join(schedulerStateDir, jobName), 'utf8'),
      ]))
    : {};
  return {
    out,
    code,
    timedOut,
    errorCode,
    gcloudCalls,
    npxCalls,
    callOrder,
    gitCalls,
    artifactDir,
    admissionArtifactPath,
    schedulerStates,
  };
}

afterAll(() => {
  for (const dir of stubDirs) rmSync(dir, { recursive: true, force: true });
});

describe('provision-isolated-rig.sh — bounded synchronous child execution', () => {
  it('terminates hung dry-run and apply helpers with deterministic ETIMEDOUT reporting', () => {
    const hangDir = mkdtempSync(join(tmpdir(), 'provision-child-timeout-'));
    stubDirs.push(hangDir);
    const bashEnv = join(hangDir, 'hang-before-provisioner.sh');
    writeFileSync(bashEnv, 'while :; do :; done\n');
    const timeoutMs = 150;
    const cases: Array<[string, () => SyncRunResult]> = [
      [
        'dryRun',
        () => dryRun(
          ['--name', 'bounded-dry-run'],
          { BASH_ENV: bashEnv },
          timeoutMs,
        ),
      ],
      [
        'applyRunStubbed',
        () => applyRunStubbed('bounded-apply-run', 'mock', {
          childTimeoutMs: timeoutMs,
          env: { BASH_ENV: bashEnv },
        }),
      ],
    ];

    for (const [helperName, run] of cases) {
      const startedAt = Date.now();
      const result = run();
      const elapsedMs = Date.now() - startedAt;
      expect(result.code, `${helperName}: ${result.out}`).toBe(CHILD_TIMEOUT_EXIT_CODE);
      expect(result.timedOut, helperName).toBe(true);
      expect(result.errorCode, helperName).toBe('ETIMEDOUT');
      expect(result.out, helperName).toContain(`ETIMEDOUT after ${timeoutMs}ms`);
      expect(elapsedMs, `${helperName} exceeded the bounded hang-test wall time`).toBeLessThan(2_000);
    }
  });
});

function expectEveryDeclaredSchedulerJobContainedAfter(
  result: ApplyRunResult,
  failureIndex: number,
): void {
  const jobNames = result.gcloudCalls
    .filter((call) => call.startsWith('scheduler jobs create http '))
    .map((call) => call.split(' ')[4]);
  expect(jobNames.length).toBeGreaterThan(1);

  const rollbackPauses = result.callOrder
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry, index }) =>
        index > failureIndex && entry.startsWith('gcloud scheduler jobs pause '),
    );
  expect(rollbackPauses).toHaveLength(jobNames.length);
  const lastRollbackPauseIndex = Math.max(...rollbackPauses.map(({ index }) => index));

  for (const jobName of jobNames) {
    expect(
      rollbackPauses.some(({ entry }) =>
        entry.startsWith(`gcloud scheduler jobs pause ${jobName} `),
      ),
      `containment must pause declared Scheduler job ${jobName}`,
    ).toBe(true);
    expect(
      result.callOrder.some(
        (entry, index) =>
          index > lastRollbackPauseIndex &&
          entry.startsWith(`gcloud scheduler jobs describe ${jobName} `) &&
          entry.includes('value(state)'),
      ),
      `containment must verify declared Scheduler job ${jobName} after pausing the full set`,
    ).toBe(true);
  }
}

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
    expect(deploy).toContain(`--labels=arkova-source-head=${APPLY_FIXTURE.head}`);
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

  it('keeps Scheduler paused through seed + clean_mirror and restores cadence without resuming', () => {
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
    const firstCadenceUpdateIndex = result.callOrder.findIndex((entry) =>
      entry.startsWith('gcloud scheduler jobs update http '),
    );
    expect(lastPausedVerification).toBeLessThan(seedIndex);
    expect(seedIndex).toBeLessThan(preflightIndex);
    expect(preflightIndex).toBeLessThan(firstCadenceUpdateIndex);

    const resumes = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '));
    const cadenceUpdates = result.gcloudCalls.filter((call) =>
      call.startsWith('scheduler jobs update http '),
    );
    expect(resumes).toHaveLength(0);
    expect(cadenceUpdates).toHaveLength(schedulerCreates.length);
    expect(cadenceUpdates.every((call) => !call.includes('--schedule=*/5 * * * *'))).toBe(true);
    for (const update of cadenceUpdates) {
      const jobName = update.split(' ')[4];
      const cadenceUpdateIndex = result.callOrder.indexOf(`gcloud ${update}`);
      expect(cadenceUpdateIndex).toBeGreaterThan(preflightIndex);
      const pausedVerification = result.callOrder.findIndex(
        (entry, index) =>
          index > cadenceUpdateIndex &&
          entry.startsWith(`gcloud scheduler jobs describe ${jobName} `) &&
          entry.includes('value(state)'),
      );
      expect(pausedVerification).toBe(cadenceUpdateIndex + 1);
    }
    expect(Object.values(result.schedulerStates).every((state) => state === 'PAUSED')).toBe(true);
  });

  it('emits admission v2 with provenance, non-secret critical config, preflight artifact, Scheduler state, and soak id', () => {
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    expect(line).toBeTruthy();
    const json = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(json).toMatchObject({
      schema_version: 2,
      profile: 'chain',
      soak_id: 'soak-s2afix-chain',
      declared_source_head: APPLY_FIXTURE.head,
      deployed_revision: STUB_REVISION,
      deployed_image_digest: STUB_IMAGE_DIGEST,
      deployed_source_head: APPLY_FIXTURE.head,
      clean_mirror: {
        result: 'environment_type=clean_mirror',
        artifact: `${result.artifactDir}/clean-mirror-preflight-s2afix-chain.json`,
      },
      scheduler: {
        applicable: true,
        paused_through_clean_mirror: true,
        activation_mode: 'PAUSED',
        state: 'paused_after_clean_mirror',
      },
    });
    expect(json.critical_config).toEqual({
      node_env: 'production',
      enable_ai_fraud: 'false',
      enable_ai_reports: 'false',
      frontend_url: 'https://app.arkova.ai',
      use_mocks: 'false',
      enable_prod_network_anchoring: 'true',
      bitcoin_network: 'mainnet',
      bitcoin_utxo_provider: 'getblock',
      kms_provider: 'gcp',
      gemini_tuned_model: '',
      gemini_v6_prompt: '',
      gemini_tuned_response_schema: '<unset>',
    });
    expect(json.clean_mirror.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readFileSync(json.clean_mirror.artifact, 'utf8')).toContain('clean_mirror');
  });
});

describe('provision-isolated-rig.sh — RIG-B1 identity, trigger specs, and admission bindings', () => {
  const leaseId = 'lease-rig-b1-s33-window';
  const result = applyRunStubbed('rig-b1-chain', 'chain', {
    rigId: 'RIG-B1',
    leaseId,
    env: RIG_B1_APPLY_ENV,
  });
  const schedulerCreates = result.gcloudCalls.filter((call) =>
    call.startsWith('scheduler jobs create http '),
  );
  const expectedSpecs = [
    {
      name: 'arkova-worker-rig-b1-chain-staging-batch-anchors-forced-flush',
      path: '/jobs/batch-anchors?force=true',
    },
    {
      name: 'arkova-worker-rig-b1-chain-staging-recover-broadcasts',
      path: '/jobs/recover-broadcasts',
    },
    {
      name: 'arkova-worker-rig-b1-chain-staging-org-queue-scheduler',
      path: '/jobs/org-queue-scheduler',
    },
  ];

  it('admits the explicit signet/T3 RIG-B1 declaration', () => {
    expect(result.code, result.out).toBe(0);
  });

  it.each(expectedSpecs)('creates distinct Scheduler job $name targeting exact $path', (spec) => {
    const create = schedulerCreates.find((call) => call.split(' ')[4] === spec.name);
    expect(create, `missing create for ${spec.name}`).toBeDefined();
    expect(create).toContain(`--uri=${STUB_SERVICE_URL}${spec.path}`);
  });

  it.each(expectedSpecs)('holds, pauses, re-observes, restores cadence, and retains $name paused', (spec) => {
    const createIndex = result.callOrder.findIndex((entry) =>
      entry.startsWith(`gcloud scheduler jobs create http ${spec.name} `),
    );
    const pauseIndex = result.callOrder.findIndex((entry) =>
      entry.startsWith(`gcloud scheduler jobs pause ${spec.name} `),
    );
    const preflightIndex = result.callOrder.findIndex((entry) =>
      entry.startsWith('npx tsx scripts/ci/staging-honesty-preflight.ts '),
    );
    const describeIndexes = result.callOrder
      .map((entry, index) =>
        entry.startsWith(`gcloud scheduler jobs describe ${spec.name} `) &&
        entry.includes('value(state)')
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    const updateIndex = result.callOrder.findIndex((entry) =>
      entry.startsWith(`gcloud scheduler jobs update http ${spec.name} `),
    );
    const resumeIndex = result.callOrder.findIndex((entry) =>
      entry.startsWith(`gcloud scheduler jobs resume ${spec.name} `),
    );

    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(result.callOrder[createIndex]).toContain('--schedule=0 0 31 2 *');
    expect(pauseIndex).toBe(createIndex + 1);
    expect(describeIndexes.some((index) => index === pauseIndex + 1)).toBe(true);
    expect(describeIndexes.some((index) => index > preflightIndex && index < updateIndex)).toBe(true);
    expect(updateIndex).toBeGreaterThan(preflightIndex);
    expect(resumeIndex).toBe(-1);
    expect(describeIndexes.some((index) => index === updateIndex + 1)).toBe(true);
  });

  it('binds rig/lease/location/floors, exact job specs, and sanitized clean_mirror bytes', () => {
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    expect(line).toBeTruthy();
    const admission = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    const artifactBytes = readFileSync(admission.clean_mirror.artifact);
    const attestationId = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;

    expect(admission).toMatchObject({
      schema_version: 2,
      rig_id: 'RIG-B1',
      gcp_project_id: 'arkova1',
      supabase_org_id: 'byhkazrpmivhcsuqjtva',
      region: 'us-central1',
      lease_id: leaseId,
      clean_mirror_attestation_id: attestationId,
      required_uptime_min: 2880,
      required_wall_min: 2910,
      duration_min: 2880,
      clean_mirror: { attestation_id: attestationId },
      scheduler: {
        applicable: true,
        paused_through_clean_mirror: true,
        activation_mode: 'PAUSED',
        state: 'paused_after_clean_mirror',
      },
    });
    expect(admission.critical_config).toEqual({
      node_env: 'production',
      enable_ai_fraud: 'false',
      enable_ai_reports: 'false',
      frontend_url: 'https://app.arkova.ai',
      use_mocks: 'false',
      enable_prod_network_anchoring: 'true',
      bitcoin_network: 'signet',
      bitcoin_utxo_provider: 'getblock',
      kms_provider: 'gcp',
      gemini_tuned_model: '',
      gemini_v6_prompt: '',
      gemini_tuned_response_schema: '<unset>',
    });
    expect(admission.scheduler.jobs).toEqual(
      expect.arrayContaining(expectedSpecs.map((spec) => expect.objectContaining(spec))),
    );
  });
});

describe('provision-isolated-rig.sh — W3-C fail-closed RIG-B1 activation', () => {
  const paused = applyRunStubbed('w3c-rig-b1-paused', 'chain', {
    rigId: 'RIG-B1',
    env: RIG_B1_APPLY_ENV,
  });
  const accelerated = applyRunStubbed('w3c-rig-b1-accelerated', 'chain', {
    rigId: 'RIG-B1',
    env: FORCE_ACCELERATED_RIG_B1_ENV,
  });

  const exactTopology = [
    ['batch-anchors', '/jobs/batch-anchors'],
    ['check-confirmations', '/jobs/check-confirmations'],
    ['populate-confirmation-proofs', '/jobs/populate-confirmation-proofs'],
    ['org-queue-scheduler', '/jobs/org-queue-scheduler'],
    ['batch-anchors-forced-flush', '/jobs/batch-anchors?force=true'],
    ['recover-broadcasts', '/jobs/recover-broadcasts'],
  ] as const;
  const bindingTopology = [
    ['batch-anchors', '*/30 * * * *', 'Etc/UTC', '120s'],
    ['check-confirmations', '*/30 * * * *', 'Etc/UTC', '300s'],
    ['populate-confirmation-proofs', '*/15 * * * *', 'Etc/UTC', '300s'],
    ['org-queue-scheduler', '0 * * * *', 'Etc/UTC', '600s'],
    ['batch-anchors-forced-flush', '0 3 * * *', 'America/New_York', '600s'],
    ['recover-broadcasts', '*/15 * * * *', 'Etc/UTC', '120s'],
  ] as const;

  it('freezes the exact six-job topology and uses only service-derived job identities', () => {
    expect(paused.code, paused.out).toBe(0);
    const creates = paused.gcloudCalls.filter((call) => call.startsWith('scheduler jobs create http '));
    expect(creates).toHaveLength(6);
    expect(creates.map((call) => {
      const parts = call.split(' ');
      const name = parts[4]!;
      const uri = parts.find((part) => part.startsWith('--uri='))!;
      return [name.replace('arkova-worker-w3c-rig-b1-paused-staging-', ''), uri
        .replace(`--uri=${STUB_SERVICE_URL}`, '')];
    })).toEqual(exactTopology);
  });

  it('defaults to PAUSED, records that state, and never silently resumes traffic', () => {
    expect(paused.code, paused.out).toBe(0);
    expect(paused.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '))).toEqual([]);
    expect(Object.values(paused.schedulerStates)).toHaveLength(6);
    expect(Object.values(paused.schedulerStates).every((state) => state === 'PAUSED')).toBe(true);
    const cadenceUpdates = paused.gcloudCalls.filter((call) =>
      call.startsWith('scheduler jobs update http '),
    );
    expect(cadenceUpdates).toHaveLength(6);
    expect(cadenceUpdates.map((call) => call.split('--schedule=')[1]!.split(' --time-zone=')[0])).toEqual([
      '*/30 * * * *',
      '*/30 * * * *',
      '*/15 * * * *',
      '0 * * * *',
      '0 3 * * *',
      '*/15 * * * *',
    ]);
    expect(cadenceUpdates.join('\n')).not.toContain('--schedule=*/5 * * * *');
    const line = paused.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!.slice('ADMISSION_JSON='.length)).scheduler).toMatchObject({
      activation_mode: 'PAUSED',
      state: 'paused_after_clean_mirror',
    });
  });

  it('carries the binding timezone, deadline, and retry topology through create/update and admission evidence', () => {
    expect(paused.code, paused.out).toBe(0);
    const admissionLine = paused.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    const admission = JSON.parse(admissionLine!.slice('ADMISSION_JSON='.length));
    for (const [suffix, schedule, timeZone, attemptDeadline] of bindingTopology) {
      const jobName = `arkova-worker-w3c-rig-b1-paused-staging-${suffix}`;
      const create = paused.gcloudCalls.find((call) => call.startsWith(`scheduler jobs create http ${jobName} `));
      const update = paused.gcloudCalls.find((call) => call.startsWith(`scheduler jobs update http ${jobName} `));
      for (const call of [create, update]) {
        expect(call).toContain(`--time-zone=${timeZone}`);
        expect(call).toContain(`--attempt-deadline=${attemptDeadline}`);
        expect(call).toContain('--min-backoff=5s');
        expect(call).toContain('--max-backoff=3600s');
        expect(call).toContain('--max-doublings=5');
      }
      expect(update).toContain(`--schedule=${schedule}`);
      expect(admission.scheduler.jobs).toContainEqual({
        name: jobName,
        path: exactTopology.find(([candidate]) => candidate === suffix)![1],
        schedule,
        time_zone: timeZone,
        attempt_deadline: attemptDeadline,
        retry: { min_backoff: '5s', max_backoff: '3600s', max_doublings: 5 },
      });
    }
  });

  it('re-observes binding config and lets acceleration change cadence only', () => {
    const configDescribes = paused.gcloudCalls.filter((call) =>
      call.startsWith('scheduler jobs describe ') &&
      call.includes('--format=json(schedule,timeZone,attemptDeadline,retryConfig)'),
    );
    expect(configDescribes).toHaveLength(6);
    for (const [suffix, , timeZone, attemptDeadline] of bindingTopology) {
      const jobName = `arkova-worker-w3c-rig-b1-accelerated-staging-${suffix}`;
      const update = accelerated.gcloudCalls.find((call) => call.startsWith(`scheduler jobs update http ${jobName} `));
      expect(update).toContain('--schedule=*/5 * * * *');
      expect(update).toContain(`--time-zone=${timeZone}`);
      expect(update).toContain(`--attempt-deadline=${attemptDeadline}`);
      expect(update).toContain('--min-backoff=5s');
      expect(update).toContain('--max-backoff=3600s');
      expect(update).toContain('--max-doublings=5');
    }
  });

  it('uses explicit per-rig secret and runtime/OIDC identities instead of shared defaults', () => {
    expect(paused.code, paused.out).toBe(0);
    const deploy = paused.gcloudCalls.find((call) => call.startsWith('run deploy '));
    expect(deploy).toContain(`--service-account=${RIG_B1_ISOLATED_INPUTS.STAGING_RUNTIME_SA_EMAIL}`);
    for (const secretName of Object.values(RIG_B1_ISOLATED_INPUTS).filter(
      (value) => !value.includes('@'),
    )) expect(deploy).toContain(secretName);
    const creates = paused.gcloudCalls.filter((call) => call.startsWith('scheduler jobs create http '));
    expect(creates.every((call) => call.includes(
      `--oidc-service-account-email=${RIG_B1_ISOLATED_INPUTS.STAGING_CRON_OIDC_SA}`,
    ))).toBe(true);
  });

  it('grants only the explicit B1 OIDC principal service-scoped invoker before Scheduler creation', () => {
    expect(paused.code, paused.out).toBe(0);
    const exactGrant = [
      'run services add-iam-policy-binding arkova-worker-w3c-rig-b1-paused-staging',
      `--member=serviceAccount:${RIG_B1_ISOLATED_INPUTS.STAGING_CRON_OIDC_SA}`,
      '--role=roles/run.invoker',
      '--region=us-central1',
      '--project=arkova1',
      '--condition=None',
      '--quiet',
    ];
    const grantCalls = paused.gcloudCalls.filter((call) =>
      call.startsWith('run services add-iam-policy-binding '),
    );
    expect(grantCalls).toHaveLength(1);
    for (const fragment of exactGrant) expect(grantCalls[0]).toContain(fragment);
    expect(paused.gcloudCalls.some((call) =>
      call.startsWith('projects add-iam-policy-binding ') && call.includes('roles/run.invoker'),
    )).toBe(false);
    const deployIndex = paused.callOrder.findIndex((entry) => entry.startsWith('gcloud run deploy '));
    const grantIndex = paused.callOrder.findIndex((entry) =>
      entry.startsWith('gcloud run services add-iam-policy-binding '),
    );
    const firstCreateIndex = paused.callOrder.findIndex((entry) =>
      entry.startsWith('gcloud scheduler jobs create http '),
    );
    expect(grantIndex).toBeGreaterThan(deployIndex);
    expect(grantIndex).toBeLessThan(firstCreateIndex);
  });

  it('fails closed before every Scheduler create when the B1 invoker grant fails', () => {
    const result = applyRunStubbed('w3c-rig-b1-invoker-denied', 'chain', {
      rigId: 'RIG-B1',
      env: RIG_B1_APPLY_ENV,
      b1InvokerGrantFails: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/invoker|IAM|grant|failure/i);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(true);
    expect(result.gcloudCalls.some((call) => call.startsWith('scheduler jobs create '))).toBe(false);
  });

  it('uses the CTO five-minute cadence only under explicit FORCE_ACCELERATED_RIG_ONLY confirmation', () => {
    expect(accelerated.code, accelerated.out).toBe(0);
    const updates = accelerated.gcloudCalls.filter((call) =>
      call.startsWith('scheduler jobs update http '),
    );
    const resumes = accelerated.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '));
    expect(updates).toHaveLength(6);
    expect(updates.every((call) => call.includes('--schedule=*/5 * * * *'))).toBe(true);
    expect(resumes).toHaveLength(6);
    expect(Object.values(accelerated.schedulerStates).every((state) => state === 'ENABLED')).toBe(true);
  });

  it('rejects accelerated activation without a second exact acknowledgement before mutation', () => {
    const result = applyRunStubbed('w3c-rig-b1-unconfirmed', 'chain', {
      rigId: 'RIG-B1',
      env: {
        ...RIG_B1_APPLY_ENV,
        STAGING_SCHEDULER_ACTIVATION_MODE: 'FORCE_ACCELERATED_RIG_ONLY',
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/FORCE_ACCELERATED_RIG_ONLY|activation.*confirm/i);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
  });

  it('rejects RIG-B1 shared-default secret and identity fallbacks before mutation', () => {
    const result = applyRunStubbed('w3c-rig-b1-shared-defaults', 'chain', {
      rigId: 'RIG-B1',
      env: {
        STAGING_BITCOIN_NETWORK: 'signet',
        STAGING_TIER: 'T3',
        STAGING_DURATION_MIN: '2880',
        STAGING_REQUIRED_WALL_MIN: '2910',
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/per-rig|explicit.*secret|runtime.*identity|OIDC/i);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
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

  it('rejects a foreign or cross-project source image repository before secrets or paid project creation', () => {
    const result = applyRunStubbed('guard-foreign-image', 'mock', {
      imageRef:
        `us-central1-docker.pkg.dev/foreign-project/foreign-repo/arkova-worker@${STUB_IMAGE_DIGEST}`,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/source image|repository|arkova-worker-images/i);
    expect(result.gcloudCalls.some((call) => call.startsWith('secrets '))).toBe(false);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(
      false,
    );
  });

  it('rejects a RIG-B1 Supabase organization override before paid project creation', () => {
    const result = applyRunStubbed('guard-b1-org', 'chain', {
      rigId: 'RIG-B1',
      env: {
        ...RIG_B1_APPLY_ENV,
        STAGING_SUPABASE_ORG: 'wrong-org-id',
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/RIG-B1|Supabase org|byhkazrpmivhcsuqjtva/i);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(
      false,
    );
  });

  const identityCases: Array<[string, string, string, ApplyRunOptions]> = [
    ['no-rig', 'missing rig id', 'mock', { rigId: null }],
    ['bad-rig', 'malformed rig id', 'mock', { rigId: 'RIG B1' }],
    ['no-lease', 'missing lease id', 'mock', { leaseId: null }],
    ['bad-lease', 'malformed lease id', 'mock', { leaseId: 'lease\nsmuggle' }],
    ['b1-mock', 'RIG-B1 mock profile', 'mock', {
      rigId: 'RIG-B1', env: RIG_B1_APPLY_ENV,
    }],
    ['b1-main', 'RIG-B1 mainnet chain', 'chain', {
      rigId: 'RIG-B1', env: RIG_B1_ISOLATED_INPUTS,
    }],
    [
      'b1-project',
      'RIG-B1 unapproved GCP project',
      'chain',
      {
        rigId: 'RIG-B1',
        env: {
          ...RIG_B1_APPLY_ENV,
          STAGING_GCP_PROJECT: 'foreign-project',
        },
      },
    ],
    [
      'b1-tier',
      'RIG-B1 non-T3 tier',
      'chain',
      {
        rigId: 'RIG-B1',
        env: {
          ...RIG_B1_ISOLATED_INPUTS,
          STAGING_BITCOIN_NETWORK: 'signet',
          STAGING_TIER: 'T2',
          STAGING_DURATION_MIN: '720',
        },
      },
    ],
    [
      'b1-uptime',
      'RIG-B1 non-2880 uptime',
      'chain',
      {
        rigId: 'RIG-B1',
        env: {
          ...RIG_B1_ISOLATED_INPUTS,
          STAGING_BITCOIN_NETWORK: 'signet',
          STAGING_DURATION_MIN: '2881',
          STAGING_REQUIRED_WALL_MIN: '2911',
        },
      },
    ],
    [
      'b1-wall',
      'RIG-B1 wall floor below 2910',
      'chain',
      {
        rigId: 'RIG-B1',
        env: {
          ...RIG_B1_ISOLATED_INPUTS,
          STAGING_BITCOIN_NETWORK: 'signet',
          STAGING_REQUIRED_WALL_MIN: '2909',
        },
      },
    ],
  ];

  it.each(identityCases)('rejects %s (%s) before every external mutation', (id, _label, profile, options) => {
    const result = applyRunStubbed(`guard-${id}`, profile, options);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/rig|lease|RIG-B1|profile|network|signet|project|tier|uptime|wall/i);
    expect(result.gcloudCalls).toEqual([]);
    expect(result.npxCalls).toEqual([]);
  });

  it.each([
    [
      'kms-provider',
      { STAGING_KMS_PROVIDER: 'aws' },
      /STAGING_KMS_PROVIDER.+gcp/i,
    ],
    [
      'utxo-provider',
      { STAGING_BITCOIN_UTXO_PROVIDER: 'mempool' },
      /STAGING_BITCOIN_UTXO_PROVIDER.+getblock/i,
    ],
    [
      'frontend-url',
      { STAGING_FRONTEND_URL: 'https://staging.arkova.ai' },
      /STAGING_FRONTEND_URL.+https:\/\/app\.arkova\.ai/i,
    ],
  ] as const)(
    'rejects the RIG-B1 %s mismatch before every external mutation',
    (id, criticalConfigOverride, message) => {
      const result = applyRunStubbed(`guard-b1-${id}`, 'chain', {
        rigId: 'RIG-B1',
        env: {
          ...RIG_B1_APPLY_ENV,
          ...criticalConfigOverride,
        },
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(message);
      expect(result.gcloudCalls).toEqual([]);
      expect(result.npxCalls).toEqual([]);
    },
  );

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
    expect(result.out).toMatch(/live (?:gemini provision|admission)/i);
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
    ['T0', '2880', APPLY_FIXTURE.base, /tier|T0/i],
    ['T1', '119', APPLY_FIXTURE.base, /duration|120|minimum/i],
    ['T2', '719', APPLY_FIXTURE.base, /duration|720|minimum/i],
    ['T3', '0', APPLY_FIXTURE.base, /duration|2880|positive/i],
    ['T3', '2879', APPLY_FIXTURE.base, /duration|2880|minimum/i],
    ['T3', '02880', APPLY_FIXTURE.base, /duration|integer|canonical/i],
    ['T3', '2880', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', /base|commit|merge-base/i],
    ['T3', '2880', APPLY_FIXTURE.nonBaseAncestor, /base|merge-base|ancestor/i],
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
      env: { STAGING_TIER: 'T1', STAGING_DURATION_MIN: '120', BASE_SHA: APPLY_FIXTURE.base },
    });
    expect(result.code, result.out).toBe(0);
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    const admission = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(admission).toMatchObject({ tier: 'T1', duration_min: 120 });
  });

  it('fails closed before mutation when origin/main cannot be refreshed', () => {
    const result = applyRunStubbed('guard-origin-fetch', 'mock', { gitFetchFails: true });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/fetch|origin\/main|base/i);
    expect(result.npxCalls).toEqual([]);
  });

  it('rejects an untracked driver instead of attesting working-tree-only bytes', () => {
    const result = applyRunStubbed('guard-untracked-driver', 'mock', {
      useUntrackedDriver: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/driver|tracked|declared.*HEAD/i);
    expect(result.npxCalls).toEqual([]);
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
    // One pause per job during creation plus one complete fail-closed re-pause
    // from the EXIT handler, even though the first pause set was already safe.
    expect(pauses).toHaveLength(creates.length * 2);
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

describe('provision-isolated-rig.sh — apply failure containment after Scheduler arming', () => {
  it('re-pauses and verifies every declared job while preserving a later cadence-update rc', () => {
    const result = applyRunStubbed('later-update-failure', 'chain', {
      schedulerUpdateFailsAt: 2,
    });
    const updateIndexes = result.callOrder
      .map((entry, index) => (entry.startsWith('gcloud scheduler jobs update http ') ? index : -1))
      .filter((index) => index >= 0);

    expect(result.code, result.out).toBe(41);
    expect(result.out).toMatch(/injected Scheduler update failure rc=41/);
    expect(updateIndexes).toHaveLength(2);
    expectEveryDeclaredSchedulerJobContainedAfter(result, updateIndexes[1]);
    expect(Object.values(result.schedulerStates).every((state) => state === 'PAUSED')).toBe(true);
    expect(result.out).not.toContain('ADMISSION_JSON=');
  }, 20_000);

  it('re-pauses every declared job and preserves the original rc after a partial resume', () => {
    const result = applyRunStubbed('partial-resume-failure', 'chain', {
      rigId: 'RIG-B1',
      env: FORCE_ACCELERATED_RIG_B1_ENV,
      schedulerResumeFailsAt: 2,
    });
    const creates = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs create http '));
    const pauses = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs pause '));
    const resumes = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '));

    expect(result.code, result.out).toBe(42);
    expect(result.out).toMatch(/injected Scheduler resume failure rc=42/);
    expect(creates.length).toBeGreaterThan(1);
    expect(resumes).toHaveLength(2);
    expect(pauses).toHaveLength(creates.length * 2);
    expect(Object.keys(result.schedulerStates)).toHaveLength(creates.length);
    expect(Object.values(result.schedulerStates).every((state) => state === 'PAUSED')).toBe(true);
    expect(result.out).not.toContain('ADMISSION_JSON=');
    expect(existsSync(result.admissionArtifactPath)).toBe(false);
    const resumeIndexes = result.callOrder
      .map((entry, index) => (entry.startsWith('gcloud scheduler jobs resume ') ? index : -1))
      .filter((index) => index >= 0);
    expectEveryDeclaredSchedulerJobContainedAfter(result, resumeIndexes[1]);
  }, 20_000);

  it('re-pauses every job when a later post-resume ENABLED verification fails', () => {
    const result = applyRunStubbed('enabled-verify-failure', 'chain', {
      rigId: 'RIG-B1',
      env: FORCE_ACCELERATED_RIG_B1_ENV,
      schedulerEnabledVerificationFailsAt: 2,
    });
    const resumeIndexes = result.callOrder
      .map((entry, index) => (entry.startsWith('gcloud scheduler jobs resume ') ? index : -1))
      .filter((index) => index >= 0);

    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/ENABLED|state mismatch/i);
    expect(resumeIndexes).toHaveLength(2);
    expectEveryDeclaredSchedulerJobContainedAfter(result, resumeIndexes[1] + 1);
    expect(Object.values(result.schedulerStates).every((state) => state === 'PAUSED')).toBe(true);
    expect(result.out).not.toContain('ADMISSION_JSON=');
  }, 20_000);

  it('re-pauses every job when final admission artifact persistence cannot start', () => {
    const result = applyRunStubbed('blocked-admission-path', 'chain', {
      rigId: 'RIG-B1',
      env: FORCE_ACCELERATED_RIG_B1_ENV,
      blockAdmissionArtifactPath: true,
    });
    const creates = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs create http '));
    const pauses = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs pause '));
    const resumes = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '));

    expect(result.code).not.toBe(0);
    expect(resumes).toHaveLength(creates.length);
    expect(pauses).toHaveLength(creates.length * 2);
    expect(Object.values(result.schedulerStates).every((state) => state === 'PAUSED')).toBe(true);
    expect(result.out).not.toContain('ADMISSION_JSON=');
    expect(existsSync(result.admissionArtifactPath) && statSync(result.admissionArtifactPath).isDirectory()).toBe(true);
    const resumeIndexes = result.callOrder
      .map((entry, index) => (entry.startsWith('gcloud scheduler jobs resume ') ? index : -1))
      .filter((index) => index >= 0);
    expectEveryDeclaredSchedulerJobContainedAfter(result, Math.max(...resumeIndexes) + 1);
  }, 20_000);

  it('withdraws the artifact and re-pauses every job when final state persistence fails afterward', () => {
    const result = applyRunStubbed('final-state-failure', 'chain', {
      rigId: 'RIG-B1',
      env: FORCE_ACCELERATED_RIG_B1_ENV,
      failFinalStatePersistence: true,
    });
    const creates = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs create http '));
    const pauses = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs pause '));
    const resumes = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '));

    expect(result.code, result.out).toBe(1);
    expect(resumes).toHaveLength(creates.length);
    expect(pauses).toHaveLength(creates.length * 2);
    expect(Object.values(result.schedulerStates).every((state) => state === 'PAUSED')).toBe(true);
    expect(result.out).not.toContain('ADMISSION_JSON=');
    expect(existsSync(result.admissionArtifactPath)).toBe(false);
    const resumeIndexes = result.callOrder
      .map((entry, index) => (entry.startsWith('gcloud scheduler jobs resume ') ? index : -1))
      .filter((index) => index >= 0);
    expectEveryDeclaredSchedulerJobContainedAfter(result, Math.max(...resumeIndexes) + 1);
  }, 20_000);
});

describe('provision-isolated-rig.sh — truthful observed provenance and config', () => {
  it('binds the supplied digest to the declared full-SHA Artifact Registry tag', () => {
    const result = applyRunStubbed('source-image-binding', 'mock');
    expect(result.code, result.out).toBe(0);
    expect(
      result.gcloudCalls.some(
        (call) =>
          call.startsWith('artifacts docker images describe ') &&
          call.includes(`arkova-worker:${APPLY_FIXTURE.head}`),
      ),
    ).toBe(true);
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    const admission = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(admission.source_head_image_ref).toContain(`arkova-worker:${APPLY_FIXTURE.head}`);
    expect(admission.source_head_image_digest).toBe(STUB_IMAGE_DIGEST);
  });

  it('rejects a stale-build digest before creating the paid project', () => {
    const result = applyRunStubbed('stale-source-image', 'mock', {
      sourceImageDigest: `sha256:${'d'.repeat(64)}`,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/declared source HEAD|image digest|build/i);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
  });

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
    ['extra', { UNDECLARED_FLAG: 'true' }],
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

  it('rejects a malformed created project ref before any downstream mutation', () => {
    const result = applyRunStubbed('bad-created-project-ref', 'mock', {
      projectRef: 'abcdefghijklmnopqrs1',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/project ref|lowercase|20/i);
    expect(
      result.npxCalls.filter((call) => call.startsWith('supabase projects create ')),
    ).toHaveLength(1);
    expect(
      result.npxCalls.filter(
        (call) =>
          call.startsWith('supabase link ') ||
          call.startsWith('supabase db push ') ||
          call.startsWith('supabase projects api-keys '),
      ),
    ).toHaveLength(0);
    expect(
      result.gcloudCalls.filter(
        (call) =>
          call.startsWith('secrets create ') ||
          call.startsWith('secrets versions add ') ||
          call.startsWith('run deploy ') ||
          call.startsWith('scheduler jobs create '),
      ),
    ).toHaveLength(0);
  });
});

describe('provision-isolated-rig.sh — mock state vocabulary', () => {
  it('never records scheduler_paused for a profile where Scheduler is not applicable', () => {
    expect(script).toMatch(
      /if \[\[ \$SCHEDULER_APPLICABLE_JSON == true \]\]; then\s+write_provision_state "clean_mirror_admitted_scheduler_paused" ""\s+else\s+write_provision_state "clean_mirror_admitted" ""/,
    );
  });
});

describe('provision-isolated-rig.sh — strict clean_mirror evidence schema', () => {
  const validReport = VALID_PREFLIGHT_REPORT;

  it.each([
    ['wrong project', { ...validReport, staging_project_ref: 'vzwyaatejekddvltxyye' }],
    ['malformed timestamp', { ...validReport, timestamp: 'not-a-timestamp' }],
    ['unknown secret field', { ...validReport, service_role_key: 'secret-sentinel-must-not-leak' }],
  ])(
    'rejects %s without emitting raw preflight data',
    (_label, payload) => {
      const result = applyRunStubbed(`preflight-${_label.replace(/\s+/g, '-')}`, 'mock', {
        preflightPayload: JSON.stringify(payload),
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/preflight|schema|project|timestamp/i);
      expect(result.out).not.toContain('secret-sentinel-must-not-leak');
      expect(result.out).not.toContain('ADMISSION_JSON=');
    },
    15_000,
  );

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
  ])(
    'rejects %s instead of trusting a hollow clean_mirror verdict',
    (id, _label, payload) => {
      const result = applyRunStubbed(`preflight-hollow-${id}`, 'mock', {
        preflightPayload: JSON.stringify(payload),
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/preflight|schema|checks/i);
      expect(result.out).not.toContain('ADMISSION_JSON=');
    },
    15_000,
  );

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
