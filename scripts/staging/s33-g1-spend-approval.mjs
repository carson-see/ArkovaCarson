#!/usr/bin/env node
/**
 * RIG-G1 immutable spend-approval verifier.
 *
 * This executable intentionally imports Node built-ins only. Live authority is
 * accepted only from a strict, duplicate-key-free Ed25519 envelope whose key,
 * roster, identities, candidate, and complete execution scope are code-bound.
 * Production verification is bound to the founder/CTO-confirmed public key,
 * roster root, identities, and activation timestamp below.
 */

import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const PRODUCTION_APPROVAL_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAkxCdUepaMpp7HVHNhpjGNQ733HS72nnZTNfpKe0P/iU=\n-----END PUBLIC KEY-----\n';
const PRODUCTION_AUTHORITY = Object.freeze({
  keyId: 'arkova.s33.g1-spend.ed25519.v1',
  purpose: 'G1_SPEND',
  publicKeyFingerprintSha256:
    '6ece5cea2d35423aab35a23f6292fd769c6d839ac03ba7860a973d4febd5d987',
  authorizedApproverIdentities: Object.freeze([
    'arkova.s33.approver.founder-cto.v1',
  ]),
  verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1',
  activatedAtUtc: '2026-07-16T13:52:06Z',
  genesisRosterRootSha256:
    'sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f',
});

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/;
const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const RIG_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const IMMUTABLE_REVISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/;
const UTC_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
const ENDPOINT_RESOURCE = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/us-central1\/endpoints\/[1-9][0-9]*$/;

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
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`${label} must contain valid JSON.`);
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
  while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
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

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function identityArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  const parsed = value.map((entry) => string(entry, SAFE_IDENTITY, label, 256));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label} must be unique.`);
  return parsed;
}

function parseScope(value, label = 'G1 approval scope') {
  const scope = object(value, label);
  exactKeys(scope, [
    'rigClass', 'rigName', 'rigProfile', 'soakId', 'rigId', 'leaseId',
    'corpusDigest', 'endpointResource',
  ], label);
  return {
    rigClass: literal(scope.rigClass, 'RIG-G1', `${label}.rigClass`),
    rigName: string(scope.rigName, RIG_NAME, `${label}.rigName`, 63),
    rigProfile: literal(scope.rigProfile, 'gemini', `${label}.rigProfile`),
    soakId: string(scope.soakId, EXECUTION_ID, `${label}.soakId`, 128),
    rigId: literal(scope.rigId, 'RIG-G1', `${label}.rigId`),
    leaseId: string(scope.leaseId, EXECUTION_ID, `${label}.leaseId`, 128),
    corpusDigest: string(scope.corpusDigest, SHA256_DIGEST, `${label}.corpusDigest`, 71),
    endpointResource: string(scope.endpointResource, ENDPOINT_RESOURCE, `${label}.endpointResource`, 256),
  };
}

function parseApprovalRecord(value) {
  const record = object(value, 'G1 signed approval record');
  exactKeys(record, [
    'schemaVersion', 'approvalId', 'sourceReference', 'immutableRevisionId',
    'authority', 'candidate', 'scope', 'budget', 'execution', 'raci', 'verification',
  ], 'G1 signed approval record');
  literal(record.schemaVersion, 1, 'G1 signed approval record.schemaVersion');
  const sourceReference = typeof record.sourceReference === 'string'
    && record.sourceReference.length <= 1024
    && (record.sourceReference.startsWith('ari:') || record.sourceReference.startsWith('https://'))
    ? record.sourceReference
    : null;
  if (sourceReference === null) throw new Error('G1 approval sourceReference failed strict schema validation.');

  const authority = object(record.authority, 'G1 approval authority');
  exactKeys(authority, ['approverIdentity', 'approverRole', 'authorizedRosterRootSha256'], 'G1 approval authority');
  const candidate = object(record.candidate, 'G1 approval candidate');
  exactKeys(candidate, ['sourceHeadSha', 'imageDigest'], 'G1 approval candidate');
  const budget = object(record.budget, 'G1 approval budget');
  exactKeys(budget, [
    'isolatedSupabaseProjectCount', 'isolatedSupabaseProjectMonthlyEachUsd',
    'isolatedSupabaseProjectsMonthlyTotalUsd', 'g1VariableComputeModelCapUsd', 's33TotalCapUsd',
  ], 'G1 approval budget');
  const execution = object(record.execution, 'G1 approval execution');
  exactKeys(execution, ['ownerIdentity', 'expiresAt'], 'G1 approval execution');
  const raci = object(record.raci, 'G1 approval RACI');
  exactKeys(raci, [
    'responsibleIdentity', 'accountableIdentity', 'consultedIdentities', 'informedIdentities',
  ], 'G1 approval RACI');
  const verification = object(record.verification, 'G1 approval verification');
  exactKeys(verification, ['verifiedAt', 'verifierIdentity', 'method'], 'G1 approval verification');

  return {
    schemaVersion: 1,
    approvalId: string(record.approvalId, APPROVAL_ID, 'G1 approval approvalId', 128),
    sourceReference,
    immutableRevisionId: string(
      record.immutableRevisionId,
      IMMUTABLE_REVISION_ID,
      'G1 approval immutableRevisionId',
      256,
    ),
    authority: {
      approverIdentity: string(authority.approverIdentity, SAFE_IDENTITY, 'G1 approval approverIdentity', 256),
      approverRole: authority.approverRole === 'founder' || authority.approverRole === 'cto'
        ? authority.approverRole
        : (() => { throw new Error('G1 approval approverRole failed strict schema validation.'); })(),
      authorizedRosterRootSha256: string(
        authority.authorizedRosterRootSha256,
        SHA256_DIGEST,
        'G1 approval authorized roster root',
        71,
      ),
    },
    candidate: {
      sourceHeadSha: string(candidate.sourceHeadSha, GIT_SHA, 'G1 approval source HEAD', 40),
      imageDigest: string(candidate.imageDigest, SHA256_DIGEST, 'G1 approval image digest', 71),
    },
    scope: parseScope(record.scope),
    budget: {
      isolatedSupabaseProjectCount: literal(budget.isolatedSupabaseProjectCount, 3, 'G1 project count'),
      isolatedSupabaseProjectMonthlyEachUsd: literal(budget.isolatedSupabaseProjectMonthlyEachUsd, 10, 'G1 each-project cost'),
      isolatedSupabaseProjectsMonthlyTotalUsd: literal(budget.isolatedSupabaseProjectsMonthlyTotalUsd, 30, 'G1 aggregate project cost'),
      g1VariableComputeModelCapUsd: positiveInteger(budget.g1VariableComputeModelCapUsd, 'G1 variable compute/model cap'),
      s33TotalCapUsd: positiveInteger(budget.s33TotalCapUsd, 'S3.3 total cap'),
    },
    execution: {
      ownerIdentity: string(execution.ownerIdentity, SAFE_IDENTITY, 'G1 owner identity', 256),
      expiresAt: string(execution.expiresAt, UTC_TIMESTAMP, 'G1 approval expiresAt', 40),
    },
    raci: {
      responsibleIdentity: string(raci.responsibleIdentity, SAFE_IDENTITY, 'G1 RACI responsible', 256),
      accountableIdentity: string(raci.accountableIdentity, SAFE_IDENTITY, 'G1 RACI accountable', 256),
      consultedIdentities: identityArray(raci.consultedIdentities, 'G1 consulted identities'),
      informedIdentities: identityArray(raci.informedIdentities, 'G1 informed identities'),
    },
    verification: {
      verifiedAt: string(verification.verifiedAt, UTC_TIMESTAMP, 'G1 approval verifiedAt', 40),
      verifierIdentity: string(verification.verifierIdentity, SAFE_IDENTITY, 'G1 verifier identity', 256),
      method: literal(verification.method, 'ed25519-pinned-authority-roster', 'G1 verification method'),
    },
  };
}

function parseEnvelope(raw) {
  const envelope = object(parseJsonRejectingDuplicateKeys(raw, 'G1 approval envelope'), 'G1 approval envelope');
  exactKeys(envelope, [
    'schemaVersion', 'keyFingerprint', 'canonicalSha256', 'signedPayloadRaw', 'signatureBase64',
  ], 'G1 approval envelope');
  literal(envelope.schemaVersion, 1, 'G1 approval envelope.schemaVersion');
  const signatureBase64 = typeof envelope.signatureBase64 === 'string'
    && /^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signatureBase64)
    ? envelope.signatureBase64
    : null;
  if (signatureBase64 === null) throw new Error('G1 approval signature failed strict schema validation.');
  const signature = Buffer.from(signatureBase64, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== signatureBase64) {
    throw new Error('G1 approval signature must be one canonical Ed25519 signature.');
  }
  return {
    keyFingerprint: string(envelope.keyFingerprint, SHA256_HEX, 'G1 key fingerprint', 64),
    canonicalSha256: string(envelope.canonicalSha256, SHA256_DIGEST, 'G1 canonical SHA-256', 71),
    signedPayloadRaw: typeof envelope.signedPayloadRaw === 'string'
      && envelope.signedPayloadRaw.length >= 2
      && envelope.signedPayloadRaw.length <= 131_072
      ? envelope.signedPayloadRaw
      : (() => { throw new Error('G1 signed payload failed strict schema validation.'); })(),
    signature,
  };
}

function parseExpectedCandidate(value) {
  const candidate = object(value, 'Expected G1 candidate and scope');
  exactKeys(candidate, [
    'sourceHeadSha', 'imageDigest', 'rigClass', 'rigName', 'rigProfile', 'soakId',
    'rigId', 'leaseId', 'corpusDigest', 'endpointResource',
  ], 'Expected G1 candidate and scope');
  return {
    sourceHeadSha: string(candidate.sourceHeadSha, GIT_SHA, 'Expected source HEAD', 40),
    imageDigest: string(candidate.imageDigest, SHA256_DIGEST, 'Expected image digest', 71),
    scope: parseScope({
      rigClass: candidate.rigClass,
      rigName: candidate.rigName,
      rigProfile: candidate.rigProfile,
      soakId: candidate.soakId,
      rigId: candidate.rigId,
      leaseId: candidate.leaseId,
      corpusDigest: candidate.corpusDigest,
      endpointResource: candidate.endpointResource,
    }, 'Expected G1 scope'),
  };
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(',')}}`;
  }
  throw new Error('Approval record contains a non-JSON value.');
}

export const g1SpendApprovalRecordSchema = Object.freeze({ parse: parseApprovalRecord });

export function canonicalApprovalRecordSha256(record) {
  const parsed = parseApprovalRecord(record);
  return `sha256:${createHash('sha256').update(canonicalize(parsed)).digest('hex')}`;
}

function parseTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is not a valid UTC timestamp.`);
  return timestamp;
}

class Ed25519G1SpendApprovalVerifier {
  constructor(config) {
    const parsedConfig = object(config, 'G1 verifier config');
    exactKeys(parsedConfig, [
      'publicKeyPem', 'keyId', 'keyFingerprint', 'authorityRosterRootSha256',
      'authorizedApproverIdentities', 'verifierIdentity', 'activatedAtUtc',
    ], 'G1 verifier config');
    this.publicKey = createPublicKey(parsedConfig.publicKeyPem);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('G1 approval trust root must be an Ed25519 public key.');
    }
    const observedFingerprint = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (observedFingerprint !== parsedConfig.keyFingerprint) {
      throw new Error('G1 approval trust-root fingerprint mismatch.');
    }
    this.keyFingerprint = string(parsedConfig.keyFingerprint, SHA256_HEX, 'G1 key fingerprint', 64);
    this.keyId = string(parsedConfig.keyId, SAFE_IDENTITY, 'G1 key ID', 256);
    this.authorityRosterRootSha256 = string(
      parsedConfig.authorityRosterRootSha256,
      SHA256_DIGEST,
      'G1 authority roster root',
      71,
    );
    const identities = identityArray(parsedConfig.authorizedApproverIdentities, 'Authorized G1 approver identities');
    this.authorizedApproverIdentities = new Set(identities);
    this.verifierIdentity = string(parsedConfig.verifierIdentity, SAFE_IDENTITY, 'G1 verifier identity', 256);
    this.activatedAtUtc = string(
      parsedConfig.activatedAtUtc,
      UTC_TIMESTAMP,
      'G1 authority activation',
      40,
    );
    this.activatedAtMs = parseTimestamp(this.activatedAtUtc, 'G1 authority activation');
  }

  verify(rawEnvelope, expectedCandidateRaw, now = new Date()) {
    const expected = parseExpectedCandidate(expectedCandidateRaw);
    const envelope = parseEnvelope(rawEnvelope);
    if (envelope.keyFingerprint !== this.keyFingerprint) {
      throw new Error('G1 approval envelope names an untrusted key fingerprint.');
    }
    if (!verifySignature(null, Buffer.from(envelope.signedPayloadRaw), this.publicKey, envelope.signature)) {
      throw new Error('G1 approval Ed25519 signature is invalid.');
    }
    const record = parseApprovalRecord(parseJsonRejectingDuplicateKeys(
      envelope.signedPayloadRaw,
      'G1 signed approval record',
    ));
    if (canonicalApprovalRecordSha256(record) !== envelope.canonicalSha256) {
      throw new Error('G1 approval canonical SHA-256 mismatch.');
    }
    if (record.authority.authorizedRosterRootSha256 !== this.authorityRosterRootSha256
      || !this.authorizedApproverIdentities.has(record.authority.approverIdentity)) {
      throw new Error('G1 approval identity is not authorized by the pinned roster root.');
    }
    if (record.verification.verifierIdentity !== this.verifierIdentity) {
      throw new Error('G1 approval record names an untrusted verifier identity.');
    }
    if (record.candidate.sourceHeadSha !== expected.sourceHeadSha
      || record.candidate.imageDigest !== expected.imageDigest) {
      throw new Error('G1 approval candidate SHA/image digest does not match the provision candidate.');
    }
    if (canonicalize(record.scope) !== canonicalize(expected.scope)) {
      throw new Error('G1 approval scope does not match the exact rig execution scope.');
    }
    if (record.budget.s33TotalCapUsd !== 200) {
      throw new Error('G1 approval must bind the exact S3.3 total cap of $200.');
    }
    if (record.budget.g1VariableComputeModelCapUsd > 170
      || record.budget.g1VariableComputeModelCapUsd
        + record.budget.isolatedSupabaseProjectsMonthlyTotalUsd > 200) {
      throw new Error('G1 variable compute/model cap cannot exceed $170 within the S3.3 cap.');
    }
    if (record.raci.responsibleIdentity !== record.execution.ownerIdentity
      || record.raci.accountableIdentity !== record.authority.approverIdentity) {
      throw new Error('G1 approval RACI must bind responsible to owner and accountable to approver.');
    }
    const nowMs = now.getTime();
    const approvalVerifiedAtMs = parseTimestamp(record.verification.verifiedAt, 'approval verifiedAt');
    const expiresAtMs = parseTimestamp(record.execution.expiresAt, 'approval expiresAt');
    if (approvalVerifiedAtMs < this.activatedAtMs) {
      throw new Error('G1 approval predates the code-bound authority activation.');
    }
    if (!Number.isFinite(nowMs) || approvalVerifiedAtMs > nowMs || expiresAtMs <= nowMs) {
      throw new Error('G1 approval verification time/UTC TTL is not currently valid.');
    }

    return Object.freeze({
      status: 'VERIFIED',
      approvalId: record.approvalId,
      sourceReference: record.sourceReference,
      immutableRevisionId: record.immutableRevisionId,
      canonicalSha256: envelope.canonicalSha256,
      approverIdentity: record.authority.approverIdentity,
      approverRole: record.authority.approverRole,
      authorityRosterRootSha256: record.authority.authorizedRosterRootSha256,
      candidateSourceHeadSha: record.candidate.sourceHeadSha,
      candidateImageDigest: record.candidate.imageDigest,
      scope: Object.freeze({ ...record.scope }),
      isolatedSupabaseProjectCount: record.budget.isolatedSupabaseProjectCount,
      isolatedSupabaseProjectMonthlyEachUsd: record.budget.isolatedSupabaseProjectMonthlyEachUsd,
      isolatedSupabaseProjectsMonthlyTotalUsd: record.budget.isolatedSupabaseProjectsMonthlyTotalUsd,
      g1VariableComputeModelCapUsd: record.budget.g1VariableComputeModelCapUsd,
      s33TotalCapUsd: record.budget.s33TotalCapUsd,
      ownerIdentity: record.execution.ownerIdentity,
      expiresAt: record.execution.expiresAt,
      raci: Object.freeze({
        ...record.raci,
        consultedIdentities: Object.freeze([...record.raci.consultedIdentities]),
        informedIdentities: Object.freeze([...record.raci.informedIdentities]),
      }),
      approvalVerifiedAt: record.verification.verifiedAt,
      verifierIdentity: record.verification.verifierIdentity,
      verificationMethod: record.verification.method,
      runtimeVerifiedAt: now.toISOString(),
      trustRootKeyId: this.keyId,
      trustRootKeyFingerprint: this.keyFingerprint,
      authorityActivatedAtUtc: this.activatedAtUtc,
    });
  }
}

export function createProductionG1SpendApprovalVerifier() {
  return new Ed25519G1SpendApprovalVerifier({
    publicKeyPem: PRODUCTION_APPROVAL_PUBLIC_KEY_PEM,
    keyId: PRODUCTION_AUTHORITY.keyId,
    keyFingerprint: PRODUCTION_AUTHORITY.publicKeyFingerprintSha256,
    authorityRosterRootSha256: PRODUCTION_AUTHORITY.genesisRosterRootSha256,
    authorizedApproverIdentities: PRODUCTION_AUTHORITY.authorizedApproverIdentities,
    verifierIdentity: PRODUCTION_AUTHORITY.verifierIdentity,
    activatedAtUtc: PRODUCTION_AUTHORITY.activatedAtUtc,
  });
}

export function getG1SpendApprovalAuthority() {
  return PRODUCTION_AUTHORITY;
}

export function createG1SpendApprovalVerifierForTest(config) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('G1 approval trust-root injection is available only in tests.');
  }
  return new Ed25519G1SpendApprovalVerifier(config);
}

async function readRegularFileNoFollow(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('G1 approval artifact must be a regular file.');
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
      'expected-image-digest': { type: 'string' },
      'expected-rig-name': { type: 'string' },
      'expected-rig-profile': { type: 'string' },
      'expected-soak-id': { type: 'string' },
      'expected-rig-id': { type: 'string' },
      'expected-lease-id': { type: 'string' },
      'expected-corpus-digest': { type: 'string' },
      'expected-endpoint-resource': { type: 'string' },
    },
    strict: true,
  });
  if (!args.values.artifact) throw new Error('--artifact is required.');
  const expectedCandidate = {
    sourceHeadSha: args.values['expected-source-head'],
    imageDigest: args.values['expected-image-digest'],
    rigClass: 'RIG-G1',
    rigName: args.values['expected-rig-name'],
    rigProfile: args.values['expected-rig-profile'],
    soakId: args.values['expected-soak-id'],
    rigId: args.values['expected-rig-id'],
    leaseId: args.values['expected-lease-id'],
    corpusDigest: args.values['expected-corpus-digest'],
    endpointResource: args.values['expected-endpoint-resource'],
  };
  const verifier = createProductionG1SpendApprovalVerifier();
  const raw = await readRegularFileNoFollow(args.values.artifact);
  process.stdout.write(`${JSON.stringify(verifier.verify(raw, expectedCandidate))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
