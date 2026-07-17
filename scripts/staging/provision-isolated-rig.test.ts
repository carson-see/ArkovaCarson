import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
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
  '384d15932f5f78e047e15a0623cfee5daac623355366eb10622d88585ea498c9';
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

describe('provision-isolated-rig.sh — RIG-R authenticated ingress', () => {
  it('waits through deterministic runtime-SA propagation lag and binds the exact uniqueId', () => {
    const functionSource = script.match(
      /^wait_for_rig_r_runtime_identity_visibility\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const stubDir = mkdtempSync(join(tmpdir(), 'rig-r-sa-visibility-'));
    stubDirs.push(stubDir);
    const callCount = join(stubDir, 'describe-count');
    writeFileSync(join(stubDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(join(stubDir, 'gcloud'), `#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f '${callCount}' ]] || count="$(cat '${callCount}')"
count=$((count + 1))
printf '%s' "$count" > '${callCount}'
if (( count < 3 )); then exit 1; fi
printf '%s\n' '{"email":"s33-rig-r-runtime@arkova1.iam.gserviceaccount.com","uniqueId":"270018525501000000777"}'
`);
    chmodSync(join(stubDir, 'sleep'), 0o755);
    chmodSync(join(stubDir, 'gcloud'), 0o755);
    const testScript = `set -euo pipefail
export PATH='${stubDir}':"$PATH"
IS_RIG_R=1
RUNTIME_SA='s33-rig-r-runtime@arkova1.iam.gserviceaccount.com'
GCP_PROJECT='arkova1'
RIG_R_RUNTIME_SA_UNIQUE_ID='<uncaptured>'
${functionSource}
wait_for_rig_r_runtime_identity_visibility
printf 'captured=%s calls=%s\n' "$RIG_R_RUNTIME_SA_UNIQUE_ID" "$(cat '${callCount}')"
`;
    const out = execFileSync('bash', ['-c', testScript], { encoding: 'utf8' });
    expect(out).toContain(
      'email=s33-rig-r-runtime@arkova1.iam.gserviceaccount.com unique_id=270018525501000000777',
    );
    expect(out).toContain('captured=270018525501000000777 calls=3');
    expect(functionSource).toContain('refusing project IAM binding');
  });

  it('retries only the exact project-IAM propagation transient, proves membership, and fails other errors fast', () => {
    const functionSource = script.match(
      /^grant_rig_r_runtime_project_role_with_propagation_retry\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const runtimeSa = 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com';
    const role = 'roles/logging.logWriter';

    const successDir = mkdtempSync(join(tmpdir(), 'rig-r-project-iam-propagation-'));
    stubDirs.push(successDir);
    const successCount = join(successDir, 'grant-count');
    writeFileSync(join(successDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(join(successDir, 'gcloud'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == 'projects add-iam-policy-binding' ]]; then
  count=0
  [[ ! -f '${successCount}' ]] || count="$(cat '${successCount}')"
  count=$((count + 1))
  printf '%s' "$count" > '${successCount}'
  if (( count < 3 )); then
    printf '%s\n' 'ERROR: (gcloud.projects.add-iam-policy-binding) INVALID_ARGUMENT: Service account ${runtimeSa} does not exist.' >&2
    exit 1
  fi
  exit 0
fi
if [[ "$1 $2" == 'projects get-iam-policy' ]]; then
  printf '%s\n' '{"bindings":[{"role":"${role}","members":["serviceAccount:${runtimeSa}"]}]}'
  exit 0
fi
exit 64
`);
    chmodSync(join(successDir, 'sleep'), 0o755);
    chmodSync(join(successDir, 'gcloud'), 0o755);
    const successScript = `set -euo pipefail
export PATH='${successDir}':"$PATH"
RUNTIME_SA='${runtimeSa}'
GCP_PROJECT='arkova1'
${functionSource}
grant_rig_r_runtime_project_role_with_propagation_retry '${role}'
printf 'calls=%s\n' "$(cat '${successCount}')"
`;
    const successOut = execFileSync('bash', ['-c', successScript], { encoding: 'utf8' });
    expect(successOut).toContain(
      `role=${role} member=serviceAccount:${runtimeSa} grant_attempts=3`,
    );
    expect(successOut).toContain('calls=3');

    const failureDir = mkdtempSync(join(tmpdir(), 'rig-r-project-iam-fail-fast-'));
    stubDirs.push(failureDir);
    const failureCount = join(failureDir, 'grant-count');
    writeFileSync(join(failureDir, 'sleep'), '#!/usr/bin/env bash\nexit 99\n');
    writeFileSync(join(failureDir, 'gcloud'), `#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f '${failureCount}' ]] || count="$(cat '${failureCount}')"
count=$((count + 1))
printf '%s' "$count" > '${failureCount}'
printf '%s\n' 'ERROR: (gcloud.projects.add-iam-policy-binding) INVALID_ARGUMENT: Service account ${runtimeSa} does not exist.' >&2
printf '%s\n' 'ERROR: (gcloud.projects.add-iam-policy-binding) PERMISSION_DENIED: mixed unexpected error' >&2
exit 1
`);
    chmodSync(join(failureDir, 'sleep'), 0o755);
    chmodSync(join(failureDir, 'gcloud'), 0o755);
    const failureScript = `set -euo pipefail
export PATH='${failureDir}':"$PATH"
RUNTIME_SA='${runtimeSa}'
GCP_PROJECT='arkova1'
${functionSource}
grant_rig_r_runtime_project_role_with_propagation_retry '${role}'
`;
    expect(() => execFileSync('bash', ['-c', failureScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();
    expect(readFileSync(failureCount, 'utf8')).toBe('1');
  });

  it('binds only the frozen operator as Token Creator and rejects operator or membership drift', () => {
    const assertSource = script.match(
      /^assert_rig_r_frozen_operator_identity\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    const grantSource = script.match(
      /^grant_rig_r_runtime_impersonation\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(assertSource).toBeDefined();
    expect(grantSource).toBeDefined();
    const operator = '270018525501-compute@developer.gserviceaccount.com';
    const member = `serviceAccount:${operator}`;
    const role = 'roles/iam.serviceAccountTokenCreator';
    const runtimeSa = 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com';

    const runCase = (active: string, members: string[]) => {
      const root = mkdtempSync(join(tmpdir(), 'rig-r-token-creator-'));
      stubDirs.push(root);
      const log = join(root, 'gcloud.log');
      writeFileSync(join(root, 'gcloud'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> '${log}'
if [[ "$1 $2" == 'auth list' ]]; then printf '%s\n' '${active}'; exit 0; fi
if [[ "$1 $2 $3" == 'iam service-accounts add-iam-policy-binding' ]]; then exit 0; fi
if [[ "$1 $2 $3" == 'iam service-accounts get-iam-policy' ]]; then
  printf '%s\n' '${JSON.stringify({ bindings: [{ role, members }] })}'
  exit 0
fi
exit 64
`);
      chmodSync(join(root, 'gcloud'), 0o755);
      const testScript = `set -euo pipefail
export PATH='${root}':"$PATH"
IS_RIG_R=1
RUNTIME_SA='${runtimeSa}'
GCP_PROJECT='arkova1'
RIG_R_OPERATOR_SA='${operator}'
RIG_R_RUNTIME_IMPERSONATION_ROLE='${role}'
RIG_R_RUNTIME_IMPERSONATION_MEMBER='${member}'
${assertSource}
${grantSource}
grant_rig_r_runtime_impersonation
`;
      return { root, log, testScript };
    };

    const allowed = runCase(operator, [member]);
    const out = execFileSync('bash', ['-c', allowed.testScript], { encoding: 'utf8' });
    expect(out).toContain(`role=${role} member=${member}`);
    expect(readFileSync(allowed.log, 'utf8')).toContain(
      `iam service-accounts add-iam-policy-binding ${runtimeSa}`,
    );

    const wrongOperator = runCase('someone-else@arkova1.iam.gserviceaccount.com', [member]);
    expect(() => execFileSync('bash', ['-c', wrongOperator.testScript], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();
    expect(readFileSync(wrongOperator.log, 'utf8').trim().split('\n')).toHaveLength(1);

    const extraMember = runCase(operator, [member, 'serviceAccount:shadow@arkova1.iam.gserviceaccount.com']);
    expect(() => execFileSync('bash', ['-c', extraMember.testScript], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();
  });

  it('dry-runs the exact service-scoped runtime invoker grant after deploy', () => {
    const sourceHead = execFileSync(REAL_GIT, ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const sourceTree = execFileSync(REAL_GIT, ['-C', REPO_ROOT, 'rev-parse', 'HEAD^{tree}'], {
      encoding: 'utf8',
    }).trim();
    const provisionStartedAt = new Date(Date.now() - 60_000);
    const expiresAt = new Date(provisionStartedAt.getTime() + 60 * 60 * 60 * 1000);
    const runtimeServiceAccount = 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com';
    const service = 'arkova-worker-s33-r-staging';
    const { out, code } = dryRun(['--name', 's33-r', '--profile', 'gemini-release'], {
      STAGING_RIG_ID: 'RIG-R',
      STAGING_SOAK_ID: 'soak-r-invoker-fixture',
      STAGING_LEASE_ID: 'lease-r-invoker-fixture',
      STAGING_RUNTIME_SA_EMAIL: runtimeServiceAccount,
      STAGING_TIER: 'T3',
      STAGING_DURATION_MIN: '2880',
      STAGING_REQUIRED_WALL_MIN: '2910',
      STAGING_GCP_PROJECT: 'arkova1',
      STAGING_CLOUD_RUN_REGION: 'us-central1',
      STAGING_NEW_SUPABASE_PROJECT_NAME: 'arkova-soak-s33-r',
      STAGING_GEMINI_TUNED_MODEL:
        'projects/270018525501/locations/us-central1/models/6611494259700793344@1',
      STAGING_GEMINI_V6_PROMPT: 'true',
      STAGING_PINNED_IMAGE:
        `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:${sourceHead}@sha256:${'c'.repeat(64)}`,
      STAGING_SOURCE_HEAD_SHA: sourceHead,
      STAGING_RIG_R_CANDIDATE_TREE_SHA: sourceTree,
      STAGING_RIG_R_PROVISION_ARTIFACT_SHA256: `sha256:${'d'.repeat(64)}`,
      STAGING_RIG_R_PROVISION_STARTED_AT: provisionStartedAt.toISOString(),
      STAGING_RIG_R_EXPIRES_AT: expiresAt.toISOString(),
    });
    expect(code, out).toBe(0);
    const lines = out.split('\n');
    const deployIndex = lines.findIndex((line) => line.startsWith(`+ gcloud run deploy ${service} `));
    const grantIndex = lines.findIndex((line) => line.startsWith(
      `+ gcloud run services add-iam-policy-binding ${service} `,
    ));
    expect(deployIndex).toBeGreaterThan(-1);
    expect(grantIndex).toBeGreaterThan(deployIndex);
    expect(lines[deployIndex]).toContain('ENABLE_AI_EXTRACTION=true');
    expect(lines[deployIndex]).toContain('ENABLE_VERTEX_AI=true');
    expect(lines[grantIndex]).toContain(`--member=serviceAccount:${runtimeServiceAccount}`);
    expect(lines[grantIndex]).toContain('--role=roles/run.invoker');
    expect(lines[grantIndex]).toContain('--region=us-central1');
    expect(lines[grantIndex]).toContain('--project=arkova1');
    expect(lines[grantIndex]).toContain('--condition=None');
    expect(out).not.toMatch(/projects add-iam-policy-binding .*roles\/run\.invoker/u);
    expect(script).toContain('write_provision_state "rig_r_service_invoker_bound" ""');
  });

  it('waits for the exact runtime principal to reach the exact candidate app before admission', () => {
    const functionSource = script.match(
      /^wait_for_rig_r_runtime_ingress_readiness\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'rig-r-ingress-readiness-'));
    stubDirs.push(root);
    const calls = join(root, 'curl-count');
    const curlStub = join(root, 'curl');
    const sleepStub = join(root, 'sleep');
    const expectedSha = 'a'.repeat(40);
    const ingressToken = 'runtime-identity-token-that-must-not-appear';
    writeFileSync(curlStub, `#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f '${calls}' ]] || count="$(/bin/cat '${calls}')"
count=$((count + 1))
printf '%s' "$count" > '${calls}'
if (( count == 1 )); then
  printf '%s\n%s' '{"error":"IAM propagation"}' '403'
else
  printf '%s\n%s' '{"status":"healthy","checks":{"database":"ok"},"git_sha":"${expectedSha}"}' '200'
fi
`);
    writeFileSync(sleepStub, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(curlStub, 0o755);
    chmodSync(sleepStub, 0o755);
    const source = functionSource!
      .replace('/usr/bin/curl', `'${curlStub}'`)
      .replace('/bin/sleep', `'${sleepStub}'`);
    const testScript = `set -euo pipefail
IS_RIG_R=1
CLOUD_RUN_SERVICE='arkova-worker-s33-r-staging'
RUNTIME_SA='s33-rig-r-runtime@arkova1.iam.gserviceaccount.com'
DECLARED_SOURCE_HEAD='${expectedSha}'
resolve_cloud_run_url_for_service() { printf '%s\n' 'https://exact-rig-r.run.app'; }
gcloud() {
  [[ "$1 $2" == 'auth print-identity-token' ]] || return 64
  [[ "$*" == *'--impersonate-service-account=s33-rig-r-runtime@arkova1.iam.gserviceaccount.com'* ]] || return 65
  [[ "$*" == *'--audiences=https://exact-rig-r.run.app'* ]] || return 66
  printf '%s\n' '${ingressToken}'
}
${source}
wait_for_rig_r_runtime_ingress_readiness
`;
    const out = execFileSync('bash', ['-c', testScript], { encoding: 'utf8' });
    expect(out).toContain('exact principal reached exact candidate app after 2 attempt(s)');
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(out).not.toContain(ingressToken);
    expect(script).toContain('write_provision_state "rig_r_runtime_ingress_ready" ""');
  });

  it('fails the ingress readiness gate on a 200 from the wrong app identity', () => {
    const functionSource = script.match(
      /^wait_for_rig_r_runtime_ingress_readiness\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'rig-r-ingress-wrong-app-'));
    stubDirs.push(root);
    const curlStub = join(root, 'curl');
    writeFileSync(
      curlStub,
      `#!/usr/bin/env bash\nprintf '%s\\n%s' '{"status":"healthy","checks":{"database":"ok"},"git_sha":"${'b'.repeat(40)}"}' '200'\n`,
    );
    chmodSync(curlStub, 0o755);
    const source = functionSource!.replace('/usr/bin/curl', `'${curlStub}'`);
    const testScript = `set -euo pipefail
IS_RIG_R=1
CLOUD_RUN_SERVICE='arkova-worker-s33-r-staging'
RUNTIME_SA='s33-rig-r-runtime@arkova1.iam.gserviceaccount.com'
DECLARED_SOURCE_HEAD='${'a'.repeat(40)}'
resolve_cloud_run_url_for_service() { printf '%s\n' 'https://exact-rig-r.run.app'; }
gcloud() { printf '%s\n' 'memory-only-token'; }
${source}
wait_for_rig_r_runtime_ingress_readiness
`;
    expect(() => execFileSync('bash', ['-c', testScript], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();
  });

  it('reads both release AI flags from the deployed revision and rejects either flag when not true', () => {
    const observedValueSource = script.match(
      /^observed_revision_env_value\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    const verifySource = script.match(
      /^verify_deployed_revision_env\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(observedValueSource).toBeDefined();
    expect(verifySource).toBeDefined();

    const runReadback = (extraction: string, vertex: string): string => {
      const revision = JSON.stringify({
        spec: {
          containers: [{
            env: [
              { name: 'ENABLE_AI_EXTRACTION', value: extraction },
              { name: 'ENABLE_VERTEX_AI', value: vertex },
            ],
          }],
        },
      });
      const testScript = `set -eo pipefail
ENV_VARS=('ENABLE_AI_EXTRACTION=true' 'ENABLE_VERTEX_AI=true')
EXPECTED_REVISION_SECRETS=()
PROFILE='gemini-release'
${observedValueSource}
${verifySource}
verify_deployed_revision_env '${revision}'
printf 'extraction=%s vertex=%s\n' "$ADMISSION_ENABLE_AI_EXTRACTION" "$ADMISSION_ENABLE_VERTEX_AI"
`;
      return execFileSync('bash', ['-c', testScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    };

    expect(runReadback('true', 'true')).toContain('extraction=true vertex=true');
    expect(() => runReadback('false', 'true')).toThrow();
    expect(() => runReadback('true', 'false')).toThrow();
    expect(script).toContain('if $rig_id == "RIG-R"');
    expect(script).toContain('enable_ai_extraction: $enable_ai_extraction');
    expect(script).toContain('enable_vertex_ai: $enable_vertex_ai');
  });

  it('retries only frozen transient capability statuses and fails terminal responses without leaking payloads', () => {
    const functionSource = script.match(
      /^probe_tuned_gemini_preclock\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const fixture = JSON.parse(readFileSync(
      resolve(here, 'fixtures/s33-rig-r-preclock-probe-responses.json'),
      'utf8',
    )) as {
      retryable: Record<string, { httpStatus: number; body: unknown }>;
      terminal: Record<string, { httpStatus: number; body: unknown }>;
      success: { httpStatus: number; body: unknown };
    };
    const accessToken = 'test-access-token-that-must-not-appear';

    const runProbe = (
      name: string,
      responses: Array<{ httpStatus: number; body: unknown }>,
      deadlineSeconds?: number,
    ) => {
      const root = mkdtempSync(join(tmpdir(), `rig-r-preclock-${name}-`));
      stubDirs.push(root);
      const calls = join(root, 'curl-count');
      const responseFile = join(root, 'responses.ndjson');
      const curlStub = join(root, 'curl');
      const sleepStub = join(root, 'sleep');
      writeFileSync(
        responseFile,
        `${responses.map((response) => JSON.stringify(response)).join('\n')}\n`,
      );
      writeFileSync(curlStub, `#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f '${calls}' ]] || count="$(/bin/cat '${calls}')"
count=$((count + 1))
printf '%s' "$count" > '${calls}'
line="$(/usr/bin/sed -n "${'$'}{count}p" '${responseFile}')"
[[ -n "$line" ]] || line="$(/usr/bin/tail -n 1 '${responseFile}')"
printf '%s\n%s' "$(jq -c '.body' <<<"$line")" "$(jq -r '.httpStatus' <<<"$line")"
`);
      writeFileSync(sleepStub, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(curlStub, 0o755);
      chmodSync(sleepStub, 0o755);
      let source = functionSource!
        .replace('/usr/bin/curl', `'${curlStub}'`)
        .replace('/bin/sleep', deadlineSeconds == null ? `'${sleepStub}'` : '/bin/sleep');
      if (deadlineSeconds != null) {
        source = source.replace(
          'local timeout_seconds=300 interval_seconds=10',
          `local timeout_seconds=${deadlineSeconds} interval_seconds=1`,
        );
      }
      const testScript = `set -uo pipefail
CLOUD_RUN_REGION='us-central1'
IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER='270018525501'
${source}
probe_tuned_gemini_preclock '${accessToken}' '733010' 2>&1
code=$?
printf '\nPROBE_EXIT=%s\n' "$code"
exit 0
`;
      return {
        calls,
        out: execFileSync('bash', ['-c', testScript], { encoding: 'utf8' }),
      };
    };

    for (const [name, transient] of Object.entries(fixture.retryable)) {
      const { calls, out } = runProbe(name, [transient, fixture.success]);
      expect(out, name).toContain('PROBE_EXIT=0');
      expect(readFileSync(calls, 'utf8'), name).toBe('2');
      expect(out, name).toContain(
        `http=${transient.httpStatus} reason=${(transient.body as { error: { status: string } }).error.status}`,
      );
      expect(out, name).not.toContain(accessToken);
      expect(out, name).not.toContain(JSON.stringify(transient.body));
    }

    for (const [name, terminal] of Object.entries(fixture.terminal)) {
      const { calls, out } = runProbe(name, [terminal, fixture.success]);
      expect(out, name).toContain('PROBE_EXIT=1');
      expect(readFileSync(calls, 'utf8'), name).toBe('1');
      expect(out, name).not.toContain(accessToken);
      expect(out, name).not.toContain(JSON.stringify(terminal.body));
    }

    const { calls, out } = runProbe(
      'deadline',
      [fixture.retryable.permissionDenied],
      1,
    );
    expect(out).toContain('exhausted its 1s deadline');
    expect(out).toContain('PROBE_EXIT=1');
    expect(Number(readFileSync(calls, 'utf8'))).toBeGreaterThanOrEqual(1);
    expect(out).not.toContain(accessToken);
    expect(out).not.toContain(JSON.stringify(fixture.retryable.permissionDenied.body));
  });

  it('accepts the preserved endpoint-scoped DeployModel operation response', () => {
    const functionSource = script.match(
      /^parse_genie_deploy_operation_name\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const fixture = resolve(
      here,
      'fixtures/s33-rig-r-recovery9-deploy-model-operation.json',
    );
    const testScript = `set -euo pipefail
IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER='270018525501'
CLOUD_RUN_REGION='us-central1'
${functionSource}
raw="$(/bin/cat '${fixture}')"
parse_genie_deploy_operation_name "$raw" '733003'
`;
    expect(execFileSync('bash', ['-c', testScript], { encoding: 'utf8' }).trim()).toBe(
      'projects/270018525501/locations/us-central1/endpoints/733003/operations/2290366906311376896',
    );
  });

  it('retains the canonical location-scoped DeployModel operation response', () => {
    const functionSource = script.match(
      /^parse_genie_deploy_operation_name\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const fixture = resolve(
      here,
      'fixtures/s33-genie-location-scoped-deploy-model-operation.json',
    );
    const testScript = `set -euo pipefail
IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER='270018525501'
CLOUD_RUN_REGION='us-central1'
${functionSource}
raw="$(/bin/cat '${fixture}')"
parse_genie_deploy_operation_name "$raw" '733010'
`;
    expect(execFileSync('bash', ['-c', testScript], { encoding: 'utf8' }).trim()).toBe(
      'projects/270018525501/locations/us-central1/operations/123456',
    );
  });

  it('rejects the preserved DeployModel response under a different endpoint identity', () => {
    const functionSource = script.match(
      /^parse_genie_deploy_operation_name\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const fixture = resolve(
      here,
      'fixtures/s33-rig-r-recovery9-deploy-model-operation.json',
    );
    const testScript = `set -euo pipefail
IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER='270018525501'
CLOUD_RUN_REGION='us-central1'
${functionSource}
raw="$(/bin/cat '${fixture}')"
parse_genie_deploy_operation_name "$raw" '733010'
`;
    expect(() => execFileSync('bash', ['-c', testScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();
  });

  it('rejects DeployModel operation names from the wrong project', () => {
    const functionSource = script.match(
      /^parse_genie_deploy_operation_name\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const testScript = `set -euo pipefail
IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER='270018525501'
CLOUD_RUN_REGION='us-central1'
${functionSource}
raw='{"name":"projects/999999999999/locations/us-central1/endpoints/733010/operations/123456"}'
parse_genie_deploy_operation_name "$raw" '733010'
`;
    expect(() => execFileSync('bash', ['-c', testScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();
  });

  it('rejects non-numeric DeployModel operation identities', () => {
    const functionSource = script.match(
      /^parse_genie_deploy_operation_name\(\) \{[\s\S]*?^\}/mu,
    )?.[0];
    expect(functionSource).toBeDefined();
    const testScript = `set -euo pipefail
IMMUTABLE_AUTHORITY_LEDGER_PROJECT_NUMBER='270018525501'
CLOUD_RUN_REGION='us-central1'
${functionSource}
raw='{"name":"projects/270018525501/locations/us-central1/endpoints/733010/operations/not-numeric"}'
parse_genie_deploy_operation_name "$raw" '733010'
`;
    expect(() => execFileSync('bash', ['-c', testScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();
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
    expect(script).toMatch(/require_gcloud_secret "\$BITCOIN_CORE_RPC_URL_SECRET"/);
    expect(script).toMatch(/require_gcloud_secret "\$BITCOIN_CORE_RPC_AUTH_SECRET"/);
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
  it('pins the trusted Node launchers to the exact regular host binary tuple', () => {
    const trustedNode = '/opt/homebrew/Cellar/node/25.6.1/bin/node';
    expect(script.match(/RIG_(?:G1|R)_TRUSTED_NODE_PATH="[^"]+"/g)).toEqual([
      `RIG_G1_TRUSTED_NODE_PATH="${trustedNode}"`,
      `RIG_R_TRUSTED_NODE_PATH="${trustedNode}"`,
    ]);
    expect(script).toContain('! -f "$candidate" || -L "$candidate" || ! -x "$candidate"');
    expect(script).toContain(
      '! -f "$RIG_G1_TRUSTED_NODE_PATH" || -L "$RIG_G1_TRUSTED_NODE_PATH"',
    );
    expect(script).toContain(
      '! -f "$RIG_R_TRUSTED_NODE_PATH" || -L "$RIG_R_TRUSTED_NODE_PATH"',
    );
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
    expect(realpathSync(trustedNode)).toBe(trustedNode);
    expect(statSync(trustedNode).isFile()).toBe(true);
    expect(execFileSync(trustedNode, ['--version'], { encoding: 'utf8' }).trim()).toBe('v25.6.1');
    expect(createHash('sha256').update(readFileSync(trustedNode)).digest('hex')).toBe(
      '8b6a6d43e16ddc3cddaf1217fb75dbe7151e342e36317491bf3ef4a1ec5d4202',
    );
  });

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
const STUB_PREFLIGHT_SERVICE_ROLE_KEY = 'stub-preflight-service-role-key-c0f4a2';
const STUB_PREFLIGHT_CHILD_STDERR =
  `preflight-child-stderr-must-not-leak:${STUB_PREFLIGHT_SERVICE_ROLE_KEY}`;
const STUB_SERVICE_URL = 'https://arkova-worker-stub.example.run.app';
const STUB_REVISION = 'arkova-worker-stub-00001-abc';
const STUB_IMAGE_DIGEST =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const STUB_IMAGE_REF =
  `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@${STUB_IMAGE_DIGEST}`;
const B1_FIXTURE_KEYS = generateKeyPairSync('ed25519');
const B1_FIXTURE_PUBLIC_KEY_PEM = B1_FIXTURE_KEYS.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();
const B1_FIXTURE_PUBLIC_KEY_FINGERPRINT = createHash('sha256')
  .update(B1_FIXTURE_KEYS.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const RIG_B1_ISOLATED_INPUTS = {
  STAGING_BITCOIN_CORE_SIGNET_RPC_URL_SECRET:
    'arkova-s33-rig-b1-bitcoin-core-signet-rpc-url',
  STAGING_BITCOIN_CORE_SIGNET_RPC_AUTH_SECRET:
    'arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth',
  STAGING_TREASURY_WIF_SECRET: 'arkova-s33-rig-b1-treasury-wif-signet', // gitleaks:allow — resource name only
  STAGING_STRIPE_SECRET_KEY_SECRET: 'arkova-s33-rig-b1-stripe-secret-key',
  STAGING_STRIPE_WEBHOOK_SECRET_SECRET: 'arkova-s33-rig-b1-stripe-webhook-secret',
  STAGING_API_KEY_HMAC_SECRET_SECRET: 'arkova-s33-rig-b1-api-key-hmac', // gitleaks:allow — resource name only
  STAGING_CRON_SECRET_SECRET: 'arkova-s33-rig-b1-cron-secret', // gitleaks:allow — resource name only
  STAGING_RUNTIME_SA_EMAIL: 's33-rig-b1-runtime@arkova1.iam.gserviceaccount.com',
  STAGING_CRON_OIDC_SA: 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com',
} as const;
const RIG_B1_APPLY_ENV = {
  ...RIG_B1_ISOLATED_INPUTS,
  STAGING_BITCOIN_NETWORK: 'signet',
  STAGING_KMS_PROVIDER: 'gcp',
  STAGING_BITCOIN_UTXO_PROVIDER: 'rpc',
  STAGING_FRONTEND_URL: 'https://app.arkova.ai',
  STAGING_TIER: 'T3',
  STAGING_DURATION_MIN: '2880',
  STAGING_REQUIRED_WALL_MIN: '2910',
  STAGING_B1_CORPUS_DIGEST: `sha256:${'5'.repeat(64)}`,
  STAGING_B1_RELEASE_CANDIDATE_ID: 's33-w3-final-rc-fixture',
  STAGING_B1_TREASURY_ADDRESS: 'tb1qarkovas33rigb1treasuryfixture0000000000000',
  STAGING_B1_TREASURY_DESCRIPTOR:
    'addr(tb1qarkovas33rigb1treasuryfixture0000000000000)#deadbeef',
  STAGING_B1_TREASURY_SPLIT_PLAN_DIGEST:
    'sha256:ab70ac7cf0ef1b371258c86ee4d967fec199b156156fe214238440429df794d8',
  STAGING_B1_TREASURY_EXPECTED_TOTAL_SATS: '169639',
  STAGING_B1_RPC_URL_SECRET_VERSION: '1',
  STAGING_B1_RPC_AUTH_SECRET_VERSION: '2',
  STAGING_B1_TREASURY_WIF_SECRET_VERSION: '3',
  STAGING_B1_STRIPE_SECRET_KEY_VERSION: '4',
  STAGING_B1_STRIPE_WEBHOOK_SECRET_VERSION: '5',
  STAGING_B1_API_KEY_HMAC_SECRET_VERSION: '6',
  STAGING_B1_CRON_SECRET_VERSION: '7',
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
  provisionState: Record<string, unknown> | null;
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
  deployedSecretReferenceSchema?: 'legacy' | 'current' | 'hybrid' | 'malformed';
  duplicateDeployedSecretEnv?: boolean;
  preflightServiceRoleReadFails?: boolean;
  preflightServiceRoleEmpty?: boolean;
  preflightChildStderrFails?: boolean;
  sourceImageDigest?: string;
  gitFetchFails?: boolean;
  useUntrackedDriver?: boolean;
  schedulerUpdateFailsAt?: number;
  schedulerResumeFailsAt?: number;
  schedulerEnabledVerificationFailsAt?: number;
  blockAdmissionArtifactPath?: boolean;
  failFinalStatePersistence?: boolean;
  b1InvokerGrantFails?: boolean;
  secretVersionResourceProject?: string;
  secretVersionResourceSecret?: string;
  secretVersionResourceVersion?: string;
  ledgerRetentionUntil?: string;
  topologyLedgerRetentionUntil?: string;
  supabaseProjectStatuses?: string[];
  supabaseDbResolves?: boolean;
  supabaseDbTcpAccepts?: boolean;
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
  tree: string;
  startupSha256: string;
  teardownSha256: string;
  base: string;
  nonBaseAncestor: string;
}

function createApplyGitFixture(): ApplyGitFixture {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'provision-git-fixture-')));
  const repo = join(parent, 'repo');
  const origin = join(parent, 'origin.git');
  const fixtureScript = join(repo, 'scripts/staging/provision-isolated-rig.sh');
  const fixtureDriver = join(repo, 'services/worker/scripts/pr1408-chain-resilience-driver.ts');
  const fixtureStartup = join(repo, 'scripts/staging/start-rig-b1-bitcoin-core.sh');
  const fixtureB1Verifier = join(repo, 'scripts/staging/s33-b1-node-approval.mjs');
  const fixtureTeardown = join(repo, 'scripts/staging/teardown-isolated-rig.sh');
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
    .replace(/RIG_G1_TRUSTED_NODE_PATH="[^"]+"/, `RIG_G1_TRUSTED_NODE_PATH="${process.execPath}"`)
    .replace('GIT_ALLOW_PROTOCOL=https', 'GIT_ALLOW_PROTOCOL=file');
  const fixtureB1VerifierSource = readFileSync(
    resolve(REPO_ROOT, 'scripts/staging/s33-b1-node-approval.mjs'),
    'utf8',
  )
    .replace(
      /const PUBLIC_KEY_PEM =\n {2}'[^']+';/,
      `const PUBLIC_KEY_PEM =\n  ${JSON.stringify(B1_FIXTURE_PUBLIC_KEY_PEM)};`,
    )
    .replace(
      /fingerprint: '[0-9a-f]{64}'/,
      `fingerprint: '${B1_FIXTURE_PUBLIC_KEY_FINGERPRINT}'`,
    );

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
  writeFileSync(
    fixtureStartup,
    readFileSync(resolve(REPO_ROOT, 'scripts/staging/start-rig-b1-bitcoin-core.sh')),
  );
  writeFileSync(fixtureB1Verifier, fixtureB1VerifierSource);
  writeFileSync(
    fixtureTeardown,
    readFileSync(resolve(REPO_ROOT, 'scripts/staging/teardown-isolated-rig.sh')),
  );
  chmodSync(fixtureScript, 0o755);
  chmodSync(fixtureStartup, 0o755);
  chmodSync(fixtureB1Verifier, 0o755);
  chmodSync(fixtureTeardown, 0o755);
  execFileSync(trustedGitPath, [
    '-C', repo, 'add', '--', fixtureScript, fixtureStartup, fixtureB1Verifier, fixtureTeardown,
  ]);
  execFileSync(trustedGitPath, ['-C', repo, 'commit', '--quiet', '-m', 'fixture candidate']);
  const head = execFileSync(trustedGitPath, ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const tree = execFileSync(trustedGitPath, ['-C', repo, 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8',
  }).trim();
  const startupSha256 = createHash('sha256').update(readFileSync(fixtureStartup)).digest('hex');
  const teardownSha256 = createHash('sha256').update(readFileSync(fixtureTeardown)).digest('hex');
  return {
    parent,
    repo,
    script: fixtureScript,
    origin,
    head,
    tree,
    startupSha256,
    teardownSha256,
    base,
    nonBaseAncestor,
  };
}

const APPLY_FIXTURE = createApplyGitFixture();
stubDirs.push(APPLY_FIXTURE.parent);

function b1SecretReference(env: string, secretName: string, version: string) {
  return {
    env,
    secretName,
    version,
    resource: `projects/arkova1/secrets/${secretName}/versions/${version}`,
  };
}

function writeB1ApprovalFixture(
  artifactPath: string,
  name: string,
  options: ApplyRunOptions,
): void {
  const fixtureEnv = { ...RIG_B1_APPLY_ENV, ...(options.env ?? {}) };
  const service = `arkova-worker-${name}-staging`;
  const soakId = options.soakId ?? `soak-${name}`;
  const leaseId = options.leaseId ?? `lease-${name}`;
  const treasuryAddress = fixtureEnv.STAGING_B1_TREASURY_ADDRESS;
  const treasuryDescriptor = fixtureEnv.STAGING_B1_TREASURY_DESCRIPTOR;
  const bitcoinCoreImage =
    'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8';
  const bitcoinCoreRecipeCommit = 'b9a54856c9bee87d958cc4b070776828b5c17b32';
  const bitcoinCoreAmd64RuntimeDigest =
    'sha256:684e80900f124890c45ad9b691d7f76456c1042385bce4ab92725b1979b55888';
  const issuedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiresAt = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const signedPayload = {
    schemaVersion: 1,
    approvalId: `b1-node-approval-${name}`,
    authority: {
      keyId: 'arkova.s33.b1-evidence.ed25519.v1',
      approverIdentity: 'arkova.s33.approver.founder-cto.v1',
      purpose: 'RIG_B1_BITCOIN_CORE_PROVISION',
    },
    candidate: {
      sourceHeadSha: options.sourceHead ?? APPLY_FIXTURE.head,
      sourceTreeSha: APPLY_FIXTURE.tree,
      workerImage: options.imageRef ?? STUB_IMAGE_REF,
      workerImageDigest: STUB_IMAGE_DIGEST,
      bitcoinCoreRecipeCommit,
      bitcoinCoreImage,
      bitcoinCoreAmd64RuntimeDigest,
      startupScriptSha256: `sha256:${APPLY_FIXTURE.startupSha256}`,
      teardownScriptSha256: `sha256:${APPLY_FIXTURE.teardownSha256}`,
      corpusDigest: fixtureEnv.STAGING_B1_CORPUS_DIGEST,
      releaseCandidateId: fixtureEnv.STAGING_B1_RELEASE_CANDIDATE_ID,
    },
    run: {
      rigId: 'RIG-B1',
      rigName: name,
      soakId,
      leaseId,
      workerService: service,
      workerRuntimeServiceAccount: fixtureEnv.STAGING_RUNTIME_SA_EMAIL,
      schedulerOidcServiceAccount: fixtureEnv.STAGING_CRON_OIDC_SA,
    },
    topology: {
      provider: {
        workerProvider: 'rpc',
        primary: 'bitcoin-core-signet-rpc',
        secondary: 'mempool-space-signet',
        secondaryApiUrl: 'https://mempool.space/signet/api',
      },
      bitcoinCore: {
        version: '31.1',
        recipeCommit: bitcoinCoreRecipeCommit,
        sourceTarballUrl:
          'https://bitcoincore.org/bin/bitcoin-core-31.1/bitcoin-31.1-x86_64-linux-gnu.tar.gz',
        sourceTarballSha256:
          'b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e',
        containerImage: bitcoinCoreImage,
        amd64RuntimeDigest: bitcoinCoreAmd64RuntimeDigest,
        startupScriptPath: 'scripts/staging/start-rig-b1-bitcoin-core.sh',
        startupScriptSha256: `sha256:${APPLY_FIXTURE.startupSha256}`,
      },
      resources: {
        zone: 'us-central1-a',
        vm: 'arkova-s33-rig-b1-bitcoin-core-signet',
        bootDisk: 'arkova-s33-rig-b1-bitcoin-core-signet-boot',
        dataDisk: 'arkova-s33-rig-b1-bitcoin-core-signet-data',
        internalAddress: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-ip',
        externalAddress: 'arkova-s33-rig-b1-bitcoin-core-signet-p2p-ip',
        network: 'arkova-s33-rig-b1-bitcoin-core-signet-vpc',
        subnet: 'arkova-s33-rig-b1-bitcoin-core-signet-subnet',
        rpcFirewall: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc',
        vpcConnector: 'arkova-s33-rig-b1-bitcoin-core-signet-connector',
        nodeServiceAccount: 's33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
      },
      schedulerJobs: [
        `${service}-batch-anchors`,
        `${service}-batch-anchors-forced-flush`,
        `${service}-check-confirmations`,
        `${service}-org-queue-scheduler`,
        `${service}-populate-confirmation-proofs`,
        `${service}-recover-broadcasts`,
      ],
      iam: {
        artifactRegistryReader: {
          repository:
            'projects/arkova1/locations/us-central1/repositories/arkova-worker-images',
          member:
            'serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
          role: 'roles/artifactregistry.reader',
        },
        rpcAuthSecretAccessor: {
          secretName: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth',
          member:
            'serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
          role: 'roles/secretmanager.secretAccessor',
        },
      },
      network: {
        rpcEndpoint: 'http://10.33.10.10:38332',
        rpcBind: '10.33.10.10',
        rpcAllowCidr: '10.33.11.0/28',
        subnetCidr: '10.33.10.0/28',
        rpcPort: 38332,
        signetP2pPort: 38333,
        publicRpc: false,
      },
      secretReferences: [
        b1SecretReference('SUPABASE_URL', `supabase-url-${name}-staging`, '1'),
        b1SecretReference(
          'SUPABASE_SERVICE_ROLE_KEY',
          `supabase-service-role-key-${name}-staging`,
          '1',
        ),
        b1SecretReference(
          'STRIPE_SECRET_KEY',
          fixtureEnv.STAGING_STRIPE_SECRET_KEY_SECRET,
          fixtureEnv.STAGING_B1_STRIPE_SECRET_KEY_VERSION,
        ),
        b1SecretReference(
          'STRIPE_WEBHOOK_SECRET',
          fixtureEnv.STAGING_STRIPE_WEBHOOK_SECRET_SECRET,
          fixtureEnv.STAGING_B1_STRIPE_WEBHOOK_SECRET_VERSION,
        ),
        b1SecretReference(
          'API_KEY_HMAC_SECRET',
          fixtureEnv.STAGING_API_KEY_HMAC_SECRET_SECRET,
          fixtureEnv.STAGING_B1_API_KEY_HMAC_SECRET_VERSION,
        ),
        b1SecretReference(
          'CRON_SECRET',
          fixtureEnv.STAGING_CRON_SECRET_SECRET,
          fixtureEnv.STAGING_B1_CRON_SECRET_VERSION,
        ),
        b1SecretReference(
          'BITCOIN_RPC_URL',
          fixtureEnv.STAGING_BITCOIN_CORE_SIGNET_RPC_URL_SECRET,
          fixtureEnv.STAGING_B1_RPC_URL_SECRET_VERSION,
        ),
        b1SecretReference(
          'BITCOIN_RPC_AUTH',
          fixtureEnv.STAGING_BITCOIN_CORE_SIGNET_RPC_AUTH_SECRET,
          fixtureEnv.STAGING_B1_RPC_AUTH_SECRET_VERSION,
        ),
        b1SecretReference(
          'BITCOIN_TREASURY_WIF',
          fixtureEnv.STAGING_TREASURY_WIF_SECRET,
          fixtureEnv.STAGING_B1_TREASURY_WIF_SECRET_VERSION,
        ),
      ],
      nodeSecretEnvs: ['BITCOIN_RPC_AUTH'],
      forbiddenNodeSecretEnvs: ['BITCOIN_TREASURY_WIF'],
      treasuryWatchOnly: {
        address: treasuryAddress,
        descriptor: treasuryDescriptor,
        splitTransactionId:
          '1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941',
        preSplitPlanDigest: fixtureEnv.STAGING_B1_TREASURY_SPLIT_PLAN_DIGEST,
        expectedConfirmedOutputCount: 32,
        expectedTotalSats: 169_639,
        descriptorPolicy: 'addr-checksummed-importdescriptors',
        wifOnNode: false,
      },
    },
    budget: { spendCapUsd: 200 },
    teardown: {
      orderedResources: [
        'scheduler-jobs',
        'cloud-run-service',
        'bitcoin-core-vm',
        'boot-disk',
        'data-disk',
        'external-address',
        'internal-address',
        'rpc-firewall',
        'vpc-connector',
        'subnet',
        'vpc-network',
        'artifact-registry-iam',
        'node-secret-iam',
        'node-service-account',
        'worker-secret-iam',
        'worker-runtime-service-account',
        'scheduler-oidc-service-account',
        'supabase-project',
      ],
      projectedMonthlyRecurringUsd: 0,
    },
    issuedAt,
    expiresAt,
  };
  const signedPayloadRaw = JSON.stringify(signedPayload);
  const envelope = {
    schemaVersion: 1,
    envelopeId: `b1-node-envelope-${name}`,
    keyId: 'arkova.s33.b1-evidence.ed25519.v1',
    keyFingerprint: B1_FIXTURE_PUBLIC_KEY_FINGERPRINT,
    signedPayloadRaw,
    signatureBase64: sign(
      null,
      Buffer.from(signedPayloadRaw),
      B1_FIXTURE_KEYS.privateKey,
    ).toString('base64'),
  };
  writeFileSync(artifactPath, JSON.stringify(envelope));
}

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
  const iamStateDir = join(stubDir, 'iam-state');
  const artifactDir = join(stubDir, 'artifacts');
  const admissionArtifactPath = join(artifactDir, `isolated-rig-admission-${name}.json`);
  const provisionStatePath = join(artifactDir, `isolated-rig-provision-${name}.json`);
  const updateCountFile = join(stubDir, 'scheduler-update-count');
  const resumeCountFile = join(stubDir, 'scheduler-resume-count');
  const enabledDescribeCountFile = join(stubDir, 'scheduler-enabled-describe-count');
  const supabaseStatusCountFile = join(stubDir, 'supabase-status-count');
  const b1ApprovalArtifactPath = join(stubDir, 'b1-node-approval.json');
  const gcsLastObjectFile = join(stubDir, 'gcs-last-object.json');
  const finalSchedulerJobSuffix = profile === 'gemini'
    ? 'classify-proof-backcatalog'
    : options.rigId === 'RIG-B1'
      ? 'recover-broadcasts'
      : 'org-queue-scheduler';
  writeFileSync(logFile, '');
  writeFileSync(npxLogFile, '');
  writeFileSync(orderLogFile, '');
  writeFileSync(gitLogFile, '');
  if (options.rigId === 'RIG-B1') {
    writeB1ApprovalFixture(b1ApprovalArtifactPath, name, options);
  }
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
    ...(options.rigId === 'RIG-B1' ? { DISABLE_ALL_IN_PROCESS_CRON: 'true' } : {}),
    ...(profile === 'chain'
      ? {
          KMS_PROVIDER: options.env?.STAGING_KMS_PROVIDER ?? 'gcp',
          BITCOIN_NETWORK: options.env?.STAGING_BITCOIN_NETWORK ?? 'mainnet',
          BITCOIN_UTXO_PROVIDER: options.env?.STAGING_BITCOIN_UTXO_PROVIDER ?? 'getblock',
          ...(options.rigId === 'RIG-B1'
            ? { MEMPOOL_API_URL: 'https://mempool.space/signet/api' }
            : {}),
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
  const isRigB1 = options.rigId === 'RIG-B1';
  const baseSecretVersion = isRigB1 ? '1' : 'latest';
  const deployedSecrets = [
    {
      name: 'SUPABASE_URL',
      secret: `supabase-url-${name}-staging`,
      version: baseSecretVersion,
    },
    {
      name: 'SUPABASE_SERVICE_ROLE_KEY',
      secret: `supabase-service-role-key-${name}-staging`,
      version: baseSecretVersion,
    },
    {
      name: 'STRIPE_SECRET_KEY',
      secret: options.env?.STAGING_STRIPE_SECRET_KEY_SECRET ?? 'stripe-secret-key-staging',
      version: isRigB1 ? (options.env?.STAGING_B1_STRIPE_SECRET_KEY_VERSION ?? '1') : 'latest',
    },
    {
      name: 'STRIPE_WEBHOOK_SECRET',
      secret:
        options.env?.STAGING_STRIPE_WEBHOOK_SECRET_SECRET ??
        'stripe-webhook-secret-staging',
      version: isRigB1
        ? (options.env?.STAGING_B1_STRIPE_WEBHOOK_SECRET_VERSION ?? '1')
        : 'latest',
    },
    {
      name: 'API_KEY_HMAC_SECRET',
      secret: options.env?.STAGING_API_KEY_HMAC_SECRET_SECRET ?? 'api-key-hmac-secret-staging',
      version: isRigB1 ? (options.env?.STAGING_B1_API_KEY_HMAC_SECRET_VERSION ?? '1') : 'latest',
    },
    {
      name: 'CRON_SECRET',
      secret: options.env?.STAGING_CRON_SECRET_SECRET ?? 'cron-secret',
      version: isRigB1 ? (options.env?.STAGING_B1_CRON_SECRET_VERSION ?? '1') : 'latest',
    },
    ...(profile === 'chain'
      ? [
          {
            name: 'BITCOIN_RPC_URL',
            secret:
              options.env?.STAGING_BITCOIN_CORE_SIGNET_RPC_URL_SECRET ??
              'bitcoin-rpc-url-staging',
            version: isRigB1 ? (options.env?.STAGING_B1_RPC_URL_SECRET_VERSION ?? '1') : 'latest',
          },
          {
            name: 'BITCOIN_RPC_AUTH',
            secret:
              options.env?.STAGING_BITCOIN_CORE_SIGNET_RPC_AUTH_SECRET ??
              'bitcoin-rpc-auth-staging',
            version: isRigB1 ? (options.env?.STAGING_B1_RPC_AUTH_SECRET_VERSION ?? '1') : 'latest',
          },
          {
            name: 'BITCOIN_TREASURY_WIF',
            secret: options.env?.STAGING_TREASURY_WIF_SECRET ?? 'bitcoin-treasury-wif-staging',
            version: isRigB1
              ? (options.env?.STAGING_B1_TREASURY_WIF_SECRET_VERSION ?? '1')
              : 'latest',
          },
        ]
      : []),
    ...(profile === 'gemini'
      ? [
          {
            name: 'GEMINI_API_KEY',
            secret: options.env?.STAGING_GEMINI_API_KEY_SECRET ?? 'gemini-api-key',
            version: options.env?.STAGING_GEMINI_API_KEY_SECRET_VERSION ?? '2',
          },
        ]
      : []),
  ];
  const deployedSecretEnvs = deployedSecrets.map(({ name, secret, version }) => {
    switch (options.deployedSecretReferenceSchema ?? 'legacy') {
      case 'current':
        return { name, valueFrom: { secretKeyRef: { name: secret, key: version } } };
      case 'hybrid':
        return {
          name,
          valueSource: { secretKeyRef: { secret, version } },
          valueFrom: { secretKeyRef: { name: secret, key: version } },
        };
      case 'malformed':
        return {
          name,
          valueFrom: { secretKeyRef: { name: secret, key: version, unexpected: true } },
        };
      case 'legacy':
        return { name, valueSource: { secretKeyRef: { secret, version } } };
    }
  });
  if (options.duplicateDeployedSecretEnv) {
    deployedSecretEnvs.push(deployedSecretEnvs[0]);
  }
  const revisionPayload = JSON.stringify({
    metadata: { labels: { 'arkova-source-head': options.sourceHead ?? APPLY_FIXTURE.head } },
    spec: {
      serviceAccountName:
        options.env?.STAGING_RUNTIME_SA_EMAIL ??
        '270018525501-compute@developer.gserviceaccount.com',
      containers: [
        {
          image: options.deployedImageRef ?? STUB_IMAGE_REF,
          env: [
            ...Object.entries(deployedEnv).map(([name, value]) => ({ name, value })),
            ...deployedSecretEnvs,
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
if [[ "$1" == "iam" && "$2" == "service-accounts" && "$3" == "describe" ]]; then
  account_local="\${4%@*}"
  if [[ ! -f '${iamStateDir}/'"$account_local" ]]; then exit 1; fi
  printf '%s\\n' '{"uniqueId":"270018525501000000001"}'
  exit 0
fi
if [[ "$1" == "iam" && "$2" == "service-accounts" && "$3" == "create" ]]; then
  mkdir -p '${iamStateDir}'
  : > '${iamStateDir}/'"$4"
  exit 0
fi
if [[ "$1" == "projects" && "$2" == "describe" ]]; then
  printf '{"projectId":"%s","projectNumber":"270018525501"}\\n' "$3"
  exit 0
fi
if [[ "$1" == "compute" && "$2" == "instances" && "$3" == "get-serial-port-output" ]]; then
  printf '%s\\n' 'ARKOVA_RIG_B1_READY_V1 {"schemaVersion":"arkova.s33.rig-b1.node-readiness/v1","bitcoinCoreVersion":"31.1","bitcoinCoreImage":"us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8","sourceTarballSha256":"b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e","chain":"signet","initialBlockDownload":false,"blocks":100,"headers":100,"genesisHash":"00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6","txindexSynced":true,"txindexBestBlockHeight":100,"treasurySplitPlanDigest":"sha256:ab70ac7cf0ef1b371258c86ee4d967fec199b156156fe214238440429df794d8","splitTransactionId":"1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941","confirmedOutputCount":32,"confirmedTotalSats":169639,"splitBlockHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","splitBlockHeader":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","txOutProof":"aa"}'
  exit 0
fi
if [[ "$1" == "compute" && "$2" == "instances" && "$3" == "describe" ]]; then
  printf '%s\\n' '{"id":"1000000000000000001"}'
  exit 0
fi
if [[ "$1" == "compute" && "$2" == "disks" && "$3" == "describe" ]]; then
  printf '%s\\n' '{"id":"1000000000000000002"}'
  exit 0
fi
if [[ "$1" == "compute" && "$2" == "addresses" && "$3" == "describe" ]]; then
  printf '%s\\n' '{"id":"1000000000000000003"}'
  exit 0
fi
if [[ "$1" == "compute" && "$2" == "firewall-rules" && "$3" == "describe" ]]; then
  printf '%s\\n' '{"id":"1000000000000000004"}'
  exit 0
fi
if [[ "$1" == "compute" && "$2" == "networks" && "$3" == "vpc-access" \
  && "$4" == "connectors" && "$5" == "describe" ]]; then
  printf '%s\\n' '{"name":"projects/arkova1/locations/us-central1/connectors/arkova-s33-rig-b1-bitcoin-core-signet-connector"}'
  exit 0
fi
if [[ "$1" == "compute" && "$2" == "networks" && "$3" == "subnets" \
  && "$4" == "describe" ]]; then
  printf '%s\\n' '{"id":"1000000000000000005"}'
  exit 0
fi
if [[ "$1" == "compute" && "$2" == "networks" && "$3" == "describe" ]]; then
  printf '%s\\n' '{"id":"1000000000000000006"}'
  exit 0
fi
if [[ "$1" == "services" && "$2" == "list" && "$3" == "--enabled" ]]; then
  printf '%s\\n' \
    artifactregistry.googleapis.com \
    cloudscheduler.googleapis.com \
    compute.googleapis.com \
    iam.googleapis.com \
    run.googleapis.com \
    secretmanager.googleapis.com \
    serviceusage.googleapis.com \
    vpcaccess.googleapis.com
  exit 0
fi
if [[ "$1" == "storage" && "$2" == "buckets" && "$3" == "describe" ]]; then
  printf '%s\\n' '{"name":"arkova1-s33-immutable-authority-ledger","projectNumber":"270018525501","objectRetention":{"mode":"Enabled"}}'
  exit 0
fi
if [[ "$1" == "storage" && "$2" == "cp" ]]; then
  cp -- "$3" '${gcsLastObjectFile}'
  exit 0
fi
if [[ "$1" == "storage" && "$2" == "objects" && "$3" == "describe" ]]; then
  object_uri="$4"
  object_name="\${object_uri#gs://arkova1-s33-immutable-authority-ledger/}"
  retention_until='${options.ledgerRetentionUntil ?? '2099-01-01T00:00:00+00:00'}'
  if [[ "$object_name" == s33/rig-b1/topology-ownership/* ]]; then
    retention_until='${options.topologyLedgerRetentionUntil ?? options.ledgerRetentionUntil ?? '2099-01-01T00:00:00+00:00'}'
  fi
  printf '{"bucket":"arkova1-s33-immutable-authority-ledger","name":"%s","generation":"1","retention":{"mode":"Locked","retainUntilTime":"%s"}}\\n' "$object_name" "$retention_until"
  exit 0
fi
if [[ "$1" == "storage" && "$2" == "cat" ]]; then
  cat '${gcsLastObjectFile}'
  exit 0
fi
if [[ "$1" == "run" && "$2" == "services" && "$3" == "describe" ]]; then
  if [[ "$*" == *"status.latestReadyRevisionName"* ]]; then
    echo '${STUB_REVISION}'
  elif [[ "$*" == *"--format=json"* ]]; then
    printf '%s\\n' '{"metadata":{"uid":"cloudrunuid123"}}'
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
	if [[ "$1" == "secrets" && "$2" == "describe" ]]; then
	  case "$3" in
	    supabase-url-*-staging|supabase-service-role-key-*-staging) exit 1 ;;
	    *) exit 0 ;;
	  esac
	fi
	if [[ "$1" == "secrets" && "$2" == "versions" && "$3" == "describe" ]]; then
	  version="$4"
	  secret=''
	  for arg in "$@"; do
	    case "$arg" in --secret=*) secret="\${arg#--secret=}" ;; esac
	  done
	  resource_project='${options.secretVersionResourceProject ?? '270018525501'}'
	  resource_secret='${options.secretVersionResourceSecret ?? ''}'
	  resource_version='${options.secretVersionResourceVersion ?? ''}'
	  [[ -n "$resource_secret" ]] || resource_secret="$secret"
	  [[ -n "$resource_version" ]] || resource_version="$version"
	  printf '{"name":"projects/%s/secrets/%s/versions/%s","state":"ENABLED"}\n' \
	    "$resource_project" "$resource_secret" "$resource_version"
	  exit 0
	fi
	if [[ "$1" == "secrets" && "$2" == "versions" && "$3" == "access" ]]; then
	  secret=''
	  for arg in "$@"; do
	    case "$arg" in --secret=*) secret="\${arg#--secret=}" ;; esac
	  done
	  case "$secret" in
	    supabase-service-role-key-*-staging)
	      if [[ "$4" == '1' && '${options.preflightServiceRoleReadFails ? 'true' : 'false'}' == 'true' ]]; then
	        echo 'injected generated service-role secret read failure' >&2
	        exit 47
	      fi
	      if [[ "$4" != '1' || '${options.preflightServiceRoleEmpty ? 'true' : 'false'}' != 'true' ]]; then
	        printf '%s\n' '${STUB_PREFLIGHT_SERVICE_ROLE_KEY}'
	      fi
	      ;;
	    arkova-s33-rig-b1-bitcoin-core-signet-rpc-url)
	      printf '%s\\n' 'http://10.33.10.10:38332'
	      ;;
	    arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth)
	      printf '%s\\n' 'fixture-user:0123456789abcdef0123456789abcdef'
	      ;;
	    *)
	      printf '%s\\n' '${STUB_CRON_SECRET}'
	      ;;
	  esac
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
  echo '{"id":"${options.projectRef ?? 'abcdefghijklmnopqrst'}","name":"arkova-soak-${name}"}'
  exit 0
fi
if [[ "$1" == "supabase" && "$2" == "projects" && "$3" == "list" ]]; then
  count=0
  [[ ! -f '${supabaseStatusCountFile}' ]] || count="$(cat '${supabaseStatusCountFile}')"
  count=$((count + 1))
  printf '%s' "$count" > '${supabaseStatusCountFile}'
  case "$count" in
${(options.supabaseProjectStatuses ?? ['ACTIVE_HEALTHY'])
    .map((status, index) => `    ${index + 1}) status='${status}' ;;`)
    .join('\n')}
    *) status='${(options.supabaseProjectStatuses ?? ['ACTIVE_HEALTHY']).at(-1)}' ;;
  esac
  printf '[{"id":"${options.projectRef ?? 'abcdefghijklmnopqrst'}","name":"arkova-soak-${name}","status":"%s"}]\\n' "$status"
  exit 0
fi
if [[ "$1" == "supabase" ]]; then
  exit 0
fi
if [[ "$1" == "tsx" && "$2" == "scripts/ci/staging-honesty-preflight.ts" ]]; then
  if [[ "${'$'}{SUPABASE_SERVICE_ROLE_KEY:-}" != '${STUB_PREFLIGHT_SERVICE_ROLE_KEY}' ]]; then
    echo 'missing exact generated service-role key in preflight child environment' >&2
    exit 46
  fi
  if [[ '${options.preflightChildStderrFails ? 'true' : 'false'}' == 'true' ]]; then
    echo '${STUB_PREFLIGHT_CHILD_STDERR}' >&2
    exit 45
  fi
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

  writeFileSync(join(stubDir, 'getent'), `#!/usr/bin/env bash
if [[ '${options.supabaseDbResolves === false ? 'false' : 'true'}' != 'true' ]]; then exit 2; fi
printf '%s\\n' '203.0.113.10 STREAM db fixture'
`);
  chmodSync(join(stubDir, 'getent'), 0o755);

  writeFileSync(join(stubDir, 'nc'), `#!/usr/bin/env bash
[[ "$*" == '-z -w 5 db.${options.projectRef ?? 'abcdefghijklmnopqrst'}.supabase.co 5432' ]] || exit 64
[[ '${options.supabaseDbTcpAccepts === false ? 'false' : 'true'}' == 'true' ]]
`);
  chmodSync(join(stubDir, 'nc'), 0o755);

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
  if (options.rigId === 'RIG-B1') {
    env.STAGING_B1_NODE_APPROVAL_ARTIFACT = b1ApprovalArtifactPath;
  }
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
    provisionState: existsSync(provisionStatePath)
      ? JSON.parse(readFileSync(provisionStatePath, 'utf8'))
      : null,
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
      bitcoin_utxo_provider: 'rpc',
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
  const exactTopology = [
    ['batch-anchors', '/jobs/batch-anchors'],
    ['check-confirmations', '/jobs/check-confirmations'],
    ['populate-confirmation-proofs', '/jobs/populate-confirmation-proofs'],
    ['org-queue-scheduler', '/jobs/org-queue-scheduler'],
    ['batch-anchors-forced-flush', '/jobs/batch-anchors?force=true'],
    ['recover-broadcasts', '/jobs/recover-broadcasts'],
  ] as const;
  const bindingTopology = [
    ['batch-anchors', '*/5 * * * *', 'Etc/UTC', '120s'],
    ['check-confirmations', '*/5 * * * *', 'Etc/UTC', '300s'],
    ['populate-confirmation-proofs', '*/5 * * * *', 'Etc/UTC', '300s'],
    ['org-queue-scheduler', '*/5 * * * *', 'Etc/UTC', '600s'],
    ['batch-anchors-forced-flush', '*/5 * * * *', 'America/New_York', '600s'],
    ['recover-broadcasts', '*/5 * * * *', 'Etc/UTC', '120s'],
  ] as const;

  it('accepts canonical Secret Manager version names using the resolved project number', () => {
    expect(paused.code, paused.out).toBe(0);
    expect(paused.gcloudCalls).toContain('projects describe arkova1 --format=json');
    expect(paused.gcloudCalls.some((call) =>
      call.startsWith('secrets versions describe 1 ') &&
      call.includes('--secret=arkova-s33-rig-b1-bitcoin-core-signet-rpc-url'),
    )).toBe(true);
  });

  it.each([
    '2099-01-01T01:00:00+01:00',
    '2099-01-01T00:00:00',
    '2099-99-01T00:00:00Z',
  ])('rejects non-canonical immutable claim retention %s before paid mutation', (ledgerRetentionUntil) => {
    const result = applyRunStubbed('w3c-rig-b1-invalid-retention', 'chain', {
      rigId: 'RIG-B1',
      env: RIG_B1_APPLY_ENV,
      ledgerRetentionUntil,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/immutable approval claim/i);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
  });

  it('rejects non-UTC B1 topology-ownership retention metadata', () => {
    const result = applyRunStubbed('w3c-b1-bad-topology', 'chain', {
      rigId: 'RIG-B1',
      env: RIG_B1_APPLY_ENV,
      topologyLedgerRetentionUntil: '2099-01-01T01:00:00+01:00',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/topology ownership metadata/i);
  });

  it.each([
    ['project', { secretVersionResourceProject: '999999999999' }],
    ['secret', { secretVersionResourceSecret: 'arkova-s33-rig-b1-unrelated' }],
    ['version', { secretVersionResourceVersion: '999' }],
  ] as const)('rejects a Secret Manager version name with an unrelated %s', (_field, override) => {
    const result = applyRunStubbed(`w3c-rig-b1-secret-${_field}`, 'chain', {
      rigId: 'RIG-B1',
      env: RIG_B1_APPLY_ENV,
      ...override,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/Secret Manager version .* missing, disabled, or not exact/iu);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
  });

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
    expect(cadenceUpdates.every((call) => call.includes('--schedule=*/5 * * * *'))).toBe(true);
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

  it('re-observes the exact five-minute binding config while every job remains PAUSED', () => {
    const configDescribes = paused.gcloudCalls.filter((call) =>
      call.startsWith('scheduler jobs describe ') &&
      call.includes('--format=json(schedule,timeZone,attemptDeadline,retryConfig)'),
    );
    expect(configDescribes).toHaveLength(6);
    for (const [suffix, , timeZone, attemptDeadline] of bindingTopology) {
      const jobName = `arkova-worker-w3c-rig-b1-paused-staging-${suffix}`;
      const update = paused.gcloudCalls.find((call) => call.startsWith(`scheduler jobs update http ${jobName} `));
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
    const cronAccesses = paused.gcloudCalls.filter((call) =>
      call.startsWith('secrets versions access ') && call.includes('--secret=arkova-s33-rig-b1-cron-secret'),
    );
    expect(cronAccesses).toHaveLength(1);
    expect(cronAccesses[0]).toContain(
      `secrets versions access ${RIG_B1_APPLY_ENV.STAGING_B1_CRON_SECRET_VERSION}`,
    );
    expect(cronAccesses[0]).not.toContain(' access latest ');
  });

  it('keeps B1 Scheduler ingress unauthorized while provisioning all six jobs PAUSED', () => {
    expect(paused.code, paused.out).toBe(0);
    const grantCalls = paused.gcloudCalls.filter((call) =>
      call.startsWith('run services add-iam-policy-binding '),
    );
    expect(grantCalls).toHaveLength(0);
    expect(paused.gcloudCalls.some((call) =>
      call.startsWith('projects add-iam-policy-binding ') && call.includes('roles/run.invoker'),
    )).toBe(false);
    const deployIndex = paused.callOrder.findIndex((entry) => entry.startsWith('gcloud run deploy '));
    const firstCreateIndex = paused.callOrder.findIndex((entry) =>
      entry.startsWith('gcloud scheduler jobs create http '),
    );
    expect(firstCreateIndex).toBeGreaterThan(deployIndex);
    expect(Object.values(paused.schedulerStates)).toEqual(Array(6).fill('PAUSED'));
    expect(script).not.toContain('write_provision_state "b1_service_invoker_bound" ""');
  });

  it('rejects the former FORCE activation even with its exact acknowledgement before mutation', () => {
    const result = applyRunStubbed('w3c-rig-b1-force-forbidden', 'chain', {
      rigId: 'RIG-B1',
      env: FORCE_ACCELERATED_RIG_B1_ENV,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/provisioning never activates|forbidden/i);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
    expect(result.gcloudCalls.some((call) => call.startsWith('scheduler jobs '))).toBe(false);
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
      /STAGING_BITCOIN_UTXO_PROVIDER.+rpc/i,
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

  it('re-pauses every PAUSED job when final admission artifact persistence cannot start', () => {
    const result = applyRunStubbed('blocked-admission-path', 'chain', {
      rigId: 'RIG-B1',
      env: RIG_B1_APPLY_ENV,
      blockAdmissionArtifactPath: true,
    });
    const creates = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs create http '));
    const pauses = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs pause '));
    const resumes = result.gcloudCalls.filter((call) => call.startsWith('scheduler jobs resume '));

    expect(result.code).not.toBe(0);
    expect(resumes).toHaveLength(0);
    expect(pauses).toHaveLength(creates.length * 2);
    expect(Object.values(result.schedulerStates).every((state) => state === 'PAUSED')).toBe(true);
    expect(result.out).not.toContain('ADMISSION_JSON=');
    expect(existsSync(result.admissionArtifactPath) && statSync(result.admissionArtifactPath).isDirectory()).toBe(true);
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

  it.each(['legacy', 'current'] as const)(
    'accepts the exact seven Gemini secret bindings in the %s gcloud schema',
    (deployedSecretReferenceSchema) => {
      const result = applyRunStubbed(`secret-schema-${deployedSecretReferenceSchema}`, 'gemini', {
        deployedSecretReferenceSchema,
      });
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain('ADMISSION_JSON=');
    },
  );

  it.each(['hybrid', 'malformed'] as const)(
    'rejects %s Cloud Run secret-reference objects',
    (deployedSecretReferenceSchema) => {
      const result = applyRunStubbed(`secret-schema-${deployedSecretReferenceSchema}`, 'gemini', {
        deployedSecretReferenceSchema,
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/deployed revision secret/i);
      expect(result.out).not.toContain('ADMISSION_JSON=');
    },
  );

  it('rejects duplicate secret environment bindings', () => {
    const result = applyRunStubbed('secret-schema-duplicate', 'gemini', {
      deployedSecretReferenceSchema: 'current',
      duplicateDeployedSecretEnv: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/deployed revision secret/i);
    expect(result.out).not.toContain('ADMISSION_JSON=');
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

  it('waits through COMING_UP and pushes schema only after ACTIVE_HEALTHY plus DNS', () => {
    const result = applyRunStubbed('ready-after-coming-up', 'mock', {
      supabaseProjectStatuses: ['COMING_UP', 'ACTIVE_HEALTHY'],
      env: {
        STAGING_SUPABASE_PROJECT_READY_TIMEOUT_SECONDS: '2',
        STAGING_SUPABASE_PROJECT_READY_POLL_SECONDS: '1',
      },
    });
    expect(result.code, result.out).toBe(0);
    expect(result.npxCalls.filter((call) =>
      call.startsWith('supabase projects list '))).toHaveLength(2);
    expect(result.npxCalls.some((call) => call.startsWith('supabase link '))).toBe(true);
    expect(result.npxCalls.some((call) => call.startsWith('supabase db push '))).toBe(true);
  }, 15_000);

  it('persists teardown state and performs no link, schema push, or deploy on readiness timeout', () => {
    const result = applyRunStubbed('readiness-timeout', 'mock', {
      supabaseProjectStatuses: ['ACTIVE_HEALTHY'],
      supabaseDbTcpAccepts: false,
      env: {
        STAGING_SUPABASE_PROJECT_READY_TIMEOUT_SECONDS: '1',
        STAGING_SUPABASE_PROJECT_READY_POLL_SECONDS: '1',
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/TCP 5432/i);
    expect(result.provisionState).toMatchObject({
      status: 'REQUIRES_IMMEDIATE_TEARDOWN',
      supabase_project_ref: 'abcdefghijklmnopqrst',
    });
    expect(result.npxCalls.some((call) =>
      call.startsWith('supabase link ') || call.startsWith('supabase db push '))).toBe(false);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
  });

  it('rejects a malformed created project ref before any downstream mutation', () => {
    const result = applyRunStubbed('bad-created-project-ref', 'mock', {
      projectRef: 'abcdefghijklmnopqrs1',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/legacy JSON create response|strict project contract/i);
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

  it('passes the exact generated service-role secret only through the preflight child environment', () => {
    const result = applyRunStubbed('preflight-service-role-env', 'mock');
    expect(result.code, result.out).toBe(0);
    expect(result.gcloudCalls.filter((call) =>
      call.startsWith('secrets versions access 1 ') &&
      call.includes('--secret=supabase-service-role-key-preflight-service-role-env-staging'),
    )).toHaveLength(1);
    expect(result.out).not.toContain(STUB_PREFLIGHT_SERVICE_ROLE_KEY);
    expect(result.npxCalls.join('\n')).not.toContain(STUB_PREFLIGHT_SERVICE_ROLE_KEY);
    const persistedArtifacts = readdirSync(result.artifactDir)
      .filter((entry) => statSync(join(result.artifactDir, entry)).isFile())
      .map((entry) => readFileSync(join(result.artifactDir, entry), 'utf8'))
      .join('\n');
    expect(persistedArtifacts).not.toContain(STUB_PREFLIGHT_SERVICE_ROLE_KEY);
  });

  it('fails closed when the generated preflight service-role secret is empty', () => {
    const result = applyRunStubbed('preflight-service-role-empty', 'mock', {
      preflightServiceRoleEmpty: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/service-role secret was empty/i);
    expect(result.out).not.toContain(STUB_PREFLIGHT_SERVICE_ROLE_KEY);
    expect(result.out).not.toContain('ADMISSION_JSON=');
  });

  it('fails closed without leaking when the generated service-role secret cannot be read', () => {
    const result = applyRunStubbed('preflight-role-read-fail', 'mock', {
      preflightServiceRoleReadFails: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/could not read the generated Supabase service-role secret/i);
    expect(result.out).not.toContain(STUB_PREFLIGHT_SERVICE_ROLE_KEY);
    expect(result.out).not.toContain('injected generated service-role secret read failure');
    expect(result.out).not.toContain('ADMISSION_JSON=');
  });

  it('suppresses credential-bearing preflight child stderr and emits only a fixed parent error', () => {
    const result = applyRunStubbed('preflight-child-stderr', 'mock', {
      preflightChildStderrFails: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain(
      'ERROR: clean-mirror preflight child failed with rc=45; child diagnostics suppressed.',
    );
    expect(result.out).not.toContain(STUB_PREFLIGHT_CHILD_STDERR);
    expect(result.out).not.toContain(STUB_PREFLIGHT_SERVICE_ROLE_KEY);
    const persistedArtifacts = readdirSync(result.artifactDir)
      .filter((entry) => statSync(join(result.artifactDir, entry)).isFile())
      .map((entry) => readFileSync(join(result.artifactDir, entry), 'utf8'))
      .join('\n');
    expect(persistedArtifacts).not.toContain(STUB_PREFLIGHT_CHILD_STDERR);
    expect(persistedArtifacts).not.toContain(STUB_PREFLIGHT_SERVICE_ROLE_KEY);
  });

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
    expect(admission.critical_config).not.toHaveProperty('enable_ai_extraction');
    expect(admission.critical_config).not.toHaveProperty('enable_vertex_ai');
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
