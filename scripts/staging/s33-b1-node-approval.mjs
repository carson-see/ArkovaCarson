#!/usr/bin/env node
/**
 * Verify the founder/CTO-signed RIG-B1 Bitcoin Core Signet provision authority.
 * Built-ins only; the production CLI has no caller-supplied trust-root option.
 */

import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE+Ir2My5+bBwU73QkL73F7fiRteZ0V5yIAe41fD6MdU=\n-----END PUBLIC KEY-----\n';
const AUTHORITY = Object.freeze({
  keyId: 'arkova.s33.b1-evidence.ed25519.v1',
  fingerprint: '8b7fbc51c74828dab2e1a3ca6f0c15069575bae8e4e190eaf3b165daea50d5c6',
  approverIdentity: 'arkova.s33.approver.founder-cto.v1',
  verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1',
});
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,254}$/u;
const SECRET_VERSION = /^[1-9][0-9]*$/u;
const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/u;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@arkova1[.]iam[.]gserviceaccount[.]com$/u;

const EXACT_BITCOIN_BUILD = Object.freeze({
  recipeCommit: 'b9a54856c9bee87d958cc4b070776828b5c17b32',
  containerImage:
    'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8',
  amd64RuntimeDigest:
    'sha256:684e80900f124890c45ad9b691d7f76456c1042385bce4ab92725b1979b55888',
  sourceTarballSha256:
    'b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e',
});

const EXACT_RESOURCES = Object.freeze({
  zone: 'us-central1-a',
  vm: 'arkova-s33-rig-b1-bitcoin-core-signet',
  bootDisk: 'arkova-s33-rig-b1-bitcoin-core-signet-boot',
  dataDisk: 'arkova-s33-rig-b1-bitcoin-core-signet-data',
  internalAddress: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-ip',
  externalAddress: 'arkova-s33-rig-b1-bitcoin-core-signet-p2p-ip',
  network: 'arkova-s33-rig-b1-bitcoin-core-signet-vpc',
  subnet: 'arkova-s33-rig-b1-bitcoin-core-signet-subnet',
  rpcFirewall: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc',
  vpcConnector: 'arkova-s33-b1-signet-vpc',
  nodeServiceAccount: 's33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
});
const EXACT_NETWORK = Object.freeze({
  rpcEndpoint: 'http://10.33.10.10:38332',
  rpcBind: '10.33.10.10',
  rpcAllowCidr: '10.33.11.0/28',
  subnetCidr: '10.33.10.0/28',
  rpcPort: 38332,
  signetP2pPort: 38333,
  publicRpc: false,
});
const EXACT_IAM = Object.freeze({
  artifactRegistryReader: Object.freeze({
    repository: 'projects/arkova1/locations/us-central1/repositories/arkova-worker-images',
    member: 'serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
    role: 'roles/artifactregistry.reader',
  }),
  rpcAuthSecretAccessor: Object.freeze({
    secretName: 'arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth',
    member: 'serviceAccount:s33-rig-b1-bitcoin-core@arkova1.iam.gserviceaccount.com',
    role: 'roles/secretmanager.secretAccessor',
  }),
});
const EXACT_PROVIDER = Object.freeze({
  workerProvider: 'rpc',
  primary: 'bitcoin-core-signet-rpc',
  secondary: 'mempool-space-signet',
  secondaryApiUrl: 'https://mempool.space/signet/api',
});
const EXACT_TREASURY_SPLIT_TXID =
  '1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941';
const EXACT_TREASURY_TOTAL_SATS = 169_639;
const EXACT_TEARDOWN_ORDER = Object.freeze([
  'scheduler-jobs', 'cloud-run-service', 'bitcoin-core-vm', 'boot-disk', 'data-disk',
  'external-address', 'internal-address', 'rpc-firewall', 'vpc-connector',
  'subnet', 'vpc-network', 'artifact-registry-iam', 'node-secret-iam', 'node-service-account',
  'worker-secret-iam', 'worker-runtime-service-account', 'scheduler-oidc-service-account',
  'supabase-project',
]);

function scanString(raw, start) {
  let end = start + 1;
  while (end < raw.length) {
    if (raw[end] === '\\') { end += 2; continue; }
    if (raw[end] === '"') break;
    end += 1;
  }
  let cursor = end + 1;
  while (/\s/u.test(raw[cursor] ?? '')) cursor += 1;
  return { end, key: raw[cursor] === ':' };
}

function decodedKey(raw, start, end, label) {
  try { return JSON.parse(raw.slice(start, end + 1)); } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function assertNoDuplicateKeys(raw, label) {
  const stack = [];
  for (let index = 0; index < raw.length;) {
    const char = raw[index];
    if (char === '{') { stack.push({ kind: 'object', keys: new Set() }); index += 1; continue; }
    if (char === '[') { stack.push({ kind: 'array' }); index += 1; continue; }
    if (char === '}' || char === ']') { stack.pop(); index += 1; continue; }
    if (char !== '"') { index += 1; continue; }
    const start = index;
    const scanned = scanString(raw, start);
    if (scanned.end >= raw.length) throw new Error(`${label} must contain valid JSON.`);
    index = scanned.end + 1;
    if (!scanned.key) continue;
    const frame = stack.at(-1);
    if (frame?.kind !== 'object') continue;
    const key = decodedKey(raw, start, scanned.end, label);
    if (frame.keys.has(key)) throw new Error(`${label} contains duplicate JSON key ${key}.`);
    frame.keys.add(key);
  }
}

function parseJson(raw, label) {
  if (typeof raw !== 'string') throw new Error(`${label} must be a primitive string.`);
  assertNoDuplicateKeys(raw, label);
  try { return JSON.parse(raw); } catch { throw new Error(`${label} must contain valid JSON.`); }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    throw new Error(`${label} failed strict schema validation.`);
  }
}

function string(value, pattern, label, max = 1024) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) {
    throw new Error(`${label} failed strict schema validation.`);
  }
  return value;
}

function literal(value, expected, label) {
  if (value !== expected) throw new Error(`${label} failed strict schema validation.`);
  return value;
}

function timestamp(value, label) {
  const text = string(value, UTC, label, 40);
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch)) throw new Error(`${label} is not a valid UTC timestamp.`);
  return { text, epoch };
}

function exactObject(value, expected, label) {
  const candidate = object(value, label);
  exactKeys(candidate, Object.keys(expected), label);
  return Object.fromEntries(Object.entries(expected).map(([key, expectedValue]) => [
    key, literal(candidate[key], expectedValue, `${label}.${key}`),
  ]));
}

function parseSecrets(value) {
  if (!Array.isArray(value) || value.length !== 9) {
    throw new Error('B1 approval requires the exact nine-secret inventory.');
  }
  const seenEnv = new Set();
  const parsed = value.map((entry, index) => {
    const secret = object(entry, `B1 approval secretReferences[${index}]`);
    exactKeys(secret, ['env', 'secretName', 'version', 'resource'], `B1 approval secretReferences[${index}]`);
    const env = string(secret.env, /^[A-Z][A-Z0-9_]{2,63}$/u, `secretReferences[${index}].env`, 64);
    if (seenEnv.has(env)) throw new Error('B1 approval secret inventory contains duplicate env identities.');
    seenEnv.add(env);
    const secretName = string(secret.secretName, SECRET_NAME, `secretReferences[${index}].secretName`, 255);
    const version = string(secret.version, SECRET_VERSION, `secretReferences[${index}].version`, 32);
    const resource = literal(
      secret.resource,
      `projects/arkova1/secrets/${secretName}/versions/${version}`,
      `secretReferences[${index}].resource`,
    );
    return { env, secretName, version, resource };
  });
  const expectedEnvs = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET', 'API_KEY_HMAC_SECRET', 'CRON_SECRET',
    'BITCOIN_RPC_URL', 'BITCOIN_RPC_AUTH', 'BITCOIN_TREASURY_WIF',
  ];
  if (parsed.some((entry, index) => entry.env !== expectedEnvs[index])) {
    throw new Error('B1 approval secret inventory order/scope differs from the exact topology.');
  }
  return parsed;
}

function parsePayload(raw, now, options = {}) {
  const payload = object(parseJson(raw, 'B1 signed approval payload'), 'B1 signed approval payload');
  exactKeys(payload, [
    'schemaVersion', 'approvalId', 'authority', 'candidate', 'run', 'topology',
    'budget', 'teardown', 'issuedAt', 'expiresAt',
  ], 'B1 signed approval payload');
  literal(payload.schemaVersion, 1, 'B1 approval schemaVersion');
  const authority = object(payload.authority, 'B1 approval authority');
  exactKeys(authority, ['keyId', 'approverIdentity', 'purpose'], 'B1 approval authority');
  literal(authority.keyId, AUTHORITY.keyId, 'B1 approval keyId');
  literal(authority.approverIdentity, AUTHORITY.approverIdentity, 'B1 approval approverIdentity');
  literal(authority.purpose, 'RIG_B1_BITCOIN_CORE_PROVISION', 'B1 approval purpose');

  const candidate = object(payload.candidate, 'B1 approval candidate');
  exactKeys(candidate, [
    'sourceHeadSha', 'sourceTreeSha', 'workerImage', 'workerImageDigest',
    'bitcoinCoreRecipeCommit', 'bitcoinCoreImage', 'bitcoinCoreAmd64RuntimeDigest',
    'startupScriptSha256', 'teardownScriptSha256',
    'corpusDigest', 'releaseCandidateId',
  ], 'B1 approval candidate');
  const workerImage = string(candidate.workerImage, PINNED_IMAGE, 'candidate.workerImage', 512);
  const workerImageDigest = string(candidate.workerImageDigest, SHA256, 'candidate.workerImageDigest', 71);
  if (!workerImage.endsWith(`@${workerImageDigest}`)) {
    throw new Error('B1 approval worker image does not bind its digest.');
  }

  const run = object(payload.run, 'B1 approval run');
  exactKeys(run, [
    'rigId', 'rigName', 'soakId', 'leaseId', 'workerService',
    'workerRuntimeServiceAccount', 'schedulerOidcServiceAccount',
  ], 'B1 approval run');
  literal(run.rigId, 'RIG-B1', 'B1 approval run.rigId');
  const workerService = string(
    run.workerService,
    /^[a-z][a-z0-9-]{2,62}$/u,
    'run.workerService',
    63,
  );

  const topology = object(payload.topology, 'B1 approval topology');
  exactKeys(topology, [
    'provider', 'bitcoinCore', 'resources', 'schedulerJobs', 'iam', 'network', 'secretReferences',
    'nodeSecretEnvs', 'forbiddenNodeSecretEnvs', 'treasuryWatchOnly',
  ], 'B1 approval topology');
  const iam = object(topology.iam, 'B1 approval IAM');
  exactKeys(iam, ['artifactRegistryReader', 'rpcAuthSecretAccessor'], 'B1 approval IAM');
  const expectedSchedulerJobs = [
    'batch-anchors', 'batch-anchors-forced-flush', 'check-confirmations',
    'org-queue-scheduler', 'populate-confirmation-proofs', 'recover-broadcasts',
  ].map((suffix) => `${workerService}-${suffix}`);
  if (!Array.isArray(topology.schedulerJobs)
    || topology.schedulerJobs.length !== expectedSchedulerJobs.length
    || topology.schedulerJobs.some((job, index) => job !== expectedSchedulerJobs[index])) {
    throw new Error('B1 approval must enumerate the exact six Scheduler resource identities.');
  }
  const bitcoinCore = object(topology.bitcoinCore, 'B1 approval topology.bitcoinCore');
  exactKeys(bitcoinCore, [
    'version', 'recipeCommit', 'sourceTarballUrl', 'sourceTarballSha256',
    'containerImage', 'amd64RuntimeDigest',
    'startupScriptPath', 'startupScriptSha256',
  ], 'B1 approval topology.bitcoinCore');
  literal(bitcoinCore.version, '31.1', 'B1 approval Bitcoin Core version');
  literal(
    bitcoinCore.sourceTarballUrl,
    'https://bitcoincore.org/bin/bitcoin-core-31.1/bitcoin-31.1-x86_64-linux-gnu.tar.gz',
    'B1 approval Bitcoin Core source URL',
  );
  literal(
    bitcoinCore.sourceTarballSha256,
    EXACT_BITCOIN_BUILD.sourceTarballSha256,
    'B1 approval Bitcoin Core source digest',
  );
  literal(bitcoinCore.startupScriptPath, 'scripts/staging/start-rig-b1-bitcoin-core.sh', 'B1 startup path');
  const bitcoinCoreRecipeCommit = literal(
    string(bitcoinCore.recipeCommit, GIT_SHA, 'B1 approval Bitcoin Core recipe commit', 40),
    EXACT_BITCOIN_BUILD.recipeCommit,
    'B1 approval Bitcoin Core recipe commit',
  );
  const bitcoinCoreImage = literal(
    string(bitcoinCore.containerImage, PINNED_IMAGE, 'B1 approval Bitcoin Core image', 512),
    EXACT_BITCOIN_BUILD.containerImage,
    'B1 approval Bitcoin Core image',
  );
  const bitcoinCoreAmd64RuntimeDigest = literal(
    string(bitcoinCore.amd64RuntimeDigest, SHA256, 'B1 approval Bitcoin Core amd64 digest', 71),
    EXACT_BITCOIN_BUILD.amd64RuntimeDigest,
    'B1 approval Bitcoin Core amd64 digest',
  );
  literal(
    candidate.bitcoinCoreRecipeCommit,
    bitcoinCoreRecipeCommit,
    'candidate/topology Bitcoin Core recipe commit',
  );
  literal(bitcoinCoreImage, candidate.bitcoinCoreImage, 'candidate/topology Bitcoin Core image');
  literal(
    candidate.bitcoinCoreAmd64RuntimeDigest,
    bitcoinCoreAmd64RuntimeDigest,
    'candidate/topology Bitcoin Core amd64 digest',
  );
  const startupScriptSha256 = string(bitcoinCore.startupScriptSha256, SHA256, 'B1 startup digest', 71);
  literal(startupScriptSha256, candidate.startupScriptSha256, 'candidate/topology startup digest');

  const nodeSecretEnvs = topology.nodeSecretEnvs;
  const forbiddenNodeSecretEnvs = topology.forbiddenNodeSecretEnvs;
  if (!Array.isArray(nodeSecretEnvs) || nodeSecretEnvs.length !== 1 || nodeSecretEnvs[0] !== 'BITCOIN_RPC_AUTH') {
    throw new Error('B1 node may access only BITCOIN_RPC_AUTH.');
  }
  if (!Array.isArray(forbiddenNodeSecretEnvs)
    || forbiddenNodeSecretEnvs.length !== 1
    || forbiddenNodeSecretEnvs[0] !== 'BITCOIN_TREASURY_WIF') {
    throw new Error('B1 node topology must explicitly forbid the treasury WIF.');
  }
  const treasuryWatchOnly = object(topology.treasuryWatchOnly, 'B1 approval treasuryWatchOnly');
  exactKeys(treasuryWatchOnly, [
    'address', 'descriptor', 'splitTransactionId', 'preSplitPlanDigest',
    'expectedConfirmedOutputCount', 'expectedTotalSats', 'descriptorPolicy', 'wifOnNode',
  ], 'B1 approval treasuryWatchOnly');
  const treasuryAddress = string(
    treasuryWatchOnly.address,
    /^tb1[a-z0-9]{20,87}$/u,
    'B1 approval treasuryWatchOnly.address',
    90,
  );
  literal(
    treasuryWatchOnly.descriptorPolicy,
    'addr-checksummed-importdescriptors',
    'B1 approval treasury descriptor policy',
  );
  literal(treasuryWatchOnly.wifOnNode, false, 'B1 approval treasury WIF-on-node policy');
  const treasuryDescriptor = string(
    treasuryWatchOnly.descriptor,
    /^addr\(tb1[a-z0-9]{20,87}\)#[a-z0-9]{8}$/u,
    'B1 approval treasury descriptor',
    110,
  );
  if (!treasuryDescriptor.startsWith(`addr(${treasuryAddress})#`)) {
    throw new Error('B1 approval treasury descriptor does not bind its public address.');
  }
  const preSplitPlanDigest = string(
    treasuryWatchOnly.preSplitPlanDigest,
    SHA256,
    'B1 approval treasury pre-split plan digest',
    71,
  );
  literal(
    treasuryWatchOnly.splitTransactionId,
    EXACT_TREASURY_SPLIT_TXID,
    'B1 treasury split transaction ID',
  );
  literal(treasuryWatchOnly.expectedConfirmedOutputCount, 32, 'B1 expected confirmed output count');
  literal(
    treasuryWatchOnly.expectedTotalSats,
    EXACT_TREASURY_TOTAL_SATS,
    'B1 expected treasury total sats',
  );

  const budget = object(payload.budget, 'B1 approval budget');
  exactKeys(budget, ['spendCapUsd'], 'B1 approval budget');
  if (!Number.isSafeInteger(budget.spendCapUsd) || budget.spendCapUsd < 1 || budget.spendCapUsd > 200) {
    throw new Error('B1 approval spend cap must be an integer from 1 through 200 USD.');
  }
  const teardown = object(payload.teardown, 'B1 approval teardown');
  exactKeys(teardown, ['orderedResources', 'projectedMonthlyRecurringUsd'], 'B1 approval teardown');
  if (!Array.isArray(teardown.orderedResources)
    || teardown.orderedResources.length !== EXACT_TEARDOWN_ORDER.length
    || teardown.orderedResources.some((entry, index) => entry !== EXACT_TEARDOWN_ORDER[index])) {
    throw new Error('B1 approval teardown inventory differs from the exact zero-cost boundary.');
  }
  literal(teardown.projectedMonthlyRecurringUsd, 0, 'B1 teardown projected recurring USD');
  const issued = timestamp(payload.issuedAt, 'B1 approval issuedAt');
  const expires = timestamp(payload.expiresAt, 'B1 approval expiresAt');
  if (issued.epoch > now
    || (!options.allowExpiredForTeardown && expires.epoch <= now)
    || expires.epoch <= issued.epoch
    || expires.epoch - issued.epoch > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('B1 signed approval is not currently valid or exceeds the seven-day authority window.');
  }

  return {
    schemaVersion: 1,
    approvalId: string(payload.approvalId, SAFE_ID, 'B1 approvalId', 128),
    authority: { ...authority },
    candidate: {
      sourceHeadSha: string(candidate.sourceHeadSha, GIT_SHA, 'candidate.sourceHeadSha', 40),
      sourceTreeSha: string(candidate.sourceTreeSha, GIT_SHA, 'candidate.sourceTreeSha', 40),
      workerImage,
      workerImageDigest,
      bitcoinCoreRecipeCommit,
      bitcoinCoreImage,
      bitcoinCoreAmd64RuntimeDigest,
      startupScriptSha256,
      teardownScriptSha256: string(candidate.teardownScriptSha256, SHA256, 'candidate.teardownScriptSha256', 71),
      corpusDigest: string(candidate.corpusDigest, SHA256, 'candidate.corpusDigest', 71),
      releaseCandidateId: string(candidate.releaseCandidateId, SAFE_ID, 'candidate.releaseCandidateId', 128),
    },
    run: {
      rigId: 'RIG-B1',
      rigName: string(run.rigName, /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/u, 'run.rigName', 30),
      soakId: string(run.soakId, SAFE_ID, 'run.soakId', 128),
      leaseId: string(run.leaseId, SAFE_ID, 'run.leaseId', 128),
      workerService,
      workerRuntimeServiceAccount: string(run.workerRuntimeServiceAccount, SERVICE_ACCOUNT, 'run.workerRuntimeServiceAccount', 128),
      schedulerOidcServiceAccount: string(run.schedulerOidcServiceAccount, SERVICE_ACCOUNT, 'run.schedulerOidcServiceAccount', 128),
    },
    topology: {
      provider: exactObject(topology.provider, EXACT_PROVIDER, 'B1 approval provider'),
      bitcoinCore: {
        version: '31.1',
        recipeCommit: bitcoinCoreRecipeCommit,
        sourceTarballUrl: bitcoinCore.sourceTarballUrl,
        sourceTarballSha256: bitcoinCore.sourceTarballSha256,
        containerImage: bitcoinCoreImage,
        amd64RuntimeDigest: bitcoinCoreAmd64RuntimeDigest,
        startupScriptPath: bitcoinCore.startupScriptPath,
        startupScriptSha256,
      },
      resources: exactObject(topology.resources, EXACT_RESOURCES, 'B1 approval resources'),
      schedulerJobs: [...expectedSchedulerJobs],
      iam: {
        artifactRegistryReader: exactObject(
          iam.artifactRegistryReader,
          EXACT_IAM.artifactRegistryReader,
          'B1 approval IAM artifactRegistryReader',
        ),
        rpcAuthSecretAccessor: exactObject(
          iam.rpcAuthSecretAccessor,
          EXACT_IAM.rpcAuthSecretAccessor,
          'B1 approval IAM rpcAuthSecretAccessor',
        ),
      },
      network: exactObject(topology.network, EXACT_NETWORK, 'B1 approval network'),
      secretReferences: parseSecrets(topology.secretReferences),
      nodeSecretEnvs: ['BITCOIN_RPC_AUTH'],
      forbiddenNodeSecretEnvs: ['BITCOIN_TREASURY_WIF'],
      treasuryWatchOnly: {
        address: treasuryAddress,
        descriptor: treasuryDescriptor,
        splitTransactionId: EXACT_TREASURY_SPLIT_TXID,
        preSplitPlanDigest,
        expectedConfirmedOutputCount: 32,
        expectedTotalSats: EXACT_TREASURY_TOTAL_SATS,
        descriptorPolicy: 'addr-checksummed-importdescriptors',
        wifOnNode: false,
      },
    },
    budget: { spendCapUsd: budget.spendCapUsd },
    teardown: { orderedResources: [...EXACT_TEARDOWN_ORDER], projectedMonthlyRecurringUsd: 0 },
    issuedAt: issued.text,
    expiresAt: expires.text,
  };
}

export function verifyB1NodeApprovalEnvelope(raw, options = {}) {
  const envelope = object(parseJson(raw, 'B1 signed approval envelope'), 'B1 signed approval envelope');
  exactKeys(envelope, [
    'schemaVersion', 'envelopeId', 'keyId', 'keyFingerprint',
    'signedPayloadRaw', 'signatureBase64',
  ], 'B1 signed approval envelope');
  literal(envelope.schemaVersion, 1, 'B1 approval envelope schemaVersion');
  string(envelope.envelopeId, SAFE_ID, 'B1 approval envelopeId', 128);
  literal(envelope.keyId, options.keyId ?? AUTHORITY.keyId, 'B1 approval envelope keyId');
  literal(envelope.keyFingerprint, options.fingerprint ?? AUTHORITY.fingerprint, 'B1 approval envelope fingerprint');
  const signedPayloadRaw = string(envelope.signedPayloadRaw, /^[\s\S]+$/u, 'B1 signed payload raw', MAX_ARTIFACT_BYTES);
  const signature = string(envelope.signatureBase64, /^[A-Za-z0-9+/]{86}==$/u, 'B1 approval signature', 88);
  const publicKey = createPublicKey(options.publicKeyPem ?? PUBLIC_KEY_PEM);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('B1 approval trust root must be Ed25519.');
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  if (fingerprint !== (options.fingerprint ?? AUTHORITY.fingerprint)) {
    throw new Error('B1 approval trust-root fingerprint mismatch.');
  }
  if (!verifySignature(null, Buffer.from(signedPayloadRaw), publicKey, Buffer.from(signature, 'base64'))) {
    throw new Error('B1 signed approval Ed25519 signature is invalid.');
  }
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  const payload = parsePayload(signedPayloadRaw, now, {
    allowExpiredForTeardown: options.allowExpiredForTeardown === true,
  });
  return Object.freeze({
    status: 'VERIFIED',
    envelopeId: envelope.envelopeId,
    envelopeSha256: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    signedPayloadSha256: `sha256:${createHash('sha256').update(signedPayloadRaw).digest('hex')}`,
    keyId: AUTHORITY.keyId,
    verifierIdentity: AUTHORITY.verifierIdentity,
    payload,
  });
}

async function readArtifact(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error('B1 approval artifact must be a bounded regular file.');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      artifact: { type: 'string' },
      'allow-expired-for-teardown': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.artifact) throw new Error('--artifact is required.');
  const result = verifyB1NodeApprovalEnvelope(await readArtifact(values.artifact), {
    allowExpiredForTeardown: values['allow-expired-for-teardown'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : 'B1 approval verification failed.'}\n`);
    process.exitCode = 1;
  });
}
