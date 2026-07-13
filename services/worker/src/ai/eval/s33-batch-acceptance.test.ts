import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import {
  applyLexicalLeakagePolicy,
  canonicalManifestHash,
  compareEmbeddingLeakage,
  computeLexicalLeakageMetrics,
  parseBatchManifest,
  rawManifestHash,
  scanEmbeddingLeakage,
  scanLexicalLeakage,
  selectManifestSeededSample,
  type EmbeddingBatchProvider,
  type SamplingPolicyArtifact,
  type SamplingPolicyPayload,
  type SamplingTrustRoot,
} from './s33-batch-acceptance.js';

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

function manifestContent(entryCount: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision: 5,
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

function createSignedSamplingFixture(
  manifest: string,
  overrides: Partial<SamplingPolicyPayload> = {},
): {
  artifact: SamplingPolicyArtifact;
  trustRoot: SamplingTrustRoot;
  reveal: { salt: string; revealedAtUtc: string };
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeyDer = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const salt = '11'.repeat(32);
  const parsed = parseBatchManifest(manifest);
  const payload: SamplingPolicyPayload = {
    artifactType: 'arkova-s33-sampling-policy',
    artifactVersion: '1.0.0',
    policyId: 'S33-W1-r5-review-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:00:00.000Z',
    batchId: parsed.batchId,
    revision: parsed.revision,
    manifestHashRepresentation: 'raw-file-sha256',
    manifestSha256: rawManifestHash(manifest),
    prng: 'xorshift32-v1',
    saltCommitment: {
      algorithm: 'sha256',
      value: sha256(salt),
      recordedAtUtc: '2026-07-13T12:59:00.000Z',
    },
    ...overrides,
  };
  const payloadDigestSha256 = sha256(canonicaliseJson(payload));
  const signatureValue = sign(
    null,
    Buffer.from(canonicaliseJson({ payload, payloadDigestSha256 }), 'utf8'),
    privateKey,
  ).toString('base64url');
  const signature = { algorithm: 'Ed25519' as const, value: signatureValue };
  return {
    artifact: {
      payload,
      payloadDigestSha256,
      signature,
      artifactDigestSha256: sha256(canonicaliseJson({
        payload,
        payloadDigestSha256,
        signature,
      })),
    },
    trustRoot: {
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      publicKeyPem,
      publicKeyFingerprintSha256: sha256(publicKeyDer),
    },
    reveal: { salt, revealedAtUtc: '2026-07-13T13:01:00.000Z' },
  };
}

function sampleManifest(
  manifest: string,
  fixture = createSignedSamplingFixture(manifest),
  consumedPolicyArtifactDigests: readonly string[] = [],
) {
  return selectManifestSeededSample({
    manifestContent: manifest,
    policyArtifact: fixture.artifact,
    trustRoot: fixture.trustRoot,
    reveal: fixture.reveal,
    verification: {
      verifiedAtUtc: '2026-07-13T13:02:00.000Z',
      consumedPolicyArtifactDigests,
    },
  });
}

describe('S3.3 batch acceptance — authenticated manifest sampling', () => {
  it('parses the real manifest schema and selects the fixed ceil(10%), min-5 sample', () => {
    const manifest = manifestContent(81);
    const first = sampleManifest(manifest);
    const second = sampleManifest(manifest);

    expect(first.sampleEntryIds).toHaveLength(9);
    expect(new Set(first.sampleEntryIds)).toHaveLength(9);
    expect(second.sampleEntryIds).toEqual(first.sampleEntryIds);
    expect(first.manifest).toMatchObject({ batchId: 'S33-W1', revision: 5, entryCount: 81 });
    expect(first.evidence.manifestSha256).toBe(rawManifestHash(manifest));
  });

  it('cannot cherry-pick the entry universe or lower the 10%/min-5 floor', () => {
    const oneHundred = manifestContent(100);
    const fixture = createSignedSamplingFixture(oneHundred);
    const result = selectManifestSeededSample({
      manifestContent: oneHundred,
      policyArtifact: fixture.artifact,
      trustRoot: fixture.trustRoot,
      reveal: fixture.reveal,
      verification: {
        verifiedAtUtc: '2026-07-13T13:02:00.000Z',
        consumedPolicyArtifactDigests: [],
      },
      sampleRatio: 0.01,
      sampleMinimum: 1,
      entryIds: ['GD-S33-001'],
    } as never);
    expect(result.sampleEntryIds).toHaveLength(10);

    const inconsistent = manifestContent(81, { entryCount: 9 });
    expect(() => parseBatchManifest(inconsistent)).toThrow(/entryCount.*entries/i);
  });

  it('rejects empty, duplicate, and malformed manifest entry universes', () => {
    expect(() => parseBatchManifest(manifestContent(0))).toThrow(/empty/i);
    const duplicateEntries = JSON.parse(manifestContent(5)) as { entries: Array<{ id: string }> };
    duplicateEntries.entries[1].id = duplicateEntries.entries[0].id;
    expect(() => parseBatchManifest(JSON.stringify(duplicateEntries))).toThrow(/duplicate/i);
    expect(() => parseBatchManifest('{not json')).toThrow(/parse/i);
  });

  it('recomputes the declared raw-file or canonical JSON hash from actual bytes', () => {
    const raw = manifestContent(6);
    const canonicalFixture = createSignedSamplingFixture(raw, {
      manifestHashRepresentation: 'canonical-json-sha256',
      manifestSha256: canonicalManifestHash(JSON.parse(raw)),
    });
    expect(sampleManifest(raw, canonicalFixture).evidence.manifestHashRepresentation)
      .toBe('canonical-json-sha256');

    const rawFixture = createSignedSamplingFixture(raw);
    const reformatted = JSON.stringify(JSON.parse(raw));
    expect(() => sampleManifest(reformatted, rawFixture)).toThrow(/manifest.*hash/i);

    const badCanonical = createSignedSamplingFixture(raw, {
      manifestHashRepresentation: 'canonical-json-sha256',
      manifestSha256: '00'.repeat(32),
    });
    expect(() => sampleManifest(raw, badCanonical)).toThrow(/manifest.*hash/i);
  });

  it('fails closed without a pinned CTO trust root or with an untrusted key/fingerprint', () => {
    const manifest = manifestContent(6);
    const fixture = createSignedSamplingFixture(manifest);
    expect(() => selectManifestSeededSample({
      manifestContent: manifest,
      policyArtifact: fixture.artifact,
      trustRoot: undefined,
      reveal: fixture.reveal,
      verification: { verifiedAtUtc: '2026-07-13T13:02:00.000Z', consumedPolicyArtifactDigests: [] },
    } as never)).toThrow(/trust root/i);
    expect(() => sampleManifest(manifest, {
      ...fixture,
      trustRoot: { ...fixture.trustRoot, publicKeyFingerprintSha256: '00'.repeat(32) },
    })).toThrow(/fingerprint/i);

    const attacker = createSignedSamplingFixture(manifest);
    expect(() => sampleManifest(manifest, { ...fixture, trustRoot: attacker.trustRoot }))
      .toThrow(/trust root|signature|key/i);
  });

  it('rejects bad, replayed, and late signatures or commitments', () => {
    const manifest = manifestContent(6);
    const badSignature = createSignedSamplingFixture(manifest);
    badSignature.artifact.signature.value = `${badSignature.artifact.signature.value.slice(0, -2)}aa`;
    badSignature.artifact.artifactDigestSha256 = sha256(canonicaliseJson({
      payload: badSignature.artifact.payload,
      payloadDigestSha256: badSignature.artifact.payloadDigestSha256,
      signature: badSignature.artifact.signature,
    }));
    expect(() => sampleManifest(manifest, badSignature)).toThrow(/signature/i);

    const valid = createSignedSamplingFixture(manifest);
    const first = sampleManifest(manifest, valid);
    expect(() => sampleManifest(manifest, valid, [first.evidence.policyArtifactDigestSha256]))
      .toThrow(/replay|consumed/i);

    const signedLate = createSignedSamplingFixture(manifest, {
      signedAtUtc: '2026-07-13T13:01:30.000Z',
    });
    expect(() => sampleManifest(manifest, signedLate)).toThrow(/signed.*before.*reveal|ordering/i);

    const committedLate = createSignedSamplingFixture(manifest, {
      saltCommitment: {
        algorithm: 'sha256',
        value: sha256('11'.repeat(32)),
        recordedAtUtc: '2026-07-13T13:01:30.000Z',
      },
    });
    expect(() => sampleManifest(manifest, committedLate)).toThrow(/commitment.*before.*reveal|ordering/i);
  });

  it('authenticates the prior salt commitment and exposes ordering evidence', () => {
    const manifest = manifestContent(6);
    const fixture = createSignedSamplingFixture(manifest);
    const mismatch = { ...fixture, reveal: { ...fixture.reveal, salt: '22'.repeat(32) } };
    expect(() => sampleManifest(manifest, mismatch)).toThrow(/commitment/i);

    const result = sampleManifest(manifest, fixture);
    expect(result.evidence).toMatchObject({
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      commitmentRecordedAtUtc: '2026-07-13T12:59:00.000Z',
      signedAtUtc: '2026-07-13T13:00:00.000Z',
      revealedAtUtc: '2026-07-13T13:01:00.000Z',
      verifiedAtUtc: '2026-07-13T13:02:00.000Z',
      sampleSize: 5,
      manifestEntryCount: 6,
    });
  });
});

describe('S3.3 batch acceptance — complete lexical leakage matrix', () => {
  const normalization = {
    unicodeForm: 'NFKC',
    caseFold: 'lowercase',
    nonAlphanumeric: 'space',
    whitespace: 'collapse',
  } as const;
  const heldout = [
    { id: 'KE-001', text: 'Nursing Council registration certificate for a licensed practitioner in Nairobi County' },
    { id: 'KE-002', text: 'Medical board practising licence for a physician in Nairobi County Kenya' },
  ];
  const corpus = [
    { id: 'training/example:4', text: 'A nursing council registration certificate for a licensed practitioner in Nairobi County was supplied' },
    { id: 'training/example:5', text: 'Completely different tokens with enough words to produce six token shingles safely' },
  ];
  const policy = {
    allowedN: [6, 7, 8, 9, 10, 11, 12, 13],
    minimumSharedNgrams: 3,
    minimumHeldoutContainment: 0.5,
    combination: 'all',
  } as const;
  const universe = {
    heldoutIds: heldout.map(({ id }) => id),
    corpusIds: corpus.map(({ id }) => id),
  };

  it('computes and applies one complete n=6..13 matrix at one orchestration boundary', () => {
    const result = scanLexicalLeakage(heldout, corpus, normalization, policy);
    expect(result.metrics).toHaveLength(2 * 2 * 8);
    expect(result.hits.some((hit) => hit.heldoutId === 'KE-001' && hit.n === 6)).toBe(true);
  });

  it('rejects empty, fabricated, and escaped [999] metric evidence', () => {
    expect(() => applyLexicalLeakagePolicy([], policy, universe)).toThrow(/empty|complete/i);
    const metrics = computeLexicalLeakageMetrics(heldout, corpus, {
      minN: 6, maxN: 13, normalization,
    });
    expect(() => applyLexicalLeakagePolicy(metrics, { ...policy, allowedN: [999] }, universe))
      .toThrow(/6.*13|allowedN/i);
    expect(() => applyLexicalLeakagePolicy([
      { ...metrics[0], heldoutContainment: 0.99, sharedNgrams: 0 },
      ...metrics.slice(1),
    ], policy, universe)).toThrow(/fabricated|inconsistent/i);
  });

  it('rejects missing pair/n tuples and duplicate metrics', () => {
    const metrics = computeLexicalLeakageMetrics(heldout, corpus, {
      minN: 6, maxN: 13, normalization,
    });
    expect(() => applyLexicalLeakagePolicy(metrics.slice(1), policy, universe))
      .toThrow(/missing|complete/i);
    const duplicate = [...metrics];
    duplicate[duplicate.length - 1] = metrics[0];
    expect(() => applyLexicalLeakagePolicy(duplicate, policy, universe))
      .toThrow(/duplicate|complete/i);
    expect(() => applyLexicalLeakagePolicy(
      metrics.filter((metric) => metric.corpusId !== 'training/example:5'),
      policy,
      universe,
    )).toThrow(/missing|complete/i);
  });
});

describe('S3.3 batch acceptance — embedding leakage', () => {
  it('compares only the explicitly pinned model and threshold', () => {
    const hits = compareEmbeddingLeakage(
      [{ id: 'held-1', model: 'gemini-embedding-test@001', vector: [1, 0] }],
      [
        { id: 'near', model: 'gemini-embedding-test@001', vector: [0.99, 0.01] },
        { id: 'far', model: 'gemini-embedding-test@001', vector: [0, 1] },
      ],
      { model: 'gemini-embedding-test@001', minimumCosineSimilarity: 0.95 },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ heldoutId: 'held-1', corpusId: 'near' });
  });

  it('fails closed on non-finite derived dot/norm/cosine arithmetic', () => {
    expect(() => compareEmbeddingLeakage(
      [{ id: 'held', model: 'model-a', vector: [1e308, 1e308] }],
      [{ id: 'corpus', model: 'model-a', vector: [1e308, 1e308] }],
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).toThrow(/overflow|non-finite|arithmetic/i);
  });

  it('propagates provider failure and rejects incomplete embedding output', async () => {
    const failedProvider: EmbeddingBatchProvider = {
      embed: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    await expect(scanEmbeddingLeakage(
      [{ id: 'held', text: 'held text' }],
      [{ id: 'corpus', text: 'corpus text' }],
      failedProvider,
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).rejects.toThrow(/provider unavailable/i);

    const incompleteProvider: EmbeddingBatchProvider = {
      embed: vi.fn().mockResolvedValue([]),
    };
    await expect(scanEmbeddingLeakage(
      [{ id: 'held', text: 'held text' }],
      [{ id: 'corpus', text: 'corpus text' }],
      incompleteProvider,
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).rejects.toThrow(/count/i);
  });
});
