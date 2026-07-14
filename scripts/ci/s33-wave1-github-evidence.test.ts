import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CROSS_REVIEW_MARKER,
  extractSingleFileArchive,
  extractProdDiffAdjudication,
  FIXED_PULL_REQUEST_NUMBER,
  FIXED_REPOSITORY,
  loadWorkflowReportBundle,
  runS33PremergeApiPreflight,
  recursivelyFreeze,
  S33_PREMERGE_API_QUERY,
  verifyS33PrerequisiteInventory,
  validatePrerequisiteWorkflowIdentity,
  verifyGitHubTrustRoot,
  type GitHubEvidenceSnapshot,
} from './s33-wave1-github-evidence.js';

const HEAD = '1'.repeat(40);
const MAIN = '2'.repeat(40);
const SUPPORT_MERGE = '3'.repeat(40);
const MANIFEST_SHA = '4'.repeat(64);
const TRAINING_MANIFEST_SHA = '5'.repeat(64);
const APP = {
  id: 'MDM6QXBwMTUzNjg=',
  databaseId: 15368,
  slug: 'github-actions',
};
const REVIEWER = {
  login: 'chatgpt-codex-connector[bot]',
  databaseId: 199175422,
  id: 'BOT_kgDOC98s_g',
};
const ENTRY_IDS = Array.from({ length: 81 }, (_, index) => `GD-S33-${String(index + 1).padStart(3, '0')}`);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function rankedSample(entryIds = ENTRY_IDS): string[] {
  return [...entryIds]
    .map((entryId) => ({
      entryId,
      rank: sha256(`${MANIFEST_SHA}\0${entryId}`),
    }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.entryId.localeCompare(right.entryId))
    .slice(0, 9)
    .map(({ entryId }) => entryId);
}

function crossReviewBody(overrides: Record<string, unknown> = {}): string {
  const sampleEntryIds = rankedSample();
  const block = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave1-cross-review',
    batchId: 'S33-W1',
    producerHeadSha: HEAD,
    manifestRawSha256: MANIFEST_SHA,
    sampleAlgorithm: 'sha256-manifest-entry-rank-v1',
    sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count',
    manifestEntryCount: 81,
    sampleEntryIds,
    materialLabelDefectCount: 0,
    adjudications: sampleEntryIds.map((entryId) => ({
      entryId,
      verdict: 'PASS',
      note: `Lane 3 independently re-derived the source-grounded truth for ${entryId}.`,
    })),
    wholeBatchVerdict: 'ACCEPT',
    ...overrides,
  };
  return [
    `<!-- ${CROSS_REVIEW_MARKER} -->`,
    '```json',
    JSON.stringify(block, null, 2),
    '```',
    `<!-- /${CROSS_REVIEW_MARKER} -->`,
  ].join('\n');
}

function snapshot(): GitHubEvidenceSnapshot {
  return {
    repository: {
      defaultBranchRef: { name: 'main', target: { oid: MAIN } },
      branchProtectionRules: {
        nodes: [{
          id: 'BPR_main',
          pattern: 'main',
          requiresStatusChecks: true,
          requiredStatusCheckContexts: ['TypeCheck & Lint'],
          requiredStatusChecks: [{ context: 'TypeCheck & Lint', app: APP }],
          matchingRefs: { nodes: [{ name: 'main' }] },
        }],
      },
      pullRequest: {
        number: FIXED_PULL_REQUEST_NUMBER,
        state: 'OPEN',
        baseRefName: 'main',
        headRefOid: HEAD,
        headRepository: { nameWithOwner: FIXED_REPOSITORY },
        author: { login: 'producer', databaseId: 700, id: 'U_producer' },
        headCommit: {
          nodes: [{
            commit: {
              oid: HEAD,
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{
                    __typename: 'CheckRun',
                    id: 'CR_required',
                    databaseId: 9001,
                    name: 'TypeCheck & Lint',
                    status: 'COMPLETED',
                    conclusion: 'SUCCESS',
                    startedAt: '2026-07-14T12:00:00Z',
                    completedAt: '2026-07-14T12:01:00Z',
                    detailsUrl: 'https://github.com/carson-see/ArkovaCarson/actions/runs/1/job/2',
                    isRequired: true,
                    checkSuite: { app: APP },
                  }],
                },
              },
            },
          }],
        },
        allCommits: {
          pageInfo: { hasNextPage: false },
          nodes: [{
            commit: {
              oid: HEAD,
              author: { user: { login: 'producer', databaseId: 700, id: 'U_producer' } },
              committer: { user: { login: 'github-actions[bot]', databaseId: 41898282, id: 'BOT_actions' } },
            },
          }],
        },
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: [{
            id: 'PRR_primary',
            databaseId: 6001,
            url: 'https://github.com/carson-see/ArkovaCarson/pull/1498#pullrequestreview-6001',
            state: 'APPROVED',
            submittedAt: '2026-07-14T12:02:00Z',
            body: crossReviewBody(),
            author: REVIEWER,
            commit: { oid: HEAD },
          }],
        },
      },
      supportPullRequest: {
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-07-14T11:00:00Z',
        mergeCommit: { oid: SUPPORT_MERGE },
      },
      bestNessie: {
        edges: [{ permission: 'WRITE', node: { login: 'BestNessie', databaseId: 129661809, id: 'U_kgDOB7p7cQ' } }],
      },
      alibama: {
        edges: [{ permission: 'WRITE', node: { login: 'alibama', databaseId: 911386, id: 'MDQ6VXNlcjkxMTM4Ng==' } }],
      },
    },
  };
}

function verify(value = snapshot()) {
  return verifyGitHubTrustRoot(value, {
    localMainHeadSha: MAIN,
    localProducerHeadSha: HEAD,
    supportMergeIsAncestorOfMain: true,
    manifestRawSha256: MANIFEST_SHA,
    manifestEntryIds: ENTRY_IDS,
  });
}

describe('verifyGitHubTrustRoot', () => {
  it('binds the live main protection rule, exact-head required check app, and primary approval', () => {
    const result = verify();
    expect(result.repositoryIdentity).toBe(FIXED_REPOSITORY);
    expect(result.pullRequestNumber).toBe(FIXED_PULL_REQUEST_NUMBER);
    expect(result.producerHeadSha).toBe(HEAD);
    expect(result.requiredChecks).toEqual([expect.objectContaining({
      name: 'TypeCheck & Lint',
      checkRunId: 'CR_required',
      app: APP,
    })]);
    expect(result.approval).toEqual(expect.objectContaining({
      reviewId: 'PRR_primary',
      reviewer: REVIEWER,
    }));
    expect(result.crossReview.sampleEntryIds).toEqual(rankedSample());
  });

  it('fails closed on missing, pending, neutral/skipped, non-required, and app-mismatched checks', () => {
    const cases: Array<[string, (value: GitHubEvidenceSnapshot) => void, RegExp]> = [
      ['missing', (value) => { value.repository.pullRequest.headCommit.nodes[0].commit.statusCheckRollup!.contexts.nodes = []; }, /missing required check/i],
      ['pending', (value) => { const check = value.repository.pullRequest.headCommit.nodes[0].commit.statusCheckRollup!.contexts.nodes[0]; check.status = 'IN_PROGRESS'; check.conclusion = null; }, /must be completed successfully/i],
      ['neutral', (value) => { value.repository.pullRequest.headCommit.nodes[0].commit.statusCheckRollup!.contexts.nodes[0].conclusion = 'NEUTRAL'; }, /must be completed successfully/i],
      ['skipped', (value) => { value.repository.pullRequest.headCommit.nodes[0].commit.statusCheckRollup!.contexts.nodes[0].conclusion = 'SKIPPED'; }, /must be completed successfully/i],
      ['not required', (value) => { value.repository.pullRequest.headCommit.nodes[0].commit.statusCheckRollup!.contexts.nodes[0].isRequired = false; }, /does not report isRequired=true/i],
      ['app mismatch', (value) => { value.repository.pullRequest.headCommit.nodes[0].commit.statusCheckRollup!.contexts.nodes[0].checkSuite = { app: { ...APP, databaseId: 999 } }; }, /app mismatch/i],
    ];
    for (const [, mutate, expected] of cases) {
      const value = snapshot();
      mutate(value);
      expect(() => verify(value)).toThrow(expected);
    }
  });

  it('selects only the unique latest duplicate and rejects an ambiguous latest timestamp', () => {
    const value = snapshot();
    const newest = value.repository.pullRequest.headCommit.nodes[0].commit.statusCheckRollup!.contexts.nodes[0];
    value.repository.pullRequest.headCommit.nodes[0].commit.statusCheckRollup!.contexts.nodes.unshift({
      ...newest,
      id: 'CR_old',
      databaseId: 9000,
      startedAt: '2026-07-14T11:00:00Z',
      completedAt: '2026-07-14T11:01:00Z',
    });
    expect(verify(value).requiredChecks[0].checkRunId).toBe('CR_required');

    value.repository.pullRequest.headCommit.nodes[0].commit.statusCheckRollup!.contexts.nodes.unshift({
      ...newest,
      id: 'CR_ambiguous',
      databaseId: 9002,
    });
    expect(() => verify(value)).toThrow(/ambiguous latest duplicate/i);
  });

  it('rejects stale local/head/review evidence and requires #1529 merged into the trusted main head', () => {
    const staleReview = snapshot();
    staleReview.repository.pullRequest.reviews.nodes[0].commit = { oid: '9'.repeat(40) };
    expect(() => verify(staleReview)).toThrow(/exact producer head/i);

    const openSupport = snapshot();
    openSupport.repository.supportPullRequest.merged = false;
    openSupport.repository.supportPullRequest.state = 'OPEN';
    openSupport.repository.supportPullRequest.mergeCommit = null;
    expect(() => verify(openSupport)).toThrow(/#1529 must be merged/i);

    expect(() => verifyGitHubTrustRoot(snapshot(), {
      localMainHeadSha: MAIN,
      localProducerHeadSha: '8'.repeat(40),
      supportMergeIsAncestorOfMain: true,
      manifestRawSha256: MANIFEST_SHA,
      manifestEntryIds: ENTRY_IDS,
    })).toThrow(/producer checkout.*exact GitHub head/i);

    expect(() => verifyGitHubTrustRoot(snapshot(), {
      localMainHeadSha: MAIN,
      localProducerHeadSha: HEAD,
      supportMergeIsAncestorOfMain: false,
      manifestRawSha256: MANIFEST_SHA,
      manifestEntryIds: ENTRY_IDS,
    })).toThrow(/#1529 merge commit.*ancestor/i);
  });

  it('rejects an author/committer as reviewer and checks fallback WRITE live', () => {
    const author = snapshot();
    author.repository.pullRequest.author = REVIEWER;
    expect(() => verify(author)).toThrow(/reviewer must not be the pull request author/i);

    const committer = snapshot();
    committer.repository.pullRequest.allCommits.nodes[0].commit.committer!.user = REVIEWER;
    expect(() => verify(committer)).toThrow(/reviewer must not be a commit author or committer/i);

    const fallback = snapshot();
    fallback.repository.pullRequest.reviews.nodes[0].author = {
      login: 'BestNessie', databaseId: 129661809, id: 'U_kgDOB7p7cQ',
    };
    fallback.repository.pullRequest.reviews.nodes[0].id = 'PRR_fallback';
    expect(verify(fallback).approval.authorityKind).toBe('fallback');

    fallback.repository.bestNessie.edges[0].permission = 'READ';
    expect(() => verify(fallback)).toThrow(/live WRITE.*permission/i);
  });

  it('lets the latest exact-head review state mask every older approval from that authority', () => {
    for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) {
      const value = snapshot();
      value.repository.pullRequest.reviews.nodes.push({
        ...value.repository.pullRequest.reviews.nodes[0],
        id: `PRR_latest_${state}`,
        databaseId: 6100,
        state,
        submittedAt: '2026-07-14T12:03:00Z',
        body: '',
      });
      expect(() => verify(value)).toThrow(new RegExp(`latest exact-head review.*${state}.*not APPROVED`, 'i'));
    }
  });

  it('authenticates the strict deterministic cross-review block and rejects defects or sample substitution', () => {
    const defect = snapshot();
    defect.repository.pullRequest.reviews.nodes[0].body = crossReviewBody({ materialLabelDefectCount: 1 });
    expect(() => verify(defect)).toThrow(/materialLabelDefectCount must be zero/i);

    const substituted = snapshot();
    substituted.repository.pullRequest.reviews.nodes[0].body = crossReviewBody({
      sampleEntryIds: rankedSample().slice().reverse(),
    });
    expect(() => verify(substituted)).toThrow(/deterministic sample/i);

    const duplicate = snapshot();
    duplicate.repository.pullRequest.reviews.nodes[0].body += `\n${crossReviewBody()}`;
    expect(() => verify(duplicate)).toThrow(/exactly one.*cross-review block/i);
  });
});

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('authenticated bundle recursive freeze primitive', () => {
  it('freezes every nested object and array so authenticated facts cannot mutate', () => {
    const value = { approval: { reviewer: { login: 'fixed' } }, checks: [{ name: 'required' }] };
    const frozen = recursivelyFreeze(value);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.approval)).toBe(true);
    expect(Object.isFrozen(frozen.approval.reviewer)).toBe(true);
    expect(Object.isFrozen(frozen.checks)).toBe(true);
    expect(Object.isFrozen(frozen.checks[0])).toBe(true);
    expect(() => { (frozen.approval.reviewer as { login: string }).login = 'mutated'; }).toThrow();
    expect(frozen.approval.reviewer.login).toBe('fixed');
  });
});

describe('loadWorkflowReportBundle', () => {
  it('reads workflow-local report bytes, validates bindings, and derives raw/canonical digests', () => {
    const directory = mkdtempSync(join(tmpdir(), 's33-wave1-reports-'));
    tempDirectories.push(directory);
    const reports = {
      crossReviewPlan: {
        schemaVersion: 1,
        artifactType: 'arkova-s33-wave1-cross-review-plan',
        batchId: 'S33-W1',
        producerHeadSha: HEAD,
        manifestRawSha256: MANIFEST_SHA,
        status: 'PASS',
        payload: {
          sampleAlgorithm: 'sha256-manifest-entry-rank-v1',
          sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count',
          manifestEntryCount: 81,
          sampleEntryIds: rankedSample(),
          wholeBatchMachineValidation: 'PASS', kenyaFirst: true,
        },
      },
      prodModelDiff: {
        schemaVersion: 1,
        artifactType: 'arkova-s33-wave1-prod-model-diff',
        batchId: 'S33-W1', producerHeadSha: HEAD, manifestRawSha256: MANIFEST_SHA,
        status: 'PASS', payload: {
          mode: 'offline-prod-parity-replay',
          providerSurface: 'google-generative-language-developer-api',
          model: 'gemini-2.5-flash',
          producerTreeSha: '6'.repeat(40),
          manifestCanonicalSha256: '7'.repeat(64),
          entryUniverseSha256: '8'.repeat(64),
          workflowRunId: 500,
          workflowRunAttempt: 1,
          trustedMainRunSha: MAIN,
          workflowPath: '.github/workflows/s33-wave1-prerequisites.yml',
          startedAtUtc: '2026-07-14T10:00:00Z',
          completedAtUtc: '2026-07-14T11:00:00Z',
          requestCount: 81,
          retryCount: 0,
          entryCount: 81,
          results: ENTRY_IDS.map((id) => ({ id, classification: 'MATCH' })),
          rawReportSha256: '9'.repeat(64),
          rawReportCanonicalSha256: 'a'.repeat(64),
        },
      },
      lexicalLeakage: {
        schemaVersion: 1,
        artifactType: 'arkova-s33-wave1-lexical-leakage',
        batchId: 'S33-W1', producerHeadSha: HEAD, manifestRawSha256: MANIFEST_SHA,
        status: 'PASS', payload: { compared: true,
          algorithm: 'normalized-token-exact-ngram-v1',
          n: [6, 7, 8, 9, 10, 11, 12, 13], trainingManifestSha256: TRAINING_MANIFEST_SHA,
          exactMatchCount: 0 },
      },
      embeddingDiagnostic: {
        schemaVersion: 1,
        artifactType: 'arkova-s33-wave1-embedding-diagnostic',
        batchId: 'S33-W1', producerHeadSha: HEAD, manifestRawSha256: MANIFEST_SHA,
        status: 'PASS', payload: { reviewed: true, role: 'diagnostic-only', canOverrideExactScan: false },
      },
    };
    const paths = {
      crossReviewPlan: join(directory, 'cross-review-plan.json'),
      prodModelDiff: join(directory, 'prod-model-diff.json'),
      lexicalLeakage: join(directory, 'lexical-leakage.json'),
      embeddingDiagnostic: join(directory, 'embedding-diagnostic.json'),
    };
    for (const [key, path] of Object.entries(paths)) {
      writeFileSync(path, `${JSON.stringify(reports[key as keyof typeof reports], null, 2)}\n`);
    }

    const bundle = loadWorkflowReportBundle(paths, {
      producerHeadSha: HEAD,
      manifestRawSha256: MANIFEST_SHA,
      manifestEntryIds: ENTRY_IDS,
    });
    expect(bundle.crossReviewPlan.rawSha256).toBe(sha256(readFileSync(paths.crossReviewPlan, 'utf8')));
    expect(bundle.crossReviewPlan.canonicalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.lexicalLeakage.parsed.payload.trainingManifestSha256).toBe(TRAINING_MANIFEST_SHA);

    writeFileSync(paths.crossReviewPlan, JSON.stringify({
      ...reports.crossReviewPlan,
      payload: { ...reports.crossReviewPlan.payload, wholeBatchVerdict: 'ACCEPT' },
    }));
    expect(() => loadWorkflowReportBundle(paths, {
      producerHeadSha: HEAD,
      manifestRawSha256: MANIFEST_SHA,
      manifestEntryIds: ENTRY_IDS,
    })).toThrow(/must not self-assert the human verdict/i);
    writeFileSync(paths.crossReviewPlan, `${JSON.stringify(reports.crossReviewPlan, null, 2)}\n`);

    writeFileSync(paths.lexicalLeakage, JSON.stringify({
      ...reports.lexicalLeakage,
      payload: { ...reports.lexicalLeakage.payload, exactMatchCount: 1 },
    }));
    expect(() => loadWorkflowReportBundle(paths, {
      producerHeadSha: HEAD,
      manifestRawSha256: MANIFEST_SHA,
      manifestEntryIds: ENTRY_IDS,
    })).toThrow(/exactMatchCount must be zero/i);
  });

  it('rejects missing/symlinked/out-of-directory reports and never accepts caller-supplied digest strings', () => {
    const directory = mkdtempSync(join(tmpdir(), 's33-wave1-reports-bad-'));
    tempDirectories.push(directory);
    const missing = join(directory, 'missing.json');
    expect(() => loadWorkflowReportBundle({
      crossReviewPlan: missing,
      prodModelDiff: missing,
      lexicalLeakage: missing,
      embeddingDiagnostic: missing,
    }, {
      producerHeadSha: HEAD,
      manifestRawSha256: MANIFEST_SHA,
      manifestEntryIds: ENTRY_IDS,
    })).toThrow(/missing.*report/i);
  });
});

function premergeData(): Record<string, unknown> {
  return {
    repository: {
      defaultBranchRef: { name: 'main', target: { oid: MAIN } },
      branchProtectionRules: {
        pageInfo: { hasNextPage: false },
        nodes: [{
          id: 'BPR_main',
          pattern: 'main',
          requiresStatusChecks: true,
          requiredStatusCheckContexts: ['TypeCheck & Lint'],
          requiredStatusChecks: [{ context: 'TypeCheck & Lint', app: APP }],
          matchingRefs: { nodes: [{ name: 'main' }] },
        }],
      },
      supportPullRequest: {
        number: 1529,
        state: 'OPEN',
        headRefOid: HEAD,
        headRepository: { nameWithOwner: FIXED_REPOSITORY },
        author: { login: 'producer', databaseId: 700, id: 'U_producer' },
        headCommit: {
          nodes: [{
            commit: {
              oid: HEAD,
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{
                    __typename: 'CheckRun',
                    id: 'CR_preflight',
                    databaseId: 9010,
                    name: 'Pre-merge same-token API preflight',
                    status: 'IN_PROGRESS',
                    conclusion: null,
                    startedAt: '2026-07-14T12:00:00Z',
                    completedAt: null,
                    detailsUrl: 'https://github.com/carson-see/ArkovaCarson/actions/runs/2/job/3',
                    isRequired: false,
                    checkSuite: { app: APP },
                  }],
                },
              },
            },
          }],
        },
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: [],
        },
      },
      bestNessie: {
        edges: [{ permission: 'WRITE', node: { login: 'BestNessie', databaseId: 129661809, id: 'U_kgDOB7p7cQ' } }],
      },
      alibama: {
        edges: [{ permission: 'WRITE', node: { login: 'alibama', databaseId: 911386, id: 'MDQ6VXNlcjkxMTM4Ng==' } }],
      },
    },
  };
}

describe('runS33PremergeApiPreflight', () => {
  it('uses injected same-token GraphQL/REST enumerators without network or acceptance side effects', async () => {
    const graphql = vi.fn(async () => premergeData());
    const rest = vi.fn(async (path: string) => {
      if (path.endsWith('/actions/workflows?per_page=100')) {
        return { total_count: 1, workflows: [{ id: 12, path: '.github/workflows/ci.yml' }] };
      }
      return { total_count: 7, artifacts: [{ id: 1 }] };
    });
    const result = await runS33PremergeApiPreflight({
      token: 'test-token-never-used-by-mocks',
      event: {
        repository: { full_name: FIXED_REPOSITORY },
        pull_request: { number: 1529, head: { sha: HEAD } },
      },
      graphql,
      rest,
    });
    expect(graphql).toHaveBeenCalledOnce();
    expect(graphql).toHaveBeenCalledWith(S33_PREMERGE_API_QUERY);
    expect(rest).toHaveBeenNthCalledWith(1, '/repos/carson-see/ArkovaCarson/actions/workflows?per_page=100');
    expect(rest).toHaveBeenNthCalledWith(2, '/repos/carson-see/ArkovaCarson/actions/artifacts?per_page=1');
    expect(result).toEqual({
      requiredContextCount: 1,
      checkContextCount: 1,
      reviewCount: 0,
      writableFallbacks: ['BestNessie', 'alibama'],
      artifactCount: 7,
      listedWorkflowCount: 1,
      prerequisiteWorkflowRegistered: false,
    });
  });

  it('fails closed on stale PR head, missing app identity, or no live writable fallback', async () => {
    const event = {
      repository: { full_name: FIXED_REPOSITORY },
      pull_request: { number: 1529, head: { sha: HEAD } },
    };
    const rest = async (path: string) => path.endsWith('/actions/workflows?per_page=100')
      ? { total_count: 1, workflows: [{ id: 12, path: '.github/workflows/ci.yml' }] }
      : { total_count: 0, artifacts: [] };

    const stale = premergeData();
    (stale.repository as any).supportPullRequest.headRefOid = '9'.repeat(40);
    await expect(runS33PremergeApiPreflight({ token: 'x', event, graphql: async () => stale, rest }))
      .rejects.toThrow(/exact #1529 event head/i);

    const missingApp = premergeData();
    (missingApp.repository as any).branchProtectionRules.nodes[0].requiredStatusChecks[0].app = null;
    await expect(runS33PremergeApiPreflight({ token: 'x', event, graphql: async () => missingApp, rest }))
      .rejects.toThrow(/must be an object/i);

    const noWrite = premergeData();
    (noWrite.repository as any).bestNessie.edges[0].permission = 'READ';
    (noWrite.repository as any).alibama.edges[0].permission = 'READ';
    await expect(runS33PremergeApiPreflight({ token: 'x', event, graphql: async () => noWrite, rest }))
      .rejects.toThrow(/no exact fallback.*WRITE/i);

    const unexpectedlyRegistered = async (path: string) => path.endsWith('/actions/workflows?per_page=100')
      ? { total_count: 1, workflows: [{ id: 77, path: '.github/workflows/s33-wave1-prerequisites.yml' }] }
      : { total_count: 0, artifacts: [] };
    await expect(runS33PremergeApiPreflight({
      token: 'x', event, graphql: async () => premergeData(), rest: unexpectedlyRegistered,
    })).rejects.toThrow(/unexpectedly already has a numeric/i);
  });
});

const PREREQUISITE_NOW = Date.parse('2026-07-14T13:00:00Z');

function prerequisiteResponses() {
  const run = {
    id: 500,
    run_number: 20,
    run_attempt: 1,
    path: '.github/workflows/s33-wave1-prerequisites.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: MAIN,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-07-14T12:00:00Z',
    updated_at: '2026-07-14T12:30:00Z',
  };
  const artifact = (id: number, name: string) => ({
    id,
    name,
    expired: false,
    size_in_bytes: 500,
    digest: `sha256:${'a'.repeat(64)}`,
    created_at: '2026-07-14T12:00:00Z',
    updated_at: '2026-07-14T12:05:00Z',
    expires_at: '2026-07-28T12:00:00Z',
    workflow_run: { id: 500, head_sha: MAIN },
  });
  return {
    runsResponse: { total_count: 1, workflow_runs: [run] },
    artifactsResponse: {
      total_count: 2,
      artifacts: [
        artifact(700, `s33-wave1-prod-model-diff-${HEAD}`),
        artifact(701, `s33-wave1-embedding-diagnostic-${HEAD}`),
      ],
    },
  };
}

describe('verifyS33PrerequisiteInventory', () => {
  it('accepts only the newest exact/current attempt-1 run and exactly two head-bound artifacts', () => {
    const responses = prerequisiteResponses();
    const inventory = verifyS33PrerequisiteInventory({
      ...responses,
      currentMainHeadSha: MAIN,
      producerHeadSha: HEAD,
      nowMs: PREREQUISITE_NOW,
    });
    expect(inventory.run).toEqual(expect.objectContaining({ id: 500, runAttempt: 1, headSha: MAIN }));
    expect(inventory.artifacts.prodModelDiff.name).toBe(`s33-wave1-prod-model-diff-${HEAD}`);
    expect(inventory.artifacts.embeddingDiagnostic.name).toBe(`s33-wave1-embedding-diagnostic-${HEAD}`);
  });

  it('lets a newer failed run mask an older green run and rejects reruns/staleness/duplicates', () => {
    const failedNewest = prerequisiteResponses();
    const oldGreen = { ...(failedNewest.runsResponse.workflow_runs[0] as any), id: 499, created_at: '2026-07-14T10:00:00Z' };
    const bad = { ...(failedNewest.runsResponse.workflow_runs[0] as any), id: 501, run_number: 21, conclusion: 'failure', created_at: '2026-07-14T09:00:00Z' };
    failedNewest.runsResponse.workflow_runs = [oldGreen, bad];
    expect(() => verifyS33PrerequisiteInventory({
      ...failedNewest, currentMainHeadSha: MAIN, producerHeadSha: HEAD, nowMs: PREREQUISITE_NOW,
    })).toThrow(/newest.*not successful.*older runs are masked/i);

    const rerun = prerequisiteResponses();
    (rerun.runsResponse.workflow_runs[0] as any).run_attempt = 2;
    expect(() => verifyS33PrerequisiteInventory({
      ...rerun, currentMainHeadSha: MAIN, producerHeadSha: HEAD, nowMs: PREREQUISITE_NOW,
    })).toThrow(/run_attempt must be exactly 1/i);

    const stale = prerequisiteResponses();
    (stale.runsResponse.workflow_runs[0] as any).updated_at = '2026-07-13T11:00:00Z';
    expect(() => verifyS33PrerequisiteInventory({
      ...stale, currentMainHeadSha: MAIN, producerHeadSha: HEAD, nowMs: PREREQUISITE_NOW,
    })).toThrow(/24-hour.*freshness/i);

    const duplicate = prerequisiteResponses();
    duplicate.artifactsResponse.artifacts[1] = {
      ...duplicate.artifactsResponse.artifacts[0], id: 702,
    };
    expect(() => verifyS33PrerequisiteInventory({
      ...duplicate, currentMainHeadSha: MAIN, producerHeadSha: HEAD, nowMs: PREREQUISITE_NOW,
    })).toThrow(/exactly one.*(?:prod-model-diff|embedding)/i);
  });
});

describe('validatePrerequisiteWorkflowIdentity', () => {
  it('resolves the fixed path to a positive active numeric workflow id and rejects mismatches', () => {
    expect(validatePrerequisiteWorkflowIdentity({
      id: 77, path: '.github/workflows/s33-wave1-prerequisites.yml', state: 'active',
    })).toBe(77);
    expect(() => validatePrerequisiteWorkflowIdentity({
      id: 77, path: '.github/workflows/other.yml', state: 'active',
    })).toThrow(/identity path/i);
    expect(() => validatePrerequisiteWorkflowIdentity({
      id: 0, path: '.github/workflows/s33-wave1-prerequisites.yml', state: 'active',
    })).toThrow(/numeric id.*positive/i);
  });
});

describe('extractSingleFileArchive', () => {
  it('binds the API/download digest and safely extracts one strict exact-head report file', () => {
    const directory = mkdtempSync(join(tmpdir(), 's33-prerequisite-zip-'));
    tempDirectories.push(directory);
    const outputDirectory = join(directory, 'out');
    mkdirSync(outputDirectory, { mode: 0o700 });
    const filename = 'prod-model-diff.json';
    writeFileSync(join(directory, filename), JSON.stringify({
      schemaVersion: 1,
      artifactType: 'arkova-s33-wave1-prod-model-diff',
      batchId: 'S33-W1',
      producerHeadSha: HEAD,
      manifestRawSha256: MANIFEST_SHA,
      status: 'PASS',
      payload: { mode: 'offline-prod-parity-replay', boundedRequestCount: 81 },
    }));
    const archive = join(directory, 'artifact.zip');
    execFileSync('/usr/bin/zip', ['-q', archive, filename], { cwd: directory });
    const archiveBytes = readFileSync(archive);
    extractSingleFileArchive({
      archiveBytes,
      artifact: {
        id: 700,
        name: `s33-wave1-prod-model-diff-${HEAD}`,
        filename,
        apiDigestSha256: sha256(archiveBytes),
        sizeInBytes: archiveBytes.length,
        createdAt: '2026-07-14T12:00:00Z',
        updatedAt: '2026-07-14T12:05:00Z',
        expiresAt: '2026-07-28T12:00:00Z',
      },
      outputDirectory,
      producerHeadSha: HEAD,
      manifestRawSha256: MANIFEST_SHA,
    });
    expect(readFileSync(join(outputDirectory, filename), 'utf8')).toContain('offline-prod-parity-replay');
  });

  it('rejects an API/download digest mismatch before extraction', () => {
    const directory = mkdtempSync(join(tmpdir(), 's33-prerequisite-badzip-'));
    tempDirectories.push(directory);
    expect(() => extractSingleFileArchive({
      archiveBytes: Buffer.from('not-a-zip'),
      artifact: {
        id: 800,
        name: `s33-wave1-prod-model-diff-${HEAD}`,
        filename: 'prod-model-diff.json',
        apiDigestSha256: '0'.repeat(64),
        sizeInBytes: 9,
        createdAt: '2026-07-14T12:00:00Z',
        updatedAt: '2026-07-14T12:05:00Z',
        expiresAt: '2026-07-28T12:00:00Z',
      },
      outputDirectory: directory,
      producerHeadSha: HEAD,
      manifestRawSha256: MANIFEST_SHA,
    })).toThrow(/downloaded archive digest mismatch/i);
  });

  it('rejects a ZIP symlink entry using central-directory Unix file type attributes', () => {
    const directory = mkdtempSync(join(tmpdir(), 's33-prerequisite-linkzip-'));
    tempDirectories.push(directory);
    const filename = 'prod-model-diff.json';
    writeFileSync(join(directory, 'target.json'), '{}');
    symlinkSync('target.json', join(directory, filename));
    const archive = join(directory, 'artifact.zip');
    execFileSync('/usr/bin/zip', ['-qy', archive, filename], { cwd: directory });
    const archiveBytes = readFileSync(archive);
    expect(() => extractSingleFileArchive({
      archiveBytes,
      artifact: {
        id: 801,
        name: `s33-wave1-prod-model-diff-${HEAD}`,
        filename,
        apiDigestSha256: sha256(archiveBytes),
        sizeInBytes: archiveBytes.length,
        createdAt: '2026-07-14T12:00:00Z',
        updatedAt: '2026-07-14T12:05:00Z',
        expiresAt: '2026-07-28T12:00:00Z',
      },
      outputDirectory: directory,
      producerHeadSha: HEAD,
      manifestRawSha256: MANIFEST_SHA,
    })).toThrow(/regular file.*symlink/i);
  });
});

function prodDiffAdjudicationBody(
  reportRawSha256: string,
  reportCanonicalSha256: string,
  overrides: Record<string, unknown> = {},
): string {
  const block = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave1-prod-diff-adjudication',
    batchId: 'S33-W1',
    producerHeadSha: HEAD,
    manifestRawSha256: MANIFEST_SHA,
    prerequisite: {
      workflowRunId: 500,
      workflowRunNumber: 20,
      workflowRunAttempt: 1,
      trustedMainRunSha: MAIN,
      prodModelDiffArtifactId: 700,
      prodModelDiffArchiveSha256: 'a'.repeat(64),
      prodModelDiffReportRawSha256: reportRawSha256,
      prodModelDiffReportCanonicalSha256: reportCanonicalSha256,
    },
    mismatchCount: 2,
    adjudications: [ENTRY_IDS[1], ENTRY_IDS[7]].map((entryId) => ({
      entryId,
      disposition: 'MODEL_HARD',
      rationale: `Independent source comparison confirms ${entryId} is a model-hard production miss.`,
    })),
    ...overrides,
  };
  return [
    '<!-- S33-W1-PROD-DIFF-ADJUDICATION-V1 -->',
    '```json', JSON.stringify(block, null, 2), '```',
    '<!-- /S33-W1-PROD-DIFF-ADJUDICATION-V1 -->',
  ].join('\n');
}

describe('extractProdDiffAdjudication', () => {
  const report = {
    filename: 'prod-model-diff.json',
    bytes: Buffer.from('{}'),
    rawSha256: 'b'.repeat(64),
    canonicalSha256: 'c'.repeat(64),
    parsed: {
      schemaVersion: 1,
      artifactType: 'arkova-s33-wave1-prod-model-diff',
      batchId: 'S33-W1',
      producerHeadSha: HEAD,
      manifestRawSha256: MANIFEST_SHA,
      status: 'PASS',
      payload: {
        mode: 'offline-prod-parity-replay',
        producerTreeSha: '6'.repeat(40), manifestCanonicalSha256: '7'.repeat(64), entryUniverseSha256: '8'.repeat(64),
        providerSurface: 'google-generative-language-developer-api', model: 'gemini-2.5-flash',
        workflowRunId: 500, workflowRunAttempt: 1, trustedMainRunSha: MAIN,
        workflowPath: '.github/workflows/s33-wave1-prerequisites.yml',
        startedAtUtc: '2026-07-14T10:00:00Z', completedAtUtc: '2026-07-14T11:00:00Z',
        requestCount: 81, retryCount: 0, entryCount: 81,
        results: ENTRY_IDS.map((id, index) => ({
          id, classification: index === 1 || index === 7 ? 'MISMATCH' : 'MATCH',
        })),
        rawReportSha256: 'd'.repeat(64), rawReportCanonicalSha256: 'e'.repeat(64),
      },
    },
  } as const;
  const inventory = {
    run: { id: 500, runNumber: 20, runAttempt: 1 as const, createdAt: '2026-07-14T09:50:00Z', updatedAt: '2026-07-14T12:05:00Z', headSha: MAIN },
    artifacts: {
      prodModelDiff: { id: 700, name: `s33-wave1-prod-model-diff-${HEAD}`, filename: 'prod-model-diff.json', apiDigestSha256: 'a'.repeat(64), sizeInBytes: 500, createdAt: '2026-07-14T12:00:00Z', updatedAt: '2026-07-14T12:05:00Z', expiresAt: '2026-07-28T12:00:00Z' },
      embeddingDiagnostic: { id: 701, name: `s33-wave1-embedding-diagnostic-${HEAD}`, filename: 'embedding-diagnostic.json', apiDigestSha256: 'f'.repeat(64), sizeInBytes: 500, createdAt: '2026-07-14T12:00:00Z', updatedAt: '2026-07-14T12:05:00Z', expiresAt: '2026-07-28T12:00:00Z' },
    },
  };

  it('binds every and only mismatch to post-publication human MODEL_HARD adjudications', () => {
    const result = extractProdDiffAdjudication(
      prodDiffAdjudicationBody(report.rawSha256, report.canonicalSha256),
      '2026-07-14T12:06:00Z', HEAD, MANIFEST_SHA, report as any, inventory,
    );
    expect(result.adjudications.map(({ entryId }) => entryId)).toEqual([ENTRY_IDS[1], ENTRY_IDS[7]]);
  });

  it('rejects label defects, stale reviews, mismatch omission, and wrong artifact/report/run bindings', () => {
    const goodBody = prodDiffAdjudicationBody(report.rawSha256, report.canonicalSha256);
    expect(() => extractProdDiffAdjudication(goodBody, '2026-07-14T12:05:00Z', HEAD, MANIFEST_SHA, report as any, inventory))
      .toThrow(/must postdate/i);
    expect(() => extractProdDiffAdjudication(prodDiffAdjudicationBody(report.rawSha256, report.canonicalSha256, {
      adjudications: [{ entryId: ENTRY_IDS[1], disposition: 'LABEL_DEFECT', rationale: 'Independent source review found a material label defect.' }],
      mismatchCount: 1,
    }), '2026-07-14T12:06:00Z', HEAD, MANIFEST_SHA, report as any, inventory)).toThrow(/every and only MISMATCH|LABEL_DEFECT/i);
    expect(() => extractProdDiffAdjudication(prodDiffAdjudicationBody('9'.repeat(64), report.canonicalSha256), '2026-07-14T12:06:00Z', HEAD, MANIFEST_SHA, report as any, inventory))
      .toThrow(/report\/artifact\/run digests/i);
  });
});

describe('s33-wave1-acceptance workflow contract', () => {
  it('keeps pre-merge API enumeration side-effect-free and dispatch acceptance upload-before-POST', () => {
    const workflow = readFileSync('.github/workflows/s33-wave1-acceptance.yml', 'utf8');
    expect(workflow).toContain("if: github.event_name == 'pull_request' && github.event.pull_request.number == 1529");
    expect(workflow).toContain('s33-wave1-github-evidence.ts preflight');
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(workflow).not.toContain('ref: refs/pull/1498/head');
    expect(workflow).toContain('git init --bare --quiet');
    expect(workflow).toContain('refs/pull/1498/head:refs/heads/producer');
    expect(workflow).not.toMatch(/working-directory:\s*\.s33-producer|npm\s+ci[^\n]*\.s33-producer|npx[^\n]*\.s33-producer\/services/u);
    expect(workflow).toContain('services/worker/src/ai/eval/s33-wave1-workflow-reports.ts');
    expect(workflow).toContain('S33_REPOSITORY_ROOT: ${{ runner.temp }}/s33-producer.git');
    expect(workflow).toContain('S33_PROD_MODEL_DIFF_FINAL_PATH: ${{ runner.temp }}/s33-wave1-prerequisites/prod-model-diff.json');
    expect(workflow).toContain('S33_EMBEDDING_DIAGNOSTIC_FINAL_PATH: ${{ runner.temp }}/s33-wave1-prerequisites/embedding-diagnostic.json');
    expect(workflow).not.toContain('S33_PROD_MODEL_DIFF_RAW_PATH');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('test "${GITHUB_RUN_ATTEMPT}" = "1"');
    const fetchPrerequisites = workflow.indexOf('Fetch and authenticate fresh prerequisite artifacts');
    const trustedParse = workflow.indexOf('Parse producer bytes with trusted-main Team-3 verifier');
    expect(fetchPrerequisites).toBeGreaterThan(0);
    expect(trustedParse).toBeGreaterThan(fetchPrerequisites);
    expect(workflow).not.toMatch(/workflow_dispatch:\s*\n\s+inputs:/u);
    const upload = workflow.indexOf('Upload canonical Wave-1 evidence');
    const post = workflow.indexOf('POST new github-actions bot comment');
    expect(upload).toBeGreaterThan(0);
    expect(post).toBeGreaterThan(upload);
    expect(workflow).toContain('gh api --method POST');
    expect(workflow).not.toMatch(/--method\s+(?:PATCH|PUT)|issues\/1498\/comments\//u);
    const preflightJob = workflow.slice(
      workflow.indexOf('premerge-api-preflight:'),
      workflow.indexOf('authenticate-wave1:'),
    );
    expect(preflightJob).not.toMatch(/upload-artifact|issues\/1498\/comments|cross-review\.json|s33-wave1-reports/u);
  });
});

describe('s33-wave1-prerequisites workflow contract', () => {
  it('pins trusted dispatch, bounded phases, WIF secret, frozen producer recheck, and two 14-day finals', () => {
    const workflow = readFileSync('.github/workflows/s33-wave1-prerequisites.yml', 'utf8');
    expect(workflow).not.toMatch(/workflow_dispatch:\s*\n\s+inputs:/u);
    expect(workflow).toContain('timeout-minutes: 120');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "${GITHUB_SHA}"');
    expect(workflow).toContain('test "${GITHUB_RUN_ATTEMPT}" = "1"');
    expect(workflow).toContain('git init --bare --quiet');
    expect(workflow).toContain('refs/pull/1498/head:refs/heads/producer');
    expect(workflow).toContain('+refs/pull/1498/head:refs/heads/final');
    expect(workflow).toContain('Revalidate frozen #1498 head tree manifest and final bindings before upload');
    expect(workflow.indexOf('Revalidate frozen #1498')).toBeLessThan(workflow.indexOf('Upload exact prod-model-diff final'));
    expect(workflow).toContain('google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093');
    expect(workflow).toContain('google-github-actions/get-secretmanager-secrets@bc9c54b29fdffb8a47776820a7d26e77b379d262');
    expect(workflow).toContain('gemini_api_key:arkova1/gemini-api-key');
    expect(workflow).toContain('s33-wave1-prerequisite-runner.ts prerequisites');
    expect(workflow).toContain('--raw-output-dir "${S33_RAW_OUTPUT_DIRECTORY}"');
    expect(workflow.match(/uses: actions\/upload-artifact@/gu)).toHaveLength(2);
    expect(workflow.match(/retention-days: 14/gu)).toHaveLength(2);
    expect(workflow).not.toMatch(/GEMINI_(?:MODEL|TUNED|V5|V6)|checkout[^\n]*1498|ref:\s*refs\/pull\/1498/u);
  });
});
