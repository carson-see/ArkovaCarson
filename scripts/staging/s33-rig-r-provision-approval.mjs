#!/usr/bin/env node
/**
 * RIG-R immutable provision-approval verifier.
 *
 * Built-ins only. This executable verifies a duplicate-key-free, domain-
 * separated Ed25519 envelope against the founder/CTO-confirmed public key and
 * returns only the strict provision binding. It cannot sign, provision, read a
 * secret, or accept a caller-provided trust root.
 */

import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const RIG_R_PROVISION_APPROVAL_SIGNATURE_DOMAIN =
  'arkova:s33:rig-r-provision-approval:v1\n';

const PRODUCTION_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAf7Oe/mYJSU3rBUsLb9ni3zIZgS7K0FWbM1E9xovU/R8=\n-----END PUBLIC KEY-----\n';
const PRODUCTION_AUTHORITY = Object.freeze({
  keyId: 'arkova.s33.release-corpus.ed25519.v1',
  purpose: 'RIG_R_PROVISION',
  publicKeyFingerprintSha256:
    'b5f6445ae954ac1f29b504fdc890dedefda23beb6300f35d99cd2c9d2eeb9e59',
  authorizedApproverIdentity: 'arkova.s33.approver.founder-cto.v1',
  verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1',
  authorizedOperator: 'arkova.s33.operator.key-custodian.v1',
  activatedAtUtc: '2026-07-16T13:52:06Z',
  genesisRosterRootSha256:
    'sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f',
});

const APPROVED_IMAGE_REPOSITORY =
  'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker';
const PROTECTED_V6_MODEL =
  'projects/270018525501/locations/us-central1/models/6611494259700793344';
const PROTECTED_V6_MODEL_VERSION = `${PROTECTED_V6_MODEL}@1`;
const TEMPORARY_ENDPOINT = Object.freeze({
  id: '733013',
  resource: 'projects/arkova1/locations/us-central1/endpoints/733013',
  displayName: 'arkova-s33-rig-r-release-v6',
  modelVersionResource: PROTECTED_V6_MODEL_VERSION,
  checkpointId: '6',
  deployedModelId: '7330131',
  deployedModelDisplayName: 'arkova-s33-rig-r-release-v6',
  deploymentResourcesMode: 'TUNED_GEMINI_AUTOMATIC_RESOURCES',
  minReplicaCount: 1,
  maxReplicaCount: 1,
  endpointIamRole: 'roles/aiplatform.endpointUser',
  endpointIamMember:
    'serviceAccount:s33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
});
const RUNTIME_IMPERSONATION = Object.freeze({
  operatorServiceAccount: '270018525501-compute@developer.gserviceaccount.com',
  role: 'roles/iam.serviceAccountTokenCreator',
  member: 'serviceAccount:270018525501-compute@developer.gserviceaccount.com',
});
const TEARDOWN_PATH = 'scripts/staging/teardown-isolated-rig.sh';
const GENERATED_SECRET_NAMES = Object.freeze([
  'supabase-url-s33-r-staging',
  'supabase-service-role-key-s33-r-staging',
]);
const SECRET_REFERENCES = Object.freeze({
  supabaseUrl: 'supabase-url-s33-r-staging@1',
  supabaseServiceRoleKey: 'supabase-service-role-key-s33-r-staging@1',
  stripeSecretKey: 'stripe-secret-key-staging@1',
  stripeWebhookSecret: 'stripe-webhook-secret-staging@1',
  apiKeyHmacSecret: 'api-key-hmac-secret-staging@1',
  cronSecret: 'cron-secret@1',
  geminiApiKey: 'gemini-api-key@2',
});
const IMMUTABLE_LEDGER = Object.freeze({
  backend: 'gcs-if-generation-match-0-locked-retention',
  bucket: 'arkova1-s33-immutable-authority-ledger',
  projectId: 'arkova1',
  requiresPerObjectRetention: true,
});
const CONTAINED_DATABASE_QUEUES = Object.freeze(['ai-rollback', 'chain-fault']);
const TEARDOWN_BOUNDARIES = Object.freeze([
  'deployed-model',
  'vertex-endpoint',
  'cloud-run-service',
  'supabase-secret-pair',
  'supabase-project',
  'runtime-iam-service-account',
  'exclusive-lease',
]);

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,1023}$/u;
const UTC_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
const SOURCE_HEAD_IMAGE_REF = new RegExp(
  `^${APPROVED_IMAGE_REPOSITORY.replaceAll('.', '[.]')}:([0-9a-f]{40})@sha256:([0-9a-f]{64})$`,
  'u',
);

function decodeJsonKey(raw, start, end, label) {
  let decoded = '';
  let index = start + 1;
  while (index < end) {
    const char = raw[index];
    if (char !== '\\') {
      decoded += char;
      index += 1;
      continue;
    }
    const escaped = raw[index + 1];
    if (escaped === undefined) throw new Error(`${label} must contain valid JSON.`);
    if (escaped === 'u') {
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw new Error(`${label} must contain valid JSON.`);
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    const escapes = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    };
    if (!Object.hasOwn(escapes, escaped)) throw new Error(`${label} must contain valid JSON.`);
    decoded += escapes[escaped];
    index += 2;
  }
  return decoded;
}

function scanJsonString(raw, start) {
  let end = start + 1;
  while (end < raw.length) {
    if (raw[end] === '\\') {
      end += 2;
      continue;
    }
    if (raw[end] === '"') break;
    end += 1;
  }
  if (end >= raw.length) return { end: raw.length, followedByColon: false };
  let cursor = end + 1;
  while (/\s/u.test(raw[cursor] ?? '')) cursor += 1;
  return { end, followedByColon: raw[cursor] === ':' };
}

function assertNoDuplicateJsonKeys(raw, label) {
  const stack = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '{') {
      stack.push({ kind: 'object', keys: new Set() });
      index += 1;
      continue;
    }
    if (char === '[') {
      stack.push({ kind: 'array' });
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      stack.pop();
      index += 1;
      continue;
    }
    if (char !== '"') {
      index += 1;
      continue;
    }
    const start = index;
    const scanned = scanJsonString(raw, start);
    index = scanned.end + 1;
    if (!scanned.followedByColon) continue;
    const frame = stack[stack.length - 1];
    if (frame?.kind !== 'object') continue;
    const key = decodeJsonKey(raw, start, scanned.end, label);
    if (frame.keys.has(key)) throw new Error(`${label} contains duplicate JSON key ${key}.`);
    frame.keys.add(key);
  }
}

function parseJsonRejectingDuplicateKeys(raw, label) {
  if (typeof raw !== 'string') throw new Error(`${label} must be a primitive string.`);
  assertNoDuplicateJsonKeys(raw, label);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} failed strict schema validation.`);
  }
}

function string(value, pattern, label, maxLength = 1024) {
  if (typeof value !== 'string' || value.length > maxLength || !pattern.test(value)) {
    throw new Error(`${label} failed strict schema validation.`);
  }
  return value;
}

function literal(value, expected, label) {
  if (value !== expected) throw new Error(`${label} failed strict schema validation.`);
  return value;
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function exactStringArray(value, expected, label) {
  if (!Array.isArray(value)
    || value.length !== expected.length
    || value.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${label} must equal the exact frozen topology.`);
  }
  return [...value];
}

function emptyArray(value, label) {
  if (!Array.isArray(value) || value.length !== 0) {
    throw new Error(`${label} must be an empty managed topology.`);
  }
  return [];
}

function parseExactObject(value, expected, label) {
  const candidate = object(value, label);
  exactKeys(candidate, Object.keys(expected), label);
  return Object.fromEntries(Object.entries(expected).map(([key, expectedValue]) => [
    key,
    literal(candidate[key], expectedValue, `${label}.${key}`),
  ]));
}

function parseTimestamp(value, label) {
  const parsed = string(value, UTC_TIMESTAMP, label, 40);
  const epoch = Date.parse(parsed);
  if (!Number.isFinite(epoch)) throw new Error(`${label} is not a valid UTC timestamp.`);
  return { value: parsed, epoch };
}

function parseCandidate(value, label = 'RIG-R approval candidate') {
  const candidate = object(value, label);
  exactKeys(candidate, [
    'sourceHeadSha', 'sourceTreeSha', 'sourceHeadImageRef', 'imageDigest',
  ], label);
  const sourceHeadSha = string(candidate.sourceHeadSha, GIT_SHA, `${label}.sourceHeadSha`, 40);
  const sourceTreeSha = string(candidate.sourceTreeSha, GIT_SHA, `${label}.sourceTreeSha`, 40);
  const imageDigest = string(candidate.imageDigest, SHA256_DIGEST, `${label}.imageDigest`, 71);
  const sourceHeadImageRef = string(
    candidate.sourceHeadImageRef,
    SOURCE_HEAD_IMAGE_REF,
    `${label}.sourceHeadImageRef`,
    256,
  );
  if (!sourceHeadImageRef.includes(`:${sourceHeadSha}@${imageDigest}`)) {
    throw new Error(`${label} full-SHA image reference does not bind its HEAD and digest.`);
  }
  return { sourceHeadSha, sourceTreeSha, sourceHeadImageRef, imageDigest };
}

function parseTopology(value, label = 'RIG-R approval topology') {
  const topology = object(value, label);
  exactKeys(topology, [
    'rigId', 'rigName', 'rigProfile', 'tier', 'requiredWorkerUptimeMin',
    'requiredWallMin', 'gcpProjectId', 'gcpRegion', 'supabaseOrgId',
    'supabaseProjectName', 'supabaseRegion', 'supabasePostgresMajor',
    'cloudRunService', 'runtimeServiceAccount', 'runtimeImpersonatorServiceAccount',
    'runtimeImpersonationRole', 'runtimeImpersonationMember', 'generatedSecretNames',
    'secretReferences', 'immutableLedger',
    'vertexEndpointId', 'vertexEndpoint', 'vertexEndpointDisplayName',
    'vertexModel', 'vertexModelVersion', 'checkpointId', 'deployedModelId',
    'deployedModelDisplayName', 'deploymentResourcesMode', 'minReplicaCount',
    'maxReplicaCount', 'endpointIamRole', 'endpointIamMember',
    'temporaryVertexEndpoint',
    'chainMode', 'inProcessJobs', 'containedDatabaseQueues',
    'managedSchedulerJobs', 'managedQueues', 'oidcIdentities',
  ], label);
  const requiredWallMin = safeInteger(topology.requiredWallMin, `${label}.requiredWallMin`, 2910);
  return {
    rigId: literal(topology.rigId, 'RIG-R', `${label}.rigId`),
    rigName: literal(topology.rigName, 's33-r', `${label}.rigName`),
    rigProfile: literal(topology.rigProfile, 'gemini-release', `${label}.rigProfile`),
    tier: literal(topology.tier, 'T3', `${label}.tier`),
    requiredWorkerUptimeMin: literal(
      topology.requiredWorkerUptimeMin,
      2880,
      `${label}.requiredWorkerUptimeMin`,
    ),
    requiredWallMin,
    gcpProjectId: literal(topology.gcpProjectId, 'arkova1', `${label}.gcpProjectId`),
    gcpRegion: literal(topology.gcpRegion, 'us-central1', `${label}.gcpRegion`),
    supabaseOrgId: literal(
      topology.supabaseOrgId,
      'byhkazrpmivhcsuqjtva',
      `${label}.supabaseOrgId`,
    ),
    supabaseProjectName: literal(
      topology.supabaseProjectName,
      'arkova-soak-s33-r',
      `${label}.supabaseProjectName`,
    ),
    supabaseRegion: literal(topology.supabaseRegion, 'us-east-2', `${label}.supabaseRegion`),
    supabasePostgresMajor: literal(
      topology.supabasePostgresMajor,
      17,
      `${label}.supabasePostgresMajor`,
    ),
    cloudRunService: literal(
      topology.cloudRunService,
      'arkova-worker-s33-r-staging',
      `${label}.cloudRunService`,
    ),
    runtimeServiceAccount: literal(
      topology.runtimeServiceAccount,
      's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
      `${label}.runtimeServiceAccount`,
    ),
    runtimeImpersonatorServiceAccount: literal(
      topology.runtimeImpersonatorServiceAccount,
      RUNTIME_IMPERSONATION.operatorServiceAccount,
      `${label}.runtimeImpersonatorServiceAccount`,
    ),
    runtimeImpersonationRole: literal(
      topology.runtimeImpersonationRole,
      RUNTIME_IMPERSONATION.role,
      `${label}.runtimeImpersonationRole`,
    ),
    runtimeImpersonationMember: literal(
      topology.runtimeImpersonationMember,
      RUNTIME_IMPERSONATION.member,
      `${label}.runtimeImpersonationMember`,
    ),
    generatedSecretNames: exactStringArray(
      topology.generatedSecretNames,
      GENERATED_SECRET_NAMES,
      `${label}.generatedSecretNames`,
    ),
    secretReferences: parseExactObject(
      topology.secretReferences,
      SECRET_REFERENCES,
      `${label}.secretReferences`,
    ),
    immutableLedger: parseExactObject(
      topology.immutableLedger,
      IMMUTABLE_LEDGER,
      `${label}.immutableLedger`,
    ),
    vertexEndpointId: literal(
      topology.vertexEndpointId,
      TEMPORARY_ENDPOINT.id,
      `${label}.vertexEndpointId`,
    ),
    vertexEndpoint: literal(
      topology.vertexEndpoint,
      TEMPORARY_ENDPOINT.resource,
      `${label}.vertexEndpoint`,
    ),
    vertexEndpointDisplayName: literal(
      topology.vertexEndpointDisplayName,
      TEMPORARY_ENDPOINT.displayName,
      `${label}.vertexEndpointDisplayName`,
    ),
    vertexModel: literal(topology.vertexModel, PROTECTED_V6_MODEL, `${label}.vertexModel`),
    vertexModelVersion: literal(
      topology.vertexModelVersion,
      TEMPORARY_ENDPOINT.modelVersionResource,
      `${label}.vertexModelVersion`,
    ),
    checkpointId: literal(
      topology.checkpointId,
      TEMPORARY_ENDPOINT.checkpointId,
      `${label}.checkpointId`,
    ),
    deployedModelId: literal(
      topology.deployedModelId,
      TEMPORARY_ENDPOINT.deployedModelId,
      `${label}.deployedModelId`,
    ),
    deployedModelDisplayName: literal(
      topology.deployedModelDisplayName,
      TEMPORARY_ENDPOINT.deployedModelDisplayName,
      `${label}.deployedModelDisplayName`,
    ),
    deploymentResourcesMode: literal(
      topology.deploymentResourcesMode,
      TEMPORARY_ENDPOINT.deploymentResourcesMode,
      `${label}.deploymentResourcesMode`,
    ),
    minReplicaCount: literal(
      topology.minReplicaCount,
      TEMPORARY_ENDPOINT.minReplicaCount,
      `${label}.minReplicaCount`,
    ),
    maxReplicaCount: literal(
      topology.maxReplicaCount,
      TEMPORARY_ENDPOINT.maxReplicaCount,
      `${label}.maxReplicaCount`,
    ),
    endpointIamRole: literal(
      topology.endpointIamRole,
      TEMPORARY_ENDPOINT.endpointIamRole,
      `${label}.endpointIamRole`,
    ),
    endpointIamMember: literal(
      topology.endpointIamMember,
      TEMPORARY_ENDPOINT.endpointIamMember,
      `${label}.endpointIamMember`,
    ),
    temporaryVertexEndpoint: literal(
      topology.temporaryVertexEndpoint,
      true,
      `${label}.temporaryVertexEndpoint`,
    ),
    chainMode: literal(topology.chainMode, 'mocked', `${label}.chainMode`),
    inProcessJobs: literal(topology.inProcessJobs, 'disabled', `${label}.inProcessJobs`),
    containedDatabaseQueues: exactStringArray(
      topology.containedDatabaseQueues,
      CONTAINED_DATABASE_QUEUES,
      `${label}.containedDatabaseQueues`,
    ),
    managedSchedulerJobs: emptyArray(
      topology.managedSchedulerJobs,
      `${label}.managedSchedulerJobs`,
    ),
    managedQueues: emptyArray(topology.managedQueues, `${label}.managedQueues`),
    oidcIdentities: emptyArray(topology.oidcIdentities, `${label}.oidcIdentities`),
  };
}

function parseExecution(value, requiredWallMin, label = 'RIG-R approval execution') {
  const execution = object(value, label);
  exactKeys(execution, [
    'soakId', 'leaseId', 'ownerIdentity', 'provisionStartedAt', 'expiresAt',
    'hardStopAuthorityIdentity', 'teardownOnOrAfterExpiry', 'teardownOnDriverFailure',
  ], label);
  const started = parseTimestamp(execution.provisionStartedAt, `${label}.provisionStartedAt`);
  const expires = parseTimestamp(execution.expiresAt, `${label}.expiresAt`);
  const minimumExpiry = started.epoch + (requiredWallMin + 360) * 60_000;
  const maximumExpiry = started.epoch + 72 * 60 * 60_000;
  if (expires.epoch < minimumExpiry) {
    throw new Error('RIG-R approval hard-stop expiry must cover wall floor plus 360 minutes.');
  }
  if (expires.epoch > maximumExpiry) {
    throw new Error('RIG-R approval hard-stop expiry cannot exceed 72 hours from provision start.');
  }
  return {
    soakId: string(execution.soakId, SAFE_ID, `${label}.soakId`, 128),
    leaseId: string(execution.leaseId, SAFE_ID, `${label}.leaseId`, 128),
    ownerIdentity: literal(
      execution.ownerIdentity,
      PRODUCTION_AUTHORITY.authorizedOperator,
      `${label}.ownerIdentity`,
    ),
    provisionStartedAt: started.value,
    expiresAt: expires.value,
    hardStopAuthorityIdentity: literal(
      execution.hardStopAuthorityIdentity,
      PRODUCTION_AUTHORITY.authorizedApproverIdentity,
      `${label}.hardStopAuthorityIdentity`,
    ),
    teardownOnOrAfterExpiry: literal(
      execution.teardownOnOrAfterExpiry,
      true,
      `${label}.teardownOnOrAfterExpiry`,
    ),
    teardownOnDriverFailure: literal(
      execution.teardownOnDriverFailure,
      true,
      `${label}.teardownOnDriverFailure`,
    ),
  };
}

function parseTeardown(value, label = 'RIG-R approval teardown') {
  const teardown = object(value, label);
  exactKeys(teardown, [
    'scriptPath', 'scriptSha256', 'orderedBoundaries', 'protectedV6Model',
    'deleteProtectedV6Model',
    'projectedMonthlyRecurringUsd',
  ], label);
  return {
    scriptPath: literal(teardown.scriptPath, TEARDOWN_PATH, `${label}.scriptPath`),
    scriptSha256: string(teardown.scriptSha256, SHA256_DIGEST, `${label}.scriptSha256`, 71),
    orderedBoundaries: exactStringArray(
      teardown.orderedBoundaries,
      TEARDOWN_BOUNDARIES,
      `${label}.orderedBoundaries`,
    ),
    protectedV6Model: literal(
      teardown.protectedV6Model,
      PROTECTED_V6_MODEL,
      `${label}.protectedV6Model`,
    ),
    deleteProtectedV6Model: literal(
      teardown.deleteProtectedV6Model,
      false,
      `${label}.deleteProtectedV6Model`,
    ),
    projectedMonthlyRecurringUsd: literal(
      teardown.projectedMonthlyRecurringUsd,
      0,
      `${label}.projectedMonthlyRecurringUsd`,
    ),
  };
}

function parseApprovalRecord(value) {
  const record = object(value, 'RIG-R signed provision approval');
  exactKeys(record, [
    'schemaVersion', 'approvalId', 'sourceReference', 'immutableRevisionId',
    'authority', 'candidate', 'topology', 'execution', 'budget', 'teardown',
    'verification',
  ], 'RIG-R signed provision approval');
  literal(record.schemaVersion, 1, 'RIG-R approval schemaVersion');
  const authority = object(record.authority, 'RIG-R approval authority');
  exactKeys(authority, [
    'signingKeyId', 'approverIdentity', 'authorizedRosterRootSha256',
  ], 'RIG-R approval authority');
  const topology = parseTopology(record.topology);
  const execution = parseExecution(record.execution, topology.requiredWallMin);
  const budget = object(record.budget, 'RIG-R approval budget');
  exactKeys(budget, ['s33TotalCapUsd'], 'RIG-R approval budget');
  const verification = object(record.verification, 'RIG-R approval verification');
  exactKeys(verification, ['verifiedAt', 'verifierIdentity', 'method'], 'RIG-R approval verification');
  const sourceReference = typeof record.sourceReference === 'string'
    && record.sourceReference.length <= 1024
    && (record.sourceReference.startsWith('ari:') || record.sourceReference.startsWith('https://'))
    ? record.sourceReference
    : null;
  if (sourceReference === null) {
    throw new Error('RIG-R approval sourceReference failed strict schema validation.');
  }
  return {
    schemaVersion: 1,
    approvalId: string(record.approvalId, SAFE_ID, 'RIG-R approval approvalId', 128),
    sourceReference,
    immutableRevisionId: string(
      record.immutableRevisionId,
      SAFE_REFERENCE,
      'RIG-R approval immutableRevisionId',
      256,
    ),
    authority: {
      signingKeyId: literal(
        authority.signingKeyId,
        PRODUCTION_AUTHORITY.keyId,
        'RIG-R approval signingKeyId',
      ),
      approverIdentity: literal(
        authority.approverIdentity,
        PRODUCTION_AUTHORITY.authorizedApproverIdentity,
        'RIG-R approval approverIdentity',
      ),
      authorizedRosterRootSha256: string(
        authority.authorizedRosterRootSha256,
        SHA256_DIGEST,
        'RIG-R approval roster root',
        71,
      ),
    },
    candidate: parseCandidate(record.candidate),
    topology,
    execution,
    budget: {
      s33TotalCapUsd: literal(budget.s33TotalCapUsd, 200, 'RIG-R S3.3 total cap'),
    },
    teardown: parseTeardown(record.teardown),
    verification: {
      verifiedAt: parseTimestamp(
        verification.verifiedAt,
        'RIG-R approval verification.verifiedAt',
      ).value,
      verifierIdentity: string(
        verification.verifierIdentity,
        SAFE_REFERENCE,
        'RIG-R approval verifierIdentity',
        256,
      ),
      method: literal(
        verification.method,
        'ed25519-pinned-authority-roster',
        'RIG-R approval verification method',
      ),
    },
  };
}

function parseEnvelope(raw) {
  const envelope = object(
    parseJsonRejectingDuplicateKeys(raw, 'RIG-R provision approval envelope'),
    'RIG-R provision approval envelope',
  );
  exactKeys(envelope, [
    'schemaVersion', 'keyId', 'keyFingerprint', 'canonicalSha256',
    'signedPayloadRaw', 'signatureBase64',
  ], 'RIG-R provision approval envelope');
  literal(envelope.schemaVersion, 1, 'RIG-R approval envelope schemaVersion');
  const signatureBase64 = typeof envelope.signatureBase64 === 'string'
    && /^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.signatureBase64)
    ? envelope.signatureBase64
    : null;
  if (signatureBase64 === null) {
    throw new Error('RIG-R approval signature failed strict schema validation.');
  }
  const signature = Buffer.from(signatureBase64, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== signatureBase64) {
    throw new Error('RIG-R approval signature must be one canonical Ed25519 signature.');
  }
  return {
    keyId: string(envelope.keyId, SAFE_REFERENCE, 'RIG-R key ID', 128),
    keyFingerprint: string(envelope.keyFingerprint, SHA256_HEX, 'RIG-R key fingerprint', 64),
    canonicalSha256: string(
      envelope.canonicalSha256,
      SHA256_DIGEST,
      'RIG-R canonical SHA-256',
      71,
    ),
    signedPayloadRaw: typeof envelope.signedPayloadRaw === 'string'
      && envelope.signedPayloadRaw.length >= 2
      && envelope.signedPayloadRaw.length <= 262_144
      ? envelope.signedPayloadRaw
      : (() => { throw new Error('RIG-R signed payload failed strict schema validation.'); })(),
    signature,
  };
}

function parseExpectedBinding(value) {
  const binding = object(value, 'Expected RIG-R provision binding');
  exactKeys(binding, [
    'sourceHeadSha', 'sourceTreeSha', 'sourceHeadImageRef', 'imageDigest',
    'provisionArtifactSha256', 'rigName', 'rigProfile', 'soakId', 'leaseId',
    'requiredWallMin', 'vertexEndpointId', 'vertexEndpoint',
    'vertexEndpointDisplayName', 'vertexModel', 'vertexModelVersion',
    'checkpointId', 'deployedModelId', 'deployedModelDisplayName',
    'deploymentResourcesMode', 'minReplicaCount', 'maxReplicaCount',
    'endpointIamRole', 'endpointIamMember', 'runtimeImpersonatorServiceAccount',
    'runtimeImpersonationRole', 'runtimeImpersonationMember',
    'provisionStartedAt', 'expiresAt', 'teardownScriptSha256',
    'secretReferences', 'immutableLedger',
  ], 'Expected RIG-R provision binding');
  const candidate = parseCandidate({
    sourceHeadSha: binding.sourceHeadSha,
    sourceTreeSha: binding.sourceTreeSha,
    sourceHeadImageRef: binding.sourceHeadImageRef,
    imageDigest: binding.imageDigest,
  }, 'Expected RIG-R candidate');
  return {
    ...candidate,
    provisionArtifactSha256: string(
      binding.provisionArtifactSha256,
      SHA256_DIGEST,
      'Expected RIG-R provision artifact SHA-256',
      71,
    ),
    rigName: literal(binding.rigName, 's33-r', 'Expected RIG-R rigName'),
    rigProfile: literal(binding.rigProfile, 'gemini-release', 'Expected RIG-R rigProfile'),
    soakId: string(binding.soakId, SAFE_ID, 'Expected RIG-R soakId', 128),
    leaseId: string(binding.leaseId, SAFE_ID, 'Expected RIG-R leaseId', 128),
    requiredWallMin: safeInteger(binding.requiredWallMin, 'Expected RIG-R requiredWallMin', 2910),
    vertexEndpointId: literal(
      binding.vertexEndpointId,
      TEMPORARY_ENDPOINT.id,
      'Expected RIG-R vertexEndpointId',
    ),
    vertexEndpoint: literal(
      binding.vertexEndpoint,
      TEMPORARY_ENDPOINT.resource,
      'Expected RIG-R vertexEndpoint',
    ),
    vertexEndpointDisplayName: literal(
      binding.vertexEndpointDisplayName,
      TEMPORARY_ENDPOINT.displayName,
      'Expected RIG-R vertexEndpointDisplayName',
    ),
    vertexModel: literal(
      binding.vertexModel,
      PROTECTED_V6_MODEL,
      'Expected RIG-R vertexModel',
    ),
    vertexModelVersion: literal(
      binding.vertexModelVersion,
      TEMPORARY_ENDPOINT.modelVersionResource,
      'Expected RIG-R vertexModelVersion',
    ),
    checkpointId: literal(
      binding.checkpointId,
      TEMPORARY_ENDPOINT.checkpointId,
      'Expected RIG-R checkpointId',
    ),
    deployedModelId: literal(
      binding.deployedModelId,
      TEMPORARY_ENDPOINT.deployedModelId,
      'Expected RIG-R deployedModelId',
    ),
    deployedModelDisplayName: literal(
      binding.deployedModelDisplayName,
      TEMPORARY_ENDPOINT.deployedModelDisplayName,
      'Expected RIG-R deployedModelDisplayName',
    ),
    deploymentResourcesMode: literal(
      binding.deploymentResourcesMode,
      TEMPORARY_ENDPOINT.deploymentResourcesMode,
      'Expected RIG-R deploymentResourcesMode',
    ),
    minReplicaCount: literal(
      binding.minReplicaCount,
      TEMPORARY_ENDPOINT.minReplicaCount,
      'Expected RIG-R minReplicaCount',
    ),
    maxReplicaCount: literal(
      binding.maxReplicaCount,
      TEMPORARY_ENDPOINT.maxReplicaCount,
      'Expected RIG-R maxReplicaCount',
    ),
    endpointIamRole: literal(
      binding.endpointIamRole,
      TEMPORARY_ENDPOINT.endpointIamRole,
      'Expected RIG-R endpointIamRole',
    ),
    endpointIamMember: literal(
      binding.endpointIamMember,
      TEMPORARY_ENDPOINT.endpointIamMember,
      'Expected RIG-R endpointIamMember',
    ),
    runtimeImpersonatorServiceAccount: literal(
      binding.runtimeImpersonatorServiceAccount,
      RUNTIME_IMPERSONATION.operatorServiceAccount,
      'Expected RIG-R runtimeImpersonatorServiceAccount',
    ),
    runtimeImpersonationRole: literal(
      binding.runtimeImpersonationRole,
      RUNTIME_IMPERSONATION.role,
      'Expected RIG-R runtimeImpersonationRole',
    ),
    runtimeImpersonationMember: literal(
      binding.runtimeImpersonationMember,
      RUNTIME_IMPERSONATION.member,
      'Expected RIG-R runtimeImpersonationMember',
    ),
    provisionStartedAt: parseTimestamp(
      binding.provisionStartedAt,
      'Expected RIG-R provisionStartedAt',
    ).value,
    expiresAt: parseTimestamp(binding.expiresAt, 'Expected RIG-R expiresAt').value,
    teardownScriptSha256: string(
      binding.teardownScriptSha256,
      SHA256_DIGEST,
      'Expected RIG-R teardown SHA-256',
      71,
    ),
    secretReferences: parseExactObject(
      binding.secretReferences,
      SECRET_REFERENCES,
      'Expected RIG-R secretReferences',
    ),
    immutableLedger: parseExactObject(
      binding.immutableLedger,
      IMMUTABLE_LEDGER,
      'Expected RIG-R immutableLedger',
    ),
  };
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(',')}}`;
  }
  throw new Error('RIG-R approval contains a non-JSON value.');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const rigRProvisionApprovalRecordSchema = Object.freeze({ parse: parseApprovalRecord });

export function canonicalRigRProvisionApprovalRecordSha256(record) {
  const parsed = parseApprovalRecord(record);
  return `sha256:${createHash('sha256').update(canonicalize(parsed)).digest('hex')}`;
}

class Ed25519RigRProvisionApprovalVerifier {
  constructor(config) {
    const parsed = object(config, 'RIG-R verifier config');
    exactKeys(parsed, [
      'publicKeyPem', 'keyId', 'keyFingerprint', 'authorityRosterRootSha256',
      'authorizedApproverIdentity', 'verifierIdentity', 'operatorIdentity',
      'activatedAtUtc',
    ], 'RIG-R verifier config');
    this.publicKey = createPublicKey(parsed.publicKeyPem);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('RIG-R provision trust root must be an Ed25519 public key.');
    }
    const observedFingerprint = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    this.keyFingerprint = string(parsed.keyFingerprint, SHA256_HEX, 'RIG-R key fingerprint', 64);
    if (observedFingerprint !== this.keyFingerprint) {
      throw new Error('RIG-R provision trust-root fingerprint mismatch.');
    }
    this.keyId = literal(parsed.keyId, PRODUCTION_AUTHORITY.keyId, 'RIG-R key ID');
    this.authorityRosterRootSha256 = string(
      parsed.authorityRosterRootSha256,
      SHA256_DIGEST,
      'RIG-R authority roster root',
      71,
    );
    this.authorizedApproverIdentity = literal(
      parsed.authorizedApproverIdentity,
      PRODUCTION_AUTHORITY.authorizedApproverIdentity,
      'RIG-R authorized approver',
    );
    this.verifierIdentity = literal(
      parsed.verifierIdentity,
      PRODUCTION_AUTHORITY.verifierIdentity,
      'RIG-R verifier identity',
    );
    this.operatorIdentity = literal(
      parsed.operatorIdentity,
      PRODUCTION_AUTHORITY.authorizedOperator,
      'RIG-R operator identity',
    );
    this.activatedAt = parseTimestamp(parsed.activatedAtUtc, 'RIG-R authority activation');
  }

  verify(rawEnvelope, expectedBindingRaw, now = new Date()) {
    const expected = parseExpectedBinding(expectedBindingRaw);
    const envelope = parseEnvelope(rawEnvelope);
    if (envelope.keyId !== this.keyId || envelope.keyFingerprint !== this.keyFingerprint) {
      throw new Error('RIG-R approval envelope names an untrusted key identity/fingerprint.');
    }
    const signedMessage = Buffer.concat([
      Buffer.from(RIG_R_PROVISION_APPROVAL_SIGNATURE_DOMAIN),
      Buffer.from(envelope.signedPayloadRaw),
    ]);
    if (!verifySignature(null, signedMessage, this.publicKey, envelope.signature)) {
      throw new Error('RIG-R provision approval Ed25519 signature is invalid.');
    }
    const record = parseApprovalRecord(parseJsonRejectingDuplicateKeys(
      envelope.signedPayloadRaw,
      'RIG-R signed provision approval',
    ));
    const canonicalSha256 = canonicalRigRProvisionApprovalRecordSha256(record);
    if (canonicalSha256 !== envelope.canonicalSha256
      || canonicalSha256 !== expected.provisionArtifactSha256) {
      throw new Error('RIG-R provision approval canonical artifact SHA-256 mismatch.');
    }
    if (record.authority.authorizedRosterRootSha256 !== this.authorityRosterRootSha256
      || record.authority.approverIdentity !== this.authorizedApproverIdentity
      || record.authority.signingKeyId !== this.keyId) {
      throw new Error('RIG-R provision approval is not authorized by the pinned roster/key.');
    }
    if (record.verification.verifierIdentity !== this.verifierIdentity
      || record.execution.ownerIdentity !== this.operatorIdentity) {
      throw new Error('RIG-R provision approval verifier/operator identity mismatch.');
    }
    const candidateExpected = {
      sourceHeadSha: expected.sourceHeadSha,
      sourceTreeSha: expected.sourceTreeSha,
      sourceHeadImageRef: expected.sourceHeadImageRef,
      imageDigest: expected.imageDigest,
    };
    if (canonicalize(record.candidate) !== canonicalize(candidateExpected)) {
      throw new Error('RIG-R approval candidate HEAD/tree/full-SHA image binding mismatch.');
    }
    if (record.topology.rigName !== expected.rigName
      || record.topology.rigProfile !== expected.rigProfile
      || record.topology.requiredWallMin !== expected.requiredWallMin
      || record.topology.vertexEndpointId !== expected.vertexEndpointId
      || record.topology.vertexEndpoint !== expected.vertexEndpoint
      || record.topology.vertexEndpointDisplayName !== expected.vertexEndpointDisplayName
      || record.topology.vertexModel !== expected.vertexModel
      || record.topology.vertexModelVersion !== expected.vertexModelVersion
      || record.topology.checkpointId !== expected.checkpointId
      || record.topology.deployedModelId !== expected.deployedModelId
      || record.topology.deployedModelDisplayName !== expected.deployedModelDisplayName
      || record.topology.deploymentResourcesMode !== expected.deploymentResourcesMode
      || record.topology.minReplicaCount !== expected.minReplicaCount
      || record.topology.maxReplicaCount !== expected.maxReplicaCount
      || record.topology.endpointIamRole !== expected.endpointIamRole
      || record.topology.endpointIamMember !== expected.endpointIamMember
      || record.topology.runtimeImpersonatorServiceAccount !== expected.runtimeImpersonatorServiceAccount
      || record.topology.runtimeImpersonationRole !== expected.runtimeImpersonationRole
      || record.topology.runtimeImpersonationMember !== expected.runtimeImpersonationMember
      || canonicalize(record.topology.secretReferences) !== canonicalize(expected.secretReferences)
      || canonicalize(record.topology.immutableLedger) !== canonicalize(expected.immutableLedger)) {
      throw new Error('RIG-R approval topology does not match the exact runtime binding.');
    }
    if (record.execution.soakId !== expected.soakId
      || record.execution.leaseId !== expected.leaseId
      || record.execution.provisionStartedAt !== expected.provisionStartedAt
      || record.execution.expiresAt !== expected.expiresAt) {
      throw new Error('RIG-R approval execution/lease/expiry does not match the exact runtime binding.');
    }
    if (record.teardown.scriptSha256 !== expected.teardownScriptSha256) {
      throw new Error('RIG-R approval teardown boundary digest mismatch.');
    }
    const nowMs = now.getTime();
    const verifiedAtMs = Date.parse(record.verification.verifiedAt);
    const startedAtMs = Date.parse(record.execution.provisionStartedAt);
    const expiresAtMs = Date.parse(record.execution.expiresAt);
    if (!Number.isFinite(nowMs)) throw new Error('RIG-R verifier requires a valid current time.');
    if (verifiedAtMs < this.activatedAt.epoch) {
      throw new Error('RIG-R approval predates the code-bound authority activation.');
    }
    if (nowMs < startedAtMs || verifiedAtMs > nowMs || verifiedAtMs > startedAtMs || expiresAtMs <= nowMs) {
      throw new Error('RIG-R approval verification time/UTC TTL is not currently valid or has expired.');
    }
    return deepFreeze({
      status: 'VERIFIED',
      approvalId: record.approvalId,
      sourceReference: record.sourceReference,
      immutableRevisionId: record.immutableRevisionId,
      canonicalSha256,
      trustRootKeyId: this.keyId,
      trustRootKeyFingerprint: this.keyFingerprint,
      authorityRosterRootSha256: record.authority.authorizedRosterRootSha256,
      approverIdentity: record.authority.approverIdentity,
      verifierIdentity: record.verification.verifierIdentity,
      authorityActivatedAtUtc: this.activatedAt.value,
      candidate: { ...expected },
      topology: { ...record.topology },
      execution: { ...record.execution },
      budget: { ...record.budget },
      teardown: { ...record.teardown },
      approvalVerifiedAt: record.verification.verifiedAt,
      verificationMethod: record.verification.method,
      runtimeVerifiedAt: now.toISOString(),
    });
  }
}

export function getRigRProvisionApprovalAuthority() {
  return PRODUCTION_AUTHORITY;
}

export function createProductionRigRProvisionApprovalVerifier() {
  return new Ed25519RigRProvisionApprovalVerifier({
    publicKeyPem: PRODUCTION_PUBLIC_KEY_PEM,
    keyId: PRODUCTION_AUTHORITY.keyId,
    keyFingerprint: PRODUCTION_AUTHORITY.publicKeyFingerprintSha256,
    authorityRosterRootSha256: PRODUCTION_AUTHORITY.genesisRosterRootSha256,
    authorizedApproverIdentity: PRODUCTION_AUTHORITY.authorizedApproverIdentity,
    verifierIdentity: PRODUCTION_AUTHORITY.verifierIdentity,
    operatorIdentity: PRODUCTION_AUTHORITY.authorizedOperator,
    activatedAtUtc: PRODUCTION_AUTHORITY.activatedAtUtc,
  });
}

export function createRigRProvisionApprovalVerifierForTest(config) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('RIG-R provision trust-root injection is available only in tests.');
  }
  return new Ed25519RigRProvisionApprovalVerifier(config);
}

async function readRegularFileNoFollow(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 1_048_576) {
      throw new Error('RIG-R provision approval artifact must be one bounded regular file.');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function main() {
  const args = parseArgs({
    options: {
      artifact: { type: 'string' },
      'expected-source-head': { type: 'string' },
      'expected-source-tree': { type: 'string' },
      'expected-source-head-image-ref': { type: 'string' },
      'expected-image-digest': { type: 'string' },
      'expected-provision-artifact-sha256': { type: 'string' },
      'expected-rig-name': { type: 'string' },
      'expected-rig-profile': { type: 'string' },
      'expected-soak-id': { type: 'string' },
      'expected-lease-id': { type: 'string' },
      'expected-required-wall-min': { type: 'string' },
      'expected-vertex-endpoint-id': { type: 'string' },
      'expected-vertex-endpoint': { type: 'string' },
      'expected-vertex-endpoint-display-name': { type: 'string' },
      'expected-vertex-model': { type: 'string' },
      'expected-vertex-model-version': { type: 'string' },
      'expected-checkpoint-id': { type: 'string' },
      'expected-deployed-model-id': { type: 'string' },
      'expected-deployed-model-display-name': { type: 'string' },
      'expected-deployment-resources-mode': { type: 'string' },
      'expected-min-replica-count': { type: 'string' },
      'expected-max-replica-count': { type: 'string' },
      'expected-endpoint-iam-role': { type: 'string' },
      'expected-endpoint-iam-member': { type: 'string' },
      'expected-runtime-impersonator-service-account': { type: 'string' },
      'expected-runtime-impersonation-role': { type: 'string' },
      'expected-runtime-impersonation-member': { type: 'string' },
      'expected-provision-started-at': { type: 'string' },
      'expected-expires-at': { type: 'string' },
      'expected-teardown-script-sha256': { type: 'string' },
      'expected-supabase-url-secret': { type: 'string' },
      'expected-supabase-service-role-secret': { type: 'string' },
      'expected-stripe-secret-key-secret': { type: 'string' },
      'expected-stripe-webhook-secret': { type: 'string' },
      'expected-api-key-hmac-secret': { type: 'string' },
      'expected-cron-secret': { type: 'string' },
      'expected-gemini-api-key-secret': { type: 'string' },
      'expected-immutable-ledger-bucket': { type: 'string' },
    },
    strict: true,
  });
  if (!args.values.artifact) throw new Error('--artifact is required.');
  const requiredWallMinText = args.values['expected-required-wall-min'];
  const requiredWallMin = typeof requiredWallMinText === 'string'
    && /^[1-9][0-9]*$/u.test(requiredWallMinText)
    ? Number(requiredWallMinText)
    : Number.NaN;
  const minReplicaCountText = args.values['expected-min-replica-count'];
  const minReplicaCount = typeof minReplicaCountText === 'string'
    && /^[1-9][0-9]*$/u.test(minReplicaCountText)
    ? Number(minReplicaCountText)
    : Number.NaN;
  const maxReplicaCountText = args.values['expected-max-replica-count'];
  const maxReplicaCount = typeof maxReplicaCountText === 'string'
    && /^[1-9][0-9]*$/u.test(maxReplicaCountText)
    ? Number(maxReplicaCountText)
    : Number.NaN;
  const expectedBinding = {
    sourceHeadSha: args.values['expected-source-head'],
    sourceTreeSha: args.values['expected-source-tree'],
    sourceHeadImageRef: args.values['expected-source-head-image-ref'],
    imageDigest: args.values['expected-image-digest'],
    provisionArtifactSha256: args.values['expected-provision-artifact-sha256'],
    rigName: args.values['expected-rig-name'],
    rigProfile: args.values['expected-rig-profile'],
    soakId: args.values['expected-soak-id'],
    leaseId: args.values['expected-lease-id'],
    requiredWallMin,
    vertexEndpointId: args.values['expected-vertex-endpoint-id'],
    vertexEndpoint: args.values['expected-vertex-endpoint'],
    vertexEndpointDisplayName: args.values['expected-vertex-endpoint-display-name'],
    vertexModel: args.values['expected-vertex-model'],
    vertexModelVersion: args.values['expected-vertex-model-version'],
    checkpointId: args.values['expected-checkpoint-id'],
    deployedModelId: args.values['expected-deployed-model-id'],
    deployedModelDisplayName: args.values['expected-deployed-model-display-name'],
    deploymentResourcesMode: args.values['expected-deployment-resources-mode'],
    minReplicaCount,
    maxReplicaCount,
    endpointIamRole: args.values['expected-endpoint-iam-role'],
    endpointIamMember: args.values['expected-endpoint-iam-member'],
    runtimeImpersonatorServiceAccount:
      args.values['expected-runtime-impersonator-service-account'],
    runtimeImpersonationRole: args.values['expected-runtime-impersonation-role'],
    runtimeImpersonationMember: args.values['expected-runtime-impersonation-member'],
    provisionStartedAt: args.values['expected-provision-started-at'],
    expiresAt: args.values['expected-expires-at'],
    teardownScriptSha256: args.values['expected-teardown-script-sha256'],
    secretReferences: {
      supabaseUrl: args.values['expected-supabase-url-secret'],
      supabaseServiceRoleKey: args.values['expected-supabase-service-role-secret'],
      stripeSecretKey: args.values['expected-stripe-secret-key-secret'],
      stripeWebhookSecret: args.values['expected-stripe-webhook-secret'],
      apiKeyHmacSecret: args.values['expected-api-key-hmac-secret'],
      cronSecret: args.values['expected-cron-secret'],
      geminiApiKey: args.values['expected-gemini-api-key-secret'],
    },
    immutableLedger: {
      ...IMMUTABLE_LEDGER,
      bucket: args.values['expected-immutable-ledger-bucket'],
    },
  };
  const raw = await readRegularFileNoFollow(args.values.artifact);
  const verifier = createProductionRigRProvisionApprovalVerifier();
  process.stdout.write(`${JSON.stringify(verifier.verify(raw, expectedBinding))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
