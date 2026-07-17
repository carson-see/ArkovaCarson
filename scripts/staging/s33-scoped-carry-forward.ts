/**
 * CTO-authorized S3.3 mixed-version carry-forward contract.
 *
 * The active G1/R clocks stay bound to the exact 5964 candidate while B1
 * advances to its isolated batch fix. This artifact is clock-admissibility
 * evidence only: it cannot complete a soak or grant release acceptance.
 */

import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { canonicaliseJson } from '../../services/worker/src/utils/canonical-json';
import { S33_DETACHED_SIGNING_TRUST_POLICY_V2 } from '../../services/worker/src/ai/eval/s33-wave3-detached-signing-v2';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import { freezeS33Evidence } from './s33-evidence-integrity';

const PRESERVED_HEAD = '5964ebaaf67dbfe2b1afec1cc106c9d7402590e1' as const;
const PRESERVED_TREE = 'eb5d0678cdc94fbd98f2383eb7c8abf3bc56a342' as const;
const PRESERVED_IMAGE =
  'sha256:3526577e4ab62eb7fcee30238d0005102dfb8cd9917e059f27fc4529d27f06de' as const;
const B1_PROVISIONING_HEAD = '418721e490c63ff9ca5d5b2cff165aae60def78c' as const;
const B1_HEAD = '5dacccc888f97e8bb40f40e851547892f3d744ac' as const;
const B1_TREE = '116738ff87a8e08fa1af11f354534904875e710a' as const;
const B1_IMAGE_INDEX =
  'sha256:d69aaff07f7395f87575bd366fcbda9c5130480b5314aeddc209cf0d17990612' as const;
const B1_IMAGE_AMD64 =
  'sha256:d4d89e39c0a0f539856113e13a0fe276e44156355b9059ed9a743fc742651db6' as const;
const DECISION_ID = 's33-scoped-carry-forward-5dacccc-v1' as const;
const SIGNER_IDENTITY = 'arkova-s33-cto-release' as const;
const SIGNING_KEY_ID = 'arkova.s33.release-corpus.ed25519.v1' as const;
const APPROVER_IDENTITY = 'arkova.s33.approver.founder-cto.v1' as const;
const SIGNATURE_ALGORITHM = 'Ed25519' as const;
const MAX_HEARTBEAT_RECHECK_AGE_MS = 5 * 60_000;

export const S33_SCOPED_CARRY_FORWARD_SIGNATURE_DOMAIN =
  'arkova:s33:scoped-carry-forward:v1\n' as const;

const B1_PROVISIONING_CHANGED_PATHS = [
  'scripts/staging/batch-drain-live-evidence.ts',
  'scripts/staging/fixtures/rig-b1-admission-v2.json',
  'scripts/staging/provision-isolated-rig.sh',
  'scripts/staging/provision-isolated-rig.test.ts',
  'scripts/staging/s33-b1-node-approval.mjs',
  'scripts/staging/s33-b1-node-approval.test.ts',
  'scripts/staging/teardown-isolated-rig.sh',
  'scripts/staging/teardown-isolated-rig.test.ts',
] as const;

const B1_RUNTIME_FIX_CHANGED_PATHS = [
  'services/worker/src/jobs/batch-anchor.test.ts',
  'services/worker/src/jobs/batch-anchor.ts',
] as const;

const G1_START_RECEIPT = Object.freeze({
  uri: 'gs://arkova1-s33-immutable-authority-ledger/s33/g1/paired-start-receipts/25aabbbbdefbaea6326e9b6f12e0ed9e52331fb3cae870cfde3e654e2d13e00d.json',
  generation: '1784241786034362',
  rawSha256: 'sha256:88926a1549795de7e51541546fdcff4688cfddad87bbea5a0c635d18cb735762',
});

const RIG_R_START_RECEIPT = Object.freeze({
  uri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-r/release-start-receipts/fee5f54a1b99ff8fe0892139928977c7d9b1e6c8861af86b69c471ca47b942b8.json',
  generation: '1784246444822078',
  rawSha256: 'sha256:9b08987d4946ca006ef244f16dee1b909ed13269d95da240526a9b9c854f9b03',
});

export const S33_SCOPED_CARRY_FORWARD = Object.freeze({
  decisionId: DECISION_ID,
  preservedCandidate: Object.freeze({
    headSha: PRESERVED_HEAD,
    treeSha: PRESERVED_TREE,
    imageDigest: PRESERVED_IMAGE,
  }),
  b1ProvisioningHeadSha: B1_PROVISIONING_HEAD,
  advancedB1Candidate: Object.freeze({
    headSha: B1_HEAD,
    treeSha: B1_TREE,
    imageIndexDigest: B1_IMAGE_INDEX,
    imageLinuxAmd64Digest: B1_IMAGE_AMD64,
    embeddedBuildSha: B1_HEAD,
  }),
  b1ProvisioningChangedPaths: Object.freeze([...B1_PROVISIONING_CHANGED_PATHS]),
  b1RuntimeFixChangedPaths: Object.freeze([...B1_RUNTIME_FIX_CHANGED_PATHS]),
  g1StartReceipt: G1_START_RECEIPT,
  rigRStartReceipt: RIG_R_START_RECEIPT,
});

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const numericGeneration = z.string().regex(/^[1-9][0-9]*$/u);
const safeReference = z.string().min(3).max(1_024);
const signatureBase64Url = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);

const preservedCandidateSchema = z.object({
  headSha: z.literal(PRESERVED_HEAD),
  treeSha: z.literal(PRESERVED_TREE),
  imageDigest: z.literal(PRESERVED_IMAGE),
}).strict();

const advancedB1CandidateSchema = z.object({
  headSha: z.literal(B1_HEAD),
  treeSha: z.literal(B1_TREE),
  imageIndexDigest: z.literal(B1_IMAGE_INDEX),
  imageLinuxAmd64Digest: z.literal(B1_IMAGE_AMD64),
  embeddedBuildSha: z.literal(B1_HEAD),
}).strict();

function exactStringTuple<const T extends readonly [string, ...string[]]>(values: T) {
  return z.tuple(values.map((value) => z.literal(value)) as {
    [K in keyof T]: z.ZodLiteral<T[K]>;
  });
}

const deltaChainSchema = z.tuple([
  z.object({
    baseHeadSha: z.literal(PRESERVED_HEAD),
    headSha: z.literal(B1_PROVISIONING_HEAD),
    classification: z.literal('B1_PROVISIONING_ONLY'),
    changedPaths: exactStringTuple(B1_PROVISIONING_CHANGED_PATHS),
  }).strict(),
  z.object({
    baseHeadSha: z.literal(B1_PROVISIONING_HEAD),
    headSha: z.literal(B1_HEAD),
    classification: z.literal('B1_BATCH_RUNTIME_FIX_AND_TEST'),
    changedPaths: exactStringTuple(B1_RUNTIME_FIX_CHANGED_PATHS),
  }).strict(),
]);

function preservedRigSchema<const T extends Readonly<{
  rigId: 'RIG-G1-A' | 'RIG-G1-B' | 'RIG-R';
  tier: 'T2' | 'T3';
  service: string;
  revision: string;
  runtimeServiceAccount: string;
  supabaseProjectRef: string;
}>>(rig: T) {
  return z.object({
    rigId: z.literal(rig.rigId),
    tier: z.literal(rig.tier),
    service: z.literal(rig.service),
    revision: z.literal(rig.revision),
    runtimeServiceAccount: z.literal(rig.runtimeServiceAccount),
    supabaseProjectRef: z.literal(rig.supabaseProjectRef),
    headSha: z.literal(PRESERVED_HEAD),
    treeSha: z.literal(PRESERVED_TREE),
    imageDigest: z.literal(PRESERVED_IMAGE),
  }).strict();
}

const preservedRigsSchema = z.tuple([
  preservedRigSchema({
    rigId: 'RIG-G1-A', tier: 'T2', service: 'arkova-worker-s33-g1-a-staging',
    revision: 'arkova-worker-s33-g1-a-staging-00003-st9',
    runtimeServiceAccount: 's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com',
    supabaseProjectRef: 'xexeyggjmiljsxnbgwyw',
  }),
  preservedRigSchema({
    rigId: 'RIG-G1-B', tier: 'T2', service: 'arkova-worker-s33-g1-b-staging',
    revision: 'arkova-worker-s33-g1-b-staging-00003-82m',
    runtimeServiceAccount: 's33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com',
    supabaseProjectRef: 'kbyzdzwsxfkrgtotafab',
  }),
  preservedRigSchema({
    rigId: 'RIG-R', tier: 'T3', service: 'arkova-worker-s33-r-staging',
    revision: 'arkova-worker-s33-r-staging-00006-9rc',
    runtimeServiceAccount: 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
    supabaseProjectRef: 'kzvibjvehqoiqvjkodoj',
  }),
]);

function lockedReceiptSchema(receipt: typeof G1_START_RECEIPT | typeof RIG_R_START_RECEIPT) {
  return z.object({
    uri: z.literal(receipt.uri),
    generation: z.literal(receipt.generation),
    rawSha256: z.literal(receipt.rawSha256),
  }).strict();
}

const payloadSchema = z.object({
  schemaVersion: z.literal('arkova.s33.scoped-carry-forward/v1'),
  artifactType: z.literal('arkova-s33-scoped-carry-forward-payload'),
  decisionId: z.literal(DECISION_ID),
  decision: z.literal('PRESERVE_ACTIVE_G1_R_CLOCKS_WHILE_B1_ADVANCES'),
  authority: z.object({
    approverIdentity: z.literal(APPROVER_IDENTITY),
    signerIdentity: z.literal(SIGNER_IDENTITY),
    signingKeyId: z.literal(SIGNING_KEY_ID),
    authorizedAtUtc: timestamp,
    authorityReceipt: z.literal(
      'codex-thread:019f65ca-fdfc-7652-bd86-7be6c7463d34:cto-scoped-carry-forward-ruling',
    ),
  }).strict(),
  scope: z.object({
    releaseAcceptance: z.literal(false),
    purpose: z.literal('CLOCK_ADMISSIBILITY_ONLY'),
    rationale: z.string().min(32).max(1_024),
    residualRisk: z.string().min(32).max(1_024),
  }).strict(),
  candidates: z.object({
    preserved: preservedCandidateSchema,
    advancedB1: advancedB1CandidateSchema,
    deltaChain: deltaChainSchema,
  }).strict(),
  preservedRigs: preservedRigsSchema,
  evidence: z.object({
    callGraphProofSha256: sha256,
    beforeReadbackSha256: sha256,
    afterReadbackSha256: sha256,
    cloudAuditNoMutationSha256: sha256,
    heartbeatSnapshotSha256: sha256,
    g1PairedStartReceipt: lockedReceiptSchema(G1_START_RECEIPT),
    rigRStartReceipt: lockedReceiptSchema(RIG_R_START_RECEIPT),
    observationWindow: z.object({
      startedAtUtc: z.literal('2026-07-17T00:00:43.242Z'),
      endedAtUtc: timestamp,
      cloudRunMutationCount: z.literal(0),
      vertexEndpointMutationCount: z.literal(0),
    }).strict(),
  }).strict(),
  downstreamBinding: z.object({
    requiredArtifactType: z.literal('arkova-s33-scoped-carry-forward-binding/v1'),
    requiredB1StartReceipt: z.literal(true),
    requiredB1Heartbeat: z.literal(true),
    requiredPreservedRigHeartbeatRecheck: z.literal(true),
    releaseAcceptance: z.literal(false),
  }).strict(),
}).strict().superRefine((payload, context) => {
  const authorizedAt = Date.parse(payload.authority.authorizedAtUtc);
  const observationEnd = Date.parse(payload.evidence.observationWindow.endedAtUtc);
  if (observationEnd > authorizedAt) {
    context.addIssue({
      code: 'custom',
      path: ['evidence', 'observationWindow', 'endedAtUtc'],
      message: 'No-mutation observation cannot end after CTO authorization.',
    });
  }
});

export type S33ScopedCarryForwardPayloadInput = z.input<typeof payloadSchema>;
export type S33ScopedCarryForwardPayload = z.output<typeof payloadSchema>;

export interface S33ScopedCarryForwardSigningRequest {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-scoped-carry-forward-signing-request';
  readonly signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  readonly signerIdentity: typeof SIGNER_IDENTITY;
  readonly signingKeyId: typeof SIGNING_KEY_ID;
  readonly domainSeparator: typeof S33_SCOPED_CARRY_FORWARD_SIGNATURE_DOMAIN;
  readonly payload: S33ScopedCarryForwardPayload;
  readonly payloadCanonicalJson: string;
  readonly payloadCanonicalSha256: string;
  readonly signingBytesBase64Url: string;
  readonly signingBytesSha256: string;
  readonly requestDigestSha256: string;
}

export interface S33ScopedCarryForwardEnvelope {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-scoped-carry-forward-envelope';
  readonly signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  readonly signerIdentity: typeof SIGNER_IDENTITY;
  readonly signingKeyId: typeof SIGNING_KEY_ID;
  readonly publicKeyFingerprintSha256: string;
  readonly request: S33ScopedCarryForwardSigningRequest;
  readonly signatureBase64Url: string;
  readonly artifactDigestSha256: string;
}

export interface VerifiedS33ScopedCarryForwardEnvelope extends S33ScopedCarryForwardEnvelope {
  readonly payload: S33ScopedCarryForwardPayload;
}

const requestSchema = z.object({
  schemaVersion: z.literal(1),
  artifactType: z.literal('arkova-s33-scoped-carry-forward-signing-request'),
  signatureAlgorithm: z.literal(SIGNATURE_ALGORITHM),
  signerIdentity: z.literal(SIGNER_IDENTITY),
  signingKeyId: z.literal(SIGNING_KEY_ID),
  domainSeparator: z.literal(S33_SCOPED_CARRY_FORWARD_SIGNATURE_DOMAIN),
  payload: payloadSchema,
  payloadCanonicalJson: z.string().min(1),
  payloadCanonicalSha256: sha256,
  signingBytesBase64Url: z.string().min(1),
  signingBytesSha256: sha256,
  requestDigestSha256: sha256,
}).strict();

const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  artifactType: z.literal('arkova-s33-scoped-carry-forward-envelope'),
  signatureAlgorithm: z.literal(SIGNATURE_ALGORITHM),
  signerIdentity: z.literal(SIGNER_IDENTITY),
  signingKeyId: z.literal(SIGNING_KEY_ID),
  publicKeyFingerprintSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  request: requestSchema,
  signatureBase64Url,
  artifactDigestSha256: sha256,
}).strict();

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function clone<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`${label} cannot be captured as immutable data.`, { cause: error });
  }
}

function buildRequestWithoutDigest(payload: S33ScopedCarryForwardPayload) {
  const payloadCanonicalJson = canonicaliseJson(payload);
  const signingBytes = Buffer.from(
    `${S33_SCOPED_CARRY_FORWARD_SIGNATURE_DOMAIN}${payloadCanonicalJson}`,
  );
  return {
    schemaVersion: 1 as const,
    artifactType: 'arkova-s33-scoped-carry-forward-signing-request' as const,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: SIGNING_KEY_ID,
    domainSeparator: S33_SCOPED_CARRY_FORWARD_SIGNATURE_DOMAIN,
    payload,
    payloadCanonicalJson,
    payloadCanonicalSha256: digest(payloadCanonicalJson),
    signingBytesBase64Url: signingBytes.toString('base64url'),
    signingBytesSha256: digest(signingBytes),
  };
}

export function buildS33ScopedCarryForwardSigningRequest(
  input: S33ScopedCarryForwardPayloadInput,
): S33ScopedCarryForwardSigningRequest {
  const payload = freezeS33Evidence(payloadSchema.parse(clone(input, 'Carry-forward payload')));
  const base = buildRequestWithoutDigest(payload);
  return freezeS33Evidence({
    ...base,
    requestDigestSha256: digest(canonicaliseJson(base)),
  });
}

function parseSigningRequest(value: unknown): S33ScopedCarryForwardSigningRequest {
  const parsed = requestSchema.parse(clone(value, 'Carry-forward signing request'));
  const rebuilt = buildS33ScopedCarryForwardSigningRequest(parsed.payload);
  if (!isDeepStrictEqual(parsed, rebuilt)) {
    throw new Error('Carry-forward signing request canonical bytes or digest drifted.');
  }
  return rebuilt;
}

export interface S33ScopedCarryForwardVerifierConfig {
  readonly publicKeyPem: string;
  readonly publicKeyFingerprintSha256: string;
}

function validateVerifierConfig(config: S33ScopedCarryForwardVerifierConfig) {
  const publicKey = createPublicKey(config.publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Carry-forward trust root must be Ed25519.');
  }
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  if (fingerprint !== config.publicKeyFingerprintSha256) {
    throw new Error('Carry-forward trust-root fingerprint is invalid.');
  }
  return publicKey;
}

function verifySignature(
  request: S33ScopedCarryForwardSigningRequest,
  signature: string,
  config: S33ScopedCarryForwardVerifierConfig,
): void {
  const publicKey = validateVerifierConfig(config);
  const bytes = Buffer.from(request.signingBytesBase64Url, 'base64url');
  const signatureBytes = Buffer.from(signatureBase64Url.parse(signature), 'base64url');
  if (signatureBytes.length !== 64
    || !verifyEd25519(null, bytes, publicKey, signatureBytes)) {
    throw new Error('Carry-forward detached Ed25519 signature is invalid.');
  }
}

export function assembleS33ScopedCarryForwardEnvelope(
  requestValue: unknown,
  signature: string,
  config: S33ScopedCarryForwardVerifierConfig,
): S33ScopedCarryForwardEnvelope {
  const request = parseSigningRequest(requestValue);
  verifySignature(request, signature, config);
  const base = {
    schemaVersion: 1 as const,
    artifactType: 'arkova-s33-scoped-carry-forward-envelope' as const,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: SIGNING_KEY_ID,
    publicKeyFingerprintSha256: config.publicKeyFingerprintSha256,
    request,
    signatureBase64Url: signature,
  };
  return freezeS33Evidence({
    ...base,
    artifactDigestSha256: digest(canonicaliseJson(base)),
  });
}

export interface S33ScopedCarryForwardVerifier {
  verify(value: unknown): VerifiedS33ScopedCarryForwardEnvelope;
  verifyJson(raw: string): VerifiedS33ScopedCarryForwardEnvelope;
}

const VERIFIED_ENVELOPES = new WeakSet<VerifiedS33ScopedCarryForwardEnvelope>();

class Ed25519S33ScopedCarryForwardVerifier implements S33ScopedCarryForwardVerifier {
  constructor(private readonly config: S33ScopedCarryForwardVerifierConfig) {
    validateVerifierConfig(config);
  }

  verify(value: unknown): VerifiedS33ScopedCarryForwardEnvelope {
    const parsed = envelopeSchema.parse(clone(value, 'Carry-forward envelope'));
    if (parsed.publicKeyFingerprintSha256 !== this.config.publicKeyFingerprintSha256) {
      throw new Error('Carry-forward envelope names an untrusted fingerprint.');
    }
    const request = parseSigningRequest(parsed.request);
    verifySignature(request, parsed.signatureBase64Url, this.config);
    const base = {
      schemaVersion: parsed.schemaVersion,
      artifactType: parsed.artifactType,
      signatureAlgorithm: parsed.signatureAlgorithm,
      signerIdentity: parsed.signerIdentity,
      signingKeyId: parsed.signingKeyId,
      publicKeyFingerprintSha256: parsed.publicKeyFingerprintSha256,
      request,
      signatureBase64Url: parsed.signatureBase64Url,
    };
    if (parsed.artifactDigestSha256 !== digest(canonicaliseJson(base))) {
      throw new Error('Carry-forward envelope artifact digest mismatch.');
    }
    const verified = freezeS33Evidence({
      ...base,
      artifactDigestSha256: parsed.artifactDigestSha256,
      payload: request.payload,
    });
    VERIFIED_ENVELOPES.add(verified);
    return verified;
  }

  verifyJson(raw: string): VerifiedS33ScopedCarryForwardEnvelope {
    if (typeof raw !== 'string') {
      throw new TypeError('Carry-forward envelope raw JSON must be a string.');
    }
    return this.verify(parseJsonRejectingDuplicateKeys(
      raw,
      'S3.3 scoped carry-forward signed envelope',
    ));
  }
}

export function createProductionS33ScopedCarryForwardVerifier(): S33ScopedCarryForwardVerifier {
  const policy = S33_DETACHED_SIGNING_TRUST_POLICY_V2;
  if (policy.state !== 'ACTIVE'
    || policy.signerIdentity !== SIGNER_IDENTITY
    || policy.signingKeyId !== SIGNING_KEY_ID
    || !policy.publicKeySpkiPem
    || !policy.publicKeyFingerprintSha256) {
    throw new Error('The existing S3.3 CTO detached-signing trust policy is not active/exact.');
  }
  return new Ed25519S33ScopedCarryForwardVerifier({
    publicKeyPem: policy.publicKeySpkiPem,
    publicKeyFingerprintSha256: policy.publicKeyFingerprintSha256,
  });
}

/** Test-only trust-root injection; production uses the code-bound v2 root. */
export function createS33ScopedCarryForwardVerifierForTest(
  config: S33ScopedCarryForwardVerifierConfig,
): S33ScopedCarryForwardVerifier {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Injected carry-forward trust roots are test-only.');
  }
  return new Ed25519S33ScopedCarryForwardVerifier(config);
}

const b1StartReceiptSchema = z.object({
  headSha: z.literal(B1_HEAD),
  treeSha: z.literal(B1_TREE),
  imageIndexDigest: z.literal(B1_IMAGE_INDEX),
  imageLinuxAmd64Digest: z.literal(B1_IMAGE_AMD64),
  rawSha256: sha256,
  uri: safeReference,
  generation: numericGeneration,
}).strict();

const bindingInputSchema = z.object({
  composedAtUtc: timestamp,
  b1StartReceipt: b1StartReceiptSchema,
  b1HeartbeatSha256: sha256,
  preservedRigHeartbeatRecheckSha256: sha256,
  preservedRigHeartbeatRecheckedAtUtc: timestamp,
}).strict();

export interface S33ScopedCarryForwardBindingInput {
  readonly verifiedEnvelope: VerifiedS33ScopedCarryForwardEnvelope;
  readonly composedAtUtc: string;
  readonly b1StartReceipt: z.input<typeof b1StartReceiptSchema>;
  readonly b1HeartbeatSha256: string;
  readonly preservedRigHeartbeatRecheckSha256: string;
  readonly preservedRigHeartbeatRecheckedAtUtc: string;
}

export interface S33ScopedCarryForwardBinding {
  readonly schemaVersion: 'arkova.s33.scoped-carry-forward-binding/v1';
  readonly status: 'SCOPED_CARRY_FORWARD_BOUND';
  readonly releaseAcceptance: false;
  readonly decisionId: typeof DECISION_ID;
  readonly decisionEnvelopeSha256: string;
  readonly preservedCandidate: typeof S33_SCOPED_CARRY_FORWARD.preservedCandidate;
  readonly b1Candidate: typeof S33_SCOPED_CARRY_FORWARD.advancedB1Candidate;
  readonly b1StartReceipt: z.output<typeof b1StartReceiptSchema>;
  readonly b1HeartbeatSha256: string;
  readonly preservedRigHeartbeatRecheckSha256: string;
  readonly preservedRigHeartbeatRecheckedAtUtc: string;
  readonly composedAtUtc: string;
  readonly claims: Readonly<{
    oldClocks: 'PRESERVED_BY_SIGNED_SCOPED_CARRY_FORWARD';
    b1: 'ADVANCED_ON_EXACT_ISOLATED_TUPLE';
    soakCompletion: 'NOT_CLAIMED';
    releaseAcceptance: 'NOT_GRANTED';
  }>;
  readonly bindingDigestSha256: string;
}

/**
 * Exact downstream step after B1 starts. It binds, but never converts, the
 * three independently timed rig contracts into one release acceptance.
 */
export function composeS33ScopedCarryForwardBinding(
  input: S33ScopedCarryForwardBindingInput,
): S33ScopedCarryForwardBinding {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Carry-forward binding input must be an object.');
  }
  const keys = Object.keys(input).sort();
  const expectedKeys = [
    'b1HeartbeatSha256', 'b1StartReceipt', 'composedAtUtc',
    'preservedRigHeartbeatRecheckSha256', 'preservedRigHeartbeatRecheckedAtUtc',
    'verifiedEnvelope',
  ].sort();
  if (!isDeepStrictEqual(keys, expectedKeys)) {
    throw new Error('Carry-forward binding input has missing or extra fields.');
  }
  if (!input.verifiedEnvelope || typeof input.verifiedEnvelope !== 'object'
    || !VERIFIED_ENVELOPES.has(input.verifiedEnvelope)) {
    throw new TypeError('Carry-forward binding requires a provenance-verified envelope.');
  }
  const envelope = input.verifiedEnvelope;
  const parsed = bindingInputSchema.parse(clone({
    composedAtUtc: input.composedAtUtc,
    b1StartReceipt: input.b1StartReceipt,
    b1HeartbeatSha256: input.b1HeartbeatSha256,
    preservedRigHeartbeatRecheckSha256: input.preservedRigHeartbeatRecheckSha256,
    preservedRigHeartbeatRecheckedAtUtc: input.preservedRigHeartbeatRecheckedAtUtc,
  }, 'Carry-forward binding values'));
  const composedAt = Date.parse(parsed.composedAtUtc);
  const heartbeatAt = Date.parse(parsed.preservedRigHeartbeatRecheckedAtUtc);
  if (heartbeatAt > composedAt
    || composedAt - heartbeatAt > MAX_HEARTBEAT_RECHECK_AGE_MS) {
    throw new Error('Preserved-rig heartbeat recheck is future-dated or older than five minutes.');
  }
  const base = {
    schemaVersion: 'arkova.s33.scoped-carry-forward-binding/v1' as const,
    status: 'SCOPED_CARRY_FORWARD_BOUND' as const,
    releaseAcceptance: false as const,
    decisionId: DECISION_ID,
    decisionEnvelopeSha256: envelope.artifactDigestSha256,
    preservedCandidate: S33_SCOPED_CARRY_FORWARD.preservedCandidate,
    b1Candidate: S33_SCOPED_CARRY_FORWARD.advancedB1Candidate,
    b1StartReceipt: parsed.b1StartReceipt,
    b1HeartbeatSha256: parsed.b1HeartbeatSha256,
    preservedRigHeartbeatRecheckSha256: parsed.preservedRigHeartbeatRecheckSha256,
    preservedRigHeartbeatRecheckedAtUtc: parsed.preservedRigHeartbeatRecheckedAtUtc,
    composedAtUtc: parsed.composedAtUtc,
    claims: Object.freeze({
      oldClocks: 'PRESERVED_BY_SIGNED_SCOPED_CARRY_FORWARD' as const,
      b1: 'ADVANCED_ON_EXACT_ISOLATED_TUPLE' as const,
      soakCompletion: 'NOT_CLAIMED' as const,
      releaseAcceptance: 'NOT_GRANTED' as const,
    }),
  };
  return freezeS33Evidence({
    ...base,
    bindingDigestSha256: digest(canonicaliseJson(base)),
  });
}
