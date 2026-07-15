/**
 * Sprint 3.3 Wave 2 top-15 coverage audit.
 *
 * Lane 4 owns the registry and corpus production. Lane 3 owns acceptance. This
 * module deliberately accepts only already-authenticated Lane-3 records; it
 * cannot turn a producer candidate, training row, or generator output into
 * held-out coverage by itself.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import {
  parseStrictJsonDocument,
  type ArtifactContent,
} from './s33-batch-acceptance.js';
import { V6_SUBTYPE_TAXONOMY } from './golden-dataset-s33-types.js';
import {
  S33_WAVE2_ACCEPTANCE_CONSTANTS,
  computeS33Wave2AcceptedEntryOrderSha256,
  verifyS33Wave2AuthenticatedBatchAcceptance,
  type S33Wave2AcceptanceBindings,
  type S33Wave2AcceptanceTrustRoot,
  type S33Wave2AcceptedEntry,
  type S33Wave2AuthenticatedBatchAcceptance,
} from './s33-wave2-acceptance-envelope.js';

const gitShaPattern = /^[a-f0-9]{40}$/;
const domainIds = ['legal', 'financial', 'education'] as const;

const mappingSchema = z.object({
  credentialType: z.string().min(1),
  subType: z.string().min(1),
}).strict();

const registryTypeSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().min(1).max(15),
  documentType: z.string().min(1),
  mappings: z.array(mappingSchema).min(1),
}).strict();

const registryDomainSchema = z.object({
  id: z.enum(domainIds),
  order: z.number().int().min(1).max(3),
  types: z.array(registryTypeSchema).length(15),
}).strict();

const registrySchema = z.object({
  schemaVersion: z.literal(1),
  artifactType: z.literal('arkova-s33-wave2-top15-registry'),
  status: z.literal('CTO_SIGNED_SCOPE'),
  decisionRecord: z.object({
    confluencePageId: z.literal('104038401'),
    alignmentPageId: z.literal('104202241'),
    decidedAtUtc: z.string().datetime({ offset: true }),
    planningBaseCommit: z.string().regex(gitShaPattern),
  }).strict(),
  coveragePolicy: z.object({
    minimumHeldoutPerType: z.number().int().positive(),
    targetEdgeCaseRatio: z.number().min(0).max(1),
    minimumProductionValidSubstantiveFields: z.number().int().positive(),
    acceptedAuthorshipMethods: z.tuple([
      z.literal('real-source'),
      z.literal('independently-authored'),
    ]),
    generatorDerivedAllowed: z.literal(false),
    trainingExposedAllowed: z.literal(false),
    acceptanceLane: z.literal('lane3'),
  }).strict(),
  acceptedBaseline: z.object({
    batchId: z.literal('S33-W1'),
    revision: z.literal(12),
    pullRequest: z.literal(1544),
    producerHeadCommit: z.literal('618e08d5a11cb73cb61394bc0343d33f4353ef39'),
    mergeCommit: z.literal('42530fd73f9bd0cb7e4e70fc1259324810780b2c'),
    entryCount: z.literal(81),
    manifestRawSha256: z.literal('eeb7c1b4bbd71642b4a7429864c0e04e9a5e3daf74b2cd78dd26442592f56e20'),
    entryDatasheetRawSha256: z.literal('da27f796454edf975b2adcb1a21a37fbbb9daecbe79b8c693a9963f4a83bdd64'),
    corpusDatasheetRawSha256: z.literal('00b9d846dac8edea61b142670ada03279147128950220d4435c09c6877b272fc'),
    sourceBlobs: z.object({
      licensing: z.literal('78090443bad793d248fdd1e3d22f7e468d618777'),
      auKe: z.literal('7826dc6a34b475bdf2c73f9059026b8d19ec1b1f'),
      ood: z.literal('a261cf690c930040f7dee0361ed29d73d1d23426'),
    }).strict(),
    top15CoverageDisposition: z.literal('NOT_PROVIDED_IN_WAVE_1'),
    countedTop15EntryIds: z.tuple([]),
  }).strict(),
  domains: z.array(registryDomainSchema).length(3),
  productionOrder: z.array(z.string().min(1)).length(45),
}).strict();

export type S33Wave2Top15Registry = z.infer<typeof registrySchema>;
export type S33AcceptedCoverageEntry = S33Wave2AcceptedEntry;
export type S33RegistryType = S33Wave2Top15Registry['domains'][number]['types'][number];
type S33RegistryDomainId = typeof domainIds[number];

interface S33RegistryTypeLocation {
  readonly domain: S33RegistryDomainId;
  readonly type: S33RegistryType;
}

/** Immutable Wave 1 baseline carried into every Wave 2 coverage report. */
export interface S33CoverageBaseline {
  readonly batchId: 'S33-W1';
  readonly revision: 12;
  readonly entryCount: 81;
  readonly top15CoverageDisposition: 'NOT_PROVIDED_IN_WAVE_1';
}

/** Per-type coverage and edge-case readiness under the CTO-signed policy. */
export interface S33TypeCoverage {
  readonly registryTypeId: string;
  readonly domain: S33RegistryDomainId;
  readonly order: number;
  readonly documentType: string;
  readonly qualifyingEntryIds: readonly string[];
  readonly qualifyingCount: number;
  readonly edgeCaseCount: number;
  readonly minimumRequired: number;
  readonly minimumEdgeCaseRequired: number;
  readonly missingCount: number;
  readonly complete: boolean;
}

/** Canonical aggregate report for all 45 signed Wave 2 registry types. */
export interface S33Wave2CoverageReport {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-wave2-coverage-audit';
  readonly planningBaseCommit: string;
  readonly baseline: Readonly<S33CoverageBaseline>;
  readonly registryTypeCount: 45;
  readonly acceptedBatchCount: number;
  readonly acceptedEntryCount: number;
  readonly acceptanceArtifactDigests: readonly string[];
  readonly acceptedRegistryRootSha256: string | null;
  readonly acceptedRegistryHeadSha256: string | null;
  readonly completeTypeCount: number;
  readonly incompleteTypeCount: number;
  readonly minimumRequiredEntryCount: number;
  readonly missingEntryCount: number;
  readonly productionOrder: readonly string[];
  readonly types: readonly S33TypeCoverage[];
}

export interface S33Wave2CoverageAuditOptions {
  /** Test-only key injection; the shared verifier rejects it outside NODE_ENV=test. */
  readonly testOnlyTrustRoot?: S33Wave2AcceptanceTrustRoot;
}

function expectedProductionOrder(registry: S33Wave2Top15Registry): string[] {
  const domainMap = new Map(registry.domains.map((domain) => [domain.id, domain]));
  const ordered: string[] = [];

  for (const start of [1, 6, 11]) {
    for (const domainId of domainIds) {
      const domain = domainMap.get(domainId);
      if (!domain) throw new Error(`S3.3 registry is missing domain ${domainId}.`);
      ordered.push(...domain.types
        .filter((type) => type.order >= start && type.order < start + 5)
        .sort((left, right) => left.order - right.order)
        .map((type) => type.id));
    }
  }

  return ordered;
}

function validateRegistryDomains(registry: S33Wave2Top15Registry): void {
  const actualDomainIds = registry.domains.map((domain) => domain.id);
  if (new Set(actualDomainIds).size !== domainIds.length
      || domainIds.some((domainId) => !actualDomainIds.includes(domainId))) {
    throw new Error('S3.3 registry must contain legal, financial, and education exactly once.');
  }
}

function validateRegistryTypeMappings(type: S33RegistryType): void {
  const mappingKeys = new Set<string>();
  for (const mapping of type.mappings) {
    const taxonomy = V6_SUBTYPE_TAXONOMY[mapping.credentialType];
    if (!taxonomy?.includes(mapping.subType)) {
      throw new Error(`S3.3 registry type ${type.id} uses unratified mapping ${mapping.credentialType}/${mapping.subType}.`);
    }
    const key = `${mapping.credentialType}/${mapping.subType}`;
    if (mappingKeys.has(key)) throw new Error(`S3.3 registry type ${type.id} repeats mapping ${key}.`);
    mappingKeys.add(key);
  }
}

function validateRegistryTypes(registry: S33Wave2Top15Registry): Set<string> {
  const ids = new Set<string>();

  for (const domain of registry.domains) {
    const expectedDomainOrder = domainIds.indexOf(domain.id) + 1;
    if (domain.order !== expectedDomainOrder) {
      throw new Error(`S3.3 domain ${domain.id} has order ${domain.order}; expected ${expectedDomainOrder}.`);
    }

    const orders = new Set(domain.types.map((type) => type.order));
    if (orders.size !== 15 || Array.from({ length: 15 }, (_, index) => index + 1).some((order) => !orders.has(order))) {
      throw new Error(`S3.3 domain ${domain.id} must contain each order from 1 through 15 exactly once.`);
    }

    for (const type of domain.types) {
      if (ids.has(type.id)) throw new Error(`Duplicate S3.3 registry type id: ${type.id}.`);
      ids.add(type.id);
      if (!type.id.startsWith(`${domain.id}-`)) {
        throw new Error(`S3.3 registry type ${type.id} is not namespaced to ${domain.id}.`);
      }
      validateRegistryTypeMappings(type);
    }
  }

  return ids;
}

function validateProductionOrder(registry: S33Wave2Top15Registry, ids: ReadonlySet<string>): void {
  const expected = expectedProductionOrder(registry);
  if (registry.productionOrder.some((id, index) => id !== expected[index])) {
    throw new Error('S3.3 production order must be domain-interleaved in fixed 1-5, 6-10, and 11-15 tranches.');
  }
  if (new Set(registry.productionOrder).size !== 45 || registry.productionOrder.some((id) => !ids.has(id))) {
    throw new Error('S3.3 production order must name each of the 45 registry types exactly once.');
  }
}

function validateRegistrySemantics(registry: S33Wave2Top15Registry): void {
  validateRegistryDomains(registry);
  validateProductionOrder(registry, validateRegistryTypes(registry));
}

/** Parse the signed top-15 registry and reject semantic drift beyond its JSON schema. */
export function parseS33Wave2Top15Registry(input: unknown): S33Wave2Top15Registry {
  const registry = registrySchema.parse(input);
  validateRegistrySemantics(registry);
  return registry;
}

function acceptanceBindingsFromEnvelope(
  input: unknown,
  coverageRegistryRawSha256: string,
  coverageRegistryCanonicalSha256: string,
): S33Wave2AcceptanceBindings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Wave-2 authenticated Lane-3 acceptance must be an envelope object.');
  }
  const payloadValue = (input as { payload?: unknown }).payload;
  if (payloadValue === null || typeof payloadValue !== 'object' || Array.isArray(payloadValue)) {
    throw new Error('Wave-2 authenticated Lane-3 acceptance must contain a payload object.');
  }
  const payload = payloadValue as S33Wave2AuthenticatedBatchAcceptance['payload'];
  if (!Array.isArray(payload.acceptedEntries)) {
    throw new Error('Wave-2 authenticated Lane-3 acceptance must contain accepted entries.');
  }
  const acceptedEntryOrderSha256 = computeS33Wave2AcceptedEntryOrderSha256(
    payload.acceptedEntries.map((entry) => entry?.id),
  );

  return {
    repositoryIdentity: S33_WAVE2_ACCEPTANCE_CONSTANTS.repositoryIdentity,
    pullRequestNumber: payload.pullRequestNumber,
    candidateBaseSha: payload.candidateBaseSha,
    candidateHeadSha: payload.candidateHeadSha,
    candidateTreeSha: payload.candidateTreeSha,
    batchId: payload.batchId,
    revision: payload.revision,
    manifestPath: payload.manifestPath,
    manifestRawSha256: payload.manifestRawSha256,
    manifestCanonicalSha256: payload.manifestCanonicalSha256,
    sourceBlobSha: payload.sourceBlobSha,
    datasheetBlobSha: payload.datasheetBlobSha,
    preflightArtifactDigestSha256: payload.preflightArtifactDigestSha256,
    baseRegistryDigestSha256: payload.baseRegistryDigestSha256,
    resultingRegistryDigestSha256: payload.resultingRegistryDigestSha256,
    coverageRegistryPath: S33_WAVE2_ACCEPTANCE_CONSTANTS.coverageRegistryPath,
    coverageRegistryRawSha256,
    coverageRegistryCanonicalSha256,
    acceptedEntryOrderSha256,
  };
}

function orderAuthenticatedAcceptanceChain(
  envelopes: readonly S33Wave2AuthenticatedBatchAcceptance[],
): readonly S33Wave2AuthenticatedBatchAcceptance[] {
  if (envelopes.length === 0) return Object.freeze([]);

  const artifactDigests = new Set<string>();
  const batchIds = new Set<string>();
  const resultDigests = new Set<string>();
  const successorByBase = new Map<string, S33Wave2AuthenticatedBatchAcceptance>();

  for (const envelope of envelopes) {
    const { payload } = envelope;
    if (artifactDigests.has(envelope.artifactDigestSha256)) {
      throw new Error(`Duplicate authenticated Lane-3 acceptance artifact: ${envelope.artifactDigestSha256}.`);
    }
    artifactDigests.add(envelope.artifactDigestSha256);
    if (batchIds.has(payload.batchId)) {
      throw new Error(`Duplicate authenticated Lane-3 batch id across revisions: ${payload.batchId}.`);
    }
    batchIds.add(payload.batchId);
    if (payload.baseRegistryDigestSha256 === payload.resultingRegistryDigestSha256) {
      throw new Error(`Authenticated Lane-3 batch ${payload.batchId} does not advance the accepted registry.`);
    }
    if (successorByBase.has(payload.baseRegistryDigestSha256)) {
      throw new Error(`Authenticated Lane-3 registry chain forks at ${payload.baseRegistryDigestSha256}.`);
    }
    successorByBase.set(payload.baseRegistryDigestSha256, envelope);
    if (resultDigests.has(payload.resultingRegistryDigestSha256)) {
      throw new Error(`Authenticated Lane-3 registry chain converges twice at ${payload.resultingRegistryDigestSha256}.`);
    }
    resultDigests.add(payload.resultingRegistryDigestSha256);
  }

  const roots = envelopes.filter(({ payload }) => !resultDigests.has(payload.baseRegistryDigestSha256));
  if (roots.length !== 1) {
    throw new Error(`Authenticated Lane-3 registry chain must have exactly one root; found ${roots.length}.`);
  }

  const ordered: S33Wave2AuthenticatedBatchAcceptance[] = [];
  const visited = new Set<string>();
  let current: S33Wave2AuthenticatedBatchAcceptance | undefined = roots[0];
  while (current !== undefined) {
    if (visited.has(current.artifactDigestSha256)) {
      throw new Error('Authenticated Lane-3 registry chain contains a cycle.');
    }
    visited.add(current.artifactDigestSha256);
    ordered.push(current);
    current = successorByBase.get(current.payload.resultingRegistryDigestSha256);
  }
  if (ordered.length !== envelopes.length) {
    throw new Error('Authenticated Lane-3 registry chain is disconnected or cyclic.');
  }
  return Object.freeze(ordered);
}

function assertUniqueAcceptedEntries(entries: readonly S33Wave2AcceptedEntry[]): void {
  const seenIds = new Set<string>();
  const seenInputs = new Set<string>();
  const seenFingerprints = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) throw new Error(`Duplicate accepted held-out entry id: ${entry.id}.`);
    if (seenInputs.has(entry.normalizedInputSha256)) {
      throw new Error(`Duplicate accepted normalized-input fingerprint: ${entry.normalizedInputSha256}.`);
    }
    if (seenFingerprints.has(entry.entryCanonicalSha256)) {
      throw new Error(`Duplicate accepted entry fingerprint: ${entry.entryCanonicalSha256}.`);
    }
    seenIds.add(entry.id);
    seenInputs.add(entry.normalizedInputSha256);
    seenFingerprints.add(entry.entryCanonicalSha256);
  }
}

/** Audit only cryptographically authenticated Lane-3 held-out batches against all signed thresholds. */
export function auditS33Wave2Coverage(
  registryContent: ArtifactContent,
  acceptanceEnvelopeInputs: readonly unknown[],
  options: S33Wave2CoverageAuditOptions = {},
): S33Wave2CoverageReport {
  const registryDocument = parseStrictJsonDocument(registryContent, 'S3.3 Wave-2 top-15 coverage registry');
  const registry = parseS33Wave2Top15Registry(registryDocument.parsed);
  const verifiedEnvelopes = acceptanceEnvelopeInputs.map((envelope) => (
    verifyS33Wave2AuthenticatedBatchAcceptance(
      envelope,
      acceptanceBindingsFromEnvelope(
        envelope,
        registryDocument.rawSha256,
        registryDocument.canonicalSha256,
      ),
      options.testOnlyTrustRoot === undefined
        ? undefined
        : { testOnlyTrustRoot: options.testOnlyTrustRoot },
    )
  ));
  const acceptanceChain = orderAuthenticatedAcceptanceChain(verifiedEnvelopes);
  const entries = acceptanceChain.flatMap(({ payload }) => payload.acceptedEntries);
  assertUniqueAcceptedEntries(entries);
  const typeById = new Map<string, S33RegistryTypeLocation>();

  for (const domain of registry.domains) {
    for (const type of domain.types) typeById.set(type.id, { domain: domain.id, type });
  }

  for (const entry of entries) {
    const registryType = typeById.get(entry.registryTypeId);
    if (!registryType) throw new Error(`Accepted entry ${entry.id} names unknown registry type ${entry.registryTypeId}.`);
    if (entry.productionValidSubstantiveFieldCount < registry.coveragePolicy.minimumProductionValidSubstantiveFields) {
      throw new Error(`Accepted entry ${entry.id} has insufficient production-valid substantive depth.`);
    }
    if (!registryType.type.mappings.some((mapping) => (
      mapping.credentialType === entry.credentialType && mapping.subType === entry.subType
    ))) {
      throw new Error(`Accepted entry ${entry.id} does not match ${entry.registryTypeId}'s ratified taxonomy mapping.`);
    }
  }

  const types: S33TypeCoverage[] = registry.productionOrder.map((registryTypeId) => {
    const registryType = typeById.get(registryTypeId);
    if (!registryType) throw new Error(`Validated registry lost type ${registryTypeId}.`);
    const qualifying = entries.filter((entry) => entry.registryTypeId === registryTypeId);
    const minimumRequired = registry.coveragePolicy.minimumHeldoutPerType;
    const minimumEdgeCaseRequired = Math.ceil(
      minimumRequired * registry.coveragePolicy.targetEdgeCaseRatio,
    );
    const edgeCaseCount = qualifying.filter((entry) => entry.edgeCase).length;
    const missingCount = Math.max(
      0,
      minimumRequired - qualifying.length,
      minimumEdgeCaseRequired - edgeCaseCount,
    );
    return Object.freeze({
      registryTypeId,
      domain: registryType.domain,
      order: registryType.type.order,
      documentType: registryType.type.documentType,
      qualifyingEntryIds: Object.freeze(qualifying
        .map((entry) => entry.id)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))),
      qualifyingCount: qualifying.length,
      edgeCaseCount,
      minimumRequired,
      minimumEdgeCaseRequired,
      missingCount,
      complete: missingCount === 0,
    });
  });

  const completeTypeCount = types.filter((type) => type.complete).length;
  const minimumRequiredEntryCount = registry.productionOrder.length * registry.coveragePolicy.minimumHeldoutPerType;
  const missingEntryCount = types.reduce((total, type) => total + type.missingCount, 0);

  return Object.freeze({
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-coverage-audit',
    planningBaseCommit: registry.decisionRecord.planningBaseCommit,
    baseline: Object.freeze({
      batchId: registry.acceptedBaseline.batchId,
      revision: registry.acceptedBaseline.revision,
      entryCount: registry.acceptedBaseline.entryCount,
      top15CoverageDisposition: registry.acceptedBaseline.top15CoverageDisposition,
    }),
    registryTypeCount: 45,
    acceptedBatchCount: acceptanceChain.length,
    acceptedEntryCount: entries.length,
    acceptanceArtifactDigests: Object.freeze(
      acceptanceChain.map(({ artifactDigestSha256 }) => artifactDigestSha256),
    ),
    acceptedRegistryRootSha256: acceptanceChain[0]?.payload.baseRegistryDigestSha256 ?? null,
    acceptedRegistryHeadSha256: acceptanceChain.at(-1)?.payload.resultingRegistryDigestSha256 ?? null,
    completeTypeCount,
    incompleteTypeCount: 45 - completeTypeCount,
    minimumRequiredEntryCount,
    missingEntryCount,
    productionOrder: Object.freeze([...registry.productionOrder]),
    types: Object.freeze(types),
  });
}

/** Hash a coverage report using repository-wide canonical JSON serialization. */
export function s33Wave2CoverageReportSha256(report: S33Wave2CoverageReport): string {
  return createHash('sha256').update(canonicaliseJson(report)).digest('hex');
}
