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
import { V6_SUBTYPE_TAXONOMY } from './golden-dataset-s33-types.js';

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const DOMAIN_IDS = ['legal', 'financial', 'education'] as const;

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
  id: z.enum(DOMAIN_IDS),
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
    planningBaseCommit: z.string().regex(GIT_SHA),
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

const acceptedCoverageEntrySchema = z.object({
  id: z.string().min(1),
  registryTypeId: z.string().min(1),
  batchId: z.string().min(1),
  credentialType: z.string().min(1),
  subType: z.string().min(1),
  authorshipMethod: z.enum(['real-source', 'independently-authored']),
  generatorDerived: z.literal(false),
  trainingExposed: z.literal(false),
  intendedSplit: z.literal('held-out'),
  productionValidSubstantiveFieldCount: z.number().int().nonnegative(),
  edgeCase: z.boolean(),
  acceptance: z.object({
    lane: z.literal('lane3'),
    artifactSha256: z.string().regex(SHA256),
    acceptedHeadCommit: z.string().regex(GIT_SHA),
  }).strict(),
}).strict();

export type S33Wave2Top15Registry = z.infer<typeof registrySchema>;
export type S33AcceptedCoverageEntry = z.infer<typeof acceptedCoverageEntrySchema>;
export type S33RegistryType = S33Wave2Top15Registry['domains'][number]['types'][number];

export interface S33TypeCoverage {
  readonly registryTypeId: string;
  readonly domain: typeof DOMAIN_IDS[number];
  readonly order: number;
  readonly documentType: string;
  readonly qualifyingEntryIds: readonly string[];
  readonly qualifyingCount: number;
  readonly edgeCaseCount: number;
  readonly minimumRequired: number;
  readonly missingCount: number;
  readonly complete: boolean;
}

export interface S33Wave2CoverageReport {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-wave2-coverage-audit';
  readonly planningBaseCommit: string;
  readonly baseline: Readonly<{
    batchId: 'S33-W1';
    revision: 12;
    entryCount: 81;
    top15CoverageDisposition: 'NOT_PROVIDED_IN_WAVE_1';
  }>;
  readonly registryTypeCount: 45;
  readonly acceptedEntryCount: number;
  readonly completeTypeCount: number;
  readonly incompleteTypeCount: number;
  readonly minimumRequiredEntryCount: number;
  readonly missingEntryCount: number;
  readonly productionOrder: readonly string[];
  readonly types: readonly S33TypeCoverage[];
}

function expectedProductionOrder(registry: S33Wave2Top15Registry): string[] {
  const domainMap = new Map(registry.domains.map((domain) => [domain.id, domain]));
  const ordered: string[] = [];

  for (const start of [1, 6, 11]) {
    for (const domainId of DOMAIN_IDS) {
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

function validateRegistrySemantics(registry: S33Wave2Top15Registry): void {
  const domainIds = registry.domains.map((domain) => domain.id);
  if (new Set(domainIds).size !== DOMAIN_IDS.length
      || DOMAIN_IDS.some((domainId) => !domainIds.includes(domainId))) {
    throw new Error('S3.3 registry must contain legal, financial, and education exactly once.');
  }

  const ids = new Set<string>();
  for (const domain of registry.domains) {
    const expectedDomainOrder = DOMAIN_IDS.indexOf(domain.id) + 1;
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
  }

  const expected = expectedProductionOrder(registry);
  if (registry.productionOrder.some((id, index) => id !== expected[index])) {
    throw new Error('S3.3 production order must be domain-interleaved in fixed 1-5, 6-10, and 11-15 tranches.');
  }
  if (new Set(registry.productionOrder).size !== 45 || registry.productionOrder.some((id) => !ids.has(id))) {
    throw new Error('S3.3 production order must name each of the 45 registry types exactly once.');
  }
}

export function parseS33Wave2Top15Registry(input: unknown): S33Wave2Top15Registry {
  const registry = registrySchema.parse(input);
  validateRegistrySemantics(registry);
  return registry;
}

export function auditS33Wave2Coverage(
  registryInput: unknown,
  acceptedEntryInputs: readonly unknown[],
): S33Wave2CoverageReport {
  const registry = parseS33Wave2Top15Registry(registryInput);
  const entries = acceptedEntryInputs.map((entry) => acceptedCoverageEntrySchema.parse(entry));
  const ids = new Set<string>();
  const typeById = new Map<string, { domain: typeof DOMAIN_IDS[number]; type: S33RegistryType }>();

  for (const domain of registry.domains) {
    for (const type of domain.types) typeById.set(type.id, { domain: domain.id, type });
  }

  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate accepted held-out entry id: ${entry.id}.`);
    ids.add(entry.id);

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
    return Object.freeze({
      registryTypeId,
      domain: registryType.domain,
      order: registryType.type.order,
      documentType: registryType.type.documentType,
      qualifyingEntryIds: Object.freeze(qualifying.map((entry) => entry.id).sort()),
      qualifyingCount: qualifying.length,
      edgeCaseCount: qualifying.filter((entry) => entry.edgeCase).length,
      minimumRequired,
      missingCount: Math.max(0, minimumRequired - qualifying.length),
      complete: qualifying.length >= minimumRequired,
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
    acceptedEntryCount: entries.length,
    completeTypeCount,
    incompleteTypeCount: 45 - completeTypeCount,
    minimumRequiredEntryCount,
    missingEntryCount,
    productionOrder: Object.freeze([...registry.productionOrder]),
    types: Object.freeze(types),
  });
}

export function s33Wave2CoverageReportSha256(report: S33Wave2CoverageReport): string {
  return createHash('sha256').update(canonicaliseJson(report)).digest('hex');
}
