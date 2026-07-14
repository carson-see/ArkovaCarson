import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import { normalizeForFingerprint } from './golden-dataset-s33-types.js';
import {
  WAVE1_CORPUS_SLICE_COUNTS,
  WAVE1_CREDENTIAL_TYPE_COUNTS,
  WAVE1_DOMAIN_COUNTS,
  WAVE1_ENTRY_IDS,
  WAVE1_SOURCE_BLOB_PATHS,
  WAVE1_TYPES_PATH,
} from './s33-batch-acceptance.js';
import {
  assertS33SourceParseDiagnostics,
  parseS33Wave1ProducerVerifierCliArgs,
  parseS33ProducerModule,
  runS33Wave1ProducerVerifierCli,
  verifyS33Wave1ProducerHead,
} from './s33-wave1-producer-verifier.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const TYPE_SEQUENCE = Object.entries(WAVE1_CREDENTIAL_TYPE_COUNTS)
  .flatMap(([type, count]) => type === 'OTHER' ? [] : Array<string>(count).fill(type));

function domainForId(id: string): string {
  if (id.includes('-OOD-')) return 'out-of-distribution';
  if (id.includes('-AU-') || id.includes('-KE-')) return 'au-ke-priority-documents';
  return 'professional-licensing';
}

function sourcePathForId(id: string): (typeof WAVE1_SOURCE_BLOB_PATHS)[number] {
  if (id.includes('-OOD-')) return 'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts';
  if (id.includes('-AU-') || id.includes('-KE-')) {
    return 'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts';
  }
  return 'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts';
}

function categoryForPath(path: string): string {
  if (path.includes('ood-negatives')) return 's33-ood-negative';
  if (path.includes('au-ke')) return 's33-au-ke-heldout';
  return 's33-licensing-heldout';
}

function entries(): Array<Record<string, unknown>> {
  let coveredIndex = 0;
  return WAVE1_ENTRY_IDS.map((id) => {
    const ood = id.includes('-OOD-');
    const credentialType = ood ? 'OTHER' : TYPE_SEQUENCE[coveredIndex++];
    return {
      id,
      description: `Synthetic verifier fixture ${id}`,
      strippedText: `Issuer Example ${id}. Recipient ID R-${id}. Issued 2026-01-01. Expires 2027-01-01. Jurisdiction Test.`,
      credentialTypeHint: credentialType,
      groundTruth: ood ? {
        credentialType: 'OTHER',
        subType: 'other',
        fraudSignals: [],
      } : {
        credentialType,
        subType: 'concrete_subtype',
        issuerName: `Issuer ${id}`,
        recipientIdentifier: `R-${id}`,
        issuedDate: '2026-01-01',
        expiryDate: '2027-01-01',
        jurisdiction: 'Test jurisdiction',
        fraudSignals: [],
      },
      source: `authored/test/${id}`,
      category: categoryForPath(sourcePathForId(id)),
      tags: ['held-out', 's33', 'test'],
      provenance: 'authored-s33-lane4',
      edgeCase: false,
      jurisdictionSlice: id.includes('-KE-') ? 'KE' : 'US',
    };
  });
}

function sourceModule(path: string, allEntries: readonly Record<string, unknown>[]): string {
  const exportName = path.includes('ood-negatives')
    ? 'S33_OOD_NEGATIVES'
    : path.includes('au-ke') ? 'S33_AU_KE_HELDOUT' : 'S33_LICENSING_HELDOUT';
  const moduleEntries = allEntries.filter((entry) => sourcePathForId(String(entry.id)) === path);
  return `export const ${exportName} = ${JSON.stringify(moduleEntries, null, 2)};\n`;
}

function selfChecks(
  revision: number,
  support: string,
  typesBlob: string,
): Record<string, unknown> {
  return {
    exactCorpusManifestDatasheetBijection: { status: 'PASS', entryCount: 81 },
    normalizedInputFingerprintsPinned: {
      status: 'PASS',
      algorithm: 'sha256(normalizeForFingerprint(strippedText))',
    },
    authorizedDocumentRevisions: {
      status: 'PASS',
      revisions: Array.from({ length: revision - 1 }, (_, index) => ({
        revision: index + 2,
        authority: 'test fixture authority',
      })),
    },
    withinTypeTokenOverlap: {
      status: 'PASS',
      threshold: 0.8,
      metric: 'test-only exact overlap metric',
      violations: [],
      remediatedPairScores: [],
    },
    oodFiveFieldSemantics: {
      status: 'BLOCKED_PROTOCOL_CONTRADICTION_CTO_L3',
      entryIds: WAVE1_ENTRY_IDS.slice(-9),
      producerTruth: 'Pure abstention fixture truth.',
      contradiction: 'Protocol contradiction fixture.',
      resolutionOwner: 'Lane 3 / CTO',
    },
    cpeSubtypeRatification: { status: 'BLOCKED_CTO_L3' },
    taxonomyAdjudicationSet: { status: 'BLOCKED_CTO_L3', entryIds: ['GD-S33-KE-003'] },
    issuedDateAdjudicationSet: { status: 'BLOCKED_CTO_L3', entryIds: ['GD-S33-BAR-010'] },
    batchScopeOnly: {
      status: 'PASS',
      excludedFromBatch: [
        '.sonarcloud.properties',
        'docs/lane4/s33-lane4-plan.md',
        'services/worker/src/ai/eval/golden-dataset-s33-heldout.test.ts',
        WAVE1_TYPES_PATH,
      ],
      protocolAllowedDiffPaths: [
        'docs/lane4/s33-corpus-datasheet.md',
        'docs/lane4/s33-wave1-batch-manifest.json',
        'docs/lane4/s33-wave1-entry-datasheet.json',
        'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
        'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
        'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
      ],
      dependency: {
        owner: 'Lane 3',
        branch: 'test/lane3-support',
        commit: support,
        typesPath: WAVE1_TYPES_PATH,
        typesBlob,
        presentIdenticallyInBase: true,
        includedInProducerDiff: false,
        reviewState: 'LANE3_TOOLING_EXACT_HEAD_REVIEW_PASS',
      },
      reason: 'Exact six-path test packet.',
      authority: 'Binding CTO protocol.',
    },
    lane3Acceptance: { status: 'NOT_RUN_PRODUCER_BOUNDARY' },
  };
}

interface FixtureOptions {
  coherentFalseParent?: boolean;
  coherentFalseSourceBlob?: boolean;
  coherentFalseTypesBlob?: boolean;
  extraChangedPath?: boolean;
  preexistingSourcePath?: (typeof WAVE1_SOURCE_BLOB_PATHS)[number];
  mutateEntries?: (entries: Array<Record<string, unknown>>) => void;
  mutateManifest?: (manifest: Record<string, unknown>) => void;
}

function fixture(options: FixtureOptions = {}): { head: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 's33-producer-verifier-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lane3-test@arkova.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lane3 Test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'initial\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  const initial = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const corpusEntries = entries();
  options.mutateEntries?.(corpusEntries);
  const typesPath = join(root, WAVE1_TYPES_PATH);
  mkdirSync(dirname(typesPath), { recursive: true });
  writeFileSync(typesPath, 'export interface TrustedLane3Types { readonly version: 1 }\n');
  if (options.preexistingSourcePath) {
    const absolute = join(root, options.preexistingSourcePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, sourceModule(options.preexistingSourcePath, corpusEntries));
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'trusted Lane3 support'], { cwd: root });
  const support = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const typesBlob = execFileSync('git', ['rev-parse', `${support}:${WAVE1_TYPES_PATH}`], {
    cwd: root, encoding: 'utf8',
  }).trim();

  for (const path of WAVE1_SOURCE_BLOB_PATHS) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, sourceModule(path, corpusEntries));
  }
  const sourceBlobs = Object.fromEntries(WAVE1_SOURCE_BLOB_PATHS.map((path) => [
    path,
    execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim(),
  ]));
  const manifestEntries = corpusEntries
    .filter((entry) => WAVE1_ENTRY_IDS.includes(String(entry.id)))
    .sort((left, right) => WAVE1_ENTRY_IDS.indexOf(String(left.id)) - WAVE1_ENTRY_IDS.indexOf(String(right.id)))
    .map((entry) => ({
      id: entry.id,
      domain: domainForId(String(entry.id)),
      credentialType: (entry.groundTruth as Record<string, unknown>).credentialType,
      normalizedInputSha256: sha256(normalizeForFingerprint(String(entry.strippedText))),
    }));
  const declaredTypesBlob = options.coherentFalseTypesBlob ? Object.values(sourceBlobs)[0] : typesBlob;
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision: 12,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_RESUBMISSION_BLOCKED_L3_REVIEW',
    corpusRevisionParentCommit: options.coherentFalseParent ? initial : support,
    producerRevisionPredecessorCommit: initial,
    lane3SupportBase: {
      commit: support,
      typesPath: WAVE1_TYPES_PATH,
      typesBlob: declaredTypesBlob,
      reviewState: 'LANE3_TOOLING_EXACT_HEAD_REVIEW_PASS',
    },
    corpusSourceBlobs: options.coherentFalseSourceBlob
      ? { ...sourceBlobs, [WAVE1_SOURCE_BLOB_PATHS[2]]: Object.values(sourceBlobs)[0] }
      : sourceBlobs,
    intendedSplit: 'held-out-candidate',
    reviewOrder: 'kenya-first',
    acceptanceScope: 'whole-batch-only',
    entryCount: 81,
    kenyaEntryIds: WAVE1_ENTRY_IDS.slice(0, 11),
    counts: {
      byDomain: { ...WAVE1_DOMAIN_COUNTS },
      byCredentialType: { ...WAVE1_CREDENTIAL_TYPE_COUNTS },
      byCorpusSlice: { ...WAVE1_CORPUS_SLICE_COUNTS },
    },
    selfChecks: selfChecks(12, support, declaredTypesBlob),
    entries: manifestEntries,
  };
  options.mutateManifest?.(manifest);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestDigest = sha256(manifestText);
  const entryRows = manifestEntries.map((entry) => ({
    id: entry.id,
    domain: entry.domain,
    realOrSynthetic: 'synthetic',
    authorshipMethod: 'independently-authored',
    generatorDerived: false,
    sourceProvenance: `test/${entry.id}`,
    lawfulBasis: 'test fixture',
    generator: {
      name: 'none-independent-human-authorship',
      version: 'not-applicable-no-generator',
      seed: 'not-applicable-no-rng',
      templateId: 'not-applicable-no-template',
    },
    jurisdiction: entry.domain === 'out-of-distribution' ? 'KE' : 'US',
    jurisdictionDetail: entry.domain === 'out-of-distribution' ? null : 'Test jurisdiction',
    credentialType: entry.credentialType,
    subType: entry.credentialType === 'OTHER' ? 'other' : 'concrete_subtype',
    curationAuthor: 'Lane 4 test fixture',
    curationDate: '2026-07-14',
    licenseConsentNote: 'test only',
  }));
  const entryDatasheet = {
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision: 12,
    manifestSha256: manifestDigest,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_RESUBMISSION_BLOCKED_L3_REVIEW',
    entryCount: 81,
    reviewOrder: 'kenya-first',
    acceptanceScope: 'whole-batch-only',
    authorshipNote: 'Independently authored test fixtures.',
    rows: entryRows,
  };
  const markdown = [
    '# S3.3 Golden Held-Out Corpus — Datasheet (Wave 1, Revision 12)',
    '',
    '**Revision 12:** trusted verifier test packet',
    '',
    `- Current producer revision: \`S33-W1\` revision 12; exact raw-file SHA-256 \`${manifestDigest}\`.`,
    '- The manifest and datasheet each contain exactly 81 unique rows in exact bijection with the corpus.',
    `- Shared type definitions: blob \`${(manifest.lane3SupportBase as Record<string, unknown>).typesBlob}\` on commit \`${support}\`.`,
    '',
    `Revision 12 has sole physical parent, direct base, and Lane-3 support commit \`${manifest.corpusRevisionParentCommit}\`; its logical producer predecessor is exact commit \`${initial}\`.`,
    '',
  ].join('\n');
  for (const [path, content] of [
    ['docs/lane4/s33-wave1-batch-manifest.json', manifestText],
    ['docs/lane4/s33-wave1-entry-datasheet.json', `${JSON.stringify(entryDatasheet, null, 2)}\n`],
    ['docs/lane4/s33-corpus-datasheet.md', markdown],
  ]) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  if (options.extraChangedPath) {
    writeFileSync(join(root, 'smuggled-runtime.ts'), 'export const smuggled = true;\n');
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'Wave-1 producer'], { cwd: root });
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    root,
  };
}

describe('trusted-main S3.3 Wave-1 producer verifier', { timeout: 30_000 }, () => {
  it('parses only a literal exported array graph and never executes producer code', () => {
    const source = [
      'globalThis.__producerExecuted = true;',
      'const LEFT = [{ id: "A", value: 1 }];',
      'const RIGHT = [{ id: "B", value: 2 }];',
      'export const DATA = [...LEFT, ...RIGHT];',
    ].join('\n');
    expect(parseS33ProducerModule(source, 'fixture.ts', 'DATA')).toEqual([
      { id: 'A', value: 1 },
      { id: 'B', value: 2 },
    ]);
    expect((globalThis as Record<string, unknown>).__producerExecuted).toBeUndefined();
    expect(() => parseS33ProducerModule(
      'const x = [{id:"A"}]; export const DATA = make(x);',
      'computed.ts',
      'DATA',
    )).toThrow(/literal array graph/i);
    expect(() => parseS33ProducerModule(
      'export let DATA = [{id:"A"}];',
      'mutable-export.ts',
      'DATA',
    )).toThrow(/directly export const/i);
    expect(() => parseS33ProducerModule(
      'let LEFT = [{id:"A"}]; export const DATA = [...LEFT];',
      'mutable-helper.ts',
      'DATA',
    )).toThrow(/LEFT.*declared const/i);
    expect(() => parseS33ProducerModule(
      'export const DATA = [{id:"A"};',
      'invalid-syntax.ts',
      'DATA',
    )).toThrow(/parse diagnostics/i);

    const doubling = ['const A0 = [{id:"A"}];'];
    for (let index = 1; index <= 7; index += 1) {
      doubling.push(`const A${index} = [...A${index - 1}, ...A${index - 1}];`);
    }
    doubling.push('export const DATA = [...A7];');
    expect(() => parseS33ProducerModule(
      doubling.join('\n'),
      'over-budget.ts',
      'DATA',
    )).toThrow(/maximum 81-row/i);

    const actualSource = ts.createSourceFile(
      'api-unavailable.ts',
      'export const DATA = [];',
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const sourceWithoutDiagnostics = new Proxy(actualSource, {
      get(target, property, receiver) {
        return property === 'parseDiagnostics' ? undefined : Reflect.get(target, property, receiver);
      },
    });
    expect(() => assertS33SourceParseDiagnostics(
      sourceWithoutDiagnostics,
      'api-unavailable.ts',
    )).toThrow(/diagnostics API is unavailable/i);
  });

  it('derives Git provenance and accepts exactly 81=72 covered+9 OOD literal rows', () => {
    const repo = fixture();
    const report = verifyS33Wave1ProducerHead({ repositoryRoot: repo.root, producerHeadSha: repo.head });
    expect(report).toMatchObject({
      producerHeadSha: repo.head,
      counts: { total: 81, covered: 72, ood: 9 },
    });
    expect(report.entries).toHaveLength(81);
    expect(report.entries.at(-10)).toMatchObject({ kind: 'covered', postValidationDepth: 5 });
    expect(report.entries.at(-1)).toMatchObject({ id: 'GD-S33-OOD-009', kind: 'ood-abstention' });
    const { reportDigestSha256, ...withoutDigest } = report;
    expect(reportDigestSha256).toBe(sha256(canonicaliseJson(withoutDigest)));
    expect(() => {
      (report.counts as { covered: number }).covered = 0;
    }).toThrow(TypeError);

    const output: string[] = [];
    const cliReport = runS33Wave1ProducerVerifierCli([
      'verify',
      '--repository-root', repo.root,
      '--producer-head', repo.head,
    ], (message) => output.push(message));
    expect(cliReport.reportDigestSha256).toBe(report.reportDigestSha256);
    expect(output).toEqual([
      expect.stringMatching(/^S3\.3 Wave-1 producer verifier: PASS .*reportDigestSha256=[0-9a-f]{64}\n$/u),
    ]);
  });

  it('requires one explicit verify command and exact unique CLI flags', () => {
    const head = 'a'.repeat(40);
    expect(parseS33Wave1ProducerVerifierCliArgs([
      'verify', '--repository-root', '/tmp/repository.git', '--producer-head', head,
    ])).toEqual({ repositoryRoot: '/tmp/repository.git', producerHeadSha: head });
    for (const invalid of [
      ['--repository-root', '/tmp/repository.git', '--producer-head', head],
      ['accept', '--repository-root', '/tmp/repository.git', '--producer-head', head],
      ['verify', 'verify', '--repository-root', '/tmp/repository.git', '--producer-head', head],
      ['verify', '--repository-root', '/tmp/repository.git'],
      ['verify', '--repository-root', '/tmp/repository.git', '--repository-root', '/tmp/other', '--producer-head', head],
      ['verify', '--repository-root', '/tmp/repository.git', '--producer-head', head, '--unexpected', 'value'],
    ]) {
      expect(() => parseS33Wave1ProducerVerifierCliArgs(invalid)).toThrow(/explicit verify|invalid|duplicated|mismatch/i);
    }
  });

  it('rejects a shallow late covered row and malformed late OOD row', () => {
    const shallow = fixture({
      mutateEntries(allEntries): void {
        delete (allEntries.find(({ id }) => id === 'GD-S33-AU-011')!.groundTruth as Record<string, unknown>).jurisdiction;
      },
    });
    expect(() => verifyS33Wave1ProducerHead({ repositoryRoot: shallow.root, producerHeadSha: shallow.head }))
      .toThrow(/AU-011.*post-validation.*below minimum 5/i);

    const paddedOod = fixture({
      mutateEntries(allEntries): void {
        (allEntries.find(({ id }) => id === 'GD-S33-OOD-009')!.groundTruth as Record<string, unknown>).issuerName = 'padding';
      },
    });
    expect(() => verifyS33Wave1ProducerHead({ repositoryRoot: paddedOod.root, producerHeadSha: paddedOod.head }))
      .toThrow(/OOD-009.*exactly credentialType=OTHER/i);
  });

  it.each([
    ['omission', (allEntries: Array<Record<string, unknown>>) => { allEntries.pop(); }],
    ['surplus', (allEntries: Array<Record<string, unknown>>) => {
      allEntries.push({
        ...allEntries[0],
        id: 'GD-S33-SURPLUS-001',
        category: 's33-licensing-heldout',
      });
    }],
    ['duplicate', (allEntries: Array<Record<string, unknown>>) => { allEntries.push({ ...allEntries[0] }); }],
  ] as const)('rejects producer-universe %s even when the module remains parseable', (_case, mutateEntries) => {
    const repo = fixture({ mutateEntries });
    expect(() => verifyS33Wave1ProducerHead({ repositoryRoot: repo.root, producerHeadSha: repo.head }))
      .toThrow(/81-(?:id|entry) universe|duplicate entry ids/i);
  });

  it('rejects falsified manifest count maps after mirrors are coherently rehashed', () => {
    const repo = fixture({
      mutateManifest(manifest): void {
        ((manifest.counts as Record<string, unknown>).byDomain as Record<string, number>)['professional-licensing'] = 49;
      },
    });
    expect(() => verifyS33Wave1ProducerHead({ repositoryRoot: repo.root, producerHeadSha: repo.head }))
      .toThrow(/domain counts.*complete entries universe|count map/i);
  });

  it.each([
    ['unknown top-level key', (manifest: Record<string, unknown>) => { manifest.unreviewed = true; }, /unknown field/i],
    ['false split', (manifest: Record<string, unknown>) => { manifest.intendedSplit = 'training'; }, /intendedSplit/i],
    ['false Kenya declaration', (manifest: Record<string, unknown>) => {
      manifest.kenyaEntryIds = [...WAVE1_ENTRY_IDS.slice(0, 11)].reverse();
    }, /declared Kenya ids/i],
    ['false Kenya domain', (manifest: Record<string, unknown>) => {
      ((manifest.entries as Array<Record<string, unknown>>)[0]).domain = 'professional-licensing';
    }, /Kenya entries.*au-ke/i],
    ['false OOD domain', (manifest: Record<string, unknown>) => {
      ((manifest.entries as Array<Record<string, unknown>>).at(-1)!).domain = 'professional-licensing';
    }, /domain-bound OOD ids/i],
    ['false support review state', (manifest: Record<string, unknown>) => {
      (manifest.lane3SupportBase as Record<string, unknown>).reviewState = 'PENDING';
    }, /lane3SupportBase\.reviewState/i],
    ['false acceptance self-check', (manifest: Record<string, unknown>) => {
      const checks = manifest.selfChecks as Record<string, Record<string, unknown>>;
      checks.lane3Acceptance.status = 'PASS';
    }, /Lane-3 acceptance status/i],
  ] as const)('rejects strict active-manifest violation: %s', (_case, mutateManifest, error) => {
    const repo = fixture({ mutateManifest });
    expect(() => verifyS33Wave1ProducerHead({ repositoryRoot: repo.root, producerHeadSha: repo.head }))
      .toThrow(error);
  });

  it.each([
    ['parent', { coherentFalseParent: true }, /actual producer parent/i],
    ['types blob', { coherentFalseTypesBlob: true }, /types blob does not match Git/i],
    ['source blob', { coherentFalseSourceBlob: true }, /source blob does not match Git/i],
  ] as const)('rejects a coherent-repin %s lie because Git is the proof source', (_case, options, error) => {
    const repo = fixture(options);
    expect(() => verifyS33Wave1ProducerHead({ repositoryRoot: repo.root, producerHeadSha: repo.head }))
      .toThrow(error);
  });

  it.each([
    ['extra-path smuggle', { extraChangedPath: true }],
    ['missing packet path', { preexistingSourcePath: WAVE1_SOURCE_BLOB_PATHS[0] }],
  ] as const)('rejects an exact-diff violation: %s', (_case, options) => {
    const repo = fixture(options);
    expect(() => verifyS33Wave1ProducerHead({ repositoryRoot: repo.root, producerHeadSha: repo.head }))
      .toThrow(/exactly the six protocol packet paths/i);
  });
});
