#!/usr/bin/env -S npx tsx
/**
 * RIG-G1 immutable spend-approval verifier.
 *
 * Live authority is accepted only from an Ed25519-signed strict record whose
 * signer key, roster root, approver identity, and verifier identity are pinned
 * in code. The production bindings deliberately remain null until a founder or
 * the CTO commits the approved trust root; environment variables and CLI
 * strings cannot configure authority.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';

const PRODUCTION_APPROVAL_PUBLIC_KEY_PEM: string | null = null;
const PRODUCTION_APPROVAL_KEY_FINGERPRINT: string | null = null;
const PRODUCTION_AUTHORITY_ROSTER_ROOT_SHA256: string | null = null;
const PRODUCTION_AUTHORIZED_APPROVER_IDENTITIES: readonly string[] = Object.freeze([]);
const PRODUCTION_VERIFIER_IDENTITY: string | null = null;

const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const safeIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/);
const immutableRevisionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/);
const utcTimestamp = z.string().regex(
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/,
);
const sourceReference = z.string().max(1024).refine(
  (value) => value.startsWith('ari:') || value.startsWith('https://'),
  'Approval source reference must be an ARI or HTTPS reference.',
);

export const g1SpendApprovalRecordSchema = z.object({
  schemaVersion: z.literal(1),
  approvalId: safeIdentity,
  sourceReference,
  immutableRevisionId,
  authority: z.object({
    approverIdentity: safeIdentity,
    approverRole: z.enum(['founder', 'cto']),
    authorizedRosterRootSha256: sha256Digest,
  }).strict(),
  candidate: z.object({
    sourceHeadSha: gitSha,
    imageDigest: sha256Digest,
  }).strict(),
  budget: z.object({
    isolatedSupabaseProjectCount: z.literal(3),
    isolatedSupabaseProjectMonthlyEachUsd: z.literal(10),
    isolatedSupabaseProjectsMonthlyTotalUsd: z.literal(30),
    g1VariableComputeModelCapUsd: z.number().int().positive(),
    s33TotalCapUsd: z.number().int().positive(),
  }).strict(),
  execution: z.object({
    ownerIdentity: safeIdentity,
    expiresAt: utcTimestamp,
  }).strict(),
  raci: z.object({
    responsibleIdentity: safeIdentity,
    accountableIdentity: safeIdentity,
    consultedIdentities: z.array(safeIdentity).min(1),
    informedIdentities: z.array(safeIdentity).min(1),
  }).strict(),
  verification: z.object({
    verifiedAt: utcTimestamp,
    verifierIdentity: safeIdentity,
    method: z.literal('ed25519-pinned-authority-roster'),
  }).strict(),
}).strict();

const approvalEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  keyFingerprint: sha256Hex,
  canonicalSha256: sha256Digest,
  signedPayloadRaw: z.string().min(2).max(131_072),
  signatureBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

const expectedCandidateSchema = z.object({
  sourceHeadSha: gitSha,
  imageDigest: sha256Digest,
}).strict();

export type G1SpendApprovalRecord = z.infer<typeof g1SpendApprovalRecordSchema>;
export type G1ExpectedCandidate = z.infer<typeof expectedCandidateSchema>;

export interface VerifiedG1SpendApproval {
  readonly status: 'VERIFIED';
  readonly sourceReference: string;
  readonly immutableRevisionId: string;
  readonly canonicalSha256: string;
  readonly approverIdentity: string;
  readonly approverRole: 'founder' | 'cto';
  readonly authorityRosterRootSha256: string;
  readonly candidateSourceHeadSha: string;
  readonly candidateImageDigest: string;
  readonly isolatedSupabaseProjectCount: 3;
  readonly isolatedSupabaseProjectMonthlyEachUsd: 10;
  readonly isolatedSupabaseProjectsMonthlyTotalUsd: 30;
  readonly g1VariableComputeModelCapUsd: number;
  readonly s33TotalCapUsd: number;
  readonly ownerIdentity: string;
  readonly expiresAt: string;
  readonly raci: {
    readonly responsibleIdentity: string;
    readonly accountableIdentity: string;
    readonly consultedIdentities: readonly string[];
    readonly informedIdentities: readonly string[];
  };
  readonly approvalVerifiedAt: string;
  readonly verifierIdentity: string;
  readonly verificationMethod: 'ed25519-pinned-authority-roster';
  readonly runtimeVerifiedAt: string;
  readonly trustRootKeyFingerprint: string;
}

interface VerifierConfig {
  publicKeyPem: string;
  keyFingerprint: string;
  authorityRosterRootSha256: string;
  authorizedApproverIdentities: readonly string[];
  verifierIdentity: string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(',')}}`;
  }
  throw new Error('Approval record contains a non-JSON value.');
}

export function canonicalApprovalRecordSha256(record: G1SpendApprovalRecord): string {
  return `sha256:${createHash('sha256').update(canonicalize(record)).digest('hex')}`;
}

function strictParse<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  const parsed = parseJsonRejectingDuplicateKeys(raw, label);
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`${label} failed strict schema validation.`);
  return result.data;
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is not a valid UTC timestamp.`);
  return timestamp;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

export interface G1SpendApprovalVerifier {
  verify(rawEnvelope: string, expectedCandidate: G1ExpectedCandidate, now?: Date): VerifiedG1SpendApproval;
}

class Ed25519G1SpendApprovalVerifier implements G1SpendApprovalVerifier {
  private readonly publicKey;
  private readonly keyFingerprint: string;
  private readonly authorityRosterRootSha256: string;
  private readonly authorizedApproverIdentities: ReadonlySet<string>;
  private readonly verifierIdentity: string;

  constructor(config: VerifierConfig) {
    this.publicKey = createPublicKey(config.publicKeyPem);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('G1 approval trust root must be an Ed25519 public key.');
    }
    const observedFingerprint = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (observedFingerprint !== config.keyFingerprint) {
      throw new Error('G1 approval trust-root fingerprint mismatch.');
    }
    if (!sha256Digest.safeParse(config.authorityRosterRootSha256).success) {
      throw new Error('G1 authority roster root must be a SHA-256 digest.');
    }
    if (!safeIdentity.safeParse(config.verifierIdentity).success) {
      throw new Error('G1 approval verifier identity is invalid.');
    }
    unique(config.authorizedApproverIdentities, 'Authorized G1 approver identities');
    if (config.authorizedApproverIdentities.length === 0
      || config.authorizedApproverIdentities.some((identity) => !safeIdentity.safeParse(identity).success)) {
      throw new Error('G1 approval requires a non-empty pinned authorized-identity roster.');
    }
    this.keyFingerprint = config.keyFingerprint;
    this.authorityRosterRootSha256 = config.authorityRosterRootSha256;
    this.authorizedApproverIdentities = new Set(config.authorizedApproverIdentities);
    this.verifierIdentity = config.verifierIdentity;
  }

  verify(rawEnvelope: string, expectedCandidateRaw: G1ExpectedCandidate, now = new Date()): VerifiedG1SpendApproval {
    if (typeof rawEnvelope !== 'string') throw new Error('G1 approval envelope must be a primitive string.');
    const expectedCandidate = expectedCandidateSchema.parse(expectedCandidateRaw);
    const envelope = strictParse(approvalEnvelopeSchema, rawEnvelope, 'G1 approval envelope');
    if (envelope.keyFingerprint !== this.keyFingerprint) {
      throw new Error('G1 approval envelope names an untrusted key fingerprint.');
    }
    if (!verifySignature(
      null,
      Buffer.from(envelope.signedPayloadRaw),
      this.publicKey,
      Buffer.from(envelope.signatureBase64, 'base64'),
    )) throw new Error('G1 approval Ed25519 signature is invalid.');

    const record = strictParse(
      g1SpendApprovalRecordSchema,
      envelope.signedPayloadRaw,
      'G1 signed approval record',
    );
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
    if (record.candidate.sourceHeadSha !== expectedCandidate.sourceHeadSha
      || record.candidate.imageDigest !== expectedCandidate.imageDigest) {
      throw new Error('G1 approval candidate SHA/image digest does not match the provision candidate.');
    }
    if (record.budget.s33TotalCapUsd
      < record.budget.g1VariableComputeModelCapUsd
        + record.budget.isolatedSupabaseProjectsMonthlyTotalUsd) {
      throw new Error('G1 variable compute/model plus three-project aggregate exceeds the S3.3 total cap.');
    }
    if (record.raci.responsibleIdentity !== record.execution.ownerIdentity
      || record.raci.accountableIdentity !== record.authority.approverIdentity) {
      throw new Error('G1 approval RACI must bind responsible to owner and accountable to approver.');
    }
    unique(record.raci.consultedIdentities, 'G1 consulted identities');
    unique(record.raci.informedIdentities, 'G1 informed identities');
    const nowMs = now.getTime();
    const approvalVerifiedAtMs = parseTimestamp(record.verification.verifiedAt, 'approval verifiedAt');
    const expiresAtMs = parseTimestamp(record.execution.expiresAt, 'approval expiresAt');
    if (!Number.isFinite(nowMs) || approvalVerifiedAtMs > nowMs || expiresAtMs <= nowMs) {
      throw new Error('G1 approval verification time/UTC TTL is not currently valid.');
    }

    return Object.freeze({
      status: 'VERIFIED' as const,
      sourceReference: record.sourceReference,
      immutableRevisionId: record.immutableRevisionId,
      canonicalSha256: envelope.canonicalSha256,
      approverIdentity: record.authority.approverIdentity,
      approverRole: record.authority.approverRole,
      authorityRosterRootSha256: record.authority.authorizedRosterRootSha256,
      candidateSourceHeadSha: record.candidate.sourceHeadSha,
      candidateImageDigest: record.candidate.imageDigest,
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
      trustRootKeyFingerprint: this.keyFingerprint,
    });
  }
}

export function createProductionG1SpendApprovalVerifier(): G1SpendApprovalVerifier {
  if (
    PRODUCTION_APPROVAL_PUBLIC_KEY_PEM === null
    || PRODUCTION_APPROVAL_KEY_FINGERPRINT === null
    || PRODUCTION_AUTHORITY_ROSTER_ROOT_SHA256 === null
    || PRODUCTION_VERIFIER_IDENTITY === null
    || PRODUCTION_AUTHORIZED_APPROVER_IDENTITIES.length === 0
  ) {
    throw new Error(
      'G1 spend approval trust root/authorized roster is UNCONFIGURED; live provisioning is blocked.',
    );
  }
  return new Ed25519G1SpendApprovalVerifier({
    publicKeyPem: PRODUCTION_APPROVAL_PUBLIC_KEY_PEM,
    keyFingerprint: PRODUCTION_APPROVAL_KEY_FINGERPRINT,
    authorityRosterRootSha256: PRODUCTION_AUTHORITY_ROSTER_ROOT_SHA256,
    authorizedApproverIdentities: PRODUCTION_AUTHORIZED_APPROVER_IDENTITIES,
    verifierIdentity: PRODUCTION_VERIFIER_IDENTITY,
  });
}

export function createG1SpendApprovalVerifierForTest(config: VerifierConfig): G1SpendApprovalVerifier {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('G1 approval trust-root injection is available only in tests.');
  }
  return new Ed25519G1SpendApprovalVerifier(config);
}

async function readRegularFileNoFollow(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('G1 approval artifact must be a regular file.');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      artifact: { type: 'string' },
      'expected-source-head': { type: 'string' },
      'expected-image-digest': { type: 'string' },
    },
    strict: true,
  });
  const artifact = args.values.artifact;
  if (!artifact) throw new Error('--artifact is required.');
  const expectedCandidate = expectedCandidateSchema.parse({
    sourceHeadSha: args.values['expected-source-head'],
    imageDigest: args.values['expected-image-digest'],
  });
  const verifier = createProductionG1SpendApprovalVerifier();
  const raw = await readRegularFileNoFollow(artifact);
  process.stdout.write(`${JSON.stringify(verifier.verify(raw, expectedCandidate))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
