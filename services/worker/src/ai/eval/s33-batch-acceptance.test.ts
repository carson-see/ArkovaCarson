import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import * as acceptanceModule from './s33-batch-acceptance.js';
import {
  canonicalManifestHash,
  compareEmbeddingLeakage,
  createProductionS33AcceptanceOrchestrator,
  createTestOnlyS33AcceptanceOrchestrator,
  parseBatchManifest,
  rawManifestHash,
  scanEmbeddingLeakage,
  type EmbeddingBatchProvider,
  type LexicalLeakagePolicyPayload,
  type ManifestFreezePayload,
  type SaltCommitmentPayload,
  type SaltRevealRecord,
  type SelectionPolicyPayload,
  type SignedPolicyArtifact,
  type SamplingTrustRoot,
} from './s33-batch-acceptance.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

function manifestContent(entryCount: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision: 6,
    intendedSplit: 'held-out-candidate',
    entryCount,
    counts: {
      byDomain: { 'professional-licensing': entryCount },
      byCredentialType: { LICENSE: entryCount },
    },
    selfChecks: { structural: { status: 'PASS' } },
    entries: Array.from({ length: entryCount }, (_, index) => ({
      id: `GD-S33-${String(index + 1).padStart(3, '0')}`,
      domain: 'professional-licensing',
      credentialType: 'LICENSE',
      normalizedInputSha256: sha256(`entry-${index + 1}`),
    })),
    ...overrides,
  }, null, 2);
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

function signedArtifact<P extends object>(
  payload: P,
  privateKey: KeyObject,
): SignedPolicyArtifact<P> {
  const payloadDigestSha256 = sha256(canonicaliseJson(payload));
  const signature = {
    algorithm: 'Ed25519' as const,
    value: sign(
      null,
      Buffer.from(canonicaliseJson({ payload, payloadDigestSha256 }), 'utf8'),
      privateKey,
    ).toString('base64url'),
  };
  return {
    payload,
    payloadDigestSha256,
    signature,
    artifactDigestSha256: sha256(canonicaliseJson({ payload, payloadDigestSha256, signature })),
  };
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
  const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
    trustRoot,
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
    freezeId: 'S33-W1-r6-freeze-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:01:00.000Z',
    commitmentArtifactDigestSha256: commitment.artifactDigestSha256,
    batchId: 'S33-W1',
    revision: 6,
    manifestHashRepresentation: 'raw-file-sha256',
    manifestSha256: rawManifestHash(manifest),
    gitEvidence: {
      repositoryIdentity: 'test/ArkovaCarson',
      freezeCommitSha: repo.freezeCommitSha,
      manifestPath: repo.manifestPath,
    },
  }, privateKey);
  const policy = signedArtifact<SelectionPolicyPayload>({
    artifactType: 'arkova-s33-selection-policy',
    artifactVersion: '1.0.0',
    policyId: 'S33-W1-r6-selection-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:02:00.000Z',
    commitmentArtifactDigestSha256: commitment.artifactDigestSha256,
    freezeArtifactDigestSha256: freeze.artifactDigestSha256,
    batchId: 'S33-W1',
    revision: 6,
    prng: 'xorshift32-v1',
    sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count',
  }, privateKey);
  const reveal: SaltRevealRecord = {
    schemaVersion: 1,
    revealId: 'S33-W1-r6-reveal-1',
    commitmentArtifactDigestSha256: commitment.artifactDigestSha256,
    freezeArtifactDigestSha256: freeze.artifactDigestSha256,
    policyArtifactDigestSha256: policy.artifactDigestSha256,
    salt,
    revealedAtUtc: '2026-07-13T13:03:00.000Z',
  };
  return { orchestrator, manifest, repo, privateKey, trustRoot, commitment, freeze, policy, reveal, evidenceRoot };
}

function recordThroughReveal(context: ReturnType<typeof ceremony>): void {
  context.orchestrator.recordSaltCommitment(context.commitment);
  context.orchestrator.recordManifestFreeze(context.freeze, context.manifest);
  context.orchestrator.recordSelectionPolicy(context.policy);
  context.orchestrator.recordSaltReveal(context.reveal);
}

describe('S3.3 authenticated, durable sampling ceremony', () => {
  it('durably records commitment < freeze < policy < reveal < verification and selects the fixed floor', () => {
    const context = ceremony(81);
    recordThroughReveal(context);
    const result = context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifact: context.commitment,
      freezeArtifact: context.freeze,
      policyArtifact: context.policy,
      reveal: context.reveal,
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
      ...context.commitment.payload,
      manifestSha256: rawManifestHash(context.manifest),
    };
    const poisoned = signedArtifact(poisonedPayload, context.privateKey);
    expect(() => context.orchestrator.recordSaltCommitment(poisoned as never))
      .toThrow(/manifest-free|unknown.*manifestSha256/i);
  });

  it('rejects freeze or reveal when durable predecessor records do not exist', () => {
    const context = ceremony(6);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze, context.manifest))
      .toThrow(/commitment.*durably recorded/i);
    context.orchestrator.recordSaltCommitment(context.commitment);
    expect(() => context.orchestrator.recordSaltReveal(context.reveal))
      .toThrow(/freeze|policy.*durably recorded/i);
  });

  it('rejects a reveal that does not open the durably recorded signed commitment', () => {
    const context = ceremony(6);
    context.orchestrator.recordSaltCommitment(context.commitment);
    context.orchestrator.recordManifestFreeze(context.freeze, context.manifest);
    context.orchestrator.recordSelectionPolicy(context.policy);
    expect(() => context.orchestrator.recordSaltReveal({
      ...context.reveal,
      salt: '22'.repeat(32),
    })).toThrow(/does not match.*durably recorded.*commitment/i);
  });

  it('verifies the frozen Git blob and ancestor relation, not asserted timestamps alone', () => {
    const context = ceremony(6);
    context.orchestrator.recordSaltCommitment(context.commitment);
    const wrongCommit = signedArtifact<ManifestFreezePayload>({
      ...context.freeze.payload,
      gitEvidence: {
        ...context.freeze.payload.gitEvidence,
        freezeCommitSha: '00'.repeat(20),
      },
    }, context.privateKey);
    expect(() => context.orchestrator.recordManifestFreeze(wrongCommit, context.manifest))
      .toThrow(/git|commit|ancestor/i);
  });

  it('atomically consumes each policy/batch/revision once across contenders', () => {
    const context = ceremony(6);
    recordThroughReveal(context);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifact: context.commitment,
      freezeArtifact: context.freeze,
      policyArtifact: context.policy,
      reveal: context.reveal,
    };
    expect(context.orchestrator.selectAndConsumeSample(input).sampleEntryIds).toHaveLength(5);
    const contender = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      ledgerPath: join(context.evidenceRoot, 'acceptance-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    expect(() => contender.selectAndConsumeSample(input)).toThrow(/already consumed|exclusive/i);
  });

  it('fails closed when the append-only ledger hash chain is modified', () => {
    const context = ceremony(6);
    context.orchestrator.recordSaltCommitment(context.commitment);
    const ledgerPath = join(context.evidenceRoot, 'acceptance-ledger.jsonl');
    const tampered = readFileSync(ledgerPath, 'utf8').replace('commitment-1', 'commitment-X');
    writeFileSync(ledgerPath, tampered, 'utf8');
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze, context.manifest))
      .toThrow(/hash chain|digest|tamper/i);
  });

  it('production loader fails closed because no real CTO root is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'arkova-s33-production-'));
    tempRoots.push(root);
    expect(() => createProductionS33AcceptanceOrchestrator({
      ledgerPath: join(root, 'ledger.jsonl'),
      repositoryRoot: root,
      verificationCommitSha: '00'.repeat(20),
    })).toThrow(/CTO trust root.*not configured|fail closed/i);
  });

  it('parses the complete manifest universe and cannot lower the fixed 1/100 floor', () => {
    const context = ceremony(100);
    recordThroughReveal(context);
    expect(() => context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifact: context.commitment,
      freezeArtifact: context.freeze,
      policyArtifact: context.policy,
      reveal: context.reveal,
      sampleRatio: 0.01,
      entryIds: ['GD-S33-001'],
    } as never)).toThrow(/unknown caller controls.*sampleRatio.*entryIds/i);
    const result = context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifact: context.commitment,
      freezeArtifact: context.freeze,
      policyArtifact: context.policy,
      reveal: context.reveal,
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
      textArtifactHashRepresentation: 'raw-file-sha256',
      heldoutArtifactId: 'S33-heldout-1',
      heldoutArtifactSha256: rawManifestHash(heldout),
      corpusArtifactId: 'S33-corpus-1',
      corpusArtifactSha256: rawManifestHash(corpus),
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
      policyArtifact: policy,
    });
    expect(result.metrics).toHaveLength(8);
    expect(result.hits.some((hit) => hit.n === 6)).toBe(true);
    expect(result.evidence.metricAlgorithmVersion).toBe('token-set-ngram-v1');
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
      textArtifactHashRepresentation: 'raw-file-sha256',
      heldoutArtifactId: 'S33-heldout-1',
      heldoutArtifactSha256: rawManifestHash(heldout),
      corpusArtifactId: 'S33-corpus-1',
      corpusArtifactSha256: rawManifestHash(corpus),
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
      policyArtifact: policy,
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
      textArtifactHashRepresentation: 'canonical-json-sha256', heldoutArtifactId: 'S33-heldout-1',
      heldoutArtifactSha256: canonicalManifestHash(JSON.parse(heldout)), corpusArtifactId: 'S33-corpus-1',
      corpusArtifactSha256: canonicalManifestHash(corpusObject),
      normalization: { unicodeForm: 'NFKC', caseFold: 'lowercase', nonAlphanumeric: 'space', whitespace: 'collapse' },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13], minimumSharedNgrams: 1,
      minimumHeldoutContainment: 0.1, combination: 'all',
    }, context.privateKey);
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifact: policy,
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
