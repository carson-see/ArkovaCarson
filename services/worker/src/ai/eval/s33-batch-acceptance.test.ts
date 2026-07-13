import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import * as acceptanceModule from './s33-batch-acceptance.js';
import * as ledgerModule from './s33-acceptance-ledger.js';
// @ts-expect-error — the audit transcript state machine must remain module-private.
type _ForbiddenDirectLedgerImport = import('./s33-acceptance-ledger.js').DurableAcceptanceLedger;
import {
  canonicalManifestHash,
  compareEmbeddingLeakage,
  createProductionS33AcceptanceOrchestrator,
  createTestOnlyS33AcceptanceOrchestrator,
  parseBatchManifest,
  rawManifestHash,
  scanEmbeddingLeakage,
  type EmbeddingBatchProvider,
  type ConsumptionRegistryRecord,
  type LexicalLeakagePolicyPayload,
  type ManifestFreezePayload,
  type SaltCommitmentPayload,
  type SaltRevealRecord,
  type SelectionPolicyPayload,
  type SignedPolicyArtifact,
  type SamplingTrustRoot,
  type S33AcceptanceOrchestrator,
} from './s33-batch-acceptance.js';

// @ts-expect-error — callers cannot advance chronology with an arbitrary event.
type _ForbiddenOrchestratorAppend = S33AcceptanceOrchestrator['append'];

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

interface ProductionManifestFixtureEntry {
  id: string;
  domain: 'au-ke-priority-documents' | 'professional-licensing' | 'out-of-distribution';
  credentialType: 'LICENSE' | 'DEGREE' | 'CERTIFICATE' | 'OTHER';
  normalizedInputSha256: string;
}

const CORPUS_SLICE_BY_DOMAIN = {
  'au-ke-priority-documents': 's33-au-ke-heldout',
  'professional-licensing': 's33-licensing-heldout',
  'out-of-distribution': 's33-ood-negative',
} as const;

function countByFixtureField(
  entries: readonly ProductionManifestFixtureEntry[],
  field: 'domain' | 'credentialType',
): Record<string, number> {
  return entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry[field]] = (counts[entry[field]] ?? 0) + 1;
    return counts;
  }, {});
}

function productionManifestFixture(entryCount: number): Record<string, unknown> {
  const kenyaCount = Math.min(11, Math.max(1, Math.floor(entryCount * 11 / 81)));
  const oodCount = Math.min(entryCount - kenyaCount - 1, Math.max(1, Math.floor(entryCount * 9 / 81)));
  const auCount = Math.min(
    entryCount - kenyaCount - oodCount - 1,
    Math.max(1, Math.floor(entryCount * 11 / 81)),
  );
  const licensingCount = entryCount - kenyaCount - auCount - oodCount;
  const entries: ProductionManifestFixtureEntry[] = [
    ...Array.from({ length: kenyaCount }, (_, index) => ({
      id: `GD-S33-KE-${String(index + 1).padStart(3, '0')}`,
      domain: 'au-ke-priority-documents' as const,
      credentialType: 'LICENSE' as const,
      normalizedInputSha256: sha256(`kenya-${index + 1}`),
    })),
    ...Array.from({ length: auCount }, (_, index) => ({
      id: `GD-S33-AU-${String(index + 1).padStart(3, '0')}`,
      domain: 'au-ke-priority-documents' as const,
      credentialType: 'DEGREE' as const,
      normalizedInputSha256: sha256(`australia-${index + 1}`),
    })),
    ...Array.from({ length: licensingCount }, (_, index) => ({
      id: `GD-S33-NUR-${String(index + 1).padStart(3, '0')}`,
      domain: 'professional-licensing' as const,
      credentialType: 'CERTIFICATE' as const,
      normalizedInputSha256: sha256(`licensing-${index + 1}`),
    })),
    ...Array.from({ length: oodCount }, (_, index) => ({
      id: `GD-S33-OOD-${String(index + 1).padStart(3, '0')}`,
      domain: 'out-of-distribution' as const,
      credentialType: 'OTHER' as const,
      normalizedInputSha256: sha256(`ood-${index + 1}`),
    })),
  ];
  const kenyaEntryIds = entries.filter(({ id }) => id.startsWith('GD-S33-KE-')).map(({ id }) => id);
  const oodEntryIds = entries.filter(({ domain }) => domain === 'out-of-distribution').map(({ id }) => id);
  const byCorpusSlice = entries.reduce<Record<string, number>>((counts, entry) => {
    const slice = CORPUS_SLICE_BY_DOMAIN[entry.domain];
    counts[slice] = (counts[slice] ?? 0) + 1;
    return counts;
  }, {});
  const currentChangedId = entries.find(({ domain }) => domain !== 'out-of-distribution')?.id ?? entries[0].id;
  const verifiedUnchangedId = entries.find(({ id }) => id !== currentChangedId)?.id ?? currentChangedId;
  const supportCommit = 'd'.repeat(40);
  const sourceCommit = '5'.repeat(40);
  return {
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision: 9,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_RESUBMISSION_BLOCKED_L3_REVIEW',
    corpusRevisionParentCommit: sourceCommit,
    producerRevisionPredecessorCommit: sourceCommit,
    lane3SupportBase: {
      commit: supportCommit,
      typesPath: 'services/worker/src/ai/eval/golden-dataset-s33-types.ts',
      typesBlob: 'c'.repeat(40),
      reviewState: 'PENDING_LANE3_REVIEW_PR',
    },
    corpusSourceBlobs: {
      'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts': '1'.repeat(40),
      'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts': '2'.repeat(40),
      'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts': '3'.repeat(40),
    },
    intendedSplit: 'held-out-candidate',
    reviewOrder: 'kenya-first',
    acceptanceScope: 'whole-batch-only',
    entryCount,
    counts: {
      byDomain: countByFixtureField(entries, 'domain'),
      byCredentialType: countByFixtureField(entries, 'credentialType'),
      byCorpusSlice,
    },
    kenyaEntryIds,
    selfChecks: {
      exactCorpusManifestDatasheetBijection: { status: 'PASS', entryCount },
      normalizedInputFingerprintsPinned: {
        status: 'PASS',
        algorithm: 'sha256(normalizeForFingerprint(strippedText))',
      },
      authorizedDocumentRevisions: {
        status: 'PASS',
        revisions: [{
          revision: 9,
          authority: 'RTE production-schema fixture',
          changedEntryIds: [currentChangedId],
          verifiedUnchangedEntryIds: [verifiedUnchangedId],
          changes: ['Fixture preserves the production revision-nine contract shape'],
          corpusSourceTextChanged: false,
          normalizedInputChanged: false,
          normalizedInputPinsPreservedFromRevision8: true,
          remainingSubstantiveGroundTruthFields: {
            [currentChangedId]: 5,
            nonOodMinimum: 5,
            oodPureAbstention: 2,
          },
          producerRevisionPredecessorCommit: sourceCommit,
          lane3SupportBaseCommit: supportCommit,
        }],
      },
      withinTypeTokenOverlap: {
        status: 'PASS',
        threshold: 0.8,
        metric: 'multiset overlap coefficient (shared token occurrences / shorter input token count)',
        violations: [],
        remediatedPairScores: [],
      },
      oodFiveFieldSemantics: {
        status: 'BLOCKED_PROTOCOL_CONTRADICTION_CTO_L3',
        entryIds: oodEntryIds,
        producerTruth: 'Pure abstention labels contain only the protocol-declared fields.',
        contradiction: 'The producer must not invent extraction labels to pad abstention truth.',
        resolutionOwner: 'Lane 3 / CTO',
      },
      cpeSubtypeRatification: { status: 'BLOCKED_CTO_L3' },
      taxonomyAdjudicationSet: { status: 'BLOCKED_CTO_L3', entryIds: kenyaEntryIds.slice(0, 1) },
      issuedDateAdjudicationSet: {
        status: 'BLOCKED_CTO_L3',
        entryIds: [currentChangedId],
        resolvedEntryIdsInRevision9: [verifiedUnchangedId],
      },
      batchScopeOnly: {
        status: 'PASS',
        excludedFromBatch: ['services/worker/src/ai/eval/golden-dataset-s33-types.ts'],
        protocolAllowedDiffPaths: [
          'docs/lane4/s33-wave1-batch-manifest.json',
          'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
          'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
          'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
        ],
        dependency: {
          owner: 'Lane 3',
          branch: 'codex/s33-l3-acceptance-tooling',
          commit: supportCommit,
          typesPath: 'services/worker/src/ai/eval/golden-dataset-s33-types.ts',
          typesBlob: 'c'.repeat(40),
          presentIdenticallyInBase: true,
          includedInProducerDiff: false,
          reviewState: 'PENDING_LANE3_REVIEW_PR',
        },
        reason: 'The producer diff is limited to the protocol-owned corpus packet.',
        authority: 'Batch protocol section 1',
      },
      lane3Acceptance: { status: 'NOT_RUN_PRODUCER_BOUNDARY' },
    },
    entries,
  };
}

function manifestContent(entryCount: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...productionManifestFixture(entryCount), ...overrides }, null, 2);
}

function testKey(): {
  privateKey: KeyObject;
  trustRoot: SamplingTrustRoot;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeyDer = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    trustRoot: {
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      publicKeyPem,
      publicKeyFingerprintSha256: sha256(publicKeyDer),
    },
  };
}

interface SignedArtifactFixture<P extends object> {
  object: SignedPolicyArtifact<P>;
  content: string;
}

function signedArtifact<P extends object>(
  payload: P,
  privateKey: KeyObject,
): SignedArtifactFixture<P> {
  const payloadDigestSha256 = sha256(canonicaliseJson(payload));
  const signature = {
    algorithm: 'Ed25519' as const,
    value: sign(
      null,
      Buffer.from(canonicaliseJson({ payload, payloadDigestSha256 }), 'utf8'),
      privateKey,
    ).toString('base64url'),
  };
  const object = {
    payload,
    payloadDigestSha256,
    signature,
    artifactDigestSha256: sha256(canonicaliseJson({ payload, payloadDigestSha256, signature })),
  };
  return { object, content: JSON.stringify(object, null, 2) };
}

class TestConsumptionRegistry {
  readonly keys = new Set<string>();

  async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
    if (this.keys.has(record.uniqueKey)) return false;
    this.keys.add(record.uniqueKey);
    return true;
  }
}

function gitRepo(manifest: string): {
  root: string;
  manifestPath: string;
  freezeCommitSha: string;
  verificationCommitSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'arkova-s33-git-'));
  tempRoots.push(root);
  const manifestPath = 'docs/lane4/s33-wave1-batch-manifest.json';
  mkdirSync(join(root, 'docs/lane4'), { recursive: true });
  writeFileSync(join(root, manifestPath), manifest, 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lane3-test@arkova.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lane3 Test'], { cwd: root });
  execFileSync('git', ['add', manifestPath], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'freeze manifest'], { cwd: root });
  const freezeCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'verification.txt'), 'verification descendant\n', 'utf8');
  execFileSync('git', ['add', 'verification.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'verification descendant'], { cwd: root });
  const verificationCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, manifestPath, freezeCommitSha, verificationCommitSha };
}

function ceremony(entryCount = 81) {
  const manifest = manifestContent(entryCount);
  const repo = gitRepo(manifest);
  const { privateKey, trustRoot } = testKey();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'arkova-s33-ledger-'));
  tempRoots.push(evidenceRoot);
  const consumptionRegistry = new TestConsumptionRegistry();
  const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
    trustRoot,
    consumptionRegistry,
    ledgerPath: join(evidenceRoot, 'acceptance-ledger.jsonl'),
    repositoryRoot: repo.root,
    repositoryIdentity: 'test/ArkovaCarson',
    verificationCommitSha: repo.verificationCommitSha,
  });
  const salt = '11'.repeat(32);
  const commitment = signedArtifact<SaltCommitmentPayload>({
    artifactType: 'arkova-s33-salt-commitment',
    artifactVersion: '1.0.0',
    commitmentId: 'S33-W1-commitment-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:00:00.000Z',
    saltCommitment: { algorithm: 'sha256', value: sha256(salt) },
  }, privateKey);
  const freeze = signedArtifact<ManifestFreezePayload>({
    artifactType: 'arkova-s33-manifest-freeze',
    artifactVersion: '1.0.0',
    freezeId: 'S33-W1-r9-freeze-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:01:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    batchId: 'S33-W1',
    revision: 9,
    manifestRawSha256: rawManifestHash(manifest),
    manifestCanonicalSha256: canonicalManifestHash(manifest),
    gitEvidence: {
      repositoryIdentity: 'test/ArkovaCarson',
      freezeCommitSha: repo.freezeCommitSha,
      manifestPath: repo.manifestPath,
    },
  }, privateKey);
  const policy = signedArtifact<SelectionPolicyPayload>({
    artifactType: 'arkova-s33-selection-policy',
    artifactVersion: '1.0.0',
    policyId: 'S33-W1-r9-selection-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:02:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    freezeArtifactCanonicalSha256: canonicalManifestHash(freeze.content),
    batchId: 'S33-W1',
    revision: 9,
    prng: 'xorshift32-v1',
    sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count',
  }, privateKey);
  const reveal: SaltRevealRecord = {
    schemaVersion: 1,
    revealId: 'S33-W1-r9-reveal-1',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    freezeArtifactCanonicalSha256: canonicalManifestHash(freeze.content),
    policyArtifactCanonicalSha256: canonicalManifestHash(policy.content),
    salt,
    revealedAtUtc: '2026-07-13T13:03:00.000Z',
  };
  const revealContent = JSON.stringify(reveal, null, 2);
  return {
    orchestrator,
    manifest,
    repo,
    privateKey,
    trustRoot,
    consumptionRegistry,
    commitment,
    freeze,
    policy,
    reveal,
    revealContent,
    evidenceRoot,
  };
}

function recordThroughReveal(context: ReturnType<typeof ceremony>): void {
  context.orchestrator.recordSaltCommitment(context.commitment.content);
  context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
  context.orchestrator.recordSelectionPolicy(context.policy.content);
  context.orchestrator.recordSaltReveal(context.revealContent);
}

describe('S3.3 authenticated, durable sampling ceremony', () => {
  it('does not expose a ledger or arbitrary event append capability', () => {
    const context = ceremony(6);
    expect(ledgerModule).not.toHaveProperty('DurableAcceptanceLedger');
    expect(context.orchestrator).not.toHaveProperty('append');
    expect(context.orchestrator).not.toHaveProperty('transcript');
    expect(() => (context.orchestrator as unknown as { append(): void }).append()).toThrow(/not a function/i);
  });

  it('uses the injected monotonic registry as the one-time consumption authority', async () => {
    const context = ceremony(6);
    const createIfAbsent = vi.fn(async (record: Readonly<ConsumptionRegistryRecord>) => {
      expect(Object.isFrozen(record)).toBe(true);
      return true;
    });
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      ledgerPath: join(context.evidenceRoot, 'registry-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
      consumptionRegistry: { createIfAbsent },
    } as never);
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    await orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });
    expect(createIfAbsent).toHaveBeenCalledOnce();
  });

  it('keeps the external key consumed when transcript append fails before return', async () => {
    const context = ceremony(6);
    const transcriptPath = join(context.evidenceRoot, 'crash-ledger.jsonl');
    const keys = new Set<string>();
    let transcriptBeforeConsumption = '';
    const consumptionRegistry = {
      async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
        if (keys.has(record.uniqueKey)) return false;
        keys.add(record.uniqueKey);
        transcriptBeforeConsumption = readFileSync(transcriptPath, 'utf8');
        writeFileSync(transcriptPath, `${transcriptBeforeConsumption.slice(0, -2)}X\n`, 'utf8');
        return true;
      },
    };
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry,
      ledgerPath: transcriptPath,
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    };
    await expect(orchestrator.selectAndConsumeSample(input)).rejects.toThrow(/transcript|JSON|digest/i);
    expect(keys.size).toBe(1);
    writeFileSync(transcriptPath, transcriptBeforeConsumption, 'utf8');
    await expect(orchestrator.selectAndConsumeSample(input)).rejects
      .toThrow(/already consumed.*monotonic registry/i);
  });

  it('fails closed when the external registry loses its acknowledgement after atomic create', async () => {
    const context = ceremony(6);
    const keys = new Set<string>();
    let loseAcknowledgement = true;
    const consumptionRegistry = {
      async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
        if (keys.has(record.uniqueKey)) return false;
        keys.add(record.uniqueKey);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error('simulated lost acknowledgement after atomic create');
        }
        return true;
      },
    };
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry,
      ledgerPath: join(context.evidenceRoot, 'lost-ack-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    };
    await expect(orchestrator.selectAndConsumeSample(input)).rejects.toThrow(/lost acknowledgement/i);
    await expect(orchestrator.selectAndConsumeSample(input)).rejects
      .toThrow(/already consumed.*monotonic registry/i);
  });

  it('rejects live getter/proxy signed-artifact objects before reading them', () => {
    const context = ceremony(6);
    let reads = 0;
    const liveArtifact = new Proxy(context.commitment.object, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => context.orchestrator.recordSaltCommitment(liveArtifact as never))
      .toThrow(/artifact.*bytes|UTF-8.*JSON|string/i);
    expect(reads).toBe(0);
    const proxiedBytes = new Proxy(Buffer.from(context.commitment.content, 'utf8'), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => context.orchestrator.recordSaltCommitment(proxiedBytes))
      .toThrow(/artifact.*bytes|UTF-8.*JSON|string/i);
    expect(reads).toBe(0);
  });

  it('never rereads mutable caller bytes after producing verified frozen snapshots', async () => {
    const context = ceremony(6);
    let releaseRegistry: ((created: boolean) => void) | undefined;
    const consumptionRegistry = {
      createIfAbsent(): Promise<boolean> {
        return new Promise((resolve) => {
          releaseRegistry = resolve;
        });
      },
    };
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry,
      ledgerPath: join(context.evidenceRoot, 'immutable-snapshot-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const inputs = {
      manifestContent: Buffer.from(context.manifest),
      commitmentArtifactContent: Buffer.from(context.commitment.content),
      freezeArtifactContent: Buffer.from(context.freeze.content),
      policyArtifactContent: Buffer.from(context.policy.content),
      revealContent: Buffer.from(context.revealContent),
    };
    const pending = orchestrator.selectAndConsumeSample(inputs);
    for (const input of Object.values(inputs)) input.fill(0x58);
    expect(releaseRegistry).toBeTypeOf('function');
    releaseRegistry?.(true);
    const result = await pending;
    expect(result.manifest).toEqual({ batchId: 'S33-W1', revision: 9, entryCount: 6 });
  });

  it('deep-freezes the returned selection graph and keeps its registry evidence digest stable', async () => {
    const context = ceremony(6);
    let registryRecord: Readonly<ConsumptionRegistryRecord> | undefined;
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry: {
        async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
          registryRecord = record;
          return true;
        },
      },
      ledgerPath: join(context.evidenceRoot, 'frozen-result-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const result = await orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sampleEntryIds)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.durableSequence)).toBe(true);
    expect(() => (result.sampleEntryIds as string[]).push('attacker-selected-id')).toThrow(TypeError);
    expect(() => {
      (result.evidence as { sampleSize: number }).sampleSize = 1;
    }).toThrow(TypeError);

    const reconstructedConsumptionEvidence = {
      commitmentArtifactCanonicalSha256: result.evidence.commitmentArtifactCanonicalSha256,
      commitmentArtifactRawSha256: result.evidence.commitmentArtifactRawSha256,
      freezeArtifactCanonicalSha256: result.evidence.freezeArtifactCanonicalSha256,
      freezeArtifactRawSha256: result.evidence.freezeArtifactRawSha256,
      policyArtifactCanonicalSha256: result.evidence.policyArtifactCanonicalSha256,
      policyArtifactRawSha256: result.evidence.policyArtifactRawSha256,
      revealCanonicalSha256: result.evidence.revealCanonicalSha256,
      revealRawSha256: result.evidence.revealRawSha256,
      manifestRawSha256: result.evidence.manifestRawSha256,
      manifestCanonicalSha256: result.evidence.manifestCanonicalSha256,
      sampleEntryIdsSha256: sha256(canonicaliseJson(result.sampleEntryIds)),
      sampleSize: result.evidence.sampleSize,
    };
    expect(registryRecord).toBeDefined();
    expect(sha256(canonicaliseJson(reconstructedConsumptionEvidence)))
      .toBe(registryRecord?.evidenceCanonicalSha256);
  });

  it('strict-parses the complete Wave-1 production manifest contract and Kenya-first order', () => {
    const parsed = parseBatchManifest(manifestContent(81));
    const manifest = parsed.parsedJson;
    expect(Object.keys(manifest).sort()).toEqual([
      'acceptanceAuthority', 'acceptanceScope', 'batchId', 'corpusRevisionParentCommit',
      'corpusSourceBlobs', 'counts', 'entries', 'entryCount', 'intendedSplit', 'kenyaEntryIds',
      'lane3SupportBase', 'producerLane', 'producerRevisionPredecessorCommit', 'reviewOrder',
      'revision', 'schemaVersion', 'selfChecks', 'status',
    ].sort());
    expect(parsed.entryCount).toBe(81);
    expect(parsed.entries.slice(0, 11).map(({ id }) => id))
      .toEqual((manifest.kenyaEntryIds as string[]));
    expect((manifest.counts as { byCorpusSlice: Record<string, number> }).byCorpusSlice)
      .toEqual({
        's33-au-ke-heldout': 22,
        's33-licensing-heldout': 50,
        's33-ood-negative': 9,
      });
    expect((manifest.selfChecks as Record<string, { status: string }>).oodFiveFieldSemantics.status)
      .toBe('BLOCKED_PROTOCOL_CONTRADICTION_CTO_L3');
    expect((manifest.selfChecks as Record<string, { status: string }>).lane3Acceptance.status)
      .toBe('NOT_RUN_PRODUCER_BOUNDARY');
  });

  it('rejects missing or unknown nested production fields, count drift, and Kenya order drift', () => {
    const withUnknown = productionManifestFixture(6);
    (withUnknown.lane3SupportBase as Record<string, unknown>).reviewerOverride = true;
    expect(() => parseBatchManifest(JSON.stringify(withUnknown)))
      .toThrow(/lane3SupportBase.*unknown.*reviewerOverride/i);

    const missingSource = productionManifestFixture(6);
    delete (missingSource.corpusSourceBlobs as Record<string, unknown>)[
      'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts'
    ];
    expect(() => parseBatchManifest(JSON.stringify(missingSource)))
      .toThrow(/corpusSourceBlobs.*missing.*ood-negatives/i);

    const unknownSelfCheck = productionManifestFixture(6);
    const unknownSelfChecks = unknownSelfCheck.selfChecks as {
      withinTypeTokenOverlap: Record<string, unknown>;
    };
    unknownSelfChecks.withinTypeTokenOverlap.reviewerOverride = true;
    expect(() => parseBatchManifest(JSON.stringify(unknownSelfCheck)))
      .toThrow(/withinTypeTokenOverlap.*unknown.*reviewerOverride/i);

    const missingSelfCheck = productionManifestFixture(6);
    const missingSelfChecks = missingSelfCheck.selfChecks as {
      batchScopeOnly: Record<string, unknown>;
    };
    delete missingSelfChecks.batchScopeOnly.dependency;
    expect(() => parseBatchManifest(JSON.stringify(missingSelfCheck)))
      .toThrow(/batchScopeOnly.*missing.*dependency/i);

    const countDrift = productionManifestFixture(6);
    const countMap = (countDrift.counts as { byCorpusSlice: Record<string, number> }).byCorpusSlice;
    countMap['s33-au-ke-heldout'] += 1;
    expect(() => parseBatchManifest(JSON.stringify(countDrift)))
      .toThrow(/byCorpusSlice.*reconcile/i);

    const kenyaOrderDrift = productionManifestFixture(81);
    (kenyaOrderDrift.kenyaEntryIds as string[]).reverse();
    expect(() => parseBatchManifest(JSON.stringify(kenyaOrderDrift)))
      .toThrow(/Kenya.*order/i);
  });

  it('rejects duplicate JSON keys and unknown nested manifest fields', () => {
    const duplicate = manifestContent(6).replace('"revision": 9,', '"revision": 9,\n  "revision": 9,');
    expect(() => parseBatchManifest(duplicate)).toThrow(/duplicate.*revision/i);
    const withUnknown = manifestContent(6, {
      entries: Array.from({ length: 6 }, (_, index) => ({
        id: `GD-S33-${String(index + 1).padStart(3, '0')}`,
        domain: 'professional-licensing',
        credentialType: 'LICENSE',
        normalizedInputSha256: sha256(`entry-${index + 1}`),
        reviewerOverride: true,
      })),
    });
    expect(() => parseBatchManifest(withUnknown)).toThrow(/unknown.*reviewerOverride/i);
  });

  it('durably records commitment < freeze < policy < reveal < verification and selects the fixed floor', async () => {
    const context = ceremony(81);
    recordThroughReveal(context);
    const result = await context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });

    expect(result.sampleEntryIds).toHaveLength(9);
    expect(new Set(result.sampleEntryIds)).toHaveLength(9);
    expect(result.evidence.durableSequence).toEqual([
      'salt-commitment-recorded',
      'manifest-freeze-recorded',
      'selection-policy-recorded',
      'salt-reveal-recorded',
      'selection-consumed',
    ]);
    expect(result.evidence.freezeCommitSha).toBe(context.repo.freezeCommitSha);
    const ledger = readFileSync(join(context.evidenceRoot, 'acceptance-ledger.jsonl'), 'utf8');
    expect(ledger.trim().split('\n')).toHaveLength(5);
  });

  it('keeps the signed salt commitment strictly manifest-free', () => {
    const context = ceremony(6);
    const poisonedPayload = {
      ...context.commitment.object.payload,
      manifestSha256: rawManifestHash(context.manifest),
    };
    const poisoned = signedArtifact(poisonedPayload, context.privateKey);
    expect(() => context.orchestrator.recordSaltCommitment(poisoned.content))
      .toThrow(/manifest-free|unknown.*manifestSha256/i);
  });

  it('strict-parses signed artifacts and rejects duplicate or unknown nested fields', () => {
    const context = ceremony(6);
    const duplicate = context.commitment.content.replace(
      '"commitmentId": "S33-W1-commitment-1",',
      '"commitmentId": "S33-W1-commitment-1",\n    "commitmentId": "S33-W1-commitment-1",',
    );
    expect(() => context.orchestrator.recordSaltCommitment(duplicate)).toThrow(/duplicate.*commitmentId/i);
    const nestedUnknown = signedArtifact({
      ...context.commitment.object.payload,
      saltCommitment: {
        ...context.commitment.object.payload.saltCommitment,
        operatorOverride: true,
      },
    }, context.privateKey);
    expect(() => context.orchestrator.recordSaltCommitment(nestedUnknown.content))
      .toThrow(/unknown.*operatorOverride/i);
  });

  it('rejects freeze or reveal when durable predecessor records do not exist', () => {
    const context = ceremony(6);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
      .toThrow(/commitment.*durably recorded/i);
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordSaltReveal(context.revealContent))
      .toThrow(/freeze|policy.*durably recorded/i);
  });

  it('rejects a reveal that does not open the durably recorded signed commitment', () => {
    const context = ceremony(6);
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    context.orchestrator.recordSelectionPolicy(context.policy.content);
    expect(() => context.orchestrator.recordSaltReveal(JSON.stringify({
      ...context.reveal,
      salt: '22'.repeat(32),
    }))).toThrow(/does not match.*durably recorded.*commitment/i);
  });

  it('verifies the frozen Git blob and ancestor relation, not asserted timestamps alone', () => {
    const context = ceremony(6);
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    const wrongCommit = signedArtifact<ManifestFreezePayload>({
      ...context.freeze.object.payload,
      gitEvidence: {
        ...context.freeze.object.payload.gitEvidence,
        freezeCommitSha: '00'.repeat(20),
      },
    }, context.privateKey);
    expect(() => context.orchestrator.recordManifestFreeze(wrongCommit.content, context.manifest))
      .toThrow(/git|commit|ancestor/i);
  });

  it('atomically consumes each policy/batch/revision once across contenders', async () => {
    const context = ceremony(6);
    recordThroughReveal(context);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    };
    const contender = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry: context.consumptionRegistry,
      ledgerPath: join(context.evidenceRoot, 'acceptance-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    const attempts = await Promise.allSettled([
      context.orchestrator.selectAndConsumeSample(input),
      contender.selectAndConsumeSample(input),
    ]);
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const winner = attempts.find((attempt) => attempt.status === 'fulfilled');
    expect(winner?.status === 'fulfilled' ? winner.value.sampleEntryIds : []).toHaveLength(5);
    expect(context.consumptionRegistry.keys.size).toBe(1);
  });

  it('binds raw bytes separately from canonical content before consuming a registry key', async () => {
    const context = ceremony(6);
    recordThroughReveal(context);
    const rawVariant = `${context.commitment.content}\n`;
    expect(canonicalManifestHash(rawVariant)).toBe(canonicalManifestHash(context.commitment.content));
    expect(rawManifestHash(rawVariant)).not.toBe(rawManifestHash(context.commitment.content));
    await expect(context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: rawVariant,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    })).rejects.toThrow(/raw artifact bytes.*transcript/i);
    expect(context.consumptionRegistry.keys.size).toBe(0);
  });

  it('fails closed when the append-only ledger hash chain is modified', () => {
    const context = ceremony(6);
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    const ledgerPath = join(context.evidenceRoot, 'acceptance-ledger.jsonl');
    const tampered = readFileSync(ledgerPath, 'utf8').replace('commitment-1', 'commitment-X');
    writeFileSync(ledgerPath, tampered, 'utf8');
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
      .toThrow(/transcript|digest|tamper/i);
  });

  it('rejects an adversarial transcript symlink swap and permissive file mode', () => {
    const swapped = ceremony(6);
    swapped.orchestrator.recordSaltCommitment(swapped.commitment.content);
    const swappedPath = join(swapped.evidenceRoot, 'acceptance-ledger.jsonl');
    const originalPath = join(swapped.evidenceRoot, 'acceptance-ledger-original.jsonl');
    renameSync(swappedPath, originalPath);
    symlinkSync(originalPath, swappedPath);
    expect(() => swapped.orchestrator.recordManifestFreeze(swapped.freeze.content, swapped.manifest))
      .toThrow(/symbolic|regular file|nofollow/i);

    const parentSwapped = ceremony(6);
    parentSwapped.orchestrator.recordSaltCommitment(parentSwapped.commitment.content);
    const originalDirectory = `${parentSwapped.evidenceRoot}-original`;
    const attackerDirectory = `${parentSwapped.evidenceRoot}-attacker`;
    tempRoots.push(originalDirectory, attackerDirectory);
    const validTranscript = readFileSync(
      join(parentSwapped.evidenceRoot, 'acceptance-ledger.jsonl'),
      'utf8',
    );
    renameSync(parentSwapped.evidenceRoot, originalDirectory);
    mkdirSync(attackerDirectory, { mode: 0o700 });
    writeFileSync(join(attackerDirectory, 'acceptance-ledger.jsonl'), validTranscript, { mode: 0o600 });
    symlinkSync(attackerDirectory, parentSwapped.evidenceRoot, 'dir');
    expect(() => parentSwapped.orchestrator.recordManifestFreeze(
      parentSwapped.freeze.content,
      parentSwapped.manifest,
    )).toThrow(/containment|directory/i);

    const permissive = ceremony(6);
    permissive.orchestrator.recordSaltCommitment(permissive.commitment.content);
    chmodSync(join(permissive.evidenceRoot, 'acceptance-ledger.jsonl'), 0o644);
    expect(() => permissive.orchestrator.recordManifestFreeze(permissive.freeze.content, permissive.manifest))
      .toThrow(/permissions|mode|0600/i);
  });

  it('production loader fails closed because no CTO root or monotonic registry is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'arkova-s33-production-'));
    tempRoots.push(root);
    expect(() => createProductionS33AcceptanceOrchestrator({
      ledgerPath: join(root, 'ledger.jsonl'),
      repositoryRoot: root,
      verificationCommitSha: '00'.repeat(20),
    })).toThrow(/CTO trust root.*monotonic consumption registry.*not configured|fail closed/i);
  });

  it('parses the complete manifest universe and cannot lower the fixed 1/100 floor', async () => {
    const context = ceremony(100);
    recordThroughReveal(context);
    await expect(context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
      sampleRatio: 0.01,
      entryIds: ['GD-S33-001'],
    } as never)).rejects.toThrow(/unknown caller controls.*sampleRatio.*entryIds/i);
    const result = await context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });
    expect(result.sampleEntryIds).toHaveLength(10);
    expect(parseBatchManifest(context.manifest).entries).toHaveLength(100);
  });
});

function lexicalTextArtifact(
  role: 'heldout' | 'corpus',
  records: Array<{ id: string; text: string }>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    algorithmVersion: 's33-lexical-text-artifact-v1',
    artifactId: `S33-${role}-1`,
    role,
    records: records.map(({ id, text }) => ({ id, text, contentSha256: sha256(text) })),
  }, null, 2);
}

describe('S3.3 authenticated lexical scan boundary', () => {
  it('loads authenticated text artifacts and recomputes n=6..13 before verdict', () => {
    const context = ceremony(6);
    const heldout = lexicalTextArtifact('heldout', [{
      id: 'KE-001',
      text: 'Nursing Council registration certificate for a licensed practitioner in Nairobi County',
    }]);
    const corpus = lexicalTextArtifact('corpus', [{
      id: 'training/example:4',
      text: 'A nursing council registration certificate for a licensed practitioner in Nairobi County was supplied',
    }]);
    const policy = signedArtifact<LexicalLeakagePolicyPayload>({
      artifactType: 'arkova-s33-lexical-leakage-policy',
      artifactVersion: '1.0.0',
      policyId: 'S33-lexical-policy-test-1',
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      signedAtUtc: '2026-07-13T13:00:00.000Z',
      metricAlgorithmVersion: 'token-set-ngram-v1',
      heldoutArtifactId: 'S33-heldout-1',
      heldoutArtifactRawSha256: rawManifestHash(heldout),
      heldoutArtifactCanonicalSha256: canonicalManifestHash(heldout),
      corpusArtifactId: 'S33-corpus-1',
      corpusArtifactRawSha256: rawManifestHash(corpus),
      corpusArtifactCanonicalSha256: canonicalManifestHash(corpus),
      normalization: {
        unicodeForm: 'NFKC',
        caseFold: 'lowercase',
        nonAlphanumeric: 'space',
        whitespace: 'collapse',
      },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13],
      minimumSharedNgrams: 3,
      minimumHeldoutContainment: 0.5,
      combination: 'all',
    }, context.privateKey);
    const result = context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
    });
    expect(result.metrics).toHaveLength(8);
    expect(result.hits.some((hit) => hit.n === 6)).toBe(true);
    expect(result.evidence.metricAlgorithmVersion).toBe('token-set-ngram-v1');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(Object.isFrozen(result.metrics[0])).toBe(true);
    expect(Object.isFrozen(result.hits)).toBe(true);
    expect(Object.isFrozen(result.hits[0])).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(() => (result.metrics as unknown[]).pop()).toThrow(TypeError);
    expect(() => {
      (result.evidence as { metricCount: number }).metricCount = 0;
    }).toThrow(TypeError);
    const duplicateHeldout = heldout.replace('"id": "KE-001",', '"id": "KE-001",\n      "id": "KE-001",');
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: duplicateHeldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
    })).toThrow(/duplicate.*id/i);
  });

  it('has no public policy-only API and rejects a complete fabricated all-zero matrix', () => {
    expect(acceptanceModule).not.toHaveProperty('applyLexicalLeakagePolicy');
    expect(acceptanceModule).not.toHaveProperty('computeLexicalLeakageMetrics');
    const context = ceremony(6);
    const heldout = lexicalTextArtifact('heldout', [{ id: 'H', text: 'one two three four five six seven eight' }]);
    const corpus = lexicalTextArtifact('corpus', [{ id: 'C', text: 'one two three four five six seven eight' }]);
    const policy = signedArtifact<LexicalLeakagePolicyPayload>({
      artifactType: 'arkova-s33-lexical-leakage-policy',
      artifactVersion: '1.0.0',
      policyId: 'S33-lexical-policy-test-2',
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      signedAtUtc: '2026-07-13T13:00:00.000Z',
      metricAlgorithmVersion: 'token-set-ngram-v1',
      heldoutArtifactId: 'S33-heldout-1',
      heldoutArtifactRawSha256: rawManifestHash(heldout),
      heldoutArtifactCanonicalSha256: canonicalManifestHash(heldout),
      corpusArtifactId: 'S33-corpus-1',
      corpusArtifactRawSha256: rawManifestHash(corpus),
      corpusArtifactCanonicalSha256: canonicalManifestHash(corpus),
      normalization: { unicodeForm: 'NFKC', caseFold: 'lowercase', nonAlphanumeric: 'space', whitespace: 'collapse' },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13],
      minimumSharedNgrams: 1,
      minimumHeldoutContainment: 0.1,
      combination: 'all',
    }, context.privateKey);
    const fabricated = Array.from({ length: 8 }, (_, index) => ({
      heldoutId: 'H', corpusId: 'C', n: index + 6,
      heldoutNgrams: 0, corpusNgrams: 0, sharedNgrams: 0,
      heldoutContainment: 0, jaccard: 0,
    }));
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
      metrics: fabricated,
    } as never)).toThrow(/unknown.*metrics|precomputed.*not accepted/i);
  });

  it('rejects text-content hash or signed artifact binding mismatches', () => {
    const context = ceremony(6);
    const heldout = lexicalTextArtifact('heldout', [{ id: 'H', text: 'one two three four five six' }]);
    const corpusObject = JSON.parse(lexicalTextArtifact('corpus', [{ id: 'C', text: 'one two three four five six' }])) as {
      records: Array<{ text: string }>;
    };
    corpusObject.records[0].text = 'tampered text with unchanged content hash';
    const corpus = JSON.stringify(corpusObject);
    const policy = signedArtifact<LexicalLeakagePolicyPayload>({
      artifactType: 'arkova-s33-lexical-leakage-policy', artifactVersion: '1.0.0',
      policyId: 'S33-lexical-policy-test-3', signerIdentity: 'Arkova CTO', signingKeyId: 'cto-policy-test-key-1',
      signedAtUtc: '2026-07-13T13:00:00.000Z', metricAlgorithmVersion: 'token-set-ngram-v1',
      heldoutArtifactId: 'S33-heldout-1', heldoutArtifactRawSha256: rawManifestHash(heldout),
      heldoutArtifactCanonicalSha256: canonicalManifestHash(heldout), corpusArtifactId: 'S33-corpus-1',
      corpusArtifactRawSha256: rawManifestHash(corpus), corpusArtifactCanonicalSha256: canonicalManifestHash(corpus),
      normalization: { unicodeForm: 'NFKC', caseFold: 'lowercase', nonAlphanumeric: 'space', whitespace: 'collapse' },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13], minimumSharedNgrams: 1,
      minimumHeldoutContainment: 0.1, combination: 'all',
    }, context.privateKey);
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
    })).toThrow(/content hash/i);
  });
});

describe('S3.3 embedding arithmetic', () => {
  it('rejects non-finite derived dot/norm/cosine arithmetic', () => {
    expect(() => compareEmbeddingLeakage(
      [{ id: 'held', model: 'model-a', vector: [1e308, 1e308] }],
      [{ id: 'corpus', model: 'model-a', vector: [1e308, 1e308] }],
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).toThrow(/overflow|non-finite|arithmetic/i);
  });

  it('propagates provider failures and rejects incomplete output', async () => {
    const failedProvider: EmbeddingBatchProvider = {
      embed: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    await expect(scanEmbeddingLeakage(
      [{ id: 'held', text: 'held text' }],
      [{ id: 'corpus', text: 'corpus text' }],
      failedProvider,
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).rejects.toThrow(/provider unavailable/i);
  });
});
