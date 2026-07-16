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
const trustedNodeSha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
const trustedGitPath = '/usr/bin/git';
const trustedGitSha256 = createHash('sha256')
  .update(readFileSync(trustedGitPath))
  .digest('hex');
const trustedGitVersion = execFileSync(trustedGitPath, ['--version'], { encoding: 'utf8' }).trim();
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
    'projects/arkova1/locations/us-central1/endpoints/733001',
  STAGING_RIG_ID: 'RIG-G1',
  STAGING_TIER: 'T2',
  STAGING_REQUIRED_UPTIME_MIN: '720',
  STAGING_REQUIRED_WALL_MIN: '750',
};

function g1DryRun(env: Record<string, string> = {}): RunResult {
  return run(provisioner, ['--name', 's33-g1', '--profile', 'gemini'], {
    ...g1Env,
    ...env,
  });
}

const pinnedImageDigest = `sha256:${'d'.repeat(64)}`;
const pinnedImage = `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@${pinnedImageDigest}`;
const controlProjectRef = 'abcdefghijklmnopqrst';
const tunedProjectRef = 'bcdefghijklmnopqrstu';
const endpointModel = 'projects/270018525501/locations/us-central1/models/6611494259700793344';
const immutableLedgerBucket = 'arkova1-s33-immutable-authority-ledger';
const immutableLedger = {
  backend: 'gcs-if-generation-match-0-locked-retention',
  bucket: immutableLedgerBucket,
  projectId: 'arkova1',
  requiresPerObjectRetention: true,
};

interface G1FaultRun {
  code: number;
  out: string;
  gcloudCalls: string[];
  npxCalls: string[];
  pathGitCalls: string[];
  artifactEntries: string[];
  checksumHelperUnchanged: boolean;
  cleanChecksumDigest?: string;
  ambientChecksumDigest?: string;
  forgedChecksumDigest?: string;
  state: Record<string, unknown> | null;
}

function runG1ApplyFault(options: {
  endpoint?: Record<string, unknown>;
  failDeployAt?: number;
  failTunedRevisionDescribe?: boolean;
  name?: string;
  leaseId?: string;
  fakeNode?: boolean;
  dirtyInput?: 'provisioner' | 'driver' | 'verifier';
  hiddenByIndexFlag?: 'assume-unchanged' | 'skip-worktree';
  checksumLoaderTarget?: 'git' | 'node';
  sharedLedgerDir?: string;
  bucketObjectRetention?: boolean;
  env?: Record<string, string>;
} = {}): G1FaultRun {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'g1-provision-fault-')));
  stubRoots.push(root);
  const fakeRepo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  const fixtureVerifier = 'scripts/staging/test-g1-spend-approval-verifier.mjs';
  const fixtureDriver = 'services/worker/scripts/pr1408-chain-resilience-driver.ts';
  const rigName = options.name ?? 's33-g1';
  const leaseId = options.leaseId ?? 'lease-s33-g1';
  const ledgerDir = options.sharedLedgerDir ?? join(root, 'approval-ledger');
  mkdirSync(join(fakeRepo, 'scripts/staging'), { recursive: true });
  mkdirSync(join(fakeRepo, 'services/worker/scripts'), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  const gcloudLog = join(root, 'gcloud.log');
  const npxLog = join(root, 'npx.log');
  const pathGitLog = join(root, 'path-git.log');
  const deployCount = join(root, 'deploy-count');
  const supabaseCreateCount = join(root, 'supabase-create-count');
  const endpointPolicyState = join(root, 'endpoint-policy-state');
  const endpointDeletedState = join(root, 'endpoint-deleted-state');
  const artifactDir = join(root, 'artifacts');
  const statePath = join(artifactDir, `isolated-rig-provision-${rigName}.json`);
  writeFileSync(gcloudLog, '');
  writeFileSync(npxLog, '');
  writeFileSync(pathGitLog, '');

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
  const checksumTargetPath = options.checksumLoaderTarget === 'git'
    ? trustedGitPath
    : options.checksumLoaderTarget === 'node'
      ? process.execPath
      : undefined;
  const forgedChecksumDigest = options.checksumLoaderTarget === 'git'
    ? '4'.repeat(64)
    : options.checksumLoaderTarget === 'node'
      ? '5'.repeat(64)
      : undefined;
  const expectedGitSha256 = options.checksumLoaderTarget === 'git'
    ? forgedChecksumDigest!
    : trustedGitSha256;
  const expectedNodeSha256 = options.checksumLoaderTarget === 'node'
    ? forgedChecksumDigest!
    : trustedNodeSha256;
  const fixtureProvisionerSource = provisionerSource
    .replace(
      'RIG_G1_SPEND_APPROVAL_VERIFIER="scripts/staging/s33-g1-spend-approval.mjs"',
      `RIG_G1_SPEND_APPROVAL_VERIFIER="${fixtureVerifier}"`,
    )
    .replace(/RIG_G1_TRUSTED_NODE_PATH="[^"]+"/, `RIG_G1_TRUSTED_NODE_PATH="${process.execPath}"`)
    .replace(/RIG_G1_TRUSTED_NODE_SHA256="[0-9a-f]+"/, `RIG_G1_TRUSTED_NODE_SHA256="${expectedNodeSha256}"`)
    .replace(/RIG_G1_TRUSTED_NODE_VERSION="[^"]+"/, `RIG_G1_TRUSTED_NODE_VERSION="${process.version}"`)
    .replace(/TRUSTED_GIT_PATH="[^"]+"/, `TRUSTED_GIT_PATH="${trustedGitPath}"`)
    .replace(/TRUSTED_GIT_SHA256="[0-9a-f]+"/, `TRUSTED_GIT_SHA256="${expectedGitSha256}"`)
    .replace(/TRUSTED_GIT_VERSION="[^"]+"/, `TRUSTED_GIT_VERSION="${trustedGitVersion}"`)
    .replace(/TRUSTED_GIT_ORIGIN_URL="[^"]+"/, `TRUSTED_GIT_ORIGIN_URL="${origin}"`)
    .replace('GIT_ALLOW_PROTOCOL=https', 'GIT_ALLOW_PROTOCOL=file')
    .replaceAll('/usr/bin/curl', join(root, 'curl'));
  const checksumHelperSlice = (source: string): string => {
    const boundaryStart = source.indexOf('execute_sha256_checksum() {');
    const start = boundaryStart >= 0 ? boundaryStart : source.indexOf('trusted_sha256_file() {');
    const end = source.indexOf('validate_trusted_git_binding() {');
    return start >= 0 && end > start ? source.slice(start, end) : '';
  };
  const checksumHelperUnchanged = checksumHelperSlice(fixtureProvisionerSource) !== ''
    && checksumHelperSlice(fixtureProvisionerSource) === checksumHelperSlice(provisionerSource);
  const fixtureProvisioner = join(fakeRepo, 'scripts/staging/provision-isolated-rig.sh');
  writeFileSync(fixtureProvisioner, fixtureProvisionerSource);
  chmodSync(fixtureProvisioner, 0o755);
  writeFileSync(join(fakeRepo, fixtureVerifier), `
import { readFileSync } from 'node:fs';
const readArg = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(\`missing \${name}\`);
  return process.argv[index + 1];
};
process.stdout.write(readFileSync(readArg('--artifact'), 'utf8'));
`);
  writeFileSync(join(fakeRepo, fixtureDriver), 'export const g1FixtureDriver = true;\n');

  execFileSync('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', fakeRepo]);
  execFileSync('/usr/bin/git', ['-C', fakeRepo, 'config', 'user.name', 'G1 Integrity Test']);
  execFileSync('/usr/bin/git', ['-C', fakeRepo, 'config', 'user.email', 'g1-integrity@arkova.invalid']);
  execFileSync('/usr/bin/git', ['-C', fakeRepo, 'add', '--', fixtureProvisioner, fixtureDriver, fixtureVerifier]);
  execFileSync('/usr/bin/git', ['-C', fakeRepo, 'commit', '--quiet', '-m', 'fixture']);
  const fixtureHead = execFileSync('/usr/bin/git', ['-C', fakeRepo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('/usr/bin/git', ['init', '--quiet', '--bare', origin]);
  execFileSync('/usr/bin/git', ['-C', fakeRepo, 'remote', 'add', 'origin', origin]);
  execFileSync('/usr/bin/git', ['-C', fakeRepo, 'push', '--quiet', '-u', 'origin', 'main']);

  if (options.dirtyInput) {
    const dirtyPath = options.dirtyInput === 'provisioner'
      ? 'scripts/staging/provision-isolated-rig.sh'
      : options.dirtyInput === 'driver'
        ? fixtureDriver
        : fixtureVerifier;
    const absoluteDirtyPath = join(fakeRepo, dirtyPath);
    writeFileSync(
      absoluteDirtyPath,
      `${readFileSync(absoluteDirtyPath, 'utf8')}\n// uncommitted integrity regression\n`,
    );
    if (options.hiddenByIndexFlag) {
      execFileSync('/usr/bin/git', [
        '-C', fakeRepo, 'update-index', `--${options.hiddenByIndexFlag}`, '--', dirtyPath,
      ]);
    }
  }

  const revision = (env: Record<string, string>, runtimeServiceAccount: string) => JSON.stringify({
    metadata: { labels: { 'arkova-source-head': fixtureHead } },
    spec: {
      serviceAccountName: runtimeServiceAccount,
      containers: [{
        image: pinnedImage,
        env: [
          ...Object.entries(env).map(([name, value]) => ({ name, value })),
          ...secretNames.map((name) => ({
            name,
            valueSource: { secretKeyRef: {
              secret: name === 'SUPABASE_URL'
                ? (runtimeServiceAccount.includes('g1-a')
                    ? 'supabase-url-s33-g1-a-staging'
                    : 'supabase-url-s33-g1-b-staging')
                : name === 'SUPABASE_SERVICE_ROLE_KEY'
                  ? (runtimeServiceAccount.includes('g1-a')
                      ? 'supabase-service-role-key-s33-g1-a-staging'
                      : 'supabase-service-role-key-s33-g1-b-staging')
                  : name === 'STRIPE_SECRET_KEY' ? 'stripe-secret-key-staging'
                    : name === 'STRIPE_WEBHOOK_SECRET' ? 'stripe-webhook-secret-staging'
                      : name === 'API_KEY_HMAC_SECRET' ? 'api-key-hmac-secret-staging'
                        : name === 'CRON_SECRET' ? 'cron-secret' : 'gemini-api-key',
              version: name === 'GEMINI_API_KEY' ? '2' : '1',
            } },
          })),
        ],
      }],
    },
    status: { imageDigest: pinnedImageDigest },
  });
  const publicRevision = revision(
    baseEnv,
    's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com',
  );
  const tunedRevision = revision({
    ...baseEnv,
    GEMINI_TUNED_MODEL: g1Env.STAGING_GEMINI_TUNED_MODEL,
    GEMINI_V6_PROMPT: 'true',
  }, 's33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com');
  const endpoint = JSON.stringify(options.endpoint ?? {
    name: 'projects/270018525501/locations/us-central1/endpoints/733001',
    displayName: 'arkova-s33-rig-g1-b-tuned-v6',
    deployedModels: [{
      id: '7330011',
      displayName: 'arkova-s33-rig-g1-b-tuned-v6',
      model: endpointModel,
      modelVersionId: '1',
      checkpointId: '6',
      automaticResources: { minReplicaCount: 1, maxReplicaCount: 1 },
    }],
    trafficSplit: { '7330011': 100 },
  });
  const verifiedApproval = JSON.stringify({
    status: 'VERIFIED',
    approvalId: 'approval-s33-g1-001',
    sourceReference: 'ari:cloud:confluence:tenant:page/123456',
    immutableRevisionId: 'revision-42',
    canonicalSha256: `sha256:${'1'.repeat(64)}`,
    approverIdentity: 'arkova.s33.approver.founder-cto.v1',
    approverRole: 'founder',
    authorityActivatedAtUtc: '2026-07-16T13:52:06Z',
    authorityRosterRootSha256:
      'sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f',
    candidateSourceHeadSha: fixtureHead,
    candidateImageDigest: pinnedImageDigest,
    scope: {
      rigClass: 'RIG-G1', rigName: 's33-g1', rigProfile: 'gemini', soakId: 'soak-s33-g1',
      rigId: 'RIG-G1', leaseId: 'lease-s33-g1', corpusDigest: g1Env.STAGING_G1_CORPUS_DIGEST,
      endpointId: '733001',
      endpointResource: g1Env.STAGING_GEMINI_TUNED_MODEL,
      endpointDisplayName: 'arkova-s33-rig-g1-b-tuned-v6',
      vertexModelResource: `${endpointModel}@1`,
      checkpointId: '6',
      deployedModelId: '7330011',
      deployedModelDisplayName: 'arkova-s33-rig-g1-b-tuned-v6',
      deploymentResourcesMode: 'TUNED_GEMINI_AUTOMATIC_RESOURCES',
      minReplicaCount: 1,
      maxReplicaCount: 1,
      controlRuntimeServiceAccount: 's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com',
      tunedRuntimeServiceAccount: 's33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com',
      controlService: 'arkova-worker-s33-g1-a-staging',
      tunedService: 'arkova-worker-s33-g1-b-staging',
      controlProjectName: 'arkova-soak-s33-g1-a',
      tunedProjectName: 'arkova-soak-s33-g1-b',
      controlSupabaseUrlSecret: 'supabase-url-s33-g1-a-staging@1',
      controlSupabaseServiceRoleSecret: 'supabase-service-role-key-s33-g1-a-staging@1',
      tunedSupabaseUrlSecret: 'supabase-url-s33-g1-b-staging@1',
      tunedSupabaseServiceRoleSecret: 'supabase-service-role-key-s33-g1-b-staging@1',
      controlRunId: g1Env.STAGING_G1_CONTROL_RUN_ID,
      tunedRunId: g1Env.STAGING_G1_TUNED_RUN_ID,
      controlQueue: g1Env.STAGING_G1_CONTROL_QUEUE,
      tunedQueue: g1Env.STAGING_G1_TUNED_QUEUE,
      pairedCadenceMaxMin: 30,
      secretReferences: {
        stripeSecretKey: 'stripe-secret-key-staging@1',
        stripeWebhookSecret: 'stripe-webhook-secret-staging@1',
        apiKeyHmacSecret: 'api-key-hmac-secret-staging@1',
        cronSecret: 'cron-secret@1',
        geminiApiKey: 'gemini-api-key@2',
      },
      immutableLedger,
    },
    isolatedSupabaseProjectCount: 4,
    isolatedSupabaseProjectMonthlyEachUsd: 10,
    isolatedSupabaseProjectsMonthlyTotalUsd: 40,
    g1VariableComputeModelCapUsd: 120,
    s33TotalCapUsd: 200,
    ownerIdentity: 'lane-4-sm',
    expiresAt: '2026-07-20T00:00:00Z',
    raci: {
      responsibleIdentity: 'lane-4-sm',
      accountableIdentity: 'arkova.s33.approver.founder-cto.v1',
      consultedIdentities: ['cto'], informedIdentities: ['rte'],
    },
    approvalVerifiedAt: '2026-07-15T20:00:00Z',
    verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1',
    verificationMethod: 'ed25519-pinned-authority-roster',
    runtimeVerifiedAt: '2026-07-15T20:01:00.000Z',
    trustRootKeyId: 'arkova.s33.g1-spend.ed25519.v1',
    trustRootKeyFingerprint:
      '6ece5cea2d35423aab35a23f6292fd769c6d839ac03ba7860a973d4febd5d987',
  });
  writeFileSync(join(root, 'approval-envelope.json'), `${verifiedApproval}\n`);

  let cleanChecksumDigest: string | undefined;
  let ambientChecksumDigest: string | undefined;
  if (checksumTargetPath && forgedChecksumDigest) {
    const escapePerlSingleQuoted = (value: string) => value
      .replaceAll('\\', '\\\\')
      .replaceAll("'", "\\'");
    writeFileSync(join(root, 'ArkovaChecksumOverride.pm'), `
package ArkovaChecksumOverride;
use strict;
use warnings;
use Digest::SHA ();
my $original = \\&Digest::SHA::hexdigest;
my $target = '${escapePerlSingleQuoted(checksumTargetPath)}';
my $forged = '${forgedChecksumDigest}';
{
  no warnings qw(redefine prototype);
  *Digest::SHA::hexdigest = sub {
    return $forged if @ARGV && $ARGV[-1] eq $target;
    return $original->(@_);
  };
}
1;
`);
    cleanChecksumDigest = createHash('sha256')
      .update(readFileSync(checksumTargetPath))
      .digest('hex');
    ambientChecksumDigest = execFileSync('/usr/bin/shasum', [
      '-a', '256', '--', checksumTargetPath,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PERL5LIB: root,
        PERL5OPT: '-MArkovaChecksumOverride',
      },
    }).trim().split(/\s+/u)[0];
  }

  writeFileSync(join(root, 'git'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${pathGitLog}'
if [[ "$1" == "rev-parse" && "\${2:-}" == "--show-toplevel" ]]; then printf '%s\\n' '${fakeRepo}'; exit 0; fi
if [[ "$1" == "rev-parse" && "\${2:-}" == "HEAD" ]]; then printf '%s\\n' '${fixtureHead}'; exit 0; fi
if [[ "$1" == "fetch" || "$1" == "ls-files" || "$1" == "cat-file" ]]; then exit 0; fi
if [[ "$1" == "diff" ]]; then exit 0; fi
if [[ "$1" == "merge-base" && "\${2:-}" == "--is-ancestor" ]]; then exit 0; fi
if [[ "$1" == "merge-base" ]]; then printf '%s\\n' '${fixtureHead}'; exit 0; fi
if [[ "$1" == "show" ]]; then printf '%s' 'export const g1FixtureDriver = true;'; exit 0; fi
echo "unexpected git call: $*" >&2
exit 64
`);
  chmodSync(join(root, 'git'), 0o755);

  writeFileSync(join(root, 'npx'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${npxLog}'
if [[ "$1" == "tsx" && "$2" == "scripts/staging/s33-g1-spend-approval.ts" ]]; then
  printf '%s\\n' '${verifiedApproval}'
  exit 0
fi
if [[ "$1" == "supabase" && "$2" == "projects" && "$3" == "list" ]]; then
  printf '%s\\n' '[]'
  exit 0
fi
if [[ "$1" == "supabase" && "$2" == "projects" && "$3" == "create" ]]; then
  count=0
  [[ ! -f '${supabaseCreateCount}' ]] || count="$(cat '${supabaseCreateCount}')"
  count=$((count + 1))
  printf '%s' "$count" > '${supabaseCreateCount}'
  if [[ "$count" == "1" ]]; then
    printf '%s\\n' '{"id":"${controlProjectRef}","name":"arkova-soak-s33-g1-a"}'
  else
    printf '%s\\n' '{"id":"${tunedProjectRef}","name":"arkova-soak-s33-g1-b"}'
  fi
  exit 0
fi
if [[ "$1" == "supabase" && "$2" == "projects" && "$3" == "api-keys" ]]; then
  printf '%s\\n' '[{"name":"service_role","type":"legacy","api_key":"fixture-project-specific-service-role"}]'
  exit 0
fi
if [[ "$1" == "supabase" ]]; then exit 0; fi
echo "unexpected npx call: $*" >&2
exit 64
`);
  chmodSync(join(root, 'npx'), 0o755);

  writeFileSync(join(root, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
url=''
for arg in "$@"; do
  if [[ "$arg" == https://* ]]; then url="$arg"; fi
done
if [[ "$url" == *':deployModel' ]]; then
  printf '%s\\n' '{"name":"projects/270018525501/locations/us-central1/operations/123456"}'
  exit 0
fi
if [[ "$url" == *'/operations/123456' ]]; then
  printf '%s\\n' '{"done":true}'
  exit 0
fi
if [[ "$url" == *':getIamPolicy' ]]; then
  if [[ -f '${endpointPolicyState}' ]]; then
    printf '%s\\n' '{"version":1,"etag":"fixture-etag","bindings":[{"role":"roles/aiplatform.endpointUser","members":["serviceAccount:s33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com"]}]}'
  else
    printf '%s\\n' '{"version":1,"etag":"fixture-etag","bindings":[]}'
  fi
  exit 0
fi
if [[ "$url" == *':setIamPolicy' ]]; then
  : > '${endpointPolicyState}'
  printf '%s\\n' '{"version":1,"etag":"fixture-etag"}'
  exit 0
fi
if [[ "$url" == *':generateContent' ]]; then
  printf '%s\\n' '{"candidates":[{"content":{"parts":[{"text":"{}"}]}}]}'
  exit 0
fi
echo 'unexpected fixture curl request' >&2
exit 64
`);
  chmodSync(join(root, 'curl'), 0o755);

  if (options.fakeNode) {
    writeFileSync(join(root, 'node'), `#!/usr/bin/env bash\nprintf '%s\\n' '${verifiedApproval}'\n`);
    chmodSync(join(root, 'node'), 0o755);
  }

  writeFileSync(join(root, 'gcloud'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${gcloudLog}'
if [[ "$1" == "storage" && "$2" == "cp" ]]; then
  [[ "$*" == *'--if-generation-match=0'* ]] || { echo 'missing atomic create precondition' >&2; exit 46; }
  [[ "$*" == *'--retention-mode=Locked'* ]] || { echo 'missing locked retention' >&2; exit 47; }
  if ! mkdir '${ledgerDir}/approval-s33-g1-001' 2>/dev/null; then
    echo 'Precondition Failed: object generation is no longer zero' >&2
    exit 45
  fi
  exit 0
fi
if [[ "$1" == "storage" && "$2" == "buckets" && "$3" == "describe" ]]; then
  printf '%s\\n' '{"name":"${immutableLedgerBucket}","projectNumber":"270018525501","objectRetention":${options.bucketObjectRetention === false ? 'null' : '{"mode":"Enabled"}'}}'
  exit 0
fi
if [[ "$1" == "storage" && "$2" == "objects" && "$3" == "describe" ]]; then
  printf '%s\\n' '{"bucket":"${immutableLedgerBucket}","name":"s33/g1/approval-claims/approval-s33-g1-001.json","generation":"1","timeCreated":"2026-07-15T20:02:00Z","retention":{"mode":"Locked","retainUntilTime":"2026-07-20T00:00:00Z"}}'
  exit 0
fi
if [[ "$1" == "artifacts" && "$2" == "docker" ]]; then
  printf '%s\\n' '${pinnedImage}'
  exit 0
fi
if [[ "$1" == "secrets" && "$2" == "describe" ]]; then
  if [[ "$3" == supabase-url-s33-g1-* || "$3" == supabase-service-role-key-s33-g1-* ]]; then
    exit 1
  fi
  exit 0
fi
if [[ "$1" == "secrets" && "$2" == "versions" && "$3" == "describe" ]]; then
  version="$4"
  secret=''
  for arg in "$@"; do
    case "$arg" in --secret=*) secret="\${arg#--secret=}" ;; esac
  done
  printf '{"name":"projects/270018525501/secrets/%s/versions/%s","state":"ENABLED"}\\n' \
    "$secret" "$version"
  exit 0
fi
if [[ "$1" == "projects" && "$2" == "describe" ]]; then
  printf '%s\\n' '{"projectId":"arkova1","projectNumber":"270018525501"}'
  exit 0
fi
if [[ "$1" == "secrets" && "$2" == "versions" && "$3" == "access" ]]; then
  printf '%s\\n' 'stub-secret-value'
  exit 0
fi
if [[ "$1" == "iam" && "$2" == "service-accounts" && "$3" == "describe" ]]; then
  if [[ "$4" == s33-rig-g1-a-runtime@* ]]; then
    printf '%s\\n' '{"email":"s33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com","uniqueId":"111111111111111111111"}'
  else
    printf '%s\\n' '{"email":"s33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com","uniqueId":"222222222222222222222"}'
  fi
  exit 0
fi
if [[ "$1" == "auth" && "$2" == "print-access-token" ]]; then
  printf '%s\\n' 'fixture-access-token'
  exit 0
fi
if [[ "$1" == "ai" && "$2" == "endpoints" && "$3" == "create" ]]; then
  rm -f '${endpointDeletedState}'
  exit 0
fi
if [[ "$1" == "ai" && "$2" == "endpoints" && "$3" == "delete" ]]; then
  : > '${endpointDeletedState}'
  exit 0
fi
if [[ "$1" == "ai" && "$2" == "endpoints" && "$3" == "describe" ]]; then
  [[ ! -f '${endpointDeletedState}' ]] || exit 1
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
  if [[ "$4" == *'-b-staging-revision' ]]; then
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
    PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`,
    CONFIRM_PROVISION: rigName,
    CONFIRM_REAL_CONFIG: 'gemini',
    CONFIRM_POST_W3_PROVISION: 'RIG-G1',
    GITHUB_SHA: fixtureHead,
    BASE_SHA: fixtureHead,
    STAGING_SOURCE_HEAD_SHA: fixtureHead,
    STAGING_PINNED_IMAGE: pinnedImage,
    STAGING_SOAK_ID: 'soak-s33-g1',
    STAGING_LEASE_ID: leaseId,
    STAGING_G1_A_SUPABASE_DB_PASSWORD: 'stub-a-password-not-real',
    STAGING_G1_B_SUPABASE_DB_PASSWORD: 'stub-b-password-not-real',
    STAGING_NEW_SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role-not-real',
    STAGING_CHANGED_BEHAVIOR: 'RIG-G1 paired public/v6 external experiment',
    STAGING_G1_SPEND_APPROVAL_ARTIFACT: join(root, 'approval-envelope.json'),
    STAGING_ADMISSION_DIR: artifactDir,
    ...options.env,
    ...(checksumTargetPath
      ? { PERL5LIB: root, PERL5OPT: '-MArkovaChecksumOverride' }
      : {}),
  };
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', [fixtureProvisioner, '--name', rigName, '--profile', 'gemini', '--apply'], {
      cwd: fakeRepo,
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
    pathGitCalls: readFileSync(pathGitLog, 'utf8').trim().split('\n').filter(Boolean),
    artifactEntries: existsSync(artifactDir) ? readdirSync(artifactDir) : [],
    checksumHelperUnchanged,
    cleanChecksumDigest,
    ambientChecksumDigest,
    forgedChecksumDigest,
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
    expect(deploys[0]).toContain('arkova-worker-s33-g1-a-staging');
    expect(deploys[1]).toContain('arkova-worker-s33-g1-b-staging');
    expect(deploys.every((line) => line.includes('--min-instances=0'))).toBe(true);
    expect(deploys.every((line) => line.includes('--max-instances=2'))).toBe(true);
    expect(deploys.every((line) => line.includes('--allow-unauthenticated'))).toBe(true);
    expect(deploys.every((line) => !line.includes('--no-allow-unauthenticated'))).toBe(true);
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
      'GEMINI_TUNED_MODEL=projects/arkova1/locations/us-central1/endpoints/733001',
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
      candidate_model_resource:
        'projects/270018525501/locations/us-central1/models/6611494259700793344',
      candidate_model_version_resource:
        'projects/270018525501/locations/us-central1/models/6611494259700793344@1',
      checkpoint_id: '6',
      corpus_digest: g1Env.STAGING_G1_CORPUS_DIGEST,
      tier: 'T2',
      required_worker_uptime_min: 720,
      required_wall_min: 750,
      paired_cadence_max_min: 30,
      execution_state: 'PAUSED',
      background_execution: 'disabled',
      owner: '<from-verified-approval-record>',
      expires_at: '<from-verified-approval-record>',
      stop_authority: '<from-verified-approval-approver>',
      teardown_owner: '<from-verified-approval-owner>',
      budget: {
        s33_total_cap_usd: null,
        g1_variable_compute_model_cap_usd: null,
        isolated_supabase_project_count: 4,
        isolated_supabase_project_monthly_each_usd: 10,
        isolated_supabase_projects_monthly_total_usd: 40,
      },
      spend_approval: {
        status: 'UNVERIFIED',
      },
      approval_claim: null,
    });
    expect(admission.g1.arms).toEqual([
      expect.objectContaining({
        arm: 'public_control',
        run_id: 's33-g1-control-v6',
        queue: 's33-g1-control-queue',
        rig_id: 'RIG-G1-A',
        service: 'arkova-worker-s33-g1-a-staging',
        supabase_project_name: 'arkova-soak-s33-g1-a',
        runtime_service_account: 's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com',
        gemini_model: 'gemini-2.5-flash',
        gemini_tuned_model: '<unset>',
        gemini_v6_prompt: '<unset>',
      }),
      expect.objectContaining({
        arm: 'tuned_v6',
        run_id: 's33-g1-tuned-v6',
        queue: 's33-g1-tuned-queue',
        rig_id: 'RIG-G1-B',
        service: 'arkova-worker-s33-g1-b-staging',
        supabase_project_name: 'arkova-soak-s33-g1-b',
        runtime_service_account: 's33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com',
        gemini_tuned_model: g1Env.STAGING_GEMINI_TUNED_MODEL,
        gemini_v6_prompt: 'true',
      }),
    ]);
    expect(admission.g1.teardown.physical_arm_commands).toHaveLength(2);
    expect(admission.g1.teardown.physical_arm_commands[0]).toContain('--rig-id RIG-G1-A');
    expect(admission.g1.teardown.physical_arm_commands[1]).toContain('--rig-id RIG-G1-B');
    expect(admission.g1.shared_inputs).toEqual({
      image: '<required-in-apply:--image-or-STAGING_PINNED_IMAGE@sha256>',
      corpus_digest: g1Env.STAGING_G1_CORPUS_DIGEST,
    });
  });

  it('never promotes caller environment values into stop or teardown authority', () => {
    const callerStop = 'caller-appointed-stop-authority';
    const callerTeardown = 'caller-appointed-teardown-owner';
    const result = g1DryRun({
      STAGING_G1_STOP_AUTHORITY: callerStop,
      STAGING_G1_TEARDOWN_OWNER: callerTeardown,
    });
    expect(result.code, result.out).toBe(0);
    const line = result.out.split('\n').find((entry) => entry.startsWith('ADMISSION_JSON='));
    const admission = JSON.parse(line!.slice('ADMISSION_JSON='.length));
    expect(admission.g1.stop_authority).toBe('<from-verified-approval-approver>');
    expect(admission.g1.teardown_owner).toBe('<from-verified-approval-owner>');
    expect(JSON.stringify(admission.g1)).not.toContain(callerStop);
    expect(JSON.stringify(admission.g1)).not.toContain(callerTeardown);
  });

  it('re-observes the Vertex endpoint and proves the exact candidate deployment before mutation', () => {
    expect(provisionerSource).toContain('gcloud ai endpoints describe "$G1_ENDPOINT_ID"');
    expect(provisionerSource).toContain('(.deployedModels | type == "array" and length == 1)');
    expect(provisionerSource).toContain('.deployedModels[0].model == $expected');
    expect(provisionerSource).toContain('.deployedModels[0].id == $deployed_id');
    expect(provisionerSource).toContain('((.trafficSplit | keys) == [$deployed_id])');
    expect(provisionerSource).toContain('.trafficSplit[$deployed_id] == 100');
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
  ])('rejects endpoint readiness with %s before either worker deploy', (_label, endpoint) => {
    const result = runG1ApplyFault({ endpoint });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/endpoint|sole|traffic|ready/i);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
    expect(result.npxCalls.filter((call) => call.startsWith('supabase projects create '))).toHaveLength(2);
  }, 20_000);

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
    ['short worker clock', { STAGING_REQUIRED_UPTIME_MIN: '719' }],
    ['short wall clock', { STAGING_REQUIRED_WALL_MIN: '749' }],
    ['slow pairing cadence', { STAGING_G1_PAIRED_CADENCE_MIN: '31' }],
  ])('rejects an invalid custom-T2 contract: %s', (_label, env) => {
    const result = g1DryRun(env);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/RIG-G1|T2|720|750|cadence/i);
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
      STAGING_G1_A_SUPABASE_DB_PASSWORD: 'stub-a-password-not-real',
      STAGING_G1_B_SUPABASE_DB_PASSWORD: 'stub-b-password-not-real',
      STAGING_CHANGED_BEHAVIOR: 'RIG-G1 paired public/v6 external experiment',
      STAGING_G1_SPEND_APPROVAL_ARTIFACT: '/tmp/caller-authored-approval.json',
      STAGING_G1_SPEND_AUTHORITY_ID: 'caller-self-attestation',
      CONFIRM_G1_SPEND_AUTHORITY: 'caller-self-attestation',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/approval|trust root|UNCONFIGURED|immutable|STAGING_NEW_SUPABASE_DB_PASSWORD/i);
    expect(result.out).not.toContain('projects create');
    expect(result.out).not.toContain('gcloud run deploy');
  });

  it('uses one tracked built-in-only verifier and a code-bound launcher instead of PATH npx/tsx', () => {
    const verifierPath = resolve(here, 's33-g1-spend-approval.mjs');
    expect(existsSync(verifierPath)).toBe(true);
    if (!existsSync(verifierPath)) return;
    const verifierSource = readFileSync(verifierPath, 'utf8');
    const imports = [...verifierSource.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
    expect(provisionerSource).toContain('RIG_G1_TRUSTED_NODE_SHA256');
    expect(provisionerSource).not.toContain('npx tsx "$RIG_G1_SPEND_APPROVAL_VERIFIER"');
  });

  it('code-binds and sanitizes the sole Git/blob reader used by live admission', () => {
    expect(provisionerSource).toContain('TRUSTED_GIT_PATH="/usr/bin/git"');
    expect(provisionerSource).toMatch(/TRUSTED_GIT_SHA256="[0-9a-f]{64}"/);
    expect(provisionerSource).toContain('TRUSTED_GIT_VERSION="git version 2.50.1 (Apple Git-155)"');
    expect(provisionerSource).toContain('/usr/bin/env -i');
    expect(provisionerSource).toContain('GIT_CONFIG_NOSYSTEM=1');
    expect(provisionerSource).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    expect(provisionerSource).toContain('GIT_CONFIG_COUNT=0');
    expect(provisionerSource).toContain('GIT_NO_REPLACE_OBJECTS=1');
    expect(provisionerSource).not.toContain('git diff --quiet');
  });

  it.each([
    ['git', /trusted Git binary digest/i],
    ['node', /Node launcher digest|launcher is not trusted/i],
  ] as const)(
    'rejects an ambient checksum-loader forgery of the %s binding before every marker',
    (checksumLoaderTarget, expectedFailure) => {
      const result = runG1ApplyFault({ checksumLoaderTarget });
      expect(result.checksumHelperUnchanged).toBe(true);
      expect(result.cleanChecksumDigest).not.toBe(result.forgedChecksumDigest);
      expect(result.ambientChecksumDigest).toBe(result.forgedChecksumDigest);
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(expectedFailure);
      expect(result.pathGitCalls).toEqual([]);
      expect(result.gcloudCalls).toEqual([]);
      expect(result.npxCalls).toEqual([]);
      expect(result.state).toBeNull();
      expect(result.artifactEntries).toEqual([]);
    },
  );

  it('routes shasum and the sha256sum fallback through one fixed empty-environment boundary', () => {
    expect(provisionerSource).toContain('execute_sha256_checksum() {');
    expect(provisionerSource).toContain('utility="/usr/bin/shasum"');
    expect(provisionerSource).toContain('utility="/usr/bin/sha256sum"');
    expect(provisionerSource).toMatch(/\/usr\/bin\/env -i[\s\\]+TZ=UTC LC_ALL=C LANG=C/);
    expect(provisionerSource).toContain('trusted_sha256_file()');
    expect(provisionerSource).toContain('sha256_file()');
    expect(provisionerSource).not.toContain('\n  shasum -a 256 "$path"');
    expect(provisionerSource).not.toMatch(/(^|[^/])\bsha256sum\s+--/m);
  });

  it('binds the signed approval to the complete G1 execution scope and atomically claims it', () => {
    for (const expectedArg of [
      '--expected-rig-name', '--expected-rig-profile', '--expected-soak-id',
      '--expected-rig-id', '--expected-lease-id', '--expected-corpus-digest',
      '--expected-endpoint-id', '--expected-endpoint-resource', '--expected-endpoint-display-name',
      '--expected-vertex-model-resource', '--expected-checkpoint-id', '--expected-deployed-model-id',
      '--expected-deployed-model-display-name', '--expected-deployment-resources-mode',
      '--expected-min-replica-count', '--expected-max-replica-count',
      '--expected-control-runtime-service-account', '--expected-tuned-runtime-service-account',
      '--expected-control-service', '--expected-tuned-service', '--expected-control-run-id',
      '--expected-control-project-name', '--expected-tuned-project-name',
      '--expected-tuned-run-id', '--expected-control-queue', '--expected-tuned-queue',
      '--expected-paired-cadence-max-min',
      '--expected-control-supabase-url-secret-reference',
      '--expected-control-supabase-service-role-secret-reference',
      '--expected-tuned-supabase-url-secret-reference',
      '--expected-tuned-supabase-service-role-secret-reference',
      '--expected-stripe-secret-key-reference', '--expected-stripe-webhook-secret-reference',
      '--expected-api-key-hmac-secret-reference', '--expected-cron-secret-reference',
      '--expected-gemini-api-key-secret-reference',
      '--expected-immutable-ledger-bucket',
    ]) expect(provisionerSource).toContain(expectedArg);
    expect(provisionerSource).toContain('--if-generation-match=0');
    expect(provisionerSource).toContain('approval_claim');
    const stepOneApply = provisionerSource.slice(provisionerSource.indexOf('CREATE_CMD=('));
    expect(stepOneApply.indexOf('claim_g1_spend_approval_once'))
      .toBeLessThan(stepOneApply.indexOf('NEW_PROJECT_REF="$('));
  });

  it('fails before claim or paid mutation when the approved ledger lacks per-object retention', () => {
    const result = runG1ApplyFault({ bucketObjectRetention: false });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/per-object retention|immutable.*ledger|bucket capability/i);
    expect(result.gcloudCalls.some((call) => call.startsWith('storage buckets describe '))).toBe(true);
    expect(result.gcloudCalls.some((call) => call.startsWith('storage cp '))).toBe(false);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
  });

  it('code-binds every immutable claim to the dedicated approved retention ledger', () => {
    expect(provisionerSource).toContain(`IMMUTABLE_AUTHORITY_LEDGER_BUCKET="${immutableLedgerBucket}"`);
    expect(provisionerSource).not.toContain('RIG_G1_APPROVAL_LEDGER_BUCKET="arkova-training-data"');
    expect(provisionerSource).not.toContain('RIG_R_APPROVAL_LEDGER_BUCKET="arkova-training-data"');
    expect(provisionerSource).not.toContain('RIG_R_LEASE_BUCKET="arkova-training-data"');
    expect(provisionerSource.indexOf('verify_immutable_authority_ledger_capability'))
      .toBeLessThan(provisionerSource.indexOf('claim_g1_spend_approval_once'));
  });

  it.each([
    ['runtime service account', { STAGING_RUNTIME_SA_EMAIL: 'shadow@arkova1.iam.gserviceaccount.com' }],
    ['control run id', { STAGING_G1_CONTROL_RUN_ID: 'shadow-control-run' }],
    ['tuned queue', { STAGING_G1_TUNED_QUEUE: 'shadow-tuned-queue' }],
    ['paired cadence', { STAGING_G1_PAIRED_CADENCE_MIN: '29' }],
    ['Gemini secret', { STAGING_GEMINI_API_KEY_SECRET: 'shadow-gemini-secret' }],
  ])('rejects caller substitution of signed %s before approval claim or paid mutation', (_label, env) => {
    const result = runG1ApplyFault({ env });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/approval|approved|scope|binding|verifier/i);
    expect(result.gcloudCalls.some((call) => call.startsWith('storage cp '))).toBe(false);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
  });

  it('persists only authenticated approval authority despite arbitrary caller authority env', () => {
    const result = runG1ApplyFault({
      failDeployAt: 1,
      env: {
        STAGING_G1_STOP_AUTHORITY: 'caller-appointed-stop-authority',
        STAGING_G1_TEARDOWN_OWNER: 'caller-appointed-teardown-owner',
      },
    });
    expect(result.state).not.toBeNull();
    expect(result.state).toMatchObject({
      g1_authority: {
        approval_id: 'approval-s33-g1-001',
        stop_authority: 'arkova.s33.approver.founder-cto.v1',
        teardown_owner: 'lane-4-sm',
      },
    });
    expect(JSON.stringify(result.state)).not.toContain('caller-appointed');
  });

  it('ignores a PATH-substituted Node and uses the exact code-bound launcher', () => {
    const result = runG1ApplyFault({ fakeNode: true });
    expect(result.code).not.toBe(0);
    expect(result.out).not.toMatch(/Node launcher digest|launcher is not trusted|UNCONFIGURED/i);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(true);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(true);
  }, 20_000);

  it.each([
    ['provisioner', 'assume-unchanged'],
    ['provisioner', 'skip-worktree'],
    ['driver', 'assume-unchanged'],
    ['driver', 'skip-worktree'],
    ['verifier', 'assume-unchanged'],
    ['verifier', 'skip-worktree'],
  ] as const)(
    'rejects %s bytes hidden by %s before every resource call',
    (dirtyInput, hiddenByIndexFlag) => {
      const result = runG1ApplyFault({ dirtyInput, hiddenByIndexFlag });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/working-tree bytes differ|byte-for-byte|commit or restore/i);
      expect(result.pathGitCalls).toEqual([]);
      expect(result.gcloudCalls).toEqual([]);
      expect(result.npxCalls).toEqual([]);
    },
  );

  it.each([
    ['another rig name', { name: 's33-g1-other' }],
    ['another lease', { leaseId: 'lease-s33-g1-other' }],
  ])('rejects replay of the same envelope under %s with zero creates/deploys', (_label, scope) => {
    const result = runG1ApplyFault(scope);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/approval verifier output|scope|binding/i);
    expect(result.gcloudCalls.some((call) => call.startsWith('storage cp '))).toBe(false);
    expect(result.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
  });

  it('ignores a PATH npx/tsx approval spoof and invokes only the trusted Node verifier', () => {
    const result = runG1ApplyFault({ failDeployAt: 1 });
    expect(result.code).not.toBe(0);
    expect(result.npxCalls.some((call) => call.includes('s33-g1-spend-approval'))).toBe(false);
    expect(result.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(true);
  });

  it('allows exactly one duplicate/concurrent claimant through the generation-zero ledger', () => {
    const ledger = realpathSync(mkdtempSync(join(tmpdir(), 'g1-shared-approval-ledger-')));
    stubRoots.push(ledger);
    const winner = runG1ApplyFault({ failDeployAt: 1, sharedLedgerDir: ledger });
    expect(winner.npxCalls.filter((call) => call.startsWith('supabase projects create '))).toHaveLength(2);
    expect(winner.gcloudCalls.filter((call) => call.startsWith('storage cp '))).toHaveLength(1);

    const loser = runG1ApplyFault({ sharedLedgerDir: ledger });
    expect(loser.code).not.toBe(0);
    expect(loser.out).toMatch(/already claimed|claim ledger/i);
    expect(loser.gcloudCalls.filter((call) => call.startsWith('storage cp '))).toHaveLength(1);
    expect(loser.npxCalls.some((call) => call.startsWith('supabase projects create '))).toBe(false);
    expect(loser.gcloudCalls.some((call) => call.startsWith('run deploy '))).toBe(false);
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
    expect(result.state).toMatchObject({
      status: 'REQUIRES_IMMEDIATE_TEARDOWN',
      approval_claim: {
        status: 'CLAIMED',
        backend: 'gcs-if-generation-match-0-locked-retention',
        approval_id: 'approval-s33-g1-001',
        canonical_sha256: `sha256:${'1'.repeat(64)}`,
        generation: '1',
        retention_until: '2026-07-20T00:00:00Z',
      },
    });
    const cleanup = result.state!.cleanup as {
      cloud_run_service_candidates: string[];
      cloud_run_delete_commands: string[];
      approval_claim: { approval_id: string };
      teardown_command: string;
    };
    expect(cleanup.cloud_run_service_candidates).toEqual([
      'arkova-worker-s33-g1-a-staging',
      'arkova-worker-s33-g1-b-staging',
    ]);
    expect(cleanup.cloud_run_delete_commands).toHaveLength(2);
    expect(cleanup.cloud_run_delete_commands[0]).toContain('arkova-worker-s33-g1-a-staging');
    expect(cleanup.cloud_run_delete_commands[1]).toContain('arkova-worker-s33-g1-b-staging');
    expect(cleanup.approval_claim.approval_id).toBe('approval-s33-g1-001');
    expect(cleanup.teardown_command).toContain('--project-ref abcdefghijklmnopqrst');
    expect(cleanup.teardown_command).toContain('--service arkova-worker-s33-g1-a-staging');
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
  it('reclaims each physical arm independently and only G1-B owns the temporary endpoint', () => {
    const control = run(teardown, [
      '--project-ref', 'abcdefghijklmnopqrst',
      '--rig-name', 's33-g1-a',
      '--rig-id', 'RIG-G1-A',
      '--service', 'arkova-worker-s33-g1-a-staging',
      '--runtime-sa', 's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com',
    ]);
    const tuned = run(teardown, [
      '--project-ref', 'bcdefghijklmnopqrstu',
      '--rig-name', 's33-g1-b',
      '--rig-id', 'RIG-G1-B',
      '--service', 'arkova-worker-s33-g1-b-staging',
      '--runtime-sa', 's33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com',
      '--vertex-endpoint', 'projects/arkova1/locations/us-central1/endpoints/733001',
      '--vertex-model', endpointModel,
      '--deployed-model-id', '7330011',
    ]);
    expect(control.code, control.out).toBe(0);
    expect(tuned.code, tuned.out).toBe(0);
    expect(control.out.match(/gcloud run services delete/g)).toHaveLength(1);
    expect(tuned.out.match(/gcloud run services delete/g)).toHaveLength(1);
    expect(control.out).toContain('supabase-url-s33-g1-a-staging');
    expect(tuned.out).toContain('supabase-url-s33-g1-b-staging');
    expect(control.out.match(/supabase projects delete/g)).toHaveLength(1);
    expect(tuned.out.match(/supabase projects delete/g)).toHaveLength(1);
    expect(control.out).not.toContain('undeploy-model');
    expect(tuned.out).toContain('undeploy-model');
    expect(tuned.out).toContain('endpoints/733001');
  });
});
