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
    freezeId: 'S33-W1-r6-freeze-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:01:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    batchId: 'S33-W1',
    revision: 6,
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
    policyId: 'S33-W1-r6-selection-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:02:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    freezeArtifactCanonicalSha256: canonicalManifestHash(freeze.content),
    batchId: 'S33-W1',
    revision: 6,
    prng: 'xorshift32-v1',
    sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count',
  }, privateKey);
  const reveal: SaltRevealRecord = {
    schemaVersion: 1,
    revealId: 'S33-W1-r6-reveal-1',
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
    expect(result.manifest).toEqual({ batchId: 'S33-W1', revision: 6, entryCount: 6 });
  });

  it('rejects duplicate JSON keys and unknown nested manifest fields', () => {
    const duplicate = manifestContent(6).replace('"revision": 6,', '"revision": 6,\n  "revision": 6,');
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
