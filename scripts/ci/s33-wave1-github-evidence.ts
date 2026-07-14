/**
 * Sprint 3.3 Wave-1 GitHub trust-root authenticator.
 *
 * Fixed authority boundary:
 * - repository `carson-see/ArkovaCarson`, PR #1498, support PR #1529;
 * - branch protection and exact-head status checks are queried live with the
 *   workflow GITHUB_TOKEN (never supplied by a caller);
 * - the APPROVED review must be from one statically pinned identity and bind a
 *   strict machine-readable Lane-3 cross-review block to the exact head;
 * - evidence digests are derived from four workflow-local report files. The
 *   CLI has no option for a caller-provided SHA or verdict.
 *
 * Team-3 integration seam: its trusted-main report producer writes the four
 * fixed filenames in `WORKFLOW_REPORT_FILENAMES`. In particular,
 * `cross-review-plan.json` may prove the deterministic sample and whole-batch
 * machine gates, but it MUST NOT assert the human acceptance verdict. This
 * module extracts that verdict from the authenticated GitHub review and emits
 * the separate canonical `cross-review.json` artifact.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXED_REPOSITORY = 'carson-see/ArkovaCarson' as const;
export const FIXED_PULL_REQUEST_NUMBER = 1498 as const;
export const FIXED_SUPPORT_PULL_REQUEST_NUMBER = 1529 as const;
export const CROSS_REVIEW_MARKER = 'arkova-s33-wave1-cross-review-v1' as const;
export const PROD_DIFF_ADJUDICATION_MARKER = 'S33-W1-PROD-DIFF-ADJUDICATION-V1' as const;
export const FIXED_MANIFEST_PATH = 'docs/lane4/s33-wave1-batch-manifest.json' as const;
export const FIXED_PULL_REQUEST_URL = `https://github.com/${FIXED_REPOSITORY}/pull/${FIXED_PULL_REQUEST_NUMBER}` as const;
export const WORKFLOW_REPORT_FILENAMES = Object.freeze({
  crossReviewPlan: 'cross-review-plan.json',
  prodModelDiff: 'prod-model-diff.json',
  lexicalLeakage: 'lexical-leakage.json',
  embeddingDiagnostic: 'embedding-diagnostic.json',
});

const OUTPUT_FILENAMES = Object.freeze({
  crossReview: 'cross-review.json',
  githubEvidence: 'github-evidence.json',
  acceptanceInput: 'acceptance-input.json',
  report: 'github-evidence-report.md',
  comment: 'github-comment.md',
});
const SHA1_RE = /^[a-f0-9]{40}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const REQUIRED_LEXICAL_N = [6, 7, 8, 9, 10, 11, 12, 13] as const;
const PREREQUISITE_WORKFLOW_PATH = '.github/workflows/s33-wave1-prerequisites.yml' as const;
const PREREQUISITE_INVENTORY_FILENAME = 'prerequisite-inventory.json' as const;
const PREREQUISITE_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
const MAX_PREREQUISITE_ARCHIVE_BYTES = 10 * 1024 * 1024;
const SAMPLE_ALGORITHM = 'sha256-manifest-entry-rank-v1' as const;
const SAMPLE_RULE = 'ceil(10%),minimum-5,capped-at-entry-count' as const;
const AUTHORITY_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.github/s33-wave1-acceptance-authorities.json',
);

interface PinnedIdentity {
  login: string;
  databaseId: number;
  nodeId: string;
  requiresLiveWritePermission: boolean;
}

interface AuthorityConfiguration {
  schemaVersion: 1;
  repository: typeof FIXED_REPOSITORY;
  pullRequestNumber: typeof FIXED_PULL_REQUEST_NUMBER;
  supportPullRequestNumber: typeof FIXED_SUPPORT_PULL_REQUEST_NUMBER;
  primary: PinnedIdentity;
  fallbacks: PinnedIdentity[];
  rulings: string[];
  crossReview: {
    marker: typeof CROSS_REVIEW_MARKER;
    sampleAlgorithm: typeof SAMPLE_ALGORITHM;
    sampleRule: typeof SAMPLE_RULE;
  };
}

export interface GitHubIdentity {
  login: string;
  databaseId: number;
  id: string;
}

export interface GitHubAppIdentity {
  id: string;
  databaseId: number;
  slug: string;
}

export interface GitHubStatusContextNode {
  __typename: 'CheckRun' | 'StatusContext';
  id: string;
  databaseId?: number | null;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  isRequired: boolean;
  checkSuite?: { app: GitHubAppIdentity | null } | null;
  creator?: GitHubIdentity | null;
}

interface CommitUser {
  user: GitHubIdentity | null;
}

export interface GitHubEvidenceSnapshot {
  repository: {
    defaultBranchRef: { name: string; target: { oid: string } };
    branchProtectionRules: {
      pageInfo?: { hasNextPage: boolean };
      nodes: Array<{
        id: string;
        pattern: string;
        requiresStatusChecks: boolean;
        requiredStatusCheckContexts: string[];
        requiredStatusChecks: Array<{ context: string; app: GitHubAppIdentity | null }>;
        matchingRefs: { nodes: Array<{ name: string }> };
      }>;
    };
    pullRequest: {
      number: number;
      state: string;
      baseRefName: string;
      headRefOid: string;
      headRepository: { nameWithOwner: string } | null;
      author: GitHubIdentity | null;
      headCommit: {
        nodes: Array<{
          commit: {
            oid: string;
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: boolean };
                nodes: GitHubStatusContextNode[];
              };
            } | null;
          };
        }>;
      };
      allCommits: {
        pageInfo: { hasNextPage: boolean };
        nodes: Array<{
          commit: {
            oid: string;
            author: CommitUser | null;
            committer: CommitUser | null;
          };
        }>;
      };
      reviews: {
        pageInfo: { hasPreviousPage: boolean };
        nodes: Array<{
          id: string;
          databaseId: number | null;
          url: string;
          state: string;
          submittedAt: string;
          body: string;
          author: GitHubIdentity | null;
          commit: { oid: string } | null;
        }>;
      };
    };
    supportPullRequest: {
      state: string;
      merged: boolean;
      mergedAt: string | null;
      mergeCommit: { oid: string } | null;
    };
    bestNessie: CollaboratorConnection;
    alibama: CollaboratorConnection;
  };
}

interface CollaboratorConnection {
  edges: Array<{ permission: string; node: GitHubIdentity }>;
}

export interface DerivedRepositoryFacts {
  localMainHeadSha: string;
  localProducerHeadSha: string;
  supportMergeIsAncestorOfMain: boolean;
  manifestRawSha256: string;
  manifestEntryIds: readonly string[];
}

export interface AuthenticatedCrossReview {
  schemaVersion: 1;
  artifactType: 'arkova-s33-wave1-cross-review';
  batchId: 'S33-W1';
  producerHeadSha: string;
  manifestRawSha256: string;
  sampleAlgorithm: typeof SAMPLE_ALGORITHM;
  sampleRule: typeof SAMPLE_RULE;
  manifestEntryCount: number;
  sampleEntryIds: string[];
  materialLabelDefectCount: 0;
  adjudications: Array<{ entryId: string; verdict: 'PASS'; note: string }>;
  wholeBatchVerdict: 'ACCEPT';
}

export interface VerifiedGitHubTrustRoot {
  repositoryIdentity: typeof FIXED_REPOSITORY;
  pullRequestNumber: typeof FIXED_PULL_REQUEST_NUMBER;
  supportPullRequestNumber: typeof FIXED_SUPPORT_PULL_REQUEST_NUMBER;
  mainHeadSha: string;
  supportMergeCommitSha: string;
  producerHeadSha: string;
  branchProtectionRuleIds: string[];
  requiredChecks: Array<{
    name: string;
    conclusion: 'SUCCESS';
    headSha: string;
    detailsUrl: string;
    checkRunId: string;
    checkRunDatabaseId: number | null;
    app: GitHubAppIdentity;
  }>;
  approval: {
    status: 'APPROVED';
    headSha: string;
    url: string;
    reviewId: string;
    reviewDatabaseId: number | null;
    submittedAt: string;
    authorityKind: 'primary' | 'fallback';
    reviewer: GitHubIdentity;
  };
  crossReview: AuthenticatedCrossReview;
  authenticatedReviewBody: string;
  rulings: string[];
}

interface WorkflowReportEnvelope {
  schemaVersion: 1;
  artifactType: string;
  batchId: 'S33-W1';
  producerHeadSha: string;
  manifestRawSha256: string;
  status: 'PASS';
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LoadedWorkflowReport<T extends WorkflowReportEnvelope = WorkflowReportEnvelope> {
  filename: string;
  bytes: Uint8Array;
  parsed: Readonly<T>;
  rawSha256: string;
  canonicalSha256: string;
}

export interface WorkflowReportPaths {
  crossReviewPlan: string;
  prodModelDiff: string;
  lexicalLeakage: string;
  embeddingDiagnostic: string;
}

export interface WorkflowReportBundle {
  crossReviewPlan: LoadedWorkflowReport<WorkflowReportEnvelope & {
    artifactType: 'arkova-s33-wave1-cross-review-plan';
    payload: Record<string, unknown> & {
      sampleAlgorithm: typeof SAMPLE_ALGORITHM;
      sampleRule: typeof SAMPLE_RULE;
      manifestEntryCount: number;
      sampleEntryIds: string[];
    };
  }>;
  prodModelDiff: LoadedWorkflowReport<WorkflowReportEnvelope & {
    artifactType: 'arkova-s33-wave1-prod-model-diff';
    payload: Record<string, unknown> & {
      mode: 'offline-prod-parity-replay';
      producerTreeSha: string;
      manifestCanonicalSha256: string;
      entryUniverseSha256: string;
      providerSurface: 'google-generative-language-developer-api';
      model: 'gemini-2.5-flash';
      workflowRunId: number;
      workflowRunAttempt: 1;
      trustedMainRunSha: string;
      workflowPath: typeof PREREQUISITE_WORKFLOW_PATH;
      startedAtUtc: string;
      completedAtUtc: string;
      requestCount: 81;
      retryCount: 0;
      entryCount: 81;
      results: Array<{
        id: string;
        classification: 'MATCH' | 'MISMATCH';
        [key: string]: unknown;
      }>;
      rawReportSha256: string;
      rawReportCanonicalSha256: string;
    };
  }>;
  lexicalLeakage: LoadedWorkflowReport<WorkflowReportEnvelope & {
    artifactType: 'arkova-s33-wave1-lexical-leakage';
    payload: Record<string, unknown> & {
      algorithm: 'normalized-token-exact-ngram-v1';
      n: number[];
      trainingManifestSha256: string;
      exactMatchCount: 0;
    };
  }>;
  embeddingDiagnostic: LoadedWorkflowReport<WorkflowReportEnvelope & {
    artifactType: 'arkova-s33-wave1-embedding-diagnostic';
    payload: Record<string, unknown> & {
      role: 'diagnostic-only';
      canOverrideExactScan: false;
      workflowRunId: number;
      workflowRunAttempt: 1;
      trustedMainRunSha: string;
      workflowPath: typeof PREREQUISITE_WORKFLOW_PATH;
    };
  }>;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicaliseJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicaliseJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicaliseJson(child)}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value as number;
}

function assertSha(value: unknown, expression: RegExp, label: string): asserts value is string {
  if (typeof value !== 'string' || !expression.test(value)) throw new Error(`${label} is invalid`);
}

function assertHttpsUrl(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw new Error(`${label} must be an HTTPS URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must be an HTTPS URL`);
  return parsed.toString();
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`${label} schema mismatch; missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`);
  }
}

function assertNoDangerousKeys(value: unknown, label = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoDangerousKeys(child, `${label}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`JSON contains forbidden key ${label}.${key}`);
    }
    assertNoDangerousKeys(child, `${label}.${key}`);
  }
}

class DuplicateJsonKeyScanner {
  private index = 0;

  constructor(private readonly text: string, private readonly label: string) {}

  scan(): void {
    this.scanValue('$');
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail('has trailing content');
  }

  private scanValue(path: string): void {
    this.skipWhitespace();
    const token = this.text[this.index];
    if (token === '{') return this.scanObject(path);
    if (token === '[') return this.scanArray(path);
    if (token === '"') {
      this.scanString();
      return;
    }
    const remainder = this.text.slice(this.index);
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(remainder);
    if (!primitive) this.fail('contains an invalid value');
    this.index += primitive[0].length;
  }

  private scanObject(path: string): void {
    this.index += 1;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return;
    }
    while (this.index < this.text.length) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail('contains a non-string object key');
      const key = this.scanString();
      if (keys.has(key)) throw new Error(`${this.label} contains duplicate JSON key ${path}.${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') this.fail('is missing an object-key colon');
      this.index += 1;
      this.scanValue(`${path}.${key}`);
      this.skipWhitespace();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return;
      }
      if (this.text[this.index] !== ',') this.fail('contains malformed object entries');
      this.index += 1;
    }
    this.fail('contains an unterminated object');
  }

  private scanArray(path: string): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return;
    }
    let item = 0;
    while (this.index < this.text.length) {
      this.scanValue(`${path}[${item}]`);
      item += 1;
      this.skipWhitespace();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return;
      }
      if (this.text[this.index] !== ',') this.fail('contains malformed array entries');
      this.index += 1;
    }
    this.fail('contains an unterminated array');
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      this.index += 1;
      if (character === '"') {
        return JSON.parse(this.text.slice(start, this.index)) as string;
      }
      if (character === '\\') {
        if (this.index >= this.text.length) this.fail('contains an unterminated escape');
        const escape = this.text[this.index];
        this.index += 1;
        if (escape === 'u') this.index += 4;
      }
    }
    this.fail('contains an unterminated string');
  }

  private skipWhitespace(): void {
    while (/[\t\n\r ]/u.test(this.text[this.index] ?? '')) this.index += 1;
  }

  private fail(message: string): never {
    throw new Error(`${this.label} ${message} at character ${this.index}`);
  }
}

function parseJsonBytes(bytes: Uint8Array, label: string): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
  new DuplicateJsonKeyScanner(text, label).scan();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = record(parsed, label);
  assertNoDangerousKeys(object);
  return object;
}

function loadAuthorityConfiguration(): Readonly<AuthorityConfiguration> {
  const parsed = parseJsonBytes(readFileSync(AUTHORITY_CONFIG_PATH), 'S3.3 authority configuration');
  assertExactKeys(parsed, [
    'schemaVersion', 'repository', 'pullRequestNumber', 'supportPullRequestNumber',
    'primary', 'fallbacks', 'rulings', 'crossReview',
  ], 'S3.3 authority configuration');
  if (parsed.schemaVersion !== 1
    || parsed.repository !== FIXED_REPOSITORY
    || parsed.pullRequestNumber !== FIXED_PULL_REQUEST_NUMBER
    || parsed.supportPullRequestNumber !== FIXED_SUPPORT_PULL_REQUEST_NUMBER) {
    throw new Error('S3.3 authority configuration changed the fixed repository/PR contract');
  }
  const primary = validatePinnedIdentity(parsed.primary, 'primary authority');
  if (!Array.isArray(parsed.fallbacks) || parsed.fallbacks.length !== 2) {
    throw new Error('S3.3 authority configuration must contain exactly two fallbacks');
  }
  const fallbacks = parsed.fallbacks.map((identity, index) => validatePinnedIdentity(
    identity,
    `fallback authority[${index}]`,
  ));
  const expectedIdentities = [
    ['chatgpt-codex-connector[bot]', 199175422, 'BOT_kgDOC98s_g', false],
    ['BestNessie', 129661809, 'U_kgDOB7p7cQ', true],
    ['alibama', 911386, 'MDQ6VXNlcjkxMTM4Ng==', true],
  ] as const;
  [primary, ...fallbacks].forEach((identity, index) => {
    const expected = expectedIdentities[index];
    if (identity.login !== expected[0]
      || identity.databaseId !== expected[1]
      || identity.nodeId !== expected[2]
      || identity.requiresLiveWritePermission !== expected[3]) {
      throw new Error(`S3.3 authority identity[${index}] does not match the CTO-pinned identity`);
    }
  });
  if (!Array.isArray(parsed.rulings) || parsed.rulings.length !== 6) {
    throw new Error('S3.3 authority configuration must cite all six binding CTO rulings');
  }
  const rulings = parsed.rulings.map((value, index) => assertHttpsUrl(value, `CTO ruling[${index}]`));
  for (const id of ['102596609', '102629377', '102793217', '102858753', '102891521', '102957057']) {
    if (!rulings.some((url) => url.includes(`focusedCommentId=${id}`))) {
      throw new Error(`S3.3 authority configuration is missing CTO ruling ${id}`);
    }
  }
  const crossReview = record(parsed.crossReview, 'crossReview configuration');
  assertExactKeys(crossReview, ['marker', 'sampleAlgorithm', 'sampleRule'], 'crossReview configuration');
  if (crossReview.marker !== CROSS_REVIEW_MARKER
    || crossReview.sampleAlgorithm !== SAMPLE_ALGORITHM
    || crossReview.sampleRule !== SAMPLE_RULE) {
    throw new Error('S3.3 cross-review configuration changed the CTO-ratified fixed contract');
  }
  return Object.freeze({
    schemaVersion: 1,
    repository: FIXED_REPOSITORY,
    pullRequestNumber: FIXED_PULL_REQUEST_NUMBER,
    supportPullRequestNumber: FIXED_SUPPORT_PULL_REQUEST_NUMBER,
    primary,
    fallbacks,
    rulings,
    crossReview: {
      marker: CROSS_REVIEW_MARKER,
      sampleAlgorithm: SAMPLE_ALGORITHM,
      sampleRule: SAMPLE_RULE,
    },
  });
}

function validatePinnedIdentity(value: unknown, label: string): PinnedIdentity {
  const identity = record(value, label);
  assertExactKeys(
    identity,
    ['login', 'databaseId', 'nodeId', 'requiresLiveWritePermission'],
    label,
  );
  return {
    login: nonEmptyString(identity.login, `${label}.login`),
    databaseId: integer(identity.databaseId, `${label}.databaseId`),
    nodeId: nonEmptyString(identity.nodeId, `${label}.nodeId`),
    requiresLiveWritePermission: identity.requiresLiveWritePermission === true,
  };
}

const AUTHORITY_CONFIGURATION = loadAuthorityConfiguration();

function identityMatches(actual: GitHubIdentity | null, expected: PinnedIdentity | GitHubIdentity): boolean {
  return actual !== null
    && actual.login === expected.login
    && actual.databaseId === expected.databaseId
    && actual.id === ('nodeId' in expected ? expected.nodeId : expected.id);
}

function deterministicSample(manifestRawSha256: string, entryIds: readonly string[]): string[] {
  assertSha(manifestRawSha256, SHA256_RE, 'Manifest raw SHA-256');
  if (entryIds.length === 0 || new Set(entryIds).size !== entryIds.length) {
    throw new Error('Manifest entry ids must be a non-empty unique set');
  }
  const sampleSize = Math.min(entryIds.length, Math.max(5, Math.ceil(entryIds.length * 0.1)));
  return entryIds
    .map((entryId) => ({ entryId, rank: sha256(`${manifestRawSha256}\0${entryId}`) }))
    .sort((left, right) => compareCodeUnits(left.rank, right.rank) || compareCodeUnits(left.entryId, right.entryId))
    .slice(0, sampleSize)
    .map(({ entryId }) => entryId);
}

function sameOrderedStrings(actual: readonly unknown[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} must equal the deterministic sample exactly`);
  }
}

function extractCrossReview(body: string, facts: DerivedRepositoryFacts): AuthenticatedCrossReview {
  const open = `<!-- ${CROSS_REVIEW_MARKER} -->`;
  const close = `<!-- /${CROSS_REVIEW_MARKER} -->`;
  const openCount = body.split(open).length - 1;
  const closeCount = body.split(close).length - 1;
  if (openCount !== 1 || closeCount !== 1) {
    throw new Error('APPROVED review must contain exactly one authenticated cross-review block');
  }
  const start = body.indexOf(open) + open.length;
  const end = body.indexOf(close, start);
  if (end < start) throw new Error('Authenticated cross-review block markers are out of order');
  const fenced = body.slice(start, end).trim();
  const match = /^```json\n([\s\S]+)\n```$/u.exec(fenced);
  if (!match) throw new Error('Authenticated cross-review block must be one strict ```json fence');
  const parsed = parseJsonBytes(Buffer.from(match[1], 'utf8'), 'Authenticated cross-review block');
  assertExactKeys(parsed, [
    'schemaVersion', 'artifactType', 'batchId', 'producerHeadSha', 'manifestRawSha256',
    'sampleAlgorithm', 'sampleRule', 'manifestEntryCount', 'sampleEntryIds',
    'materialLabelDefectCount', 'adjudications', 'wholeBatchVerdict',
  ], 'Authenticated cross-review block');
  if (parsed.schemaVersion !== 1
    || parsed.artifactType !== 'arkova-s33-wave1-cross-review'
    || parsed.batchId !== 'S33-W1') {
    throw new Error('Authenticated cross-review block identity is invalid');
  }
  if (parsed.producerHeadSha !== facts.localProducerHeadSha) {
    throw new Error('Authenticated cross-review block must bind the exact producer head');
  }
  if (parsed.manifestRawSha256 !== facts.manifestRawSha256) {
    throw new Error('Authenticated cross-review block must bind the committed manifest digest');
  }
  if (parsed.sampleAlgorithm !== SAMPLE_ALGORITHM || parsed.sampleRule !== SAMPLE_RULE) {
    throw new Error('Authenticated cross-review block changed the deterministic sample contract');
  }
  if (parsed.manifestEntryCount !== facts.manifestEntryIds.length) {
    throw new Error('Authenticated cross-review block manifestEntryCount is stale');
  }
  if (!Array.isArray(parsed.sampleEntryIds)) {
    throw new Error('Authenticated cross-review block sampleEntryIds must be an array');
  }
  const expectedSample = deterministicSample(facts.manifestRawSha256, facts.manifestEntryIds);
  sameOrderedStrings(parsed.sampleEntryIds, expectedSample, 'Authenticated cross-review block sampleEntryIds');
  if (parsed.materialLabelDefectCount !== 0) {
    throw new Error('Authenticated cross-review materialLabelDefectCount must be zero for ACCEPT');
  }
  if (parsed.wholeBatchVerdict !== 'ACCEPT') {
    throw new Error('Authenticated cross-review wholeBatchVerdict must be ACCEPT');
  }
  if (!Array.isArray(parsed.adjudications) || parsed.adjudications.length !== expectedSample.length) {
    throw new Error('Authenticated cross-review must contain one adjudication per sampled entry');
  }
  const adjudications = parsed.adjudications.map((value, index) => {
    const adjudication = record(value, `Authenticated cross-review adjudications[${index}]`);
    assertExactKeys(adjudication, ['entryId', 'verdict', 'note'], `Authenticated cross-review adjudications[${index}]`);
    if (adjudication.entryId !== expectedSample[index]) {
      throw new Error('Authenticated cross-review adjudications must follow the deterministic sample order');
    }
    if (adjudication.verdict !== 'PASS') {
      throw new Error(`Authenticated cross-review adjudication ${String(adjudication.entryId)} must be PASS`);
    }
    const note = nonEmptyString(adjudication.note, `Cross-review adjudication ${String(adjudication.entryId)} note`);
    if (note.trim().length < 20) {
      throw new Error(`Cross-review adjudication ${String(adjudication.entryId)} note is not substantive`);
    }
    return { entryId: adjudication.entryId as string, verdict: 'PASS' as const, note };
  });
  return {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave1-cross-review',
    batchId: 'S33-W1',
    producerHeadSha: facts.localProducerHeadSha,
    manifestRawSha256: facts.manifestRawSha256,
    sampleAlgorithm: SAMPLE_ALGORITHM,
    sampleRule: SAMPLE_RULE,
    manifestEntryCount: facts.manifestEntryIds.length,
    sampleEntryIds: expectedSample,
    materialLabelDefectCount: 0,
    adjudications,
    wholeBatchVerdict: 'ACCEPT',
  };
}

function effectiveRequiredChecks(repository: NonNullable<GitHubEvidenceSnapshot['repository']>): {
  ruleIds: string[];
  checks: Array<{ context: string; app: GitHubAppIdentity | null }>;
} {
  if (repository.branchProtectionRules.pageInfo?.hasNextPage) {
    throw new Error('Live branchProtectionRules query was truncated; cannot authenticate main protection');
  }
  const matching = repository.branchProtectionRules.nodes.filter((rule) => (
    rule.matchingRefs.nodes.some(({ name }) => name === 'main')
  ));
  if (matching.length === 0) throw new Error('No live branchProtectionRule matches main');
  if (matching.some((rule) => !rule.requiresStatusChecks)) {
    throw new Error('A live main branchProtectionRule does not require status checks');
  }
  const byContext = new Map<string, { context: string; app: GitHubAppIdentity | null }>();
  for (const rule of matching) {
    const describedContexts = new Set(rule.requiredStatusChecks.map(({ context }) => context));
    for (const context of rule.requiredStatusCheckContexts) {
      if (!describedContexts.has(context)) {
        throw new Error(`Live main branch protection context ${context} has no app-qualified description`);
      }
    }
    for (const description of rule.requiredStatusChecks) {
      const previous = byContext.get(description.context);
      if (previous) {
        const previousApp = previous.app;
        const nextApp = description.app;
        if ((previousApp?.databaseId ?? null) !== (nextApp?.databaseId ?? null)
          || (previousApp?.slug ?? null) !== (nextApp?.slug ?? null)
          || (previousApp?.id ?? null) !== (nextApp?.id ?? null)) {
          throw new Error(`Conflicting live main branch-protection app bindings for ${description.context}`);
        }
      } else {
        byContext.set(description.context, description);
      }
    }
  }
  const checks = [...byContext.values()].sort((left, right) => compareCodeUnits(left.context, right.context));
  if (checks.length === 0) throw new Error('Live main branch protection has zero required status checks');
  return {
    ruleIds: matching.map(({ id }) => id).sort(compareCodeUnits),
    checks,
  };
}

function contextName(context: GitHubStatusContextNode): string {
  return context.__typename === 'CheckRun'
    ? nonEmptyString(context.name, 'CheckRun.name')
    : nonEmptyString(context.context, 'StatusContext.context');
}

function contextFreshness(context: GitHubStatusContextNode): string {
  const value = context.__typename === 'CheckRun' ? context.startedAt : context.createdAt;
  const text = nonEmptyString(value, `${context.__typename} freshness timestamp`);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${context.__typename} freshness timestamp is invalid`);
  return text;
}

function selectLatestContext(
  contexts: readonly GitHubStatusContextNode[],
  required: { context: string; app: GitHubAppIdentity | null },
): GitHubStatusContextNode {
  const candidates = contexts.filter((context) => contextName(context) === required.context);
  if (candidates.length === 0) throw new Error(`Missing required check: ${required.context}`);
  const ranked = [...candidates].sort((left, right) => (
    compareCodeUnits(contextFreshness(right), contextFreshness(left))
      || compareCodeUnits(right.id, left.id)
  ));
  if (ranked.length > 1 && contextFreshness(ranked[0]) === contextFreshness(ranked[1])) {
    throw new Error(`Required check ${required.context} has an ambiguous latest duplicate`);
  }
  return ranked[0];
}

function authenticateRequiredCheck(
  context: GitHubStatusContextNode,
  required: { context: string; app: GitHubAppIdentity | null },
  producerHeadSha: string,
): VerifiedGitHubTrustRoot['requiredChecks'][number] {
  if (context.__typename !== 'CheckRun') {
    throw new Error(`Required check ${required.context} is not a CheckRun and has no checkSuite app identity`);
  }
  if (context.status !== 'COMPLETED' || context.conclusion !== 'SUCCESS') {
    throw new Error(`Required check ${required.context} must be completed successfully; got ${String(context.status)}/${String(context.conclusion)}`);
  }
  if (context.isRequired !== true) {
    throw new Error(`Required check ${required.context} does not report isRequired=true for PR #1498`);
  }
  const actualApp = context.checkSuite?.app ?? null;
  if (required.app === null || actualApp === null
    || actualApp.id !== required.app.id
    || actualApp.databaseId !== required.app.databaseId
    || actualApp.slug !== required.app.slug) {
    throw new Error(`Required check ${required.context} checkSuite app mismatch`);
  }
  return {
    name: required.context,
    conclusion: 'SUCCESS',
    headSha: producerHeadSha,
    detailsUrl: assertHttpsUrl(context.detailsUrl, `Required check ${required.context} detailsUrl`),
    checkRunId: nonEmptyString(context.id, `Required check ${required.context} id`),
    checkRunDatabaseId: context.databaseId ?? null,
    app: { ...actualApp },
  };
}

function collaboratorConnectionFor(
  repository: NonNullable<GitHubEvidenceSnapshot['repository']>,
  identity: PinnedIdentity,
): CollaboratorConnection {
  if (identity.login === 'BestNessie') return repository.bestNessie;
  if (identity.login === 'alibama') return repository.alibama;
  throw new Error(`No fixed live collaborator query exists for fallback ${identity.login}`);
}

function assertFallbackWritePermission(
  repository: NonNullable<GitHubEvidenceSnapshot['repository']>,
  identity: PinnedIdentity,
): void {
  const exact = collaboratorConnectionFor(repository, identity).edges.filter(({ node }) => (
    identityMatches(node, identity)
  ));
  if (exact.length !== 1 || !['WRITE', 'MAINTAIN', 'ADMIN'].includes(exact[0].permission)) {
    throw new Error(`Fallback ${identity.login} lacks an exact live WRITE-or-higher collaborator permission`);
  }
}

function selectApproval(
  repository: NonNullable<GitHubEvidenceSnapshot['repository']>,
  facts: DerivedRepositoryFacts,
): {
  review: NonNullable<GitHubEvidenceSnapshot['repository']>['pullRequest'] extends infer P
    ? P extends { reviews: { nodes: Array<infer R> } } ? R : never
    : never;
  identity: PinnedIdentity;
  kind: 'primary' | 'fallback';
} {
  const pullRequest = repository.pullRequest;
  if (!pullRequest) throw new Error('GitHub PR #1498 is missing');
  if (pullRequest.reviews.pageInfo.hasPreviousPage) {
    throw new Error('GitHub APPROVED review query was truncated; cannot select authority safely');
  }
  const authorities = [AUTHORITY_CONFIGURATION.primary, ...AUTHORITY_CONFIGURATION.fallbacks];
  for (const [index, identity] of authorities.entries()) {
    const candidates = pullRequest.reviews.nodes.filter((review) => (
      identityMatches(review.author, identity)
      && review.commit?.oid === facts.localProducerHeadSha
    )).sort((left, right) => (
      compareCodeUnits(right.submittedAt, left.submittedAt) || compareCodeUnits(right.id, left.id)
    ));
    if (candidates.length === 0) continue;
    if (candidates.length > 1 && candidates[0].submittedAt === candidates[1].submittedAt) {
      throw new Error(`Authorized reviewer ${identity.login} has ambiguous latest exact-head reviews`);
    }
    if (candidates[0].state !== 'APPROVED') {
      throw new Error(`Latest exact-head review from authorized reviewer ${identity.login} is ${candidates[0].state}, not APPROVED`);
    }
    if (index > 0) assertFallbackWritePermission(repository, identity);
    return { review: candidates[0], identity, kind: index === 0 ? 'primary' : 'fallback' };
  }
  const staleAuthorized = pullRequest.reviews.nodes.some((review) => (
    review.state === 'APPROVED'
    && authorities.some((identity) => identityMatches(review.author, identity))
  ));
  if (staleAuthorized) {
    throw new Error('Authorized APPROVED review does not bind the exact producer head');
  }
  throw new Error('No exact-head APPROVED review exists from a CTO-authorized identity');
}

export function verifyGitHubTrustRoot(
  snapshot: GitHubEvidenceSnapshot,
  facts: DerivedRepositoryFacts,
): Readonly<VerifiedGitHubTrustRoot> {
  assertSha(facts.localMainHeadSha, SHA1_RE, 'Local main head SHA');
  assertSha(facts.localProducerHeadSha, SHA1_RE, 'Local producer head SHA');
  assertSha(facts.manifestRawSha256, SHA256_RE, 'Committed manifest raw SHA-256');
  const repository = snapshot.repository;
  if (!repository) throw new Error(`GitHub repository ${FIXED_REPOSITORY} is missing or inaccessible`);
  if (repository.defaultBranchRef?.name !== 'main'
    || repository.defaultBranchRef.target.oid !== facts.localMainHeadSha) {
    throw new Error('Trusted local main checkout does not equal the live GitHub default-branch head');
  }
  const support = repository.supportPullRequest;
  if (!support || support.state !== 'MERGED' || support.merged !== true || support.mergeCommit === null) {
    throw new Error('Support PR #1529 must be merged before Wave-1 acceptance runs');
  }
  assertSha(support.mergeCommit.oid, SHA1_RE, 'Support PR #1529 merge commit SHA');
  if (!facts.supportMergeIsAncestorOfMain) {
    throw new Error('Support PR #1529 merge commit must be an ancestor of the trusted main head');
  }
  const pullRequest = repository.pullRequest;
  if (!pullRequest || pullRequest.number !== FIXED_PULL_REQUEST_NUMBER) {
    throw new Error('Fixed GitHub PR #1498 is missing');
  }
  if (pullRequest.state !== 'OPEN'
    || pullRequest.baseRefName !== 'main'
    || pullRequest.headRepository?.nameWithOwner !== FIXED_REPOSITORY) {
    throw new Error('PR #1498 must be an open in-repository pull request targeting main');
  }
  if (pullRequest.headRefOid !== facts.localProducerHeadSha) {
    throw new Error('Local producer checkout does not equal the exact GitHub head for PR #1498');
  }
  if (pullRequest.headCommit.nodes.length !== 1
    || pullRequest.headCommit.nodes[0].commit.oid !== pullRequest.headRefOid) {
    throw new Error('GitHub exact-head statusCheckRollup is missing or stale');
  }
  const contexts = pullRequest.headCommit.nodes[0].commit.statusCheckRollup?.contexts;
  if (!contexts) throw new Error('GitHub exact-head statusCheckRollup is missing');
  if (contexts.pageInfo.hasNextPage) {
    throw new Error('GitHub exact-head statusCheckRollup was truncated; cannot authenticate required checks');
  }
  const required = effectiveRequiredChecks(repository);
  const requiredChecks = required.checks.map((description) => authenticateRequiredCheck(
    selectLatestContext(contexts.nodes, description),
    description,
    facts.localProducerHeadSha,
  ));
  if (pullRequest.allCommits.pageInfo.hasNextPage) {
    throw new Error('PR #1498 commit identity query was truncated');
  }
  const selected = selectApproval(repository, facts);
  const reviewer = selected.review.author;
  if (!reviewer || !identityMatches(reviewer, selected.identity)) {
    throw new Error('Selected review author identity changed during verification');
  }
  if (identityMatches(pullRequest.author, reviewer)) {
    throw new Error('Authorized reviewer must not be the pull request author');
  }
  const reviewerCommitted = pullRequest.allCommits.nodes.some(({ commit }) => (
    identityMatches(commit.author?.user ?? null, reviewer)
      || identityMatches(commit.committer?.user ?? null, reviewer)
  ));
  if (reviewerCommitted) throw new Error('Authorized reviewer must not be a commit author or committer');
  const crossReview = extractCrossReview(selected.review.body, facts);
  return Object.freeze({
    repositoryIdentity: FIXED_REPOSITORY,
    pullRequestNumber: FIXED_PULL_REQUEST_NUMBER,
    supportPullRequestNumber: FIXED_SUPPORT_PULL_REQUEST_NUMBER,
    mainHeadSha: facts.localMainHeadSha,
    supportMergeCommitSha: support.mergeCommit.oid,
    producerHeadSha: facts.localProducerHeadSha,
    branchProtectionRuleIds: required.ruleIds,
    requiredChecks,
    approval: {
      status: 'APPROVED' as const,
      headSha: facts.localProducerHeadSha,
      url: assertHttpsUrl(selected.review.url, 'GitHub APPROVED review URL'),
      reviewId: selected.review.id,
      reviewDatabaseId: selected.review.databaseId,
      submittedAt: selected.review.submittedAt,
      authorityKind: selected.kind,
      reviewer: { ...reviewer },
    },
    crossReview,
    authenticatedReviewBody: selected.review.body,
    rulings: [...AUTHORITY_CONFIGURATION.rulings],
  });
}

function validateReportEnvelope(
  parsed: Record<string, unknown>,
  artifactType: string,
  facts: Pick<DerivedRepositoryFacts, 'localProducerHeadSha' | 'manifestRawSha256'>,
  label: string,
): asserts parsed is WorkflowReportEnvelope {
  const requiredKeys = [
    'schemaVersion', 'artifactType', 'batchId', 'producerHeadSha',
    'manifestRawSha256', 'status', 'payload',
  ];
  assertExactKeys(parsed, requiredKeys, label);
  if (parsed.schemaVersion !== 1 || parsed.artifactType !== artifactType || parsed.batchId !== 'S33-W1') {
    throw new Error(`${label} identity fields are invalid`);
  }
  if (parsed.producerHeadSha !== facts.localProducerHeadSha) {
    throw new Error(`${label} must bind the exact producer head`);
  }
  if (parsed.manifestRawSha256 !== facts.manifestRawSha256) {
    throw new Error(`${label} must bind the committed manifest digest`);
  }
  if (parsed.status !== 'PASS') throw new Error(`${label} status must be PASS`);
  record(parsed.payload, `${label}.payload`);
}

function assertNoProducerHumanVerdict(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoProducerHumanVerdict(child, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  const forbidden = new Set([
    'adjudication', 'adjudications', 'disposition', 'acceptedBy', 'githubReview', 'humanAcceptance', 'humanPass',
    'materialLabelDefectCount', 'wholeBatchVerdict',
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) {
      throw new Error(`Workflow cross-review plan must not self-assert the human verdict (${path}.${key})`);
    }
    assertNoProducerHumanVerdict(child, `${path}.${key}`);
  }
}

function readWorkflowReport<T extends WorkflowReportEnvelope>(
  path: string,
  expectedFilename: string,
  artifactType: string,
  facts: Pick<DerivedRepositoryFacts, 'localProducerHeadSha' | 'manifestRawSha256'>,
): LoadedWorkflowReport<T> {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`Missing workflow report ${expectedFilename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Workflow report ${expectedFilename} must be a regular non-symlink file`);
  }
  if (basename(path) !== expectedFilename || basename(realpathSync(path)) !== expectedFilename) {
    throw new Error(`Workflow report path must end in the fixed filename ${expectedFilename}`);
  }
  const bytes = readFileSync(path);
  const parsed = parseJsonBytes(bytes, `Workflow report ${expectedFilename}`);
  validateReportEnvelope(parsed, artifactType, facts, `Workflow report ${expectedFilename}`);
  return {
    filename: expectedFilename,
    bytes,
    parsed: parsed as T,
    rawSha256: sha256(bytes),
    canonicalSha256: sha256(canonicaliseJson(parsed)),
  };
}

export function loadWorkflowReportBundle(
  paths: WorkflowReportPaths,
  facts: {
    producerHeadSha: string;
    manifestRawSha256: string;
    manifestEntryIds: readonly string[];
  },
): Readonly<WorkflowReportBundle> {
  const directories = Object.values(paths).map((path) => {
    try {
      return realpathSync(dirname(path));
    } catch (error) {
      throw new Error(`Missing workflow report directory for ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (new Set(directories).size !== 1) {
    throw new Error('All workflow reports must be regular files in one workflow-local directory');
  }
  const commonFacts = {
    localProducerHeadSha: facts.producerHeadSha,
    manifestRawSha256: facts.manifestRawSha256,
  };
  const crossReviewPlan = readWorkflowReport<WorkflowReportBundle['crossReviewPlan']['parsed']>(
    paths.crossReviewPlan,
    WORKFLOW_REPORT_FILENAMES.crossReviewPlan,
    'arkova-s33-wave1-cross-review-plan',
    commonFacts,
  );
  const prodModelDiff = readWorkflowReport<WorkflowReportBundle['prodModelDiff']['parsed']>(
    paths.prodModelDiff,
    WORKFLOW_REPORT_FILENAMES.prodModelDiff,
    'arkova-s33-wave1-prod-model-diff',
    commonFacts,
  );
  const lexicalLeakage = readWorkflowReport<WorkflowReportBundle['lexicalLeakage']['parsed']>(
    paths.lexicalLeakage,
    WORKFLOW_REPORT_FILENAMES.lexicalLeakage,
    'arkova-s33-wave1-lexical-leakage',
    commonFacts,
  );
  const embeddingDiagnostic = readWorkflowReport<WorkflowReportBundle['embeddingDiagnostic']['parsed']>(
    paths.embeddingDiagnostic,
    WORKFLOW_REPORT_FILENAMES.embeddingDiagnostic,
    'arkova-s33-wave1-embedding-diagnostic',
    commonFacts,
  );
  const expectedSample = deterministicSample(facts.manifestRawSha256, facts.manifestEntryIds);
  assertNoProducerHumanVerdict(crossReviewPlan.parsed.payload);
  if (crossReviewPlan.parsed.payload.sampleAlgorithm !== SAMPLE_ALGORITHM
    || crossReviewPlan.parsed.payload.sampleRule !== SAMPLE_RULE
    || crossReviewPlan.parsed.payload.manifestEntryCount !== facts.manifestEntryIds.length
    || !Array.isArray(crossReviewPlan.parsed.payload.sampleEntryIds)) {
    throw new Error('Workflow cross-review plan sample contract is invalid');
  }
  sameOrderedStrings(
    crossReviewPlan.parsed.payload.sampleEntryIds,
    expectedSample,
    'Workflow cross-review plan sampleEntryIds',
  );
  assertNoProducerHumanVerdict(prodModelDiff.parsed.payload);
  if (prodModelDiff.parsed.payload.mode !== 'offline-prod-parity-replay'
    || prodModelDiff.parsed.payload.providerSurface !== 'google-generative-language-developer-api'
    || prodModelDiff.parsed.payload.model !== 'gemini-2.5-flash'
    || prodModelDiff.parsed.payload.requestCount !== 81
    || prodModelDiff.parsed.payload.retryCount !== 0
    || prodModelDiff.parsed.payload.entryCount !== 81
    || !Array.isArray(prodModelDiff.parsed.payload.results)) {
    throw new Error('Workflow prod-model-diff public production replay contract is invalid');
  }
  if (lexicalLeakage.parsed.payload.algorithm !== 'normalized-token-exact-ngram-v1') {
    throw new Error('Workflow lexical leakage algorithm is invalid');
  }
  if (!Array.isArray(lexicalLeakage.parsed.payload.n)) {
    throw new Error('Workflow lexical leakage n must be an array');
  }
  if (lexicalLeakage.parsed.payload.n.length !== REQUIRED_LEXICAL_N.length
    || lexicalLeakage.parsed.payload.n.some((value, index) => value !== REQUIRED_LEXICAL_N[index])) {
    throw new Error('Workflow lexical leakage n must be the numeric exact range 6-13');
  }
  assertSha(
    lexicalLeakage.parsed.payload.trainingManifestSha256,
    SHA256_RE,
    'Workflow lexical leakage trainingManifestSha256',
  );
  if (lexicalLeakage.parsed.payload.exactMatchCount !== 0) {
    throw new Error('Workflow lexical leakage exactMatchCount must be zero');
  }
  if (embeddingDiagnostic.parsed.payload.role !== 'diagnostic-only'
    || embeddingDiagnostic.parsed.payload.canOverrideExactScan !== false) {
    throw new Error('Workflow embedding evidence must be diagnostic-only and non-overriding');
  }
  return Object.freeze({ crossReviewPlan, prodModelDiff, lexicalLeakage, embeddingDiagnostic });
}

export const S33_GITHUB_EVIDENCE_QUERY = `
query S33Wave1GitHubEvidence {
  repository(owner: "carson-see", name: "ArkovaCarson") {
    defaultBranchRef { name target { ... on Commit { oid } } }
    branchProtectionRules(first: 100) {
      pageInfo { hasNextPage }
      nodes {
        id pattern requiresStatusChecks requiredStatusCheckContexts
        requiredStatusChecks { context app { id databaseId slug } }
        matchingRefs(first: 10, query: "main") { nodes { name } }
      }
    }
    pullRequest(number: 1498) {
      number state baseRefName headRefOid headRepository { nameWithOwner }
      author { login ... on User { databaseId id } ... on Bot { databaseId id } }
      headCommit: commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun {
                    id databaseId name status conclusion startedAt completedAt detailsUrl
                    isRequired(pullRequestNumber: 1498)
                    checkSuite { app { id databaseId slug } }
                  }
                  ... on StatusContext {
                    id context state createdAt targetUrl isRequired(pullRequestNumber: 1498)
                    creator {
                      login
                      ... on User { databaseId id }
                      ... on Bot { databaseId id }
                      ... on Organization { databaseId id }
                    }
                  }
                }
              }
            }
          }
        }
      }
      allCommits: commits(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          commit {
            oid
            author { user { login databaseId id } }
            committer { user { login databaseId id } }
          }
        }
      }
      reviews(last: 100) {
        pageInfo { hasPreviousPage }
        nodes {
          id databaseId url state submittedAt body
          author { login ... on User { databaseId id } ... on Bot { databaseId id } }
          commit { oid }
        }
      }
    }
    supportPullRequest: pullRequest(number: 1529) {
      state merged mergedAt mergeCommit { oid }
    }
    bestNessie: collaborators(first: 10, query: "BestNessie") {
      edges { permission node { login databaseId id } }
    }
    alibama: collaborators(first: 10, query: "alibama") {
      edges { permission node { login databaseId id } }
    }
  }
}`;

export type GitHubGraphql = (query: string) => Promise<GitHubEvidenceSnapshot>;

export interface PremergePullRequestEvent {
  repository: { full_name: string };
  pull_request: {
    number: number;
    head: { sha: string };
  };
}

export const S33_PREMERGE_API_QUERY = `
query S33Wave1PremergeApiPreflight {
  repository(owner: "carson-see", name: "ArkovaCarson") {
    defaultBranchRef { name target { ... on Commit { oid } } }
    branchProtectionRules(first: 100) {
      pageInfo { hasNextPage }
      nodes {
        id pattern requiresStatusChecks requiredStatusCheckContexts
        requiredStatusChecks { context app { id databaseId slug } }
        matchingRefs(first: 10, query: "main") { nodes { name } }
      }
    }
    supportPullRequest: pullRequest(number: 1529) {
      number state headRefOid headRepository { nameWithOwner }
      author { login ... on User { databaseId id } ... on Bot { databaseId id } }
      headCommit: commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun {
                    id databaseId name status conclusion startedAt completedAt detailsUrl
                    isRequired(pullRequestNumber: 1529)
                    checkSuite { app { id databaseId slug } }
                  }
                  ... on StatusContext {
                    id context state createdAt targetUrl isRequired(pullRequestNumber: 1529)
                    creator {
                      login
                      ... on User { databaseId id }
                      ... on Bot { databaseId id }
                      ... on Organization { databaseId id }
                    }
                  }
                }
              }
            }
          }
        }
      }
      reviews(last: 100) {
        pageInfo { hasPreviousPage }
        nodes {
          id databaseId url state submittedAt
          author { login ... on User { databaseId id } ... on Bot { databaseId id } }
          commit { oid }
        }
      }
    }
    bestNessie: collaborators(first: 10, query: "BestNessie") {
      edges { permission node { login databaseId id } }
    }
    alibama: collaborators(first: 10, query: "alibama") {
      edges { permission node { login databaseId id } }
    }
  }
}`;

export type PremergeGraphql = (query: string) => Promise<Record<string, unknown>>;
export type GitHubRest = (path: string) => Promise<Record<string, unknown>>;
export type GitHubDownload = (path: string) => Promise<Uint8Array>;

interface VerifiedPrerequisiteRun {
  id: number;
  runNumber: number;
  runAttempt: 1;
  createdAt: string;
  updatedAt: string;
  headSha: string;
}

export interface VerifiedPrerequisiteArtifact {
  id: number;
  name: string;
  filename: string;
  apiDigestSha256: string;
  sizeInBytes: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface VerifiedPrerequisiteInventory {
  run: VerifiedPrerequisiteRun;
  artifacts: {
    prodModelDiff: VerifiedPrerequisiteArtifact;
    embeddingDiagnostic: VerifiedPrerequisiteArtifact;
  };
}

export interface AuthenticatedProdDiffAdjudication {
  schemaVersion: 1;
  artifactType: 'arkova-s33-wave1-prod-diff-adjudication';
  batchId: 'S33-W1';
  producerHeadSha: string;
  manifestRawSha256: string;
  prerequisite: {
    workflowRunId: number;
    workflowRunNumber: number;
    workflowRunAttempt: 1;
    trustedMainRunSha: string;
    prodModelDiffArtifactId: number;
    prodModelDiffArchiveSha256: string;
    prodModelDiffReportRawSha256: string;
    prodModelDiffReportCanonicalSha256: string;
  };
  mismatchCount: number;
  adjudications: Array<{
    entryId: string;
    disposition: 'MODEL_HARD';
    rationale: string;
  }>;
}

export interface AuthenticatedS33Wave1EvidenceBundle {
  repositoryIdentity: typeof FIXED_REPOSITORY;
  pullRequestNumber: typeof FIXED_PULL_REQUEST_NUMBER;
  producerRepositoryRoot: string;
  trustedMainHeadSha: string;
  supportMergeCommitSha: string;
  supportMergeIsAncestorOfMain: true;
  producerHeadSha: string;
  producerTreeSha: string;
  manifestPath: typeof FIXED_MANIFEST_PATH;
  manifestRawSha256: string;
  manifestCanonicalSha256: string;
  manifestEntryIds: readonly string[];
  acceptedAtUtc: string;
  approval: VerifiedGitHubTrustRoot['approval'];
  authenticatedReviewBody: string;
  branchProtectionRuleIds: readonly string[];
  requiredChecks: VerifiedGitHubTrustRoot['requiredChecks'];
  reports: {
    crossReview: AuthenticatedReportBytes;
    prodModelDiff: AuthenticatedReportBytes;
    lexicalLeakage: AuthenticatedReportBytes;
    embeddingDiagnostic: AuthenticatedReportBytes;
  };
  prodDiffAdjudication: Readonly<AuthenticatedProdDiffAdjudication>;
  prerequisiteInventory: Readonly<VerifiedPrerequisiteInventory>;
}

export interface AuthenticatedReportBytes {
  filename: string;
  bytesBase64: string;
  rawSha256: string;
  canonicalSha256: string;
}

const AUTHENTICATED_EVIDENCE_BUNDLES = new WeakSet<object>();

export function assertAuthenticatedS33Wave1EvidenceBundle(
  value: unknown,
): asserts value is Readonly<AuthenticatedS33Wave1EvidenceBundle> {
  if (!isRecord(value) || !AUTHENTICATED_EVIDENCE_BUNDLES.has(value)) {
    throw new Error('S3.3 production acceptance requires the in-memory Team-2 authenticated evidence bundle');
  }
}

function registerAuthenticatedS33Wave1EvidenceBundle(
  value: AuthenticatedS33Wave1EvidenceBundle,
): Readonly<AuthenticatedS33Wave1EvidenceBundle> {
  const frozen = recursivelyFreeze(value);
  AUTHENTICATED_EVIDENCE_BUNDLES.add(frozen);
  return frozen;
}

export function recursivelyFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) recursivelyFreeze(child, seen);
  return Object.freeze(value);
}

async function liveGitHubGraphql(token: string, query: string): Promise<GitHubEvidenceSnapshot> {
  return await liveGitHubGraphqlRecord(token, query) as unknown as GitHubEvidenceSnapshot;
}

async function liveGitHubGraphqlRecord(token: string, query: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'arkova-s33-wave1-github-evidence',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}; GITHUB_TOKEN permissions are insufficient or GitHub is unavailable`);
  }
  const body = record(await response.json() as unknown, 'GitHub GraphQL response');
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(`GitHub GraphQL returned ${body.errors.length} error(s); fail closed because GITHUB_TOKEN cannot prove the trust root`);
  }
  const data = record(body.data, 'GitHub GraphQL response.data');
  return data;
}

async function liveGitHubRest(token: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'arkova-s33-wave1-github-evidence',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub REST ${path} failed with HTTP ${response.status}; same-token preflight cannot prove API access`);
  }
  return record(await response.json() as unknown, `GitHub REST ${path}`);
}

async function liveGitHubDownload(token: string, path: string): Promise<Uint8Array> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'arkova-s33-wave1-github-evidence',
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`GitHub artifact download ${path} failed with HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PREREQUISITE_ARCHIVE_BYTES) {
    throw new Error(`GitHub artifact download ${path} has an invalid bounded size`);
  }
  return bytes;
}

function parseUtc(value: unknown, label: string): number {
  const text = nonEmptyString(value, label);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || !text.endsWith('Z')) throw new Error(`${label} must be an ISO UTC timestamp`);
  return timestamp;
}

function normalizedApiDigest(value: unknown, label: string): string {
  const digest = nonEmptyString(value, label).replace(/^sha256:/u, '');
  assertSha(digest, SHA256_RE, label);
  return digest;
}

export function validatePrerequisiteWorkflowIdentity(response: Record<string, unknown>): number {
  if (response.path !== PREREQUISITE_WORKFLOW_PATH) {
    throw new Error('GitHub prerequisite workflow identity path does not match the CTO-fixed workflow');
  }
  const id = integer(response.id, 'GitHub prerequisite workflow numeric id');
  if (id <= 0) throw new Error('GitHub prerequisite workflow numeric id must be positive');
  if (response.state !== 'active') throw new Error('GitHub prerequisite workflow must be active');
  return id;
}

function rankPrerequisiteRuns(runs: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return [...runs].sort((left, right) => (
    integer(right.run_number, 'Prerequisite workflow run_number')
      - integer(left.run_number, 'Prerequisite workflow run_number')
    || integer(right.run_attempt, 'Prerequisite workflow run_attempt')
      - integer(left.run_attempt, 'Prerequisite workflow run_attempt')
    || integer(right.id, 'Prerequisite workflow run id')
      - integer(left.id, 'Prerequisite workflow run id')
  ));
}

/**
 * Authenticate the fixed prerequisite run and its two-artifact inventory.
 * The newest run is selected before checking success: a newer failed, stale,
 * cancelled, or rerun attempt blocks consumption of every older green run.
 */
export function verifyS33PrerequisiteInventory(input: {
  runsResponse: Record<string, unknown>;
  artifactsResponse: Record<string, unknown>;
  currentMainHeadSha: string;
  runHeadIsReachableFromCurrentMain?: boolean;
  producerHeadSha: string;
  nowMs?: number;
}): Readonly<VerifiedPrerequisiteInventory> {
  assertSha(input.currentMainHeadSha, SHA1_RE, 'Current trusted-main head SHA');
  assertSha(input.producerHeadSha, SHA1_RE, 'Current producer head SHA');
  if (!Array.isArray(input.runsResponse.workflow_runs) || input.runsResponse.workflow_runs.length === 0) {
    throw new Error('Missing prerequisite workflow run; dispatch the fixed trusted-main workflow after freeze');
  }
  const runs = input.runsResponse.workflow_runs.map((value, index) => record(value, `Prerequisite workflow run[${index}]`));
  const rankedRuns = rankPrerequisiteRuns(runs);
  if (rankedRuns.length > 1
    && rankedRuns[0].run_number === rankedRuns[1].run_number
    && rankedRuns[0].run_attempt === rankedRuns[1].run_attempt
    && rankedRuns[0].id === rankedRuns[1].id) {
    throw new Error('Newest prerequisite workflow run selection is ambiguous');
  }
  const run = rankedRuns[0];
  const runHeadSha = nonEmptyString(run.head_sha, 'Prerequisite workflow run head_sha');
  assertSha(runHeadSha, SHA1_RE, 'Prerequisite workflow run head_sha');
  const reachable = input.runHeadIsReachableFromCurrentMain
    ?? runHeadSha === input.currentMainHeadSha;
  if (run.path !== PREREQUISITE_WORKFLOW_PATH
    || run.event !== 'workflow_dispatch'
    || run.head_branch !== 'main'
    || !reachable
    || run.status !== 'completed'
    || run.conclusion !== 'success') {
    throw new Error('Newest prerequisite workflow run is not successful/protected-main-reachable; older runs are masked');
  }
  if (run.run_attempt !== 1) throw new Error('Prerequisite workflow run_attempt must be exactly 1; reruns are not accepted');
  const nowMs = input.nowMs ?? Date.now();
  const createdAtMs = parseUtc(run.created_at, 'Prerequisite workflow run created_at');
  const updatedAtMs = parseUtc(run.updated_at, 'Prerequisite workflow run updated_at');
  if (createdAtMs > nowMs + 5 * 60 * 1_000
    || updatedAtMs > nowMs + 5 * 60 * 1_000
    || nowMs - updatedAtMs > PREREQUISITE_FRESHNESS_MS) {
    throw new Error('Prerequisite workflow run is outside the 24-hour acceptance freshness window');
  }
  const runId = integer(run.id, 'Prerequisite workflow run id');
  if (!Array.isArray(input.artifactsResponse.artifacts)) {
    throw new Error('Prerequisite artifact API response is malformed');
  }
  const totalCount = integer(input.artifactsResponse.total_count, 'Prerequisite artifact total_count');
  if (totalCount !== input.artifactsResponse.artifacts.length || totalCount !== 2) {
    throw new Error('Prerequisite run must contain exactly two artifacts with no pagination or extras');
  }
  const artifacts = input.artifactsResponse.artifacts.map((value, index) => record(value, `Prerequisite artifact[${index}]`));
  const expected = {
    prodModelDiff: {
      name: `s33-wave1-prod-model-diff-${input.producerHeadSha}`,
      filename: WORKFLOW_REPORT_FILENAMES.prodModelDiff,
    },
    embeddingDiagnostic: {
      name: `s33-wave1-embedding-diagnostic-${input.producerHeadSha}`,
      filename: WORKFLOW_REPORT_FILENAMES.embeddingDiagnostic,
    },
  } as const;
  const select = (kind: keyof typeof expected): VerifiedPrerequisiteArtifact => {
    const descriptor = expected[kind];
    const matches = artifacts.filter((artifact) => artifact.name === descriptor.name);
    if (matches.length !== 1) {
      throw new Error(`Prerequisite run must contain exactly one ${descriptor.name} artifact`);
    }
    const artifact = matches[0];
    if (artifact.expired !== false) throw new Error(`Prerequisite artifact ${descriptor.name} is expired`);
    const artifactRun = record(artifact.workflow_run, `Prerequisite artifact ${descriptor.name}.workflow_run`);
    if (artifactRun.id !== runId || artifactRun.head_sha !== runHeadSha) {
      throw new Error(`Prerequisite artifact ${descriptor.name} is bound to a different workflow run/head`);
    }
    const createdAtMs = parseUtc(artifact.created_at, `Prerequisite artifact ${descriptor.name}.created_at`);
    const updatedAtMs = parseUtc(artifact.updated_at, `Prerequisite artifact ${descriptor.name}.updated_at`);
    const expiresAtMs = parseUtc(artifact.expires_at, `Prerequisite artifact ${descriptor.name}.expires_at`);
    if (createdAtMs < parseUtc(run.created_at, 'Prerequisite workflow run created_at')
      || updatedAtMs < createdAtMs
      || updatedAtMs > nowMs + 5 * 60 * 1_000) {
      throw new Error(`Prerequisite artifact ${descriptor.name} timestamps are invalid`);
    }
    if (expiresAtMs <= nowMs) throw new Error(`Prerequisite artifact ${descriptor.name} has expired`);
    if (expiresAtMs - createdAtMs > 14 * 24 * 60 * 60 * 1_000 + 5 * 60 * 1_000) {
      throw new Error(`Prerequisite artifact ${descriptor.name} retention exceeds the CTO-fixed 14 days`);
    }
    const sizeInBytes = integer(artifact.size_in_bytes, `Prerequisite artifact ${descriptor.name}.size_in_bytes`);
    if (sizeInBytes <= 0 || sizeInBytes > MAX_PREREQUISITE_ARCHIVE_BYTES) {
      throw new Error(`Prerequisite artifact ${descriptor.name} exceeds the bounded archive size`);
    }
    return {
      id: integer(artifact.id, `Prerequisite artifact ${descriptor.name}.id`),
      name: descriptor.name,
      filename: descriptor.filename,
      apiDigestSha256: normalizedApiDigest(artifact.digest, `Prerequisite artifact ${descriptor.name}.digest`),
      sizeInBytes,
      createdAt: artifact.created_at as string,
      updatedAt: artifact.updated_at as string,
      expiresAt: artifact.expires_at as string,
    };
  };
  return Object.freeze({
    run: {
      id: runId,
      runNumber: integer(run.run_number, 'Prerequisite workflow run_number'),
      runAttempt: 1 as const,
      createdAt: run.created_at as string,
      updatedAt: run.updated_at as string,
      headSha: runHeadSha,
    },
    artifacts: {
      prodModelDiff: select('prodModelDiff'),
      embeddingDiagnostic: select('embeddingDiagnostic'),
    },
  });
}

export function extractSingleFileArchive(input: {
  archiveBytes: Uint8Array;
  artifact: VerifiedPrerequisiteArtifact;
  outputDirectory: string;
  producerHeadSha: string;
  manifestRawSha256: string;
}): void {
  if (sha256(input.archiveBytes) !== input.artifact.apiDigestSha256) {
    throw new Error(`Downloaded archive digest mismatch for ${input.artifact.name}`);
  }
  const archivePath = join(input.outputDirectory, `.${input.artifact.id}.zip`);
  writeFileSync(archivePath, input.archiveBytes, { mode: 0o600, flag: 'wx' });
  try {
    const listing = execFileSync('/usr/bin/unzip', ['-Z1', archivePath], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    }).split(/\r?\n/u).filter(Boolean);
    if (listing.length !== 1 || listing[0] !== input.artifact.filename) {
      throw new Error(`Prerequisite artifact ${input.artifact.name} must be a safe single-file archive`);
    }
    assertSingleRegularZipEntry(input.archiveBytes, input.artifact.filename, input.artifact.name);
    const reportBytes = execFileSync('/usr/bin/unzip', ['-p', archivePath, input.artifact.filename], {
      maxBuffer: MAX_PREREQUISITE_ARCHIVE_BYTES,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    if (reportBytes.byteLength === 0 || reportBytes.byteLength > MAX_PREREQUISITE_ARCHIVE_BYTES) {
      throw new Error(`Prerequisite report ${input.artifact.filename} has an invalid bounded size`);
    }
    const parsed = parseJsonBytes(reportBytes, `Prerequisite report ${input.artifact.filename}`);
    const artifactType = input.artifact.filename === WORKFLOW_REPORT_FILENAMES.prodModelDiff
      ? 'arkova-s33-wave1-prod-model-diff'
      : 'arkova-s33-wave1-embedding-diagnostic';
    validateReportEnvelope(parsed, artifactType, {
      localProducerHeadSha: input.producerHeadSha,
      manifestRawSha256: input.manifestRawSha256,
    }, `Prerequisite report ${input.artifact.filename}`);
    if (artifactType === 'arkova-s33-wave1-prod-model-diff'
      && parsed.payload.mode !== 'offline-prod-parity-replay') {
      throw new Error('Prerequisite prod-model-diff mode must be offline-prod-parity-replay');
    }
    if (artifactType === 'arkova-s33-wave1-embedding-diagnostic'
      && (parsed.payload.role !== 'diagnostic-only' || parsed.payload.canOverrideExactScan !== false)) {
      throw new Error('Prerequisite embedding report must be diagnostic-only and non-overriding');
    }
    writeFileSync(join(input.outputDirectory, input.artifact.filename), reportBytes, {
      mode: 0o600,
      flag: 'wx',
    });
  } finally {
    unlinkSync(archivePath);
  }
}

function assertSingleRegularZipEntry(
  archiveBytes: Uint8Array,
  expectedFilename: string,
  artifactName: string,
): void {
  const bytes = Buffer.from(archiveBytes);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) {
    throw new Error(`Prerequisite artifact ${artifactName} has no bounded ZIP central directory`);
  }
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== 1 || entries !== 1
    || eocd + 22 + commentLength !== bytes.length
    || centralOffset + centralSize !== eocd
    || centralOffset + 46 > eocd
    || bytes.readUInt32LE(centralOffset) !== 0x02014b50) {
    throw new Error(`Prerequisite artifact ${artifactName} must contain exactly one non-spanned central-directory entry`);
  }
  const madeBy = bytes.readUInt16LE(centralOffset + 4);
  const creatorSystem = madeBy >>> 8;
  const filenameLength = bytes.readUInt16LE(centralOffset + 28);
  const extraLength = bytes.readUInt16LE(centralOffset + 30);
  const entryCommentLength = bytes.readUInt16LE(centralOffset + 32);
  const centralEntryEnd = centralOffset + 46 + filenameLength + extraLength + entryCommentLength;
  const filename = bytes.subarray(centralOffset + 46, centralOffset + 46 + filenameLength).toString('utf8');
  const externalAttributes = bytes.readUInt32LE(centralOffset + 38);
  const unixMode = (externalAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (centralEntryEnd !== eocd
    || filename !== expectedFilename
    || creatorSystem !== 3
    || fileType !== 0o100000) {
    throw new Error(`Prerequisite artifact ${artifactName} entry must be an exact Unix regular file, never a symlink, hardlink, or special entry`);
  }
}

export async function fetchS33PrerequisiteArtifacts(options: {
  token: string;
  mainRepositoryRoot: string;
  producerRepositoryRoot: string;
  outputDirectory: string;
  rest?: GitHubRest;
  download?: GitHubDownload;
  nowMs?: number;
}): Promise<Readonly<VerifiedPrerequisiteInventory>> {
  const mainRepositoryRoot = realpathSync(options.mainRepositoryRoot);
  const mainHeadSha = git(mainRepositoryRoot, ['rev-parse', 'HEAD']);
  const producerRepositoryRoot = realpathSync(options.producerRepositoryRoot);
  const producerHeadSha = git(producerRepositoryRoot, ['rev-parse', 'HEAD']);
  const manifest = deriveManifestFacts(producerRepositoryRoot);
  const rest = options.rest ?? ((path: string) => liveGitHubRest(options.token, path));
  const workflowIdentity = await rest('/repos/carson-see/ArkovaCarson/actions/workflows/s33-wave1-prerequisites.yml');
  const workflowId = validatePrerequisiteWorkflowIdentity(workflowIdentity);
  const runsPath = `/repos/carson-see/ArkovaCarson/actions/workflows/${workflowId}/runs?branch=main&event=workflow_dispatch&per_page=100`;
  const runsResponse = await rest(runsPath);
  const newestRunId = (() => {
    if (!Array.isArray(runsResponse.workflow_runs) || runsResponse.workflow_runs.length === 0) {
      throw new Error('Missing prerequisite workflow run');
    }
    const sorted = rankPrerequisiteRuns(
      runsResponse.workflow_runs.map((value) => record(value, 'Prerequisite workflow run')),
    );
    return integer(sorted[0].id, 'Newest prerequisite workflow run id');
  })();
  const artifactsPath = `/repos/carson-see/ArkovaCarson/actions/runs/${newestRunId}/artifacts?per_page=100`;
  const artifactsResponse = await rest(artifactsPath);
  const selectedRun = rankPrerequisiteRuns(
    (runsResponse.workflow_runs as unknown[]).map((value) => record(value, 'Prerequisite workflow run')),
  )[0];
  const selectedRunHeadSha = nonEmptyString(selectedRun.head_sha, 'Newest prerequisite workflow run head_sha');
  assertSha(selectedRunHeadSha, SHA1_RE, 'Newest prerequisite workflow run head_sha');
  let runHeadIsReachableFromCurrentMain = false;
  try {
    execFileSync('/usr/bin/git', [
      '-C', mainRepositoryRoot, 'merge-base', '--is-ancestor', selectedRunHeadSha, mainHeadSha,
    ], { stdio: 'ignore' });
    runHeadIsReachableFromCurrentMain = true;
  } catch {
    runHeadIsReachableFromCurrentMain = false;
  }
  const inventory = verifyS33PrerequisiteInventory({
    runsResponse,
    artifactsResponse,
    currentMainHeadSha: mainHeadSha,
    runHeadIsReachableFromCurrentMain,
    producerHeadSha,
    nowMs: options.nowMs,
  });
  mkdirSync(options.outputDirectory, { recursive: false, mode: 0o700 });
  const outputDirectory = realpathSync(options.outputDirectory);
  const download = options.download ?? ((path: string) => liveGitHubDownload(options.token, path));
  for (const artifact of [inventory.artifacts.prodModelDiff, inventory.artifacts.embeddingDiagnostic]) {
    const bytes = await download(`/repos/carson-see/ArkovaCarson/actions/artifacts/${artifact.id}/zip`);
    extractSingleFileArchive({
      archiveBytes: bytes,
      artifact,
      outputDirectory,
      producerHeadSha,
      manifestRawSha256: manifest.manifestRawSha256,
    });
  }
  writeCanonical(join(outputDirectory, PREREQUISITE_INVENTORY_FILENAME), inventory);
  return inventory;
}

function loadPrerequisiteInventory(path: string): Readonly<VerifiedPrerequisiteInventory> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || basename(path) !== PREREQUISITE_INVENTORY_FILENAME) {
    throw new Error('Authenticated prerequisite inventory must be a regular fixed-name file');
  }
  const bytes = readFileSync(path);
  const parsed = parseJsonBytes(bytes, 'Authenticated prerequisite inventory');
  if (!Buffer.from(bytes).equals(Buffer.from(canonicaliseJson(parsed), 'utf8'))) {
    throw new Error('Authenticated prerequisite inventory must retain the canonical bytes written by the fetch gate');
  }
  assertExactKeys(parsed, ['run', 'artifacts'], 'Authenticated prerequisite inventory');
  const run = record(parsed.run, 'Authenticated prerequisite inventory.run');
  assertExactKeys(run, [
    'id', 'runNumber', 'runAttempt', 'createdAt', 'updatedAt', 'headSha',
  ], 'Authenticated prerequisite inventory.run');
  const artifacts = record(parsed.artifacts, 'Authenticated prerequisite inventory.artifacts');
  assertExactKeys(artifacts, ['prodModelDiff', 'embeddingDiagnostic'], 'Authenticated prerequisite inventory.artifacts');
  const parseArtifact = (kind: 'prodModelDiff' | 'embeddingDiagnostic'): VerifiedPrerequisiteArtifact => {
    const artifact = record(artifacts[kind], `Authenticated prerequisite inventory.artifacts.${kind}`);
    assertExactKeys(artifact, [
      'id', 'name', 'filename', 'apiDigestSha256', 'sizeInBytes', 'createdAt', 'updatedAt', 'expiresAt',
    ], `Authenticated prerequisite inventory.artifacts.${kind}`);
    const apiDigestSha256 = nonEmptyString(artifact.apiDigestSha256, `${kind}.apiDigestSha256`);
    assertSha(apiDigestSha256, SHA256_RE, `${kind}.apiDigestSha256`);
    parseUtc(artifact.createdAt, `${kind}.createdAt`);
    parseUtc(artifact.updatedAt, `${kind}.updatedAt`);
    parseUtc(artifact.expiresAt, `${kind}.expiresAt`);
    return {
      id: integer(artifact.id, `${kind}.id`),
      name: nonEmptyString(artifact.name, `${kind}.name`),
      filename: nonEmptyString(artifact.filename, `${kind}.filename`),
      apiDigestSha256,
      sizeInBytes: integer(artifact.sizeInBytes, `${kind}.sizeInBytes`),
      createdAt: artifact.createdAt as string,
      updatedAt: artifact.updatedAt as string,
      expiresAt: artifact.expiresAt as string,
    };
  };
  const headSha = nonEmptyString(run.headSha, 'Authenticated prerequisite inventory.run.headSha');
  assertSha(headSha, SHA1_RE, 'Authenticated prerequisite inventory.run.headSha');
  parseUtc(run.createdAt, 'Authenticated prerequisite inventory.run.createdAt');
  parseUtc(run.updatedAt, 'Authenticated prerequisite inventory.run.updatedAt');
  if (run.runAttempt !== 1) throw new Error('Authenticated prerequisite inventory must bind run attempt 1');
  return Object.freeze({
    run: {
      id: integer(run.id, 'Authenticated prerequisite inventory.run.id'),
      runNumber: integer(run.runNumber, 'Authenticated prerequisite inventory.run.runNumber'),
      runAttempt: 1 as const,
      createdAt: run.createdAt as string,
      updatedAt: run.updatedAt as string,
      headSha,
    },
    artifacts: {
      prodModelDiff: parseArtifact('prodModelDiff'),
      embeddingDiagnostic: parseArtifact('embeddingDiagnostic'),
    },
  });
}

async function reauthenticatePrerequisiteInventory(options: {
  token: string;
  mainRepositoryRoot: string;
  producerHeadSha: string;
  manifestRawSha256: string;
  prerequisiteDirectory: string;
  storedInventory: Readonly<VerifiedPrerequisiteInventory>;
  rest?: GitHubRest;
  download?: GitHubDownload;
}): Promise<Readonly<VerifiedPrerequisiteInventory>> {
  const rest = options.rest ?? ((path: string) => liveGitHubRest(options.token, path));
  const workflowIdentity = await rest('/repos/carson-see/ArkovaCarson/actions/workflows/s33-wave1-prerequisites.yml');
  const workflowId = validatePrerequisiteWorkflowIdentity(workflowIdentity);
  const runsResponse = await rest(`/repos/carson-see/ArkovaCarson/actions/workflows/${workflowId}/runs?branch=main&event=workflow_dispatch&per_page=100`);
  if (!Array.isArray(runsResponse.workflow_runs) || runsResponse.workflow_runs.length === 0) {
    throw new Error('Final verifier cannot re-authenticate the prerequisite workflow run');
  }
  const selectedRun = rankPrerequisiteRuns(
    runsResponse.workflow_runs.map((value) => record(value, 'Final prerequisite workflow run')),
  )[0];
  const runId = integer(selectedRun.id, 'Final prerequisite workflow run id');
  const artifactsResponse = await rest(`/repos/carson-see/ArkovaCarson/actions/runs/${runId}/artifacts?per_page=100`);
  const mainHeadSha = git(options.mainRepositoryRoot, ['rev-parse', 'HEAD']);
  const runHeadSha = nonEmptyString(selectedRun.head_sha, 'Final prerequisite workflow run head_sha');
  assertSha(runHeadSha, SHA1_RE, 'Final prerequisite workflow run head_sha');
  let reachable = false;
  try {
    execFileSync('/usr/bin/git', [
      '-C', options.mainRepositoryRoot, 'merge-base', '--is-ancestor', runHeadSha, mainHeadSha,
    ], { stdio: 'ignore' });
    reachable = true;
  } catch {
    reachable = false;
  }
  const liveInventory = verifyS33PrerequisiteInventory({
    runsResponse,
    artifactsResponse,
    currentMainHeadSha: mainHeadSha,
    runHeadIsReachableFromCurrentMain: reachable,
    producerHeadSha: options.producerHeadSha,
  });
  if (canonicaliseJson(liveInventory) !== canonicaliseJson(options.storedInventory)) {
    throw new Error('Final verifier prerequisite inventory changed after initial download');
  }
  const temporaryDirectory = mkdtempSync(join(dirname(options.prerequisiteDirectory), '.s33-prerequisite-reauth-'));
  try {
    const download = options.download ?? ((path: string) => liveGitHubDownload(options.token, path));
    for (const artifact of [liveInventory.artifacts.prodModelDiff, liveInventory.artifacts.embeddingDiagnostic]) {
      const archiveBytes = await download(`/repos/carson-see/ArkovaCarson/actions/artifacts/${artifact.id}/zip`);
      extractSingleFileArchive({
        archiveBytes,
        artifact,
        outputDirectory: temporaryDirectory,
        producerHeadSha: options.producerHeadSha,
        manifestRawSha256: options.manifestRawSha256,
      });
      const storedPath = join(options.prerequisiteDirectory, artifact.filename);
      const reauthenticatedPath = join(temporaryDirectory, artifact.filename);
      if (!readFileSync(storedPath).equals(readFileSync(reauthenticatedPath))) {
        throw new Error(`Final verifier prerequisite report bytes changed for ${artifact.filename}`);
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return liveInventory;
}

export function extractProdDiffAdjudication(
  body: string,
  submittedAt: string,
  producerHeadSha: string,
  manifestRawSha256: string,
  report: WorkflowReportBundle['prodModelDiff'],
  inventory: Readonly<VerifiedPrerequisiteInventory>,
): Readonly<AuthenticatedProdDiffAdjudication> {
  const startMarker = `<!-- ${PROD_DIFF_ADJUDICATION_MARKER} -->`;
  const endMarker = `<!-- /${PROD_DIFF_ADJUDICATION_MARKER} -->`;
  if (body.split(startMarker).length - 1 !== 1 || body.split(endMarker).length - 1 !== 1) {
    throw new Error('APPROVED review must contain exactly one authenticated prod-diff adjudication block');
  }
  const start = body.indexOf(startMarker) + startMarker.length;
  const end = body.indexOf(endMarker, start);
  if (end < start) throw new Error('Authenticated prod-diff adjudication markers are out of order');
  const match = body.slice(start, end).trim().match(/^```json\s*\n([\s\S]*?)\n```$/u);
  if (!match) throw new Error('Authenticated prod-diff adjudication block must be one strict ```json fence');
  const parsed = parseJsonBytes(Buffer.from(match[1], 'utf8'), 'Authenticated prod-diff adjudication block');
  assertExactKeys(parsed, [
    'schemaVersion', 'artifactType', 'batchId', 'producerHeadSha', 'manifestRawSha256',
    'prerequisite', 'mismatchCount', 'adjudications',
  ], 'Authenticated prod-diff adjudication block');
  if (parsed.schemaVersion !== 1
    || parsed.artifactType !== 'arkova-s33-wave1-prod-diff-adjudication'
    || parsed.batchId !== 'S33-W1'
    || parsed.producerHeadSha !== producerHeadSha
    || parsed.manifestRawSha256 !== manifestRawSha256) {
    throw new Error('Authenticated prod-diff adjudication identity/binding is invalid');
  }
  const prerequisite = record(parsed.prerequisite, 'Authenticated prod-diff adjudication prerequisite');
  assertExactKeys(prerequisite, [
    'workflowRunId', 'workflowRunNumber', 'workflowRunAttempt', 'trustedMainRunSha',
    'prodModelDiffArtifactId', 'prodModelDiffArchiveSha256',
    'prodModelDiffReportRawSha256', 'prodModelDiffReportCanonicalSha256',
  ], 'Authenticated prod-diff adjudication prerequisite');
  const artifact = inventory.artifacts.prodModelDiff;
  if (prerequisite.workflowRunId !== inventory.run.id
    || prerequisite.workflowRunNumber !== inventory.run.runNumber
    || prerequisite.workflowRunAttempt !== 1
    || prerequisite.trustedMainRunSha !== inventory.run.headSha
    || prerequisite.prodModelDiffArtifactId !== artifact.id
    || prerequisite.prodModelDiffArchiveSha256 !== artifact.apiDigestSha256
    || prerequisite.prodModelDiffReportRawSha256 !== report.rawSha256
    || prerequisite.prodModelDiffReportCanonicalSha256 !== report.canonicalSha256) {
    throw new Error('Authenticated prod-diff adjudication does not bind the exact report/artifact/run digests');
  }
  const payload = report.parsed.payload;
  if (payload.workflowRunId !== inventory.run.id
    || payload.workflowRunAttempt !== 1
    || payload.trustedMainRunSha !== inventory.run.headSha
    || payload.workflowPath !== PREREQUISITE_WORKFLOW_PATH) {
    throw new Error('Production diff report prerequisite run binding disagrees with authenticated GitHub inventory');
  }
  const reportCompletedAt = parseUtc(payload.completedAtUtc, 'Production diff completedAtUtc');
  const publishedAt = Math.max(
    reportCompletedAt,
    parseUtc(inventory.run.updatedAt, 'Prerequisite run updatedAt'),
    parseUtc(artifact.updatedAt, 'Prod-model-diff artifact updatedAt'),
  );
  if (parseUtc(submittedAt, 'Authenticated APPROVED review submittedAt') <= publishedAt) {
    throw new Error('Authenticated prod-diff adjudication review must postdate the published prerequisite report/artifact/run');
  }
  const mismatches = payload.results.filter(({ classification }) => classification === 'MISMATCH');
  if (parsed.mismatchCount !== mismatches.length
    || !Array.isArray(parsed.adjudications)
    || parsed.adjudications.length !== mismatches.length) {
    throw new Error('Authenticated prod-diff adjudication must list every and only MISMATCH exactly once');
  }
  const adjudications = parsed.adjudications.map((value, index) => {
    const adjudication = record(value, `Authenticated prod-diff adjudications[${index}]`);
    assertExactKeys(adjudication, ['entryId', 'disposition', 'rationale'], `Authenticated prod-diff adjudications[${index}]`);
    if (adjudication.entryId !== mismatches[index].id) {
      throw new Error('Authenticated prod-diff adjudication must follow the exact ordered MISMATCH universe');
    }
    if (adjudication.disposition === 'LABEL_DEFECT') {
      throw new Error(`Production diff ${String(adjudication.entryId)} is a LABEL_DEFECT; Wave-1 acceptance is rejected`);
    }
    if (adjudication.disposition !== 'MODEL_HARD') {
      throw new Error('Each production diff mismatch disposition must be MODEL_HARD or LABEL_DEFECT');
    }
    const rationale = nonEmptyString(adjudication.rationale, `Prod-diff adjudication ${String(adjudication.entryId)} rationale`);
    if (rationale.trim().length < 20) throw new Error('Each production diff mismatch requires a substantive rationale');
    return { entryId: adjudication.entryId as string, disposition: 'MODEL_HARD' as const, rationale };
  });
  return Object.freeze({
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave1-prod-diff-adjudication',
    batchId: 'S33-W1',
    producerHeadSha,
    manifestRawSha256,
    prerequisite: {
      workflowRunId: inventory.run.id,
      workflowRunNumber: inventory.run.runNumber,
      workflowRunAttempt: 1 as const,
      trustedMainRunSha: inventory.run.headSha,
      prodModelDiffArtifactId: artifact.id,
      prodModelDiffArchiveSha256: artifact.apiDigestSha256,
      prodModelDiffReportRawSha256: report.rawSha256,
      prodModelDiffReportCanonicalSha256: report.canonicalSha256,
    },
    mismatchCount: mismatches.length,
    adjudications,
  });
}

function validatePremergeBranchProtection(repository: Record<string, unknown>): number {
  const connection = record(repository.branchProtectionRules, 'Pre-merge branchProtectionRules');
  const pageInfo = record(connection.pageInfo, 'Pre-merge branchProtectionRules.pageInfo');
  if (pageInfo.hasNextPage === true) throw new Error('Pre-merge branchProtectionRules enumeration was truncated');
  if (!Array.isArray(connection.nodes)) throw new Error('Pre-merge branchProtectionRules.nodes must be an array');
  const matching = connection.nodes.map((value, index) => record(value, `Pre-merge branch rule[${index}]`))
    .filter((rule) => {
      const refs = record(rule.matchingRefs, 'Pre-merge branch rule matchingRefs');
      return Array.isArray(refs.nodes)
        && refs.nodes.some((value) => record(value, 'Pre-merge matching ref').name === 'main');
    });
  if (matching.length === 0) throw new Error('Pre-merge same-token query found no branch-protection rule matching main');
  let contextCount = 0;
  for (const rule of matching) {
    if (rule.requiresStatusChecks !== true || !Array.isArray(rule.requiredStatusChecks)) {
      throw new Error('Pre-merge main branch rule must expose requiredStatusChecks');
    }
    const legacy = Array.isArray(rule.requiredStatusCheckContexts)
      ? rule.requiredStatusCheckContexts
      : [];
    const descriptions = rule.requiredStatusChecks.map((value, index) => {
      const description = record(value, `Pre-merge required status check[${index}]`);
      const context = nonEmptyString(description.context, `Pre-merge required status check[${index}].context`);
      const app = record(description.app, `Pre-merge required status check ${context}.app`);
      nonEmptyString(app.id, `Pre-merge required status check ${context}.app.id`);
      integer(app.databaseId, `Pre-merge required status check ${context}.app.databaseId`);
      nonEmptyString(app.slug, `Pre-merge required status check ${context}.app.slug`);
      return context;
    });
    if (legacy.some((context) => !descriptions.includes(context))) {
      throw new Error('Pre-merge main branch rule has a context without an app-qualified description');
    }
    contextCount += descriptions.length;
  }
  if (contextCount === 0) throw new Error('Pre-merge same-token query returned zero required contexts/apps');
  return contextCount;
}

function validatePremergeFallbacks(repository: Record<string, unknown>): string[] {
  const writable: string[] = [];
  for (const identity of AUTHORITY_CONFIGURATION.fallbacks) {
    const key = identity.login === 'BestNessie' ? 'bestNessie' : 'alibama';
    const connection = record(repository[key], `Pre-merge collaborator query ${identity.login}`);
    if (!Array.isArray(connection.edges)) throw new Error(`Pre-merge collaborator edges missing for ${identity.login}`);
    const exact = connection.edges.map((value) => record(value, `Pre-merge collaborator edge ${identity.login}`))
      .filter((edge) => identityMatches(record(edge.node, `Pre-merge collaborator ${identity.login}`) as unknown as GitHubIdentity, identity));
    if (exact.length === 1 && ['WRITE', 'MAINTAIN', 'ADMIN'].includes(String(exact[0].permission))) {
      writable.push(identity.login);
    }
  }
  if (writable.length === 0) throw new Error('Pre-merge same-token query found no exact fallback with live WRITE-or-higher permission');
  return writable;
}

export async function runS33PremergeApiPreflight(options: {
  token: string;
  event: PremergePullRequestEvent;
  graphql?: PremergeGraphql;
  rest?: GitHubRest;
}): Promise<Readonly<{ requiredContextCount: number; checkContextCount: number; reviewCount: number; writableFallbacks: string[]; artifactCount: number; listedWorkflowCount: number; prerequisiteWorkflowRegistered: false }>> {
  if (options.event.repository.full_name !== FIXED_REPOSITORY
    || options.event.pull_request.number !== FIXED_SUPPORT_PULL_REQUEST_NUMBER) {
    throw new Error('Pre-merge same-token API preflight is fixed to ArkovaCarson PR #1529');
  }
  assertSha(options.event.pull_request.head.sha, SHA1_RE, 'Pre-merge event PR head SHA');
  const graphql = options.graphql ?? ((query: string) => liveGitHubGraphqlRecord(options.token, query));
  const data = await graphql(S33_PREMERGE_API_QUERY);
  const repository = record(data.repository, 'Pre-merge GitHub repository');
  const defaultBranch = record(repository.defaultBranchRef, 'Pre-merge defaultBranchRef');
  if (defaultBranch.name !== 'main') throw new Error('Pre-merge repository default branch must be main');
  const requiredContextCount = validatePremergeBranchProtection(repository);
  const pullRequest = record(repository.supportPullRequest, 'Pre-merge PR #1529');
  if (pullRequest.number !== FIXED_SUPPORT_PULL_REQUEST_NUMBER
    || pullRequest.state !== 'OPEN'
    || pullRequest.headRefOid !== options.event.pull_request.head.sha
    || record(pullRequest.headRepository, 'Pre-merge PR headRepository').nameWithOwner !== FIXED_REPOSITORY) {
    throw new Error('Pre-merge PR API enumeration does not bind the exact #1529 event head');
  }
  const headCommitConnection = record(pullRequest.headCommit, 'Pre-merge PR headCommit');
  if (!Array.isArray(headCommitConnection.nodes) || headCommitConnection.nodes.length !== 1) {
    throw new Error('Pre-merge check API enumeration returned an ambiguous head commit');
  }
  const headCommit = record(record(headCommitConnection.nodes[0], 'Pre-merge head node').commit, 'Pre-merge head commit');
  if (headCommit.oid !== options.event.pull_request.head.sha) throw new Error('Pre-merge check API head is stale');
  const rollup = record(headCommit.statusCheckRollup, 'Pre-merge statusCheckRollup');
  const contexts = record(rollup.contexts, 'Pre-merge statusCheckRollup.contexts');
  const contextPage = record(contexts.pageInfo, 'Pre-merge statusCheckRollup.pageInfo');
  if (contextPage.hasNextPage === true || !Array.isArray(contexts.nodes) || contexts.nodes.length === 0) {
    throw new Error('Pre-merge check API enumeration is missing or truncated');
  }
  for (const [index, value] of contexts.nodes.entries()) {
    const context = record(value, `Pre-merge check context[${index}]`);
    if (context.__typename === 'CheckRun') {
      const suite = record(context.checkSuite, `Pre-merge CheckRun[${index}].checkSuite`);
      const app = record(suite.app, `Pre-merge CheckRun[${index}].app`);
      nonEmptyString(app.id, `Pre-merge CheckRun[${index}].app.id`);
      integer(app.databaseId, `Pre-merge CheckRun[${index}].app.databaseId`);
      nonEmptyString(app.slug, `Pre-merge CheckRun[${index}].app.slug`);
    } else if (context.__typename !== 'StatusContext') {
      throw new Error(`Pre-merge check context[${index}] has an unknown type`);
    }
  }
  const reviews = record(pullRequest.reviews, 'Pre-merge PR reviews');
  if (record(reviews.pageInfo, 'Pre-merge PR reviews.pageInfo').hasPreviousPage === true
    || !Array.isArray(reviews.nodes)) {
    throw new Error('Pre-merge review API enumeration is truncated or malformed');
  }
  const writableFallbacks = validatePremergeFallbacks(repository);
  const rest = options.rest ?? ((path: string) => liveGitHubRest(options.token, path));
  const workflowListing = await rest('/repos/carson-see/ArkovaCarson/actions/workflows?per_page=100');
  if (!Array.isArray(workflowListing.workflows)) {
    throw new Error('Pre-merge Actions workflow listing is malformed');
  }
  const listedWorkflowCount = integer(workflowListing.total_count, 'Pre-merge Actions workflow total_count');
  if (listedWorkflowCount === 0 || listedWorkflowCount !== workflowListing.workflows.length) {
    throw new Error('Pre-merge Actions workflow listing is empty or paginated; actions:read is not fully proven');
  }
  for (const [index, value] of workflowListing.workflows.entries()) {
    const workflow = record(value, `Pre-merge Actions workflow[${index}]`);
    if (integer(workflow.id, `Pre-merge Actions workflow[${index}].id`) <= 0) {
      throw new Error('Pre-merge Actions workflow id must be positive');
    }
    nonEmptyString(workflow.path, `Pre-merge Actions workflow[${index}].path`);
  }
  if (workflowListing.workflows.some((value) => record(value, 'Pre-merge Actions workflow').path === PREREQUISITE_WORKFLOW_PATH)) {
    throw new Error('Pre-merge prerequisite workflow unexpectedly already has a numeric main-branch identity');
  }
  const artifacts = await rest('/repos/carson-see/ArkovaCarson/actions/artifacts?per_page=1');
  const artifactCount = integer(artifacts.total_count, 'Pre-merge actions artifacts total_count');
  if (!Array.isArray(artifacts.artifacts)) throw new Error('Pre-merge actions artifacts enumeration is malformed');
  return Object.freeze({
    requiredContextCount,
    checkContextCount: contexts.nodes.length,
    reviewCount: reviews.nodes.length,
    writableFallbacks,
    artifactCount,
    listedWorkflowCount,
    prerequisiteWorkflowRegistered: false as const,
  });
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

function deriveManifestFacts(producerRepositoryRoot: string): {
  manifestRawSha256: string;
  manifestCanonicalSha256: string;
  manifestEntryIds: string[];
} {
  const bytes = execFileSync('/usr/bin/git', [
    '-C', producerRepositoryRoot, 'show', `HEAD:${FIXED_MANIFEST_PATH}`,
  ], {
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  const parsed = parseJsonBytes(bytes, 'Committed Wave-1 manifest');
  if (parsed.batchId !== 'S33-W1' || !Array.isArray(parsed.entries) || parsed.entries.length !== 81) {
    throw new Error('Committed Wave-1 manifest must identify S33-W1 with exactly 81 entries');
  }
  const manifestEntryIds = parsed.entries.map((value, index) => {
    const entry = record(value, `Committed Wave-1 manifest entries[${index}]`);
    return nonEmptyString(entry.id, `Committed Wave-1 manifest entries[${index}].id`);
  });
  if (new Set(manifestEntryIds).size !== manifestEntryIds.length) {
    throw new Error('Committed Wave-1 manifest entry ids must be unique');
  }
  return {
    manifestRawSha256: sha256(bytes),
    manifestCanonicalSha256: sha256(canonicaliseJson(parsed)),
    manifestEntryIds,
  };
}

function writeCanonical(path: string, value: unknown): { rawSha256: string; canonicalSha256: string } {
  const canonical = canonicaliseJson(value);
  writeFileSync(path, canonical, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const digest = sha256(canonical);
  return { rawSha256: digest, canonicalSha256: digest };
}

function reportDigestRecord(report: LoadedWorkflowReport): Record<string, unknown> {
  return {
    filename: report.filename,
    rawSha256: report.rawSha256,
    canonicalSha256: report.canonicalSha256,
  };
}

function renderEvidenceReport(evidence: Record<string, unknown>): string {
  const approval = evidence.approval as VerifiedGitHubTrustRoot['approval'];
  const checks = evidence.requiredChecks as VerifiedGitHubTrustRoot['requiredChecks'];
  const reports = evidence.workflowReports as Record<string, { rawSha256: string; canonicalSha256: string }>;
  const lines = [
    '# S3.3 Wave-1 GitHub-authenticated evidence',
    '',
    `- Repository: ${FIXED_REPOSITORY}`,
    `- PR: #${FIXED_PULL_REQUEST_NUMBER}`,
    `- Producer head: ${String(evidence.producerHeadSha)}`,
    `- Producer tree: ${String(evidence.producerTreeSha)}`,
    `- Manifest raw SHA-256: ${String(evidence.manifestRawSha256)}`,
    `- Manifest canonical SHA-256: ${String(evidence.manifestCanonicalSha256)}`,
    `- Reviewer: ${approval.reviewer.login} (databaseId ${approval.reviewer.databaseId}; nodeId ${approval.reviewer.id})`,
    `- Review: ${approval.reviewId}`,
    '',
    '## Live required checks',
    '',
    ...checks.map((check) => `- ${check.name}: ${check.conclusion}; check ${check.checkRunId}; app ${check.app.slug}/${check.app.databaseId}/${check.app.id}`),
    '',
    '## Workflow-local report digests',
    '',
    ...Object.entries(reports).map(([name, digest]) => `- ${name}: raw ${digest.rawSha256}; canonical ${digest.canonicalSha256}`),
    '',
    'Embedding evidence is diagnostic-only and cannot override the exact normalized 6-13 gram scan.',
  ];
  return `${lines.join('\n')}\n`;
}

interface AuthenticateOptions {
  mainRepositoryRoot: string;
  producerRepositoryRoot: string;
  prerequisiteDirectory: string;
  reportDirectory: string;
  outputDirectory: string;
  token: string;
  graphql?: GitHubGraphql;
  rest?: GitHubRest;
  download?: GitHubDownload;
}

export async function authenticateS33Wave1GitHubEvidence(options: AuthenticateOptions): Promise<void> {
  const mainRepositoryRoot = realpathSync(options.mainRepositoryRoot);
  const producerRepositoryRoot = realpathSync(options.producerRepositoryRoot);
  const reportDirectory = realpathSync(options.reportDirectory);
  const prerequisiteDirectory = realpathSync(options.prerequisiteDirectory);
  const mainHeadSha = git(mainRepositoryRoot, ['rev-parse', 'HEAD']);
  const producerHeadSha = git(producerRepositoryRoot, ['rev-parse', 'HEAD']);
  const producerTreeSha = git(producerRepositoryRoot, ['rev-parse', 'HEAD^{tree}']);
  assertSha(mainHeadSha, SHA1_RE, 'Local main head SHA');
  assertSha(producerHeadSha, SHA1_RE, 'Local producer head SHA');
  assertSha(producerTreeSha, SHA1_RE, 'Local producer tree SHA');
  const lineage = git(producerRepositoryRoot, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/u);
  if (lineage.length !== 2 || lineage[0] !== producerHeadSha) {
    throw new Error('PR #1498 producer head must be one exact single-parent commit');
  }
  const manifest = deriveManifestFacts(producerRepositoryRoot);
  const graphql = options.graphql ?? ((query: string) => liveGitHubGraphql(options.token, query));
  const snapshot = await graphql(S33_GITHUB_EVIDENCE_QUERY);
  const supportMergeSha = snapshot.repository?.supportPullRequest?.mergeCommit?.oid;
  let supportMergeIsAncestorOfMain = false;
  if (typeof supportMergeSha === 'string') {
    try {
      execFileSync('/usr/bin/git', [
        '-C', mainRepositoryRoot, 'merge-base', '--is-ancestor', supportMergeSha, mainHeadSha,
      ], { stdio: 'ignore' });
      supportMergeIsAncestorOfMain = true;
    } catch {
      supportMergeIsAncestorOfMain = false;
    }
  }
  const facts: DerivedRepositoryFacts = {
    localMainHeadSha: mainHeadSha,
    localProducerHeadSha: producerHeadSha,
    supportMergeIsAncestorOfMain,
    manifestRawSha256: manifest.manifestRawSha256,
    manifestEntryIds: manifest.manifestEntryIds,
  };
  const trust = verifyGitHubTrustRoot(snapshot, facts);
  const reports = loadWorkflowReportBundle({
    crossReviewPlan: join(reportDirectory, WORKFLOW_REPORT_FILENAMES.crossReviewPlan),
    prodModelDiff: join(reportDirectory, WORKFLOW_REPORT_FILENAMES.prodModelDiff),
    lexicalLeakage: join(reportDirectory, WORKFLOW_REPORT_FILENAMES.lexicalLeakage),
    embeddingDiagnostic: join(reportDirectory, WORKFLOW_REPORT_FILENAMES.embeddingDiagnostic),
  }, {
    producerHeadSha: facts.localProducerHeadSha,
    manifestRawSha256: facts.manifestRawSha256,
    manifestEntryIds: facts.manifestEntryIds,
  });
  const storedInventory = loadPrerequisiteInventory(join(
    prerequisiteDirectory,
    PREREQUISITE_INVENTORY_FILENAME,
  ));
  const inventory = await reauthenticatePrerequisiteInventory({
    token: options.token,
    mainRepositoryRoot,
    producerHeadSha,
    manifestRawSha256: manifest.manifestRawSha256,
    prerequisiteDirectory,
    storedInventory,
    rest: options.rest,
    download: options.download,
  });
  const embeddingPayload = reports.embeddingDiagnostic.parsed.payload;
  if (embeddingPayload.workflowRunId !== inventory.run.id
    || embeddingPayload.workflowRunAttempt !== 1
    || embeddingPayload.trustedMainRunSha !== inventory.run.headSha
    || embeddingPayload.workflowPath !== PREREQUISITE_WORKFLOW_PATH) {
    throw new Error('Embedding report prerequisite run binding disagrees with authenticated GitHub inventory');
  }
  const prodDiffAdjudication = extractProdDiffAdjudication(
    trust.authenticatedReviewBody,
    trust.approval.submittedAt,
    producerHeadSha,
    manifest.manifestRawSha256,
    reports.prodModelDiff,
    inventory,
  );
  sameOrderedStrings(
    reports.crossReviewPlan.parsed.payload.sampleEntryIds,
    trust.crossReview.sampleEntryIds,
    'Authenticated human review and workflow cross-review plan sampleEntryIds',
  );
  mkdirSync(options.outputDirectory, { recursive: false, mode: 0o700 });
  const outputDirectory = realpathSync(options.outputDirectory);
  const authenticatedCrossReview = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave1-cross-review',
    batchId: 'S33-W1',
    producerHeadSha,
    manifestRawSha256: manifest.manifestRawSha256,
    status: 'PASS',
    payload: {
      sampleAlgorithm: trust.crossReview.sampleAlgorithm,
      sampleRule: trust.crossReview.sampleRule,
      manifestEntryCount: trust.crossReview.manifestEntryCount,
      sampleEntryIds: trust.crossReview.sampleEntryIds,
      materialLabelDefectCount: 0,
      adjudications: trust.crossReview.adjudications,
      wholeBatchVerdict: 'ACCEPT',
      githubAuthentication: trust.approval,
    },
  };
  const crossReviewDigests = writeCanonical(
    join(outputDirectory, OUTPUT_FILENAMES.crossReview),
    authenticatedCrossReview,
  );
  const reportBytes = (report: LoadedWorkflowReport): AuthenticatedReportBytes => ({
    filename: report.filename,
    bytesBase64: Buffer.from(report.bytes).toString('base64'),
    rawSha256: report.rawSha256,
    canonicalSha256: report.canonicalSha256,
  });
  const authenticatedBundle = registerAuthenticatedS33Wave1EvidenceBundle({
    repositoryIdentity: FIXED_REPOSITORY,
    pullRequestNumber: FIXED_PULL_REQUEST_NUMBER,
    producerRepositoryRoot,
    trustedMainHeadSha: trust.mainHeadSha,
    supportMergeCommitSha: trust.supportMergeCommitSha,
    supportMergeIsAncestorOfMain: true,
    producerHeadSha,
    producerTreeSha,
    manifestPath: FIXED_MANIFEST_PATH,
    manifestRawSha256: manifest.manifestRawSha256,
    manifestCanonicalSha256: manifest.manifestCanonicalSha256,
    manifestEntryIds: [...manifest.manifestEntryIds],
    acceptedAtUtc: trust.approval.submittedAt,
    approval: trust.approval,
    authenticatedReviewBody: trust.authenticatedReviewBody,
    branchProtectionRuleIds: trust.branchProtectionRuleIds,
    requiredChecks: trust.requiredChecks,
    reports: {
      crossReview: {
        filename: OUTPUT_FILENAMES.crossReview,
        bytesBase64: Buffer.from(canonicaliseJson(authenticatedCrossReview), 'utf8').toString('base64'),
        ...crossReviewDigests,
      },
      prodModelDiff: reportBytes(reports.prodModelDiff),
      lexicalLeakage: reportBytes(reports.lexicalLeakage),
      embeddingDiagnostic: reportBytes(reports.embeddingDiagnostic),
    },
    prodDiffAdjudication,
    prerequisiteInventory: inventory,
  });
  assertAuthenticatedS33Wave1EvidenceBundle(authenticatedBundle);
  const acceptedAtUtc = trust.approval.submittedAt;
  const acceptanceInput = {
    repositoryIdentity: FIXED_REPOSITORY,
    pullRequestNumber: FIXED_PULL_REQUEST_NUMBER,
    producerHeadSha,
    acceptedAtUtc,
    githubVerdict: {
      status: 'APPROVED',
      headSha: producerHeadSha,
      url: FIXED_PULL_REQUEST_URL,
      reviewUrl: trust.approval.url,
      reviewer: trust.approval.reviewer,
      checks: trust.requiredChecks.map((check) => ({
        name: check.name,
        conclusion: 'SUCCESS',
        headSha: producerHeadSha,
        detailsUrl: check.detailsUrl,
        checkRunId: check.checkRunId,
        app: check.app,
      })),
    },
    evidence: {
      crossReview: {
        path: OUTPUT_FILENAMES.crossReview,
        ...crossReviewDigests,
      },
      prodModelDiff: reportDigestRecord(reports.prodModelDiff),
      prodModelDiffMode: 'offline-prod-parity-replay',
      prodDiffAdjudication,
      lexicalLeakage: {
        ...reportDigestRecord(reports.lexicalLeakage),
        algorithm: 'normalized-token-exact-ngram-v1',
        n: [...REQUIRED_LEXICAL_N],
        trainingManifestSha256: reports.lexicalLeakage.parsed.payload.trainingManifestSha256,
        exactMatchCount: 0,
      },
      embedding: {
        ...reportDigestRecord(reports.embeddingDiagnostic),
        role: 'diagnostic-only',
        canOverrideExactScan: false,
      },
    },
  };
  const acceptanceInputDigests = writeCanonical(
    join(outputDirectory, OUTPUT_FILENAMES.acceptanceInput),
    acceptanceInput,
  );
  const githubEvidence = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave1-github-evidence',
    batchId: 'S33-W1',
    trustRoot: 'github-authenticated-exact-head-ci',
    repositoryIdentity: FIXED_REPOSITORY,
    pullRequestNumber: FIXED_PULL_REQUEST_NUMBER,
    supportPullRequestNumber: FIXED_SUPPORT_PULL_REQUEST_NUMBER,
    mainHeadSha,
    supportMergeCommitSha: trust.supportMergeCommitSha,
    producerHeadSha,
    producerTreeSha,
    manifestPath: FIXED_MANIFEST_PATH,
    manifestRawSha256: manifest.manifestRawSha256,
    manifestCanonicalSha256: manifest.manifestCanonicalSha256,
    branchProtectionRuleIds: trust.branchProtectionRuleIds,
    requiredChecks: trust.requiredChecks,
    approval: trust.approval,
    prodDiffAdjudication,
    prerequisiteInventory: inventory,
    crossReview: {
      filename: OUTPUT_FILENAMES.crossReview,
      ...crossReviewDigests,
      sampleEntryIds: trust.crossReview.sampleEntryIds,
    },
    workflowReports: {
      crossReviewPlan: reportDigestRecord(reports.crossReviewPlan),
      prodModelDiff: reportDigestRecord(reports.prodModelDiff),
      lexicalLeakage: reportDigestRecord(reports.lexicalLeakage),
      embeddingDiagnostic: reportDigestRecord(reports.embeddingDiagnostic),
    },
    acceptanceInput: {
      filename: OUTPUT_FILENAMES.acceptanceInput,
      ...acceptanceInputDigests,
    },
    rulings: trust.rulings,
  };
  writeCanonical(join(outputDirectory, OUTPUT_FILENAMES.githubEvidence), githubEvidence);
  writeFileSync(
    join(outputDirectory, OUTPUT_FILENAMES.report),
    renderEvidenceReport(githubEvidence),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
}

function renderComment(outputDirectory: string): void {
  const evidencePath = join(realpathSync(outputDirectory), OUTPUT_FILENAMES.githubEvidence);
  const evidenceBytes = readFileSync(evidencePath);
  const evidence = parseJsonBytes(evidenceBytes, 'Authenticated GitHub evidence');
  const canonical = canonicaliseJson(evidence);
  if (!Buffer.from(evidenceBytes).equals(Buffer.from(canonical, 'utf8'))) {
    throw new Error('Authenticated GitHub evidence bytes are not canonical');
  }
  const artifactId = nonEmptyString(process.env.S33_UPLOAD_ARTIFACT_ID, 'S33_UPLOAD_ARTIFACT_ID');
  const artifactUrl = assertHttpsUrl(process.env.S33_UPLOAD_ARTIFACT_URL, 'S33_UPLOAD_ARTIFACT_URL');
  const artifactDigest = nonEmptyString(process.env.S33_UPLOAD_ARTIFACT_DIGEST, 'S33_UPLOAD_ARTIFACT_DIGEST')
    .replace(/^sha256:/u, '');
  assertSha(artifactDigest, SHA256_RE, 'Uploaded artifact SHA-256');
  const approval = evidence.approval as VerifiedGitHubTrustRoot['approval'];
  const checks = evidence.requiredChecks as VerifiedGitHubTrustRoot['requiredChecks'];
  const workflowReports = evidence.workflowReports as Record<string, { rawSha256: string; canonicalSha256: string }>;
  const crossReview = evidence.crossReview as { rawSha256: string; canonicalSha256: string };
  const lines = [
    '<!-- arkova-s33-wave1-github-evidence -->',
    '### S3.3 Wave-1 authenticated evidence (new immutable run comment)',
    '',
    `- Artifact: [ID ${artifactId}](${artifactUrl})`,
    `- Uploaded artifact SHA-256: \`${artifactDigest}\``,
    `- GitHub evidence raw/canonical SHA-256: \`${sha256(evidenceBytes)}\``,
    `- Producer head/tree: \`${String(evidence.producerHeadSha)}\` / \`${String(evidence.producerTreeSha)}\``,
    `- Manifest raw/canonical SHA-256: \`${String(evidence.manifestRawSha256)}\` / \`${String(evidence.manifestCanonicalSha256)}\``,
    `- APPROVED review: \`${approval.reviewId}\`; reviewer \`${approval.reviewer.login}\` (databaseId \`${approval.reviewer.databaseId}\`, nodeId \`${approval.reviewer.id}\`)`,
    `- Cross-review raw/canonical SHA-256: \`${crossReview.rawSha256}\` / \`${crossReview.canonicalSha256}\``,
    '',
    '**Live required contexts (exact-head, unique latest, successful):**',
    ...checks.map((check) => `- \`${check.name}\`: check \`${check.checkRunId}\`; app \`${check.app.slug}\` databaseId \`${check.app.databaseId}\` nodeId \`${check.app.id}\``),
    '',
    '**Workflow report raw/canonical SHA-256:**',
    ...Object.entries(workflowReports).map(([name, digest]) => `- \`${name}\`: \`${digest.rawSha256}\` / \`${digest.canonicalSha256}\``),
    '',
    ...AUTHORITY_CONFIGURATION.rulings.map((url) => `- Binding CTO ruling: ${url}`),
    '',
    '_This comment was POSTed after artifact upload by github-actions[bot]. The workflow has no update-comment path._',
    '',
  ];
  writeFileSync(
    join(outputDirectory, OUTPUT_FILENAMES.comment),
    lines.join('\n'),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
}

function parseCli(argv: readonly string[]): { command: 'verify' | 'render-comment' | 'preflight' | 'fetch-prerequisites'; values: Map<string, string> } {
  const command = argv[0] === 'render-comment'
    ? 'render-comment'
    : argv[0] === 'preflight'
      ? 'preflight'
      : argv[0] === 'fetch-prerequisites'
        ? 'fetch-prerequisites'
      : 'verify';
  const args = command === 'verify' ? argv : argv.slice(1);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || values.has(key)) {
      throw new Error('Invalid or duplicated S3.3 GitHub evidence CLI argument');
    }
    values.set(key, value);
  }
  const allowed = command === 'verify'
    ? ['--main-repository', '--producer-repository', '--prerequisite-directory', '--report-directory', '--output-directory']
    : command === 'render-comment'
      ? ['--output-directory']
      : command === 'fetch-prerequisites'
        ? ['--main-repository', '--producer-repository', '--output-directory']
        : [];
  const unknown = [...values.keys()].filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !values.has(key));
  if (unknown.length > 0 || missing.length > 0 || values.size !== allowed.length) {
    throw new Error(`S3.3 GitHub evidence CLI arguments mismatch; missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`);
  }
  return { command, values };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== FIXED_REPOSITORY) {
    throw new Error('S3.3 Wave-1 GitHub evidence may run only inside the fixed Arkova GitHub Actions workflow');
  }
  const token = nonEmptyString(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN');
  if (cli.command === 'preflight') {
    if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
      throw new Error('S3.3 same-token preflight may run only on the #1529 pull_request event');
    }
    const eventPath = realpathSync(nonEmptyString(process.env.GITHUB_EVENT_PATH, 'GITHUB_EVENT_PATH'));
    const event = parseJsonBytes(readFileSync(eventPath), 'GitHub pull_request event') as unknown as PremergePullRequestEvent;
    const result = await runS33PremergeApiPreflight({ token, event });
    process.stdout.write(`S3.3 pre-merge API preflight: PASS — requiredContexts=${result.requiredContextCount}, checks=${result.checkContextCount}, reviews=${result.reviewCount}, writableFallbacks=${result.writableFallbacks.join(',')}, listedWorkflows=${result.listedWorkflowCount}, prerequisiteWorkflowRegistered=${result.prerequisiteWorkflowRegistered}, artifacts=${result.artifactCount}\n`);
    return;
  }
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('S3.3 Wave-1 acceptance may run only from workflow_dispatch on trusted main');
  }
  if (cli.command === 'render-comment') {
    renderComment(cli.values.get('--output-directory')!);
    return;
  }
  const workspace = realpathSync(nonEmptyString(process.env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE'));
  const runnerTemp = realpathSync(nonEmptyString(process.env.RUNNER_TEMP, 'RUNNER_TEMP'));
  const expectedPaths = {
    main: workspace,
    producer: join(runnerTemp, 's33-producer.git'),
    reports: join(runnerTemp, 's33-wave1-reports'),
    prerequisites: join(runnerTemp, 's33-wave1-prerequisites'),
    output: join(runnerTemp, 's33-wave1-authenticated'),
  };
  if (cli.command === 'fetch-prerequisites') {
    if (resolve(cli.values.get('--main-repository')!) !== expectedPaths.main
      || resolve(cli.values.get('--producer-repository')!) !== expectedPaths.producer
      || resolve(cli.values.get('--output-directory')!) !== expectedPaths.prerequisites) {
      throw new Error('S3.3 prerequisite paths must be the fixed workflow-local paths');
    }
    const inventory = await fetchS33PrerequisiteArtifacts({
      token,
      mainRepositoryRoot: expectedPaths.main,
      producerRepositoryRoot: expectedPaths.producer,
      outputDirectory: expectedPaths.prerequisites,
    });
    process.stdout.write(`S3.3 prerequisites: PASS — run=${inventory.run.id}, prodArtifact=${inventory.artifacts.prodModelDiff.id}, embeddingArtifact=${inventory.artifacts.embeddingDiagnostic.id}\n`);
    return;
  }
  if (resolve(cli.values.get('--main-repository')!) !== expectedPaths.main
    || resolve(cli.values.get('--producer-repository')!) !== expectedPaths.producer
    || resolve(cli.values.get('--prerequisite-directory')!) !== expectedPaths.prerequisites
    || resolve(cli.values.get('--report-directory')!) !== expectedPaths.reports
    || resolve(cli.values.get('--output-directory')!) !== expectedPaths.output) {
    throw new Error('S3.3 Wave-1 acceptance paths must be the fixed workflow-local paths');
  }
  await authenticateS33Wave1GitHubEvidence({
    mainRepositoryRoot: cli.values.get('--main-repository')!,
    producerRepositoryRoot: cli.values.get('--producer-repository')!,
    prerequisiteDirectory: cli.values.get('--prerequisite-directory')!,
    reportDirectory: cli.values.get('--report-directory')!,
    outputDirectory: cli.values.get('--output-directory')!,
    token,
  });
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`S3.3 Wave-1 GitHub evidence: FAIL — ${message}\n`);
    process.exitCode = 1;
  });
}
