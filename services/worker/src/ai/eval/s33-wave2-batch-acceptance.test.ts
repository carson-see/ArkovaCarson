import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeForFingerprint } from './golden-dataset-s33-types.js';
import {
  acceptS33Wave2BatchCandidate,
  createS33Wave2BatchAcceptanceTestHarnessV2,
  consumeMergedS33Wave2Batches,
  loadS33Wave2CandidateSnapshot,
  preflightS33Wave2BatchCandidate,
  verifyS33Wave2MergedBatch,
  type S33Wave2CandidateSnapshot,
} from './s33-wave2-batch-acceptance.js';
import {
  buildS33Wave2BaseCorpusRegistry,
  extendS33Wave2CorpusRegistry,
} from './s33-wave2-corpus-registry.js';
import {
  type S33Wave2AcceptancePayloadInput,
} from './s33-wave2-acceptance-envelope.js';
import {
  S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
  S33_DETACHED_SIGNING_TRUST_POLICY_V2,
  createS33DetachedSigningTestHarnessV2,
  emitS33DetachedSigningRequestV2,
  validateS33DetachedSigningTrustPolicySetV2,
  validateS33DetachedSigningTrustPolicyV2,
  type S33DetachedAcceptanceEnvelopeV2,
} from './s33-wave3-detached-signing-v2.js';
import { parseS33ProducerModuleWithLimit } from './s33-wave1-producer-parser.js';

const repositoryRoot = execFileSync('/usr/bin/git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const verificationHeadSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const registry = buildS33Wave2BaseCorpusRegistry({ repositoryRoot, verificationHeadSha });
const candidateHeadSha = 'a'.repeat(40);
const sourcePath = 'services/worker/src/ai/eval/golden-dataset-s33-wave2-depth-audit-heldout.ts';
const testPath = 'services/worker/src/ai/eval/golden-dataset-s33-wave2-depth-audit-heldout.test.ts';
const manifestPath = 'docs/lane4/s33-wave2-batches/depth-audit/manifest.json';
const datasheetPath = 'docs/lane4/s33-wave2-batches/depth-audit/datasheet.json';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const testKeys = generateKeyPairSync('ed25519');
const testPublicKey = testKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const testPolicy = validateS33DetachedSigningTrustPolicyV2({
  ...S33_DETACHED_SIGNING_TRUST_POLICY_V2,
  state: 'ACTIVE',
  publicKeySpkiPem: testPublicKey,
  publicKeyFingerprintSha256: createHash('sha256').update(
    createPublicKey(testPublicKey).export({ type: 'spki', format: 'der' }),
  ).digest('hex'),
  authorizedOperator: 'lane3-fixture-operator',
  fingerprintConfirmation: {
    method: 'cto-out-of-band',
    confirmedBy: 'lane3-fixture-cto',
    confirmedAtUtc: '2026-07-15T13:58:00.000Z',
  },
  activatedAtUtc: '2026-07-15T13:59:00.000Z',
});
const testSigningHarness = createS33DetachedSigningTestHarnessV2(
  validateS33DetachedSigningTrustPolicySetV2({
    ...S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2,
    activeSigningKeyId: testPolicy.signingKeyId,
    keys: [testPolicy],
  }),
);
const batchAcceptanceTestHarness = createS33Wave2BatchAcceptanceTestHarnessV2(testSigningHarness);

function coverageRegistryContent(): string {
  const domainIds = ['legal', 'financial', 'education'];
  const domains = domainIds.map((domainId, domainIndex) => ({
    id: domainId,
    order: domainIndex + 1,
    types: Array.from({ length: 15 }, (_, typeIndex) => ({
      id: `${domainId}-${String(typeIndex + 1).padStart(2, '0')}-fixture`,
      order: typeIndex + 1,
      documentType: `Fixture ${domainId} ${typeIndex + 1}`,
      mappings: [{ credentialType: 'LICENSE', subType: 'nursing_rn' }],
    })),
  }));
  const productionOrder = [1, 6, 11].flatMap((start) => domains.flatMap((domain) => (
    domain.types
      .filter((type) => type.order >= start && type.order < start + 5)
      .map((type) => type.id)
  )));
  return JSON.stringify({
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-top15-registry',
    status: 'CTO_SIGNED_SCOPE',
    decisionRecord: {},
    coveragePolicy: {
      minimumHeldoutPerType: 12,
      targetEdgeCaseRatio: 0.3,
      minimumProductionValidSubstantiveFields: 5,
      acceptedAuthorshipMethods: ['real-source', 'independently-authored'],
      generatorDerivedAllowed: false,
      trainingExposedAllowed: false,
      acceptanceLane: 'lane3',
    },
    acceptedBaseline: {},
    domains,
    productionOrder,
  });
}

function fixture(baseRegistry = registry) {
  const rows = Array.from({ length: 4 }, (_, index) => {
    const suffix = index + 1;
    const strippedText = `Quasar willow ember cobalt lantern ${suffix} verifies synthetic board record with isolated wording alpha${suffix} beta${suffix} gamma${suffix}.`;
    return {
      id: `GD-S33-W2-DEPTH-${String(suffix).padStart(3, '0')}`,
      description: `Wave-2 independently authored depth row ${suffix}`,
      strippedText,
      source: `authored/s33-wave2/depth-audit-${suffix}`,
      tags: ['held-out', 's33', 'authored'],
      provenance: 'authored-s33-lane4',
      edgeCase: index === 0,
      jurisdictionSlice: 'US',
      groundTruth: {
        credentialType: 'LICENSE', subType: 'nursing_rn', fraudSignals: [],
        issuerName: `Synthetic Board ${suffix}`, recipientIdentifier: '[NAME_REDACTED]',
        issuedDate: '2026-06-01', expiryDate: '2027-06-01',
        licenseNumber: `SYN-W2-${suffix}`, jurisdiction: 'US-MI',
      },
    };
  });
  const manifest = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-batch-manifest',
    batchId: 'S33-W2-DEPTH-AUDIT',
    revision: 1,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE',
    intendedSplit: 'held-out-candidate',
    acceptanceScope: 'whole-batch-only',
    baseRegistryDigestSha256: baseRegistry.registryDigestSha256,
    source: { path: sourcePath, exportName: 'S33_WAVE2_DEPTH_AUDIT_HELDOUT', blobSha: 'b'.repeat(40) },
    datasheet: { path: datasheetPath, blobSha: 'c'.repeat(40) },
    testPath,
    entryCount: rows.length,
    entries: rows.map((row) => ({
      id: row.id, domain: 'professional-licensing', registryTypeId: 'legal-01-fixture', credentialType: 'LICENSE',
      normalizedInputSha256: sha256(normalizeForFingerprint(row.strippedText)),
    })),
  };
  const datasheet = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-batch-datasheet',
    batchId: manifest.batchId,
    revision: 1,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE',
    containsProductionUserDocuments: false,
    authorshipNote: 'Every row was independently curated without generators or templates.',
    entryCount: rows.length,
    rows: rows.map((row, index) => ({
      id: row.id, domain: 'professional-licensing', credentialType: 'LICENSE', subType: 'nursing_rn',
      jurisdiction: 'US', edgeCase: row.edgeCase, edgeClass: index === 0 ? 'date-trap' : null,
      authorshipMethod: 'independently-authored',
      realOrSynthetic: 'synthetic-realistic', independentlyCurated: true,
      generatorDerived: false, trainingExposed: false,
      generatorName: null, generatorVersion: null, seed: null, templateId: null,
      sourceGrounding: 'Synthetic Michigan nursing-board record authored from public schema facts.',
      curationAuthor: 'Arkova Lane 4', curationDate: '2026-07-15',
      licenseConsentNote: 'Arkova-authored synthetic text; no third-party document or personal data was used.',
    })),
  };
  const snapshot: S33Wave2CandidateSnapshot = {
    candidateBaseSha: baseRegistry.verificationHeadSha,
    candidateHeadSha,
    candidateTreeSha: 'd'.repeat(40),
    changedPaths: [manifestPath, datasheetPath, sourcePath, testPath].map((path) => ({
      status: 'A', path, mode: '100644', objectType: 'blob',
      blobSha: path === sourcePath ? 'b'.repeat(40) : path === datasheetPath ? 'c'.repeat(40) : 'f'.repeat(40),
    })),
    manifestPath,
    manifestContent: JSON.stringify(manifest),
    sourceContent: 'export const inertCandidate = true;',
    datasheetContent: JSON.stringify(datasheet),
    testContent: 'export {};',
    coverageRegistryContent: coverageRegistryContent(),
    parsedEntries: rows,
    leakageCorpus: [
      { path: 'training-data/a.jsonl', content: 'tundra' },
      { path: 'src/ai/a.ts', content: 'monsoon' },
      { path: 'scripts/a.ts', content: 'solstice' },
    ],
    leakageCorpusRootCounts: { 'training-data': 1, 'src/ai': 1, scripts: 1 },
  };
  return { rows, manifest, datasheet, snapshot };
}

function loadSnapshotFixture(): Readonly<{
  snapshot: S33Wave2CandidateSnapshot;
  baseRegistry: ReturnType<typeof buildS33Wave2BaseCorpusRegistry>;
  defaultRawDiff: string;
  cleanup: () => void;
}> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 's33-w2-loader-'));
  const trustedMainRoot = join(fixtureRoot, 'trusted-main');
  const candidateRoot = join(fixtureRoot, 'candidate');
  execFileSync('/usr/bin/git', ['clone', '--quiet', repositoryRoot, trustedMainRoot]);
  gitRun(trustedMainRoot, ['config', 'user.email', 'lane3-test@arkova.test']);
  gitRun(trustedMainRoot, ['config', 'user.name', 'Lane 3 Test']);
  const coveragePath = join(trustedMainRoot, 'docs/lane4/s33-wave2-top15-registry.json');
  mkdirSync(dirname(coveragePath), { recursive: true });
  writeFileSync(coveragePath, `${coverageRegistryContent()}\n`);
  gitRun(trustedMainRoot, ['add', 'docs/lane4/s33-wave2-top15-registry.json']);
  gitRun(trustedMainRoot, ['commit', '-m', 'add coverage registry']);
  const trustedMainHead = gitRun(trustedMainRoot, ['rev-parse', 'HEAD']);
  const baseRegistry = buildS33Wave2BaseCorpusRegistry({
    repositoryRoot: trustedMainRoot,
    verificationHeadSha: trustedMainHead,
  });
  gitRun(trustedMainRoot, ['worktree', 'add', '-b', 'candidate', candidateRoot, trustedMainHead]);
  gitRun(candidateRoot, ['config', 'user.email', 'lane4-test@arkova.test']);
  gitRun(candidateRoot, ['config', 'user.name', 'Lane 4 Test']);

  const value = fixture(baseRegistry);
  const sourceContent = `export const S33_WAVE2_DEPTH_AUDIT_HELDOUT = ${JSON.stringify(value.rows, null, 2)} as const;\n`;
  for (const [path, content] of [
    [sourcePath, sourceContent],
    [datasheetPath, `${JSON.stringify(value.datasheet)}\n`],
    [testPath, 'export {};\n'],
  ] as const) {
    const absolutePath = join(candidateRoot, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  const manifest = {
    ...value.manifest,
    source: {
      ...value.manifest.source,
      blobSha: gitRun(candidateRoot, ['hash-object', sourcePath]),
    },
    datasheet: {
      ...value.manifest.datasheet,
      blobSha: gitRun(candidateRoot, ['hash-object', datasheetPath]),
    },
  };
  const manifestAbsolutePath = join(candidateRoot, manifestPath);
  mkdirSync(dirname(manifestAbsolutePath), { recursive: true });
  writeFileSync(manifestAbsolutePath, `${JSON.stringify(manifest)}\n`);
  gitRun(candidateRoot, ['add', manifestPath, datasheetPath, sourcePath, testPath]);
  gitRun(candidateRoot, ['commit', '-m', 'add candidate packet']);
  const candidateHead = gitRun(candidateRoot, ['rev-parse', 'HEAD']);
  const defaultRawDiff = gitRun(candidateRoot, [
    'diff', '--raw', '--no-renames', trustedMainHead, candidateHead,
  ]);
  const snapshot = loadS33Wave2CandidateSnapshot({
    trustedMainWorkerRoot: join(trustedMainRoot, 'services/worker'),
    candidateRepositoryRoot: candidateRoot,
    candidateBaseSha: trustedMainHead,
    candidateHeadSha: candidateHead,
    registry: baseRegistry,
  });
  return {
    snapshot,
    baseRegistry,
    defaultRawDiff,
    cleanup: () => {
      gitRun(trustedMainRoot, ['worktree', 'remove', '--force', candidateRoot]);
      rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
}

function authenticatedAcceptance(
  value: ReturnType<typeof fixture>,
  mutate?: (input: S33Wave2AcceptancePayloadInput) => void,
): S33DetachedAcceptanceEnvelopeV2 {
  const preflight = preflightS33Wave2BatchCandidate(registry, value.snapshot);
  const resultingRegistry = extendS33Wave2CorpusRegistry(registry, preflight.batch, preflight.registryEntries);
  const input: S33Wave2AcceptancePayloadInput = {
    repositoryIdentity: 'carson-see/ArkovaCarson',
    pullRequestNumber: 1600,
    candidateBaseSha: value.snapshot.candidateBaseSha,
    candidateHeadSha: value.snapshot.candidateHeadSha,
    candidateTreeSha: value.snapshot.candidateTreeSha,
    batchId: preflight.manifest.batchId,
    revision: preflight.manifest.revision,
    manifestPath: preflight.manifestPath,
    manifestRawSha256: preflight.manifest.rawSha256,
    manifestCanonicalSha256: preflight.manifest.canonicalSha256,
    sourceBlobSha: preflight.manifest.source.blobSha,
    datasheetBlobSha: preflight.manifest.datasheet.blobSha,
    preflightArtifactDigestSha256: preflight.artifactDigestSha256,
    baseRegistryDigestSha256: registry.registryDigestSha256,
    resultingRegistryDigestSha256: resultingRegistry.registryDigestSha256,
    coverageRegistryPath: preflight.coverageRegistry.path,
    coverageRegistryRawSha256: preflight.coverageRegistry.rawSha256,
    coverageRegistryCanonicalSha256: preflight.coverageRegistry.canonicalSha256,
    signedAtUtc: '2026-07-15T14:00:00.000Z',
    reviewer: {
      lane: 'Lane 3',
      transport: 'github-issue-comment',
      evidence: {
        id: 1,
        nodeId: 'IC_fixture',
        url: 'https://github.com/carson-see/ArkovaCarson/pull/1600#issuecomment-1',
        submittedAtUtc: '2026-07-15T13:59:00.000Z',
        actor: { login: 'carson-see', databaseId: 1, nodeId: 'U_fixture' },
      },
    },
    proof: {
      machineValidationArtifactSha256: '1'.repeat(64),
      machineValidationFailureCount: 0,
      humanCrossReviewArtifactSha256: '2'.repeat(64),
      humanCrossReviewSampleSize: value.rows.length,
      materialLabelDefectCount: 0,
      prodModelDiffArtifactSha256: '3'.repeat(64),
      exactLeakageArtifactSha256: '4'.repeat(64),
      exactLeakageHitCount: 0,
    },
    acceptedEntries: [...preflight.acceptanceEntries],
  };
  mutate?.(input);
  const request = emitS33DetachedSigningRequestV2(input);
  const signature = sign(
    null,
    Buffer.from(request.signingBytesBase64Url, 'base64url'),
    testKeys.privateKey,
  ).toString('base64url');
  return testSigningHarness.assemble(request, signature, {
    verifiedAtUtc: '2026-07-15T14:01:00.000Z',
  });
}

function gitRun(root: string, args: readonly string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function mergedPacketFixture() {
  const root = mkdtempSync(join(tmpdir(), 's33-w2-merged-'));
  gitRun(root, ['init', '-b', 'main']);
  gitRun(root, ['config', 'user.email', 'lane3-test@arkova.test']);
  gitRun(root, ['config', 'user.name', 'Lane 3 Test']);
  writeFileSync(join(root, 'README.md'), 'base\n');
  gitRun(root, ['add', 'README.md']);
  gitRun(root, ['commit', '-m', 'base']);
  const baseSha = gitRun(root, ['rev-parse', 'HEAD']);
  gitRun(root, ['checkout', '-b', 'candidate']);
  for (const path of [manifestPath, datasheetPath, sourcePath, testPath]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${path}\n`);
  }
  gitRun(root, ['add', manifestPath, datasheetPath, sourcePath, testPath]);
  gitRun(root, ['commit', '-m', 'candidate']);
  const candidateHead = gitRun(root, ['rev-parse', 'HEAD']);
  const candidateTree = gitRun(root, ['rev-parse', 'HEAD^{tree}']);
  const changedPaths = [manifestPath, datasheetPath, sourcePath, testPath].map((path) => ({
    status: 'A',
    path,
    mode: '100644',
    objectType: 'blob',
    blobSha: gitRun(root, ['rev-parse', `${candidateHead}:${path}`]),
  }));
  gitRun(root, ['checkout', 'main']);
  gitRun(root, ['merge', '--no-ff', 'candidate', '-m', 'merge candidate']);
  const mergedHead = gitRun(root, ['rev-parse', 'HEAD']);
  const fixtureValue = fixture();
  const snapshot: S33Wave2CandidateSnapshot = {
    ...fixtureValue.snapshot,
    candidateBaseSha: baseSha,
    candidateHeadSha: candidateHead,
    candidateTreeSha: candidateTree,
    changedPaths,
  };
  const acceptance = authenticatedAcceptance(fixtureValue, (input) => {
    input.candidateHeadSha = candidateHead;
    input.candidateTreeSha = candidateTree;
  });
  return { root, mergedHead, snapshot, acceptance };
}

describe('S3.3 Wave-2 whole-batch acceptance', () => {
  it('consumes merged Wave-2 batches without mutating the immutable base registry', () => {
    const baseDigest = registry.registryDigestSha256;
    const baseEntryCount = registry.entries.length;
    const consumed = consumeMergedS33Wave2Batches({
      trustedMainRepositoryRoot: repositoryRoot,
      registry,
    });
    expect(registry.registryDigestSha256).toBe(baseDigest);
    expect(registry.entries).toHaveLength(baseEntryCount);
    expect(consumed.entries.length).toBeGreaterThanOrEqual(baseEntryCount);
    if (consumed.entries.length === baseEntryCount) expect(consumed).toBe(registry);
    else expect(consumed).not.toBe(registry);
  }, 30_000);

  it('accepts one complete, non-leaking, independently curated batch', () => {
    const value = fixture();
    const artifact = authenticatedAcceptance(value);
    const accepted = batchAcceptanceTestHarness.accept({
      registry,
      snapshot: value.snapshot,
      pullRequestNumber: 1600,
      verifiedAtUtc: '2026-07-15T14:01:00.000Z',
      authenticatedAcceptance: artifact,
    });
    expect(accepted.request.payload.verdict).toBe('APPROVED_WHOLE_BATCH');
    expect(accepted.request.payload.acceptedEntryCount).toBe(4);
  });

  it('keeps the production acceptor fail-closed while the v2 policy is unconfigured', () => {
    const value = fixture();
    expect(() => acceptS33Wave2BatchCandidate({
      registry,
      snapshot: value.snapshot,
      pullRequestNumber: 1600,
      verifiedAtUtc: '2026-07-15T14:01:00.000Z',
      authenticatedAcceptance: authenticatedAcceptance(value),
    })).toThrow(/UNCONFIGURED|no configured ACTIVE key/iu);
  });

  it('loads default-abbreviated Git raw diffs as full object ids and preflights the real registry shape', () => {
    const loaded = loadSnapshotFixture();
    try {
      const defaultObjectIds = Array.from(
        loaded.defaultRawDiff.matchAll(/^:\d{6} \d{6} [0-9a-f]+ ([0-9a-f]+) A\t/gmu),
        (match) => match[1],
      );
      expect(defaultObjectIds).toHaveLength(4);
      expect(defaultObjectIds.every((objectId) => objectId.length < 40)).toBe(true);
      expect(loaded.snapshot.changedPaths).toHaveLength(4);
      expect(loaded.snapshot.changedPaths.every(({ blobSha }) => /^[0-9a-f]{40}$/u.test(blobSha))).toBe(true);
      expect(() => preflightS33Wave2BatchCandidate(loaded.baseRegistry, loaded.snapshot)).not.toThrow();
    } finally {
      loaded.cleanup();
    }
  }, 30_000);

  it('rejects a duplicate or non-tranche-interleaved production order', () => {
    const value = fixture();
    const outOfOrder = JSON.parse(coverageRegistryContent()) as { productionOrder: string[] };
    [outOfOrder.productionOrder[0], outOfOrder.productionOrder[1]] = [
      outOfOrder.productionOrder[1]!,
      outOfOrder.productionOrder[0]!,
    ];
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...value.snapshot,
      coverageRegistryContent: JSON.stringify(outOfOrder),
    })).toThrow(/domain-interleaved.*tranches/iu);

    const duplicated = JSON.parse(coverageRegistryContent()) as { productionOrder: string[] };
    duplicated.productionOrder[1] = duplicated.productionOrder[0]!;
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...value.snapshot,
      coverageRegistryContent: JSON.stringify(duplicated),
    })).toThrow(/45 registry types exactly once/iu);
  });

  it('admits the exact real-source authorship alternative without treating GitHub login as authority', () => {
    const value = fixture();
    const realSourceDatasheet = {
      ...value.datasheet,
      authorshipNote: 'Every row is grounded in a lawful real source and contains no production user document.',
      rows: value.datasheet.rows.map((row) => ({
        ...row,
        authorshipMethod: 'real-source',
        realOrSynthetic: 'real',
        independentlyCurated: false,
      })),
    };
    const preflight = preflightS33Wave2BatchCandidate(registry, {
      ...value.snapshot,
      datasheetContent: JSON.stringify(realSourceDatasheet),
    });
    expect(preflight.acceptanceEntries.every(({ authorshipMethod }) => authorshipMethod === 'real-source')).toBe(true);
  });

  it('rejects a cryptographically valid acceptance for a stale candidate head', () => {
    const value = fixture();
    const artifact = authenticatedAcceptance(value, (input) => {
      input.candidateHeadSha = 'e'.repeat(40);
    });
    expect(() => batchAcceptanceTestHarness.accept({
      registry,
      snapshot: value.snapshot,
      pullRequestNumber: 1600,
      verifiedAtUtc: '2026-07-15T14:01:00.000Z',
      authenticatedAcceptance: artifact,
    })).toThrow(/binding.*candidateHeadSha/iu);
  });

  it('rejects partial acceptance', () => {
    const value = fixture();
    const artifact = authenticatedAcceptance(value, (input) => {
      input.acceptedEntries = input.acceptedEntries.slice(0, 3);
      input.proof.humanCrossReviewSampleSize = 3;
    });
    expect(() => batchAcceptanceTestHarness.accept({
      registry,
      snapshot: value.snapshot,
      pullRequestNumber: 1600,
      verifiedAtUtc: '2026-07-15T14:01:00.000Z',
      authenticatedAcceptance: artifact,
    })).toThrow(/order|per-entry|binding/iu);
  });

  it('rejects a stale candidate base and a partial exact n=6 corpus overlap', () => {
    const stale = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...stale.snapshot, candidateBaseSha: '9'.repeat(40),
    })).toThrow(/base is stale/iu);

    const lexical = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...lexical.snapshot,
      leakageCorpus: [
        ...lexical.snapshot.leakageCorpus,
        { path: 'src/ai/prompt.ts', content: 'prefix quasar willow ember cobalt lantern 1 suffix' },
      ],
      leakageCorpusRootCounts: { ...lexical.snapshot.leakageCorpusRootCounts, 'src/ai': 2 },
    })).toThrow(/exact lexical leakage at n=6/iu);
  });

  it.each([
    '[SEC_RECIPIENT]',
    '[PUBLIC_APPLICABILITY]',
    '[PUBLIC_FILING]',
  ])('admits the exact CTO-approved non-PII semantic placeholder %s', (recipientIdentifier) => {
    const value = fixture();
    const parsedEntries = value.rows.map((row, index) => index === 0 ? {
      ...row,
      groundTruth: { ...row.groundTruth, recipientIdentifier },
    } : row);
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...value.snapshot,
      parsedEntries,
    })).not.toThrow();
  });

  it.each([
    '[ARBITRARY]',
    '[SEC_RECIPIENT_EXTRA]',
    '[PUBLIC_APPLICATION]',
    '[public_filing]',
  ])('rejects every non-allowlisted arbitrary bracketed recipientIdentifier %s', (recipientIdentifier) => {
    const value = fixture();
    const parsedEntries = value.rows.map((row, index) => index === 0 ? {
      ...row,
      groundTruth: { ...row.groundTruth, recipientIdentifier },
    } : row);
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...value.snapshot,
      parsedEntries,
    })).toThrow(/unredacted recipientIdentifier/iu);
  });

  it('rejects unauthorized paths, empty roots, leakage, PII, shallow truth, and duplicate ids', () => {
    const unauthorized = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...unauthorized.snapshot,
      changedPaths: [...unauthorized.snapshot.changedPaths, {
        status: 'A', path: 'src/runtime.ts', mode: '100644', objectType: 'blob', blobSha: 'e'.repeat(40),
      }],
    })).toThrow(/unauthorized paths/iu);

    const emptyRoot = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...emptyRoot.snapshot, leakageCorpusRootCounts: { ...emptyRoot.snapshot.leakageCorpusRootCounts, scripts: 0 },
    })).toThrow(/root is empty/iu);

    const leaking = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...leaking.snapshot,
      leakageCorpus: [
        ...leaking.snapshot.leakageCorpus,
        { path: 'src/ai/prompt.ts', content: leaking.rows[0].strippedText },
      ],
      leakageCorpusRootCounts: { ...leaking.snapshot.leakageCorpusRootCounts, 'src/ai': 2 },
    })).toThrow(/leakage/iu);

    const pii = fixture();
    const piiEntries = pii.rows.map((row, index) => index === 0 ? { ...row, strippedText: `${row.strippedText} jane@example.com` } : row);
    const piiManifest = {
      ...pii.manifest,
      entries: pii.manifest.entries.map((entry, index) => index === 0
        ? { ...entry, normalizedInputSha256: sha256(normalizeForFingerprint(piiEntries[0].strippedText)) }
        : entry),
    };
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...pii.snapshot,
      manifestContent: JSON.stringify(piiManifest),
      parsedEntries: piiEntries,
    })).toThrow(/PII/iu);

    const shallow = fixture();
    const shallowEntries = shallow.rows.map((row, index) => index === 0
      ? { ...row, groundTruth: { credentialType: 'LICENSE', subType: 'nursing_rn', fraudSignals: [] } }
      : row);
    expect(() => preflightS33Wave2BatchCandidate(registry, { ...shallow.snapshot, parsedEntries: shallowEntries })).toThrow(/depth/iu);

    const duplicate = fixture();
    const duplicateEntries = duplicate.rows.map((row, index) => index === 0 ? { ...row, id: registry.entries[0].id } : row);
    expect(() => preflightS33Wave2BatchCandidate(registry, { ...duplicate.snapshot, parsedEntries: duplicateEntries })).toThrow(/bijection|duplicate/iu);

    const missingProvenance = fixture();
    const unprovenancedEntries = missingProvenance.rows.map((row, index) => index === 0
      ? { ...row, provenance: 'unknown' }
      : row);
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...missingProvenance.snapshot, parsedEntries: unprovenancedEntries,
    })).toThrow(/provenance/iu);
  });

  it('parses candidate arrays without executing candidate statements and enforces explicit limits', () => {
    const source = `
      throw new Error('candidate code executed');
      export const S33_WAVE2_TEST_HELDOUT = [{ id: 'one' }, { id: 'two' }] as const;
    `;
    expect(parseS33ProducerModuleWithLimit(source, 'candidate.ts', 'S33_WAVE2_TEST_HELDOUT', 2)).toHaveLength(2);
    expect(() => parseS33ProducerModuleWithLimit(source, 'candidate.ts', 'S33_WAVE2_TEST_HELDOUT', 1)).toThrow(/maximum 1-row/iu);
  });

  it('consumes only a merged tree carrying the byte-identical authenticated packet', () => {
    const value = mergedPacketFixture();
    const result = verifyS33Wave2MergedBatch({
      mergedMainRepositoryRoot: value.root,
      mergedMainHeadSha: value.mergedHead,
      snapshot: value.snapshot,
      acceptance: value.acceptance,
    });
    expect(result.packetBlobs).toHaveLength(4);
    expect(result.candidateHeadSha).toBe(value.snapshot.candidateHeadSha);

    writeFileSync(join(value.root, sourcePath), 'post-merge tamper\n');
    gitRun(value.root, ['add', sourcePath]);
    gitRun(value.root, ['commit', '-m', 'tamper packet']);
    expect(() => verifyS33Wave2MergedBatch({
      mergedMainRepositoryRoot: value.root,
      mergedMainHeadSha: gitRun(value.root, ['rev-parse', 'HEAD']),
      snapshot: value.snapshot,
      acceptance: value.acceptance,
    })).toThrow(/blob differs/i);
  });
});
