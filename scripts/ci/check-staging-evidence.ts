#!/usr/bin/env -S npx tsx
/**
 * Staging soak evidence gate (CLAUDE.md §1.11 / §1.12).
 *
 * Every prod-affecting PR declares a risk tier (T1 / T2 / T3) in its
 * body. T0 docs/tests/CI/tooling-only PRs run CI only. The tier dictates
 * required evidence fields and, for T2/T3, required soak length. CI fails
 * the PR if:
 *
 *   1. The declared tier is missing.
 *   2. The declared tier is below what the touched files require
 *      (e.g. PR touches `services/worker/src/chain/` but declares T1).
 *   3. The `## Staging Soak Evidence` section is missing required
 *      fields for the declared tier.
 *
 * The detector for tier requirements is path-based and intentionally
 * conservative — when in doubt it pushes you up a tier rather than down.
 *
 * No override label exists. The previous `staging-soak-skip` override
 * was removed on 2026-05-07. The only CI-only path is T0, computed from
 * changed files rather than labels.
 *
 * Frontend-T2 targeted evidence mode: a declared-T2 PR whose every changed file
 * is frontend/UAT/test/support-only (`isFrontendOnlyChange`) cannot produce
 * worker artifacts. With RM approval, it satisfies T2 with targeted UI evidence
 * and an async-cycle/load floor instead of worker-artifact fields. This does NOT
 * change tier classification (`requiredTierFor` is unchanged) — it only swaps
 * the accepted evidence form for that narrow case. Any worker/migration/SDK/
 * contract-touching T2 PR keeps the full worker-artifact requirements.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import {
  REPO,
  getBaseRef,
  prBody,
  changedFiles,
  resolveCommitOrFail,
} from './lib/ciContext.js';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

interface TierSpec {
  tier: Tier;
  /** Minimum soak duration in hours. */
  soakHours: number;
  /** Required evidence field labels. Match the literal string in the PR body. */
  requiredFields: string[];
}

export const TIER_SPECS: Record<Tier, TierSpec> = {
  T0: {
    tier: 'T0',
    soakHours: 0,
    requiredFields: ['Tier:'],
  },
  T1: {
    tier: 'T1',
    soakHours: 0,
    requiredFields: [
      'Tier:',
      'PR head SHA:',
      'Staging tag URL or N/A explanation:',
      'Health/smoke result:',
      'CI/E2E green:',
      'Rollback plan:',
      'Risk rationale:',
      'Human approver:',
    ],
  },
  T2: {
    tier: 'T2',
    soakHours: 12,
    requiredFields: [
      'Tier:',
      'Staging branch:',
      'Worker revision:',
      'PR head SHA:',
      'Base SHA:',
      'Staging project ref:',
      'Cloud Run service/tag URL:',
      'Image digest:',
      'Evidence scope:',
      'Preflight timestamp:',
      'Preflight result:',
      'Soak start:',
      'Soak end:',
      'E2E result:',
      'Migration applied:',
      'Rollback rehearsed:',
      // SCRUM-1803: every T2/T3 deploy MUST go through scripts/staging/deploy.sh,
      // which writes to public.staging_deploy_log. The PR body cites the row id.
      'Staging deploy log id:',
    ],
  },
  T3: {
    tier: 'T3',
    soakHours: 48,
    requiredFields: [
      'Tier:',
      'Staging branch:',
      'Worker revision:',
      'PR head SHA:',
      'Base SHA:',
      'Staging project ref:',
      'Cloud Run service/tag URL:',
      'Image digest:',
      'Evidence scope:',
      'Preflight timestamp:',
      'Preflight result:',
      'Soak start:',
      'Soak end:',
      'E2E result:',
      'Migration applied:',
      'Rollback rehearsed:',
      'Staging deploy log id:',
      'Trigger A fires:',
      'Trigger B fires:',
      'Daily flush observation:',
      'Per-org isolation check:',
    ],
  },
};

interface PathRule {
  /** Regex matched against POSIX-style relative paths. */
  pattern: RegExp;
  /** Minimum tier required when any matched file is touched. */
  minTier: Tier;
  /** Human-readable reason printed on failure. */
  reason: string;
}

/**
 * Path → minimum tier. Order matters only for failure messages — the
 * highest tier across all matching rules wins.
 *
 * Add a rule when you discover a new prod-affecting surface that
 * shouldn't be merged without staging soak.
 */
export const PATH_RULES: PathRule[] = [
  {
    pattern: /^supabase\/migrations\//,
    minTier: 'T3',
    reason: 'migration touches schema/data integrity',
  },
  {
    pattern: /^services\/worker\/src\/security\//,
    minTier: 'T3',
    reason: 'security-sensitive worker logic',
  },
  {
    pattern: /^services\/worker\/src\/chain\//,
    minTier: 'T3',
    reason: 'chain/treasury hot path',
  },
  {
    pattern: /^services\/worker\/src\/jobs\/(anchor|anchorExpirySweep|batch-anchor|check-confirmations|broadcast-recovery|chain-maintenance|attestationAnchor|grace-expiry-sweep|revocation)\.ts$/,
    minTier: 'T3',
    reason: 'anchor lifecycle / batch processor',
  },
  {
    pattern: /^services\/worker\/src\/routes\/scheduled\.ts$/,
    minTier: 'T3',
    reason: 'cron schedule',
  },
  {
    pattern: /^services\/worker\/src\/billing\//,
    minTier: 'T3',
    reason: 'entitlement / billing logic',
  },
  {
    pattern: /^src\/components\/admin\/treasury\//,
    minTier: 'T3',
    reason: 'treasury administration surface',
  },
  {
    pattern: /^services\/worker\/src\/stripe\//,
    minTier: 'T2',
    reason: 'Stripe handler',
  },
  {
    pattern: /^services\/worker\/src\/api\//,
    minTier: 'T2',
    reason: 'public API surface',
  },
  {
    pattern: /^services\/worker\/src\/webhooks\//,
    minTier: 'T2',
    reason: 'webhook delivery',
  },
  {
    pattern: /^services\/edge\/src\//,
    minTier: 'T2',
    reason: 'edge worker',
  },
  {
    pattern: /^\.github\/workflows\/deploy-worker\.yml$/,
    minTier: 'T2',
    reason: 'worker deploy config (prod runtime: min-instances, env, secrets, image)',
  },
  {
    pattern: /^services\/worker\/cloudbuild\.yaml$/,
    minTier: 'T2',
    reason: 'worker image build config',
  },
  {
    pattern: /^services\/worker\/src\/auth\//,
    minTier: 'T2',
    reason: 'auth-sensitive worker logic',
  },
  {
    pattern: /^(?:scripts\/ci\/s33-wave1-github-evidence\.(?:ts|mjs)|\.github\/s33-wave1-acceptance-authorities\.json)$/,
    minTier: 'T2',
    reason: 'S3.3 acceptance companion reachable from production runtime',
  },
  {
    pattern: /^services\/worker\/src\/(?:ai|agents|nessie|llm|model)\//,
    minTier: 'T2',
    reason: 'AI behavior',
  },
  {
    pattern: /^services\/worker\/src\/(?:jobs|queues?|concurrency)\//,
    minTier: 'T2',
    reason: 'worker queue/concurrency behavior',
  },
  {
    pattern: /^services\/worker\/src\//,
    minTier: 'T2',
    reason: 'worker behavior',
  },
  {
    pattern: /^(?:docs\/api\/|docs\/guides\/API_GUIDE\.md|sdks\/|packages\/(?:arkova-py|embed|mcp-server|typescript|langchain))/,
    minTier: 'T2',
    reason: 'public API contract / SDK surface',
  },
  {
    pattern: /^src\/components\/(?:anchor|api|auth|billing|public|verification|verify)\//,
    minTier: 'T2',
    reason: 'sensitive user-facing contract surface',
  },
  {
    pattern: /^src\/(components|pages|hooks|lib)\//,
    minTier: 'T1',
    reason: 'frontend code',
  },
];

const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };

/**
 * The SHARED PROD-RUNTIME surface: the subset of {@link PATH_RULES} at tier T2 or
 * higher. These are the files whose semantics a completed soak implicitly depends
 * on because they are the same deployed artifact / DB / queue substrate the soak
 * ran against — migrations (T3), chain/treasury (T3), security (T3), anchor
 * lifecycle + cron (T3), billing (T3), queue/concurrency (T2), public API (T2),
 * stripe/webhooks/auth/ai (T2), edge (T2), and the catch-all worker-behavior
 * rule (T2). Derived from the single source of truth ({@link PATH_RULES}) so the
 * shared surface can NEVER drift from the tier detector: adding a T2+ path rule
 * automatically widens the surface whose intervening main-drift invalidates a
 * completed soak, and lowering a rule below T2 automatically drops it.
 *
 * The <T2 rules (frontend `src/…` at T1) are intentionally excluded: a
 * frontend-only PR is classified T1 and never reaches the T2/T3
 * {@link stagingIntegrityErrors} base-drift path, so folding the T1 frontend
 * surface in here would only gate PRs that can't reach the check anyway.
 */
export const SHARED_PROD_RUNTIME_RULES: PathRule[] = PATH_RULES.filter(
  (rule) => TIER_RANK[rule.minTier] >= TIER_RANK.T2,
);

const SHA_RE = /\b[0-9a-f]{40}\b/i;
const DECLARED_TIER_VALUES = new Set<Tier>(['T0', 'T1', 'T2', 'T3']);
const ALLOWED_EVIDENCE_SCOPES = new Set([
  'merge-grade shared staging',
  'merge-grade isolated staging',
]);

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const PUBLIC_CONTRACT_DOC_RE = /^docs\/(?:api\/|guides\/API_GUIDE\.md)/;
const DOCS_ONLY_RE = /^(?:docs\/|README\.md|ARKOVA_WORKSPACE_README\.md|WORKSPACE_STATUS\.md|memory\/.*\.md$)/;

/**
 * Supplies the unified diff body (the lines after each `@@` hunk header, i.e.
 * context + `+`/`-` lines) for a single changed file, or `null` when it cannot
 * be obtained (no git history, deleted file, binary, error). Threaded through
 * {@link isT0OnlyFile} / {@link requiredTierFor} so the classifier can, for the
 * narrow {@link DEPLOY_WORKER_WORKFLOW} carve-out, look at WHAT changed in the
 * file rather than only its name. Everything else stays name-only. A `null`
 * return always fails closed (keeps the path-rule tier).
 */
export type DiffProvider = (file: string) => string | null;

/**
 * Answers "is `ancestorSha` an ancestor of `descendantSha`?".
 * `true` / `false` are definitive; `null` means the question could not be
 * answered (missing object, shallow clone, git unavailable) and every caller
 * must treat it as "not covered" — never as an implicit yes.
 */
export type AncestryProvider = (ancestorSha: string, descendantSha: string) => boolean | null;

export interface TierClassifyOpts {
  diffProvider?: DiffProvider;
  s33RuntimeImporterProvider?: () => readonly string[];
  s33Lane1ImportScan?: S33Lane1ImportScan;
}

const DEPLOY_WORKER_WORKFLOW = '.github/workflows/deploy-worker.yml';
const ROOT_PACKAGE_MANIFEST = 'package.json';

export interface S33Lane1ImportScan {
  complete: boolean;
  importers: string[];
}

interface SourceFileText {
  path: string;
  content: string;
}

/**
 * CTO ruling 102498305: these are the complete non-test Lane-1 evidence
 * verifier modules eligible for the S3.3 offline-T0 decision. Keep this list
 * exact. A new sibling file does not inherit the carve-out.
 */
export const S33_LANE1_OFFLINE_EVIDENCE_FILES = new Set([
  'scripts/staging/batch-drain-admission-adapter.ts',
  'scripts/staging/batch-drain-crash-adapter.ts',
  'scripts/staging/batch-drain-crash-control.ts',
  'scripts/staging/batch-drain-harness-lib.ts',
  'scripts/staging/batch-drain-live-evidence.ts',
  'scripts/staging/batch-drain-observation.ts',
  'scripts/staging/batch-drain-strict-json.ts',
  'scripts/staging/batch-drain-time.ts',
]);

const S33_LANE1_LINT_SCRIPT_LINE = '"lint:batch-drain-evidence": "eslint --no-ignore scripts/staging/batch-drain-harness-lib.ts scripts/staging/batch-drain-harness-lib.test.ts scripts/staging/batch-drain-observation.ts scripts/staging/batch-drain-observation.test.ts scripts/staging/batch-drain-crash-control.ts scripts/staging/batch-drain-crash-control.test.ts scripts/staging/batch-drain-crash-adapter.ts scripts/staging/batch-drain-crash-adapter.test.ts scripts/staging/batch-drain-strict-json.ts scripts/staging/batch-drain-strict-json.test.ts scripts/staging/batch-drain-time.ts scripts/staging/batch-drain-time.test.ts scripts/staging/batch-drain-live-evidence.ts scripts/staging/batch-drain-live-evidence.test.ts scripts/staging/batch-drain-evidence-sources.test.ts scripts/staging/batch-drain-admission-adapter.ts scripts/staging/batch-drain-admission-adapter.test.ts",';

const RUNTIME_SOURCE_PATH_RE = /^(?:src\/|services\/[^/]+\/src\/|packages\/[^/]+\/src\/|integrations\/[^/]+\/src\/|sdks\/)/;
const RUNTIME_SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;
const NON_RUNTIME_DIRECTORY_RE = /(?:^|\/)(?:__tests__|test|tests|test-utils|fixtures)(?:\/|$)/;
const TEST_SOURCE_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const AGENTS_DOC_RE = /(?:^|\/)agents\.md$/;
const IMPORT_SPECIFIER_RE = /\b(?:from|import|require)\s*(?:\(\s*)?['"]([^'"\r\n]+)['"]\s*\)?/g;

const S33_OFFLINE_ACCEPTANCE_FILES = new Set([
  '.github/s33-wave1-acceptance-authorities.json',
  'scripts/ci/s33-wave1-github-evidence.ts',
  'scripts/ci/s33-wave2-batch-acceptance.ts',
  'scripts/ci/s33-wave2-github-transport.ts',
  'scripts/ci/s33-wave3-detached-signing-v2.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-types.ts',
  'services/worker/src/ai/eval/heldout-leakage.ts',
  'services/worker/src/ai/eval/s33-acceptance-ledger.ts',
  'services/worker/src/ai/eval/s33-batch-acceptance.ts',
  'services/worker/src/ai/eval/s33-wave1-dual-dag.ts',
  'services/worker/src/ai/eval/s33-wave1-github-evidence.ts',
  'services/worker/src/ai/eval/s33-wave1-prerequisite-runner.ts',
  'services/worker/src/ai/eval/s33-wave1-producer-verifier.ts',
  'services/worker/src/ai/eval/s33-wave1-producer-parser.ts',
  'services/worker/src/ai/eval/s33-wave1-workflow-reports.ts',
  'services/worker/src/ai/eval/s33-wave2-batch-acceptance.ts',
  'services/worker/src/ai/eval/s33-wave2-acceptance-envelope.ts',
  'services/worker/src/ai/eval/s33-wave2-corpus-registry.ts',
  'services/worker/src/ai/eval/s33-wave3-deterministic-eval-gates.ts',
  'services/worker/src/ai/eval/s33-wave3-detached-signing-v2.ts',
]);
const S33_WAVE2_OFFLINE_CORPUS_RE = /^services\/worker\/src\/ai\/eval\/golden-dataset-s33-wave2-[a-z0-9]+(?:-[a-z0-9]+)*-heldout\.ts$/u;

function isS33OfflineAcceptancePath(file: string): boolean {
  return S33_OFFLINE_ACCEPTANCE_FILES.has(file) || S33_WAVE2_OFFLINE_CORPUS_RE.test(file);
}
const S33_RUNTIME_ENTRYPOINTS = ['services/worker/src/index.ts'] as const;
const MODULE_CANDIDATE_SUFFIXES = [
  '', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.mts', '/index.cts',
] as const;

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stringSpecifier(expression: ts.Expression): string | null {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : null;
}

function repositoryPath(repositoryRoot: string, absolutePath: string): string {
  return relative(resolve(repositoryRoot), absolutePath).split(sep).join('/');
}

function resolveRuntimeModule(
  repositoryRoot: string,
  importerPath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const absoluteSpecifier = resolve(repositoryRoot, dirname(importerPath), specifier);
  const stems = [absoluteSpecifier];
  if (/\.(?:mjs|cjs|jsx|js)$/u.test(absoluteSpecifier)) {
    stems.push(absoluteSpecifier.replace(/\.(?:mjs|cjs|jsx|js)$/u, ''));
  }
  for (const stem of stems) {
    for (const suffix of MODULE_CANDIDATE_SUFFIXES) {
      const candidate = `${stem}${suffix}`;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return repositoryPath(repositoryRoot, candidate);
      }
    }
  }
  throw new Error(`${importerPath} has an unresolved local runtime module ${specifier}`);
}

interface RuntimeModuleParse {
  localSpecifiers: string[];
  unsafeConstructedLoads: string[];
}

interface RuntimeRequireNames {
  createRequireImports: Set<string>;
  moduleNamespaceImports: Set<string>;
  requireCallers: Set<string>;
}

interface RuntimeLoad {
  expression: ts.Expression | undefined;
  kind: string;
}

function runtimeSourceFile(sourceText: string, importerPath: string): ts.SourceFile {
  const source = ts.createSourceFile(
    importerPath,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    importerPath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const diagnostics = (source as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics;
  if (!Array.isArray(diagnostics)) {
    throw new TypeError(`${importerPath} TypeScript parser did not expose parse diagnostics`);
  }
  if (diagnostics.length > 0) throw new Error(`${importerPath} has TypeScript parse diagnostics`);
  return source;
}

function runtimeRequireNames(): RuntimeRequireNames {
  return {
    createRequireImports: new Set<string>(),
    moduleNamespaceImports: new Set<string>(),
    requireCallers: new Set<string>(['require']),
  };
}

function isNodeModuleRequire(expression: ts.Expression | undefined): boolean {
  if (!expression || !ts.isCallExpression(expression)) return false;
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'require') {
    return false;
  }
  return expression.arguments.length === 1
    && stringSpecifier(expression.arguments[0]) === 'node:module';
}

function addNodeModuleImportAliases(
  statement: ts.Statement,
  names: RuntimeRequireNames,
): void {
  if (!ts.isImportDeclaration(statement)) return;
  if (stringSpecifier(statement.moduleSpecifier) !== 'node:module') return;
  const bindings = statement.importClause?.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings)) {
    names.moduleNamespaceImports.add(bindings.name.text);
    return;
  }
  for (const element of bindings.elements) {
    if ((element.propertyName?.text ?? element.name.text) === 'createRequire') {
      names.createRequireImports.add(element.name.text);
    }
  }
}

function addNodeModuleRequireDeclaration(
  declaration: ts.VariableDeclaration,
  names: RuntimeRequireNames,
): void {
  if (!isNodeModuleRequire(declaration.initializer)) return;
  if (ts.isIdentifier(declaration.name)) {
    names.moduleNamespaceImports.add(declaration.name.text);
    return;
  }
  if (!ts.isObjectBindingPattern(declaration.name)) return;
  for (const element of declaration.name.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
    const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.name.text;
    if (importedName === 'createRequire') {
      names.createRequireImports.add(element.name.text);
    }
  }
}

function collectNodeModuleAliases(source: ts.SourceFile, names: RuntimeRequireNames): void {
  for (const statement of source.statements) {
    addNodeModuleImportAliases(statement, names);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addNodeModuleRequireDeclaration(declaration, names);
      }
    }
  }
}

function isCreateRequireCall(expression: ts.Expression, names: RuntimeRequireNames): boolean {
  if (!ts.isCallExpression(expression)) return false;
  if (ts.isIdentifier(expression.expression)) {
    return names.createRequireImports.has(expression.expression.text);
  }
  if (!ts.isPropertyAccessExpression(expression.expression)) return false;
  return expression.expression.name.text === 'createRequire'
    && ts.isIdentifier(expression.expression.expression)
    && names.moduleNamespaceImports.has(expression.expression.expression.text);
}

function collectRequireCallers(source: ts.SourceFile, names: RuntimeRequireNames): void {
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && isCreateRequireCall(node.initializer, names)) {
      names.requireCallers.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function callRuntimeLoad(node: ts.CallExpression, names: RuntimeRequireNames): RuntimeLoad | null {
  const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const requireLike = ts.isIdentifier(node.expression)
    && names.requireCallers.has(node.expression.text);
  if (!dynamicImport && !requireLike) return null;
  return {
    expression: node.arguments.length === 1 ? node.arguments[0] : undefined,
    kind: dynamicImport ? 'dynamic import' : 'require/createRequire',
  };
}

function runtimeLoad(node: ts.Node, names: RuntimeRequireNames): RuntimeLoad | null {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return { expression: node.moduleSpecifier, kind: 'static import/export' };
  }
  if (ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && node.moduleReference.expression) {
    return { expression: node.moduleReference.expression, kind: 'import-equals' };
  }
  return ts.isCallExpression(node) ? callRuntimeLoad(node, names) : null;
}

function recordRuntimeLoad(
  load: RuntimeLoad,
  importerPath: string,
  parsed: RuntimeModuleParse,
): void {
  const specifier = load.expression ? stringSpecifier(load.expression) : null;
  if (specifier === null) {
    parsed.unsafeConstructedLoads.push(`${importerPath}: ${load.kind}`);
  } else if (specifier.startsWith('.')) {
    parsed.localSpecifiers.push(specifier);
  }
}

/** Parse runtime module edges; no source module is executed. */
function parseRuntimeModule(sourceText: string, importerPath: string): RuntimeModuleParse {
  const source = runtimeSourceFile(sourceText, importerPath);
  const names = runtimeRequireNames();
  collectNodeModuleAliases(source, names);
  collectRequireCallers(source, names);
  const parsed: RuntimeModuleParse = { localSpecifiers: [], unsafeConstructedLoads: [] };
  const inspect = (node: ts.Node): void => {
    const load = runtimeLoad(node, names);
    if (load) recordRuntimeLoad(load, importerPath, parsed);
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  const { localSpecifiers, unsafeConstructedLoads } = parsed;
  return { localSpecifiers, unsafeConstructedLoads };
}

function scanRuntimeModule(
  repositoryRoot: string,
  importerPath: string,
  importers: Set<string>,
  queued: string[],
): void {
  const absolutePath = resolve(repositoryRoot, importerPath);
  if (!existsSync(absolutePath)) throw new Error(`missing runtime entry/module ${importerPath}`);
  const parsed = parseRuntimeModule(readFileSync(absolutePath, 'utf8'), importerPath);
  for (const unsafe of parsed.unsafeConstructedLoads) importers.add(`<unsafe ${unsafe}>`);
  for (const specifier of parsed.localSpecifiers) {
    const importedPath = resolveRuntimeModule(repositoryRoot, importerPath, specifier);
    if (importedPath === null) continue;
    if (isS33OfflineAcceptancePath(importedPath)) importers.add(importerPath);
    else if (!TEST_FILE_RE.test(importedPath)) queued.push(importedPath);
  }
}

/**
 * Return production-source importers of the CTO-ratified offline S3.3 files.
 * Any unreadable tree is represented as a synthetic importer so callers fail
 * closed instead of silently granting the T0 carve-out.
 */
export function findS33RuntimeImporters(repositoryRoot = REPO): string[] {
  const importers = new Set<string>();
  const queued: string[] = [...S33_RUNTIME_ENTRYPOINTS];
  const visited = new Set<string>();
  try {
    while (queued.length > 0) {
      const importerPath = queued.shift()!;
      if (visited.has(importerPath)) continue;
      visited.add(importerPath);
      scanRuntimeModule(repositoryRoot, importerPath, importers, queued);
    }
    return [...importers].sort(compareUtf16CodeUnits);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown import-graph failure';
    return [`<unreadable services/worker runtime module graph: ${reason}>`];
  }
}

function isS33OfflineAcceptanceFile(file: string, opts?: TierClassifyOpts): boolean {
  if (!isS33OfflineAcceptancePath(file)) return false;
  try {
    const importers = opts?.s33RuntimeImporterProvider?.() ?? findS33RuntimeImporters();
    return importers.length === 0;
  } catch {
    return false;
  }
}

// A changed line in deploy-worker.yml that is "harmless" for prod runtime: a
// GitHub-Actions `uses:` pin (the Dependabot bump target), an additive
// `fetch-depth: 0` checkout hardening, a YAML comment, or a blank line.
// Anything else (env, secrets, min/max-instances, image, region, service
// account, --set-env-vars, scaling, …) is a real runtime change.
// Note the optional dash + its trailing whitespace are grouped together rather
// than written as two adjacent `[^\S\r\n]*` runs — the adjacent form lets the
// engine split a whitespace span ambiguously (super-linear backtracking Sonar
// flags). Behaviour is identical: optional indent, optional `- ` list marker,
// then `uses:`.
const deployWorkerUsesLineRe = /^[^\S\r\n]*(?:-[^\S\r\n]*)?uses:[^\S\r\n]*\S/;
const deployWorkerCheckoutUsesLineRe = /^[^\S\r\n]*-[^\S\r\n]*uses:[^\S\r\n]*actions\/checkout@\S/;
const deployWorkerFullHistoryLineRe = /^[^\S\r\n]*fetch-depth:[^\S\r\n]*0[^\S\r\n]*(?:#.*)?$/;
const deployWorkerIsolatedCredentialsLineRe = /^[^\S\r\n]*persist-credentials:[^\S\r\n]*false[^\S\r\n]*(?:#.*)?$/;
const yamlStepStartRe = /^[^\S\r\n]*-[^\S\r\n]*[A-Za-z][\w-]*:/;
const yamlWithLineRe = /^[^\S\r\n]*with:[^\S\r\n]*(?:#.*)?$/;
const yamlCommentOrBlankRe = /^[^\S\r\n]*(?:#.*)?$/;

type DeployWorkerChange = 'ignored' | 'eligible' | 'invalid';

function diffContent(rawLine: string): string {
  return /^[ +-]/u.test(rawLine) ? rawLine.slice(1) : rawLine;
}

function checkoutStepContext(content: string, current: boolean): boolean {
  return yamlStepStartRe.test(content)
    ? deployWorkerCheckoutUsesLineRe.test(content)
    : current;
}

function deployWorkerChange(
  rawLine: string,
  content: string,
  inCheckoutStep: boolean,
): DeployWorkerChange {
  if (yamlCommentOrBlankRe.test(content)) return 'ignored';
  if (deployWorkerUsesLineRe.test(content)) return 'eligible';
  if (!rawLine.startsWith('+') || !inCheckoutStep) return 'invalid';
  if (deployWorkerFullHistoryLineRe.test(content)
    || deployWorkerIsolatedCredentialsLineRe.test(content)) return 'eligible';
  // `with:` is structural YAML required when checkout had no existing input
  // map. It is permitted only there and does not make a diff eligible itself.
  return yamlWithLineRe.test(content) ? 'ignored' : 'invalid';
}

/**
 * True iff a unified diff for {@link DEPLOY_WORKER_WORKFLOW} changes ONLY
 * `uses:` action-version/SHA lines, or additively configures checkout with
 * `fetch-depth: 0` (plus YAML comments / blank lines). These are CI mechanics,
 * so they are exempt from the T2 deploy-runtime rule without weakening the gate
 * for real runtime-config edits.
 *
 * Fail-closed: returns false for an empty/`null` diff, and for any diff that
 * contains at least one added/removed line outside that narrow set. Removing
 * full-history checkout or changing it to a shallow depth is never exempt. A
 * diff with no added/removed lines at all is also false.
 */
export function isDeployWorkerUsesOnlyBump(diff: string | null | undefined): boolean {
  if (!diff || diff.trim().length === 0) return false;

  let inCheckoutStep = false;
  let sawEligibleChange = false;
  for (const rawLine of diff.split(/\r?\n/)) {
    // Unified-diff file headers are not content lines.
    if (rawLine.startsWith('+++') || rawLine.startsWith('---')) {
      continue;
    }
    if (rawLine.startsWith('@@')) {
      inCheckoutStep = false;
      continue;
    }

    const isChangedLine = rawLine.startsWith('+') || rawLine.startsWith('-');
    const content = diffContent(rawLine);
    inCheckoutStep = checkoutStepContext(content, inCheckoutStep);
    if (!isChangedLine) continue;
    const change = deployWorkerChange(rawLine, content, inCheckoutStep);
    if (change === 'invalid') return false;
    if (change === 'eligible') sawEligibleChange = true;
  }
  return sawEligibleChange;
}

/**
 * Root package.json normally stays above T0 because it governs the app/runtime
 * dependency tree. The sole S3.3 exception is the exact one-line lint command
 * that gives CI coverage to the file-scoped offline verifier modules above.
 * Any second changed line, command drift, deletion, or unavailable diff keeps
 * the manifest at its normal tier.
 */
export function isS33Lane1RootLintScriptOnly(diff: string | null | undefined): boolean {
  if (!diff || diff.trim().length === 0) return false;

  const changedLines = diff.split(/\r?\n/).filter((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return false;
    return line.startsWith('+') || line.startsWith('-');
  });

  return changedLines.length === 1
    && changedLines[0]?.startsWith('+') === true
    && changedLines[0]?.slice(1).trim() === S33_LANE1_LINT_SCRIPT_LINE;
}

function isNonRuntimeSourcePath(file: string): boolean {
  return NON_RUNTIME_DIRECTORY_RE.test(file)
    || TEST_SOURCE_FILE_RE.test(file)
    || AGENTS_DOC_RE.test(file);
}

function isRuntimeSourcePath(file: string): boolean {
  return RUNTIME_SOURCE_PATH_RE.test(file)
    && RUNTIME_SOURCE_EXT_RE.test(file)
    && !isNonRuntimeSourcePath(file);
}

function isScriptsStagingTarget(path: string): boolean {
  return /(?:^|\/)scripts\/staging(?:\/|$)/.test(path);
}

function specifierTargetsStagingTooling(importer: string, specifier: string): boolean {
  const normalizedSpecifier = specifier.replaceAll('\\', '/');
  if (isScriptsStagingTarget(normalizedSpecifier)) return true;
  if (!normalizedSpecifier.startsWith('.')) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(importer), normalizedSpecifier));
  return isScriptsStagingTarget(resolved);
}

/**
 * Returns production-runtime files that statically import staging tooling.
 * Test/spec/fixture sources are excluded because the CTO ruling permits offline
 * tests; frontend, worker, service, package, integration, and SDK source roots
 * are all scanned. The matcher intentionally treats any runtime import from
 * scripts/staging as a blocker: a staging barrel could otherwise hide a
 * transitive import of one of the exact verifier files.
 */
export function findS33Lane1RuntimeImporters(files: SourceFileText[]): string[] {
  const importers = new Set<string>();
  for (const file of files) {
    if (!isRuntimeSourcePath(file.path)) continue;
    IMPORT_SPECIFIER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPECIFIER_RE.exec(file.content)) !== null) {
      const specifier = match[1];
      if (specifier && specifierTargetsStagingTooling(file.path, specifier)) {
        importers.add(file.path);
        break;
      }
    }
  }
  return [...importers].sort(compareUtf16CodeUnits);
}

function gitS33Lane1ImportScan(): S33Lane1ImportScan {
  try {
    const tracked = execFileSync(
      GIT_BIN,
      ['ls-files', '--', 'src', 'services', 'packages', 'integrations', 'sdks'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).split('\n').map((line) => line.trim()).filter(Boolean);
    const sourceFiles = tracked.filter(isRuntimeSourcePath).map((path) => ({
      path,
      content: readFileSync(resolve(REPO, path), 'utf8'),
    }));
    return { complete: true, importers: findS33Lane1RuntimeImporters(sourceFiles) };
  } catch {
    return { complete: false, importers: [] };
  }
}

function hasCleanS33Lane1ImportScan(opts?: TierClassifyOpts): boolean {
  return opts?.s33Lane1ImportScan?.complete === true
    && opts.s33Lane1ImportScan.importers.length === 0;
}

/**
 * deploy-worker.yml is normally a T2 prod-runtime surface. The narrow
 * exemptions are a Dependabot GitHub-Actions `uses:`-version bump and an
 * additive full-history checkout fix (verified against the file's diff via
 * {@link isDeployWorkerUsesOnlyBump}); neither changes prod runtime config, so
 * each is treated as CI-tooling (T0). The staging gate injects its provider;
 * other live GitHub Actions consumers reuse the resolved CI base automatically
 * so merge-authority and staging cannot disagree. Tests and non-Actions callers
 * stay pure/fail-closed unless they inject a provider. Any unavailable diff
 * keeps the file T2.
 *
 * Possible future carve-out (NOT implemented — a separate policy call for the
 * operator): a `@types/*`-only manifest/lockfile bump. Deliberately left out.
 */
function isDeployWorkerUsesOnlyExempt(file: string, opts?: TierClassifyOpts): boolean {
  if (file !== DEPLOY_WORKER_WORKFLOW) return false;
  let provider = opts?.diffProvider;
  if (!provider && process.env.GITHUB_ACTIONS === 'true' && process.env.VITEST !== 'true') {
    const baseRef = getBaseRef({ required: false });
    if (baseRef) provider = gitFileDiffProvider(baseRef);
  }
  if (!provider) return false;
  return isDeployWorkerUsesOnlyBump(provider(file));
}

function isT0OnlyFile(file: string, opts?: TierClassifyOpts): boolean {
  if (PUBLIC_CONTRACT_DOC_RE.test(file)) return false;
  // `agents-changelog.md` rides the same early return as `agents.md`: cf3917ad2
  // ("split changelog sediment out of four guide files", 2026-08-01) moved the
  // dated narrative into sibling changelog files without extending this
  // carve-out, which silently made every one of them a soak-tier file — e.g.
  // `services/worker/agents-changelog.md` matches the `services/worker/`
  // PATH_RULE and would demand T3 evidence for a pure doc edit. The check must
  // stay HERE, above the PATH_RULES short-circuit, for that reason; the
  // STAGING_TOOLING_ALLOW list below is reached too late for worker paths.
  if (
    TEST_FILE_RE.test(file)
    || file.endsWith('agents.md')
    || file.endsWith('agents-changelog.md')
  ) return true;
  // Binding CTO ruling 102498305: these exact non-test modules are T0 only
  // while a complete production-source scan proves no runtime imports anything
  // from scripts/staging. Missing scan data or any importer voids the carve-out.
  if (S33_LANE1_OFFLINE_EVIDENCE_FILES.has(file)) {
    return hasCleanS33Lane1ImportScan(opts);
  }
  // The root manifest exception is equally narrow: exact lint-script line only,
  // and only while the same runtime-import proof is clean.
  if (file === ROOT_PACKAGE_MANIFEST) {
    return hasCleanS33Lane1ImportScan(opts)
      && isS33Lane1RootLintScriptOnly(opts?.diffProvider?.(file));
  }
  // Dependency bumps that don't touch a core runtime surface are T0:
  //   - ANY package-lock.json (root / packages/* / services/* / integrations/*) —
  //     a lockfile is a deterministic re-resolution of the manifest, not a source
  //     change; it carries no behavior a soak could exercise on its own.
  //   - package.json MANIFESTS only for peripheral, non-core workspaces
  //     (packages/* libraries + integrations/* connectors). These are SDK/embed/
  //     integration surfaces, not the deployed Cloud Run worker or app root.
  // Deliberately NOT exempt: root `package.json` and `services/*/package.json`
  // manifests — those govern the prod worker / app runtime dependency tree, so a
  // manifest bump there must still earn a tier (the lockfile counterparts stay T0).
  if (/^(?:package-lock\.json|(?:packages|services|integrations)\/[^/]+\/package-lock\.json|(?:packages|integrations)\/[^/]+\/package\.json)$/.test(file)) return true;
  // deploy-worker.yml is a T2 PATH_RULE, but a Dependabot `uses:`-only action
  // bump touches no prod runtime config — exempt it to CI-tooling (T0) when the
  // diff confirms it. Checked BEFORE the PATH_RULES.some() T2 short-circuit.
  if (isDeployWorkerUsesOnlyExempt(file, opts)) return true;
  // Sprint 3.3 Wave-1 acceptance/data is an exact, CTO-ratified offline T0
  // surface. The carve-out disappears immediately if any production source
  // imports one of these files; sibling eval/runtime files stay T2.
  if (isS33OfflineAcceptanceFile(file, opts)) return true;
  // PROOF-08 (SCRUM-2341): the proof test-fixtures subtree lives under
  // services/worker/src/, which matches the T2 `services/worker/src/` PATH_RULE.
  // Its loader (index.ts) + JSON are imported ONLY by test suites (verified no
  // non-test importer), so there is no prod-runtime path. Exempt it to T0 BEFORE
  // the PATH_RULES.some() short-circuit — same shape as the deploy-worker carve-out
  // above (a T0 allowlist entry that has to win over a matching PATH_RULE).
  if (file.startsWith('services/worker/src/proof/fixtures/')) return true;
  if (PATH_RULES.some((rule) => rule.pattern.test(file))) return false;
  return STAGING_TOOLING_ALLOW.some((re) => re.test(file))
    || DOCS_ONLY_RE.test(file)
    || /^\.github\/(?:workflows\/|ISSUE_TEMPLATE\/|pull_request_template\.md|CONTRIBUTING\.md|dependabot\.yml)/.test(file);
}

export function requiredTierFor(
  files: string[],
  opts?: TierClassifyOpts,
): { tier: Tier; reason: string } {
  if (files.length === 0) return { tier: 'T0', reason: 'no changed files' };
  let cachedRuntimeImporters: readonly string[] | undefined;
  const classifyOpts = opts?.s33RuntimeImporterProvider
    ? opts
    : {
        ...opts,
        s33RuntimeImporterProvider: (): readonly string[] => {
          cachedRuntimeImporters ??= findS33RuntimeImporters();
          return cachedRuntimeImporters;
        },
      };
  if (files.every((f) => isT0OnlyFile(f, classifyOpts))) {
    return { tier: 'T0', reason: 'docs/tests/CI/tooling-only' };
  }

  const touchesS33Lane1OfflineEvidence = files.some((file) => (
    S33_LANE1_OFFLINE_EVIDENCE_FILES.has(file)
  ));
  const s33Lane1CarveoutFailed = touchesS33Lane1OfflineEvidence
    && !hasCleanS33Lane1ImportScan(opts);
  let best: Tier = s33Lane1CarveoutFailed ? 'T2' : 'T1';
  let reason = s33Lane1CarveoutFailed
    ? 'S3.3 Lane 1 offline verifier import scan missing/incomplete or runtime importer detected'
    : 'default frontend / additive change';
  for (const f of files) {
    if (isT0OnlyFile(f, classifyOpts)) continue;
    for (const rule of PATH_RULES) {
      if (rule.pattern.test(f) && TIER_RANK[rule.minTier] > TIER_RANK[best]) {
        best = rule.minTier;
        reason = `${f} — ${rule.reason}`;
      }
    }
  }
  return { tier: best, reason };
}

/**
 * Patterns for any non-frontend, prod-runtime (or CI) surface. A change that
 * touches ANY of these can produce real worker/migration/SDK/contract artifacts
 * (or is CI config/script, which is not a frontend asset), so it must NOT be
 * eligible for the frontend-targeted T2 evidence path — it keeps the full worker-artifact
 * (standard) evidence requirements. This list is intentionally a denylist (not
 * just "outside src/|public/|e2e/") so the guard fails closed: a future file
 * that lands under one of the allowed prefixes but matches a server/SDK/contract
 * pattern would still be pushed onto the standard evidence path.
 */
const NON_FRONTEND_SURFACE_RE: RegExp[] = [
  /^services\//,
  /^supabase\/(?:migrations|functions)\//,
  /^packages\//,
  /^sdks\//,
  /^docs\/api\//,
  /^docs\/guides\/API_GUIDE\.md$/,
  /^\.github\/workflows\//,
  // CI scripts are not a frontend asset — a `scripts/` change (e.g. this gate,
  // or the CSP-deps guard) keeps the standard worker-evidence path even when it
  // rides alongside a src/ change.
  /^scripts\//,
];

/** Prefixes/patterns a frontend feature can legitimately ship without producing
 * any deploying worker/migration/SDK artifact:
 *   - `src/` / `public/`  the React/TS app source + static/vendor assets,
 *   - `e2e/` / `tests/e2e` Playwright/UAT specs for the changed view,
 *   - frontend UAT/reference docs and test/support helpers that accompany the
 *     UI proof.
 * None of these are built into the Cloud Run worker image or applied to the DB,
 * so a PR confined to them (modulo the NON_FRONTEND_SURFACE_RE denylist) cannot
 * produce worker artifacts and is eligible for frontend-targeted T2 evidence. */
const FRONTEND_ONLY_PATH_RE: RegExp[] = [
  /^src\//,
  /^public\//,
  /^e2e\//,
  /^tests\/(?:e2e|frontend|ui|uat|support)\//,
  /^test\/(?:e2e|frontend|ui|uat|support)\//,
  /^docs\/(?:uat|reference|staging|bugs|qa|screenshots|frontend|ui)\//,
];

const FRONTEND_NER_RUNTIME_SIGNAL_RE: RegExp[] = [
  /^src\/lib\/nerPiiDetector(?:\.test)?\.ts$/,
  /^public\/vendor\/transformers\.(?:bundle|web)\.min\.js$/,
  /^scripts\/vendor-ner-runtime(?:\.test)?\.ts$/,
  /^scripts\/ner-runtime\.lock\.json$/,
];

const FRONTEND_NER_RUNTIME_SUPPORT_RE: RegExp[] = [
  /^\.gitignore$/,
  /^package\.json$/,
  /^docs\/reference\/WEBEXT01_FIX_RESULTS\.md$/,
  /^docs\/reference\/webext01-fix-evidence\//,
  /^scripts\/agents\.md$/,
  /^scripts\/ci\/agents\.md$/,
  /^scripts\/ci\/check-csp-runtime-deps(?:\.test)?\.ts$/,
  /^scripts\/ner-runtime\.lock\.json$/,
  /^scripts\/vendor-ner-runtime(?:\.test)?\.ts$/,
  /^scripts\/vendor-transformers-version\.test\.ts$/,
];

function isFrontendNerRuntimeSupportChange(files: string[]): boolean {
  return files.some((file) => FRONTEND_NER_RUNTIME_SIGNAL_RE.some((re) => re.test(file)));
}

function isFrontendOnlyFile(file: string, files: string[]): boolean {
  const isNerSupport = isFrontendNerRuntimeSupportChange(files)
    && FRONTEND_NER_RUNTIME_SUPPORT_RE.some((re) => re.test(file));
  const isFrontendAsset = FRONTEND_ONLY_PATH_RE.some((re) => re.test(file)) || isNerSupport;
  const isNonFrontend = NON_FRONTEND_SURFACE_RE.some((re) => re.test(file)) && !isNerSupport;
  return isFrontendAsset && !isNonFrontend;
}

/**
 * True iff EVERY changed file is a purely-frontend/UAT/test/support file and
 * not matching any
 * server/migration/SDK/contract/CI surface ({@link NON_FRONTEND_SURFACE_RE}).
 * This is the fail-closed guard for the frontend-targeted T2 evidence mode: it
 * gates the alternate evidence path so it can only ever apply to a PR that
 * genuinely cannot produce worker artifacts. A frontend feature shipping
 * vendored assets (`public/vendor`) + its E2E (`e2e/`) alongside its `src/`
 * change is exactly this case; workflow / CI-script / worker / migration
 * changes stay on the full worker-evidence path (fail-closed preserved).
 *
 * An empty fileset returns false: there is nothing to attest as frontend-only,
 * and a non-frontend caller should never reach the frontend path by default.
 */
export function isFrontendOnlyChange(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every((file) => isFrontendOnlyFile(file, files));
}

/**
 * Prefixes of the OFFLINE, architecturally-unsoakable distributable surface: the
 * standalone client SDK / CLI / library packages that ship to consumers and run
 * offline (pytest / vitest / parity), NOT the deployed Cloud Run worker.
 *   - `packages/`  the `packages/*` library + CLI tree (arkova-py, verifier,
 *                  verifier-cli, embed, mcp-server, typescript, langchain, sdk, …).
 *   - `sdks/`      the client SDK tree (typescript / langchain / mcp-server).
 * Verified (grep): no `packages/**` or `sdks/**` file is imported by
 * `services/worker/src/**`, so none is bundled into the deployed worker image or
 * applied to the DB — there is no worker runtime to soak for a PR confined here.
 */
const OFFLINE_PACKAGE_PREFIXES = ['packages/', 'sdks/'];

/**
 * A served-contract-doc predicate. `docs/api/` and `docs/guides/API_GUIDE.md`
 * are part of the SDK PATH_RULE, but they DOCUMENT the served Cloud Run worker
 * HTTP contract — a soak validates that contract's behavior — so a PR touching
 * them is NOT architecturally unsoakable and must stay on the standard
 * worker-evidence path. Excluded from {@link isOfflinePackageOnlyChange}.
 */
const SERVED_CONTRACT_DOC_RE = /^(?:docs\/api\/|docs\/guides\/API_GUIDE\.md$)/;

/**
 * True iff EVERY changed file is a purely-offline package/SDK file — under one of
 * {@link OFFLINE_PACKAGE_PREFIXES} (`packages/` / `sdks/`) and NOT matching any
 * worker/migration/served-contract surface ({@link NON_FRONTEND_SURFACE_RE} minus
 * the offline-package prefixes it also lists, plus the {@link SERVED_CONTRACT_DOC_RE}
 * carve-out). This is the fail-closed guard for the architecturally-unsoakable
 * evidence mode: it gates the alternate (test/parity + N/A-tag + unsoakable-note)
 * evidence path so it can only ever apply to a PR that genuinely has no worker
 * runtime to soak. #1411 (offline verifier-cli + arkova-py SDK) is exactly this
 * case; any worker/migration/API-contract-doc-touching PR stays on the full
 * worker-evidence path (fail-closed preserved).
 *
 * `NON_FRONTEND_SURFACE_RE` lists `^packages/` and `^sdks/` as "non-frontend", so
 * it cannot be used directly as the denylist here (it would reject every offline
 * package). Instead the denylist is the SERVED/worker/migration subset: worker
 * (`services/`), migration/functions (`supabase/(migrations|functions)/`), served
 * contract docs, CI workflows, and CI scripts. An offline package file matches
 * none of those.
 *
 * An empty fileset returns false: there is nothing to attest as offline-only.
 */
export function isOfflinePackageOnlyChange(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every(
    (f) => OFFLINE_PACKAGE_PREFIXES.some((p) => f.startsWith(p))
      && !f.startsWith('services/')
      && !f.startsWith('supabase/migrations/')
      && !f.startsWith('supabase/functions/')
      && !SERVED_CONTRACT_DOC_RE.test(f)
      && !f.startsWith('.github/workflows/')
      && !f.startsWith('scripts/'),
  );
}

const EVIDENCE_HEADER_RE = /^##\s+Staging\s+Soak\s+Evidence\s*$/im;
const UTC_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?\s*(?:UTC|Z)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// Tier declaration, tolerant of common markdown decoration on the line.
// Accepts, anchored to the start of a (whitespace-trimmed) line:
//   - an optional list marker (`-` / `*`) + optional `[x]`/`[ ]` checkbox,
//   - optional markdown emphasis (`*`/`**`/`_`/`__`) wrapping the word `Tier`
//     and/or its colon — covers `**Tier:**`, `*Tier*:`, `_Tier_:`, `**Tier**:`,
//   - then `T0`–`T3`, optionally emphasis-wrapped, as a whole token.
// The plain `Tier: T2` form keeps matching (every decoration group is optional).
// This is label-parsing tolerance only: the captured value is still validated
// against DECLARED_TIER_VALUES, so the set of accepted tiers is unchanged.
//
// Composed from named sub-parts rather than one dense literal: it keeps each
// fragment readable and below the per-regex cognitive-complexity bound, and it
// removes the backtracking ambiguity of adjacent `\s*` groups flanking optional
// emphasis (the old `\s*:\s*(?:[*_]{1,2})?\s*` shape) by using single horizontal-
// whitespace runs (`HSPACE`). Lines are pre-split on `\r?\n` by
// {@link extractDeclaredTier}, so horizontal-only whitespace is exact, not a
// behavior change — verified identical to the prior literal over a combinatorial
// corpus.
// `String.raw` only where the literal itself carries backslashes; the
// backslash-free fragments use plain template literals (interpolated sub-parts
// keep their own escaping). Same assembled source either way.
const TIER_HSPACE = String.raw`[^\S\r\n]`;
const TIER_EMPHASIS = `[*_]{1,2}`;
// Optional leading list bullet (`-`/`*`) then optional spaces.
const TIER_LIST_PREFIX = `(?:[-*]${TIER_HSPACE}*)?`;
// Optional GitHub task checkbox (`[ ]`/`[x]`) then optional spaces.
const TIER_CHECKBOX = String.raw`(?:\[[ x]\]${TIER_HSPACE}*)?`;
// The literal label `Tier`, optionally emphasis-wrapped on either side.
const TIER_LABEL = `(?:${TIER_EMPHASIS})?Tier(?:${TIER_EMPHASIS})?`;
// Separator: optional spaces, colon, optional spaces, then an optional emphasis
// run with its own trailing spaces — no two `\s*` flank the same optional group.
const TIER_SEPARATOR = `${TIER_HSPACE}*:${TIER_HSPACE}*(?:${TIER_EMPHASIS}${TIER_HSPACE}*)?`;
// The tier token `T0`–`T3`, optional trailing emphasis, not followed by a word char.
const TIER_VALUE_TOKEN = String.raw`(T[0-3])(?:${TIER_EMPHASIS})?(?!\w)`;
const DECLARED_TIER_LINE_RE = new RegExp(
  `^${TIER_HSPACE}*${TIER_LIST_PREFIX}${TIER_CHECKBOX}${TIER_LABEL}${TIER_SEPARATOR}${TIER_VALUE_TOKEN}`,
  'i',
);

export function extractDeclaredTier(body: string): Tier | null {
  for (const line of body.split(/\r?\n/)) {
    const m = DECLARED_TIER_LINE_RE.exec(line);
    if (!m) continue;
    const value = m[1].toUpperCase();
    if (DECLARED_TIER_VALUES.has(value as Tier)) {
      return value as Tier;
    }
  }
  return null;
}

export function hasEvidenceSection(body: string): boolean {
  return EVIDENCE_HEADER_RE.test(body);
}

/**
 * Evidence-block field set key: a standard tier, the frontend-targeted T2 path, or the
 * architecturally-unsoakable (offline-package) T2 path.
 */
export type FieldSet = Tier | 'T2_FRONTEND' | 'T2_UNSOAKABLE';

function requiredFieldsFor(set: FieldSet): readonly string[] {
  if (set === 'T2_FRONTEND') return T2_FRONTEND_FIELDS;
  if (set === 'T2_UNSOAKABLE') return T2_UNSOAKABLE_FIELDS;
  return TIER_SPECS[set].requiredFields;
}

export function missingFields(body: string, set: FieldSet): string[] {
  const missing: string[] = [];
  for (const field of requiredFieldsFor(set)) {
    // Field labels are line-anchored to avoid matching prose mentions.
    const re = new RegExp(String.raw`^[\s\-*]*(?:\[[ x]\]\s*)?${escapeRegExp(field)}`, 'im');
    if (!re.test(body)) missing.push(field);
  }
  return missing;
}

function extractEvidenceFieldValue(body: string, field: string): string | null {
  const re = new RegExp(String.raw`^[\s\-*]*(?:\[[ x]\]\s*)?${escapeRegExp(field)}[^\S\n]*(.*)$`, 'im');
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

function parseEvidenceTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const direct = Date.parse(trimmed);
  if (Number.isFinite(direct)) return direct;

  const utc = UTC_TIMESTAMP_RE.exec(trimmed);
  if (!utc) return null;

  const [, date, time, seconds] = utc;
  const ms = Date.parse(`${date}T${time}:${seconds ?? '00'}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function formatHours(hours: number): string {
  if (Number.isInteger(hours)) return String(hours);
  const fixed = hours.toFixed(2);
  if (fixed.endsWith('00')) return fixed.slice(0, -3);
  if (fixed.endsWith('0')) return fixed.slice(0, -1);
  return fixed;
}

export function soakDurationErrors(body: string, tier: Tier): string[] {
  const startValue = extractEvidenceFieldValue(body, 'Soak start:');
  const endValue = extractEvidenceFieldValue(body, 'Soak end:');
  const errors: string[] = [];

  if (startValue === null || endValue === null) return errors;

  const startMs = parseEvidenceTimestamp(startValue);
  const endMs = parseEvidenceTimestamp(endValue);

  if (startMs === null || endMs === null) {
    if (startMs === null) {
      errors.push(`Soak start could not parse as a timestamp: \`${startValue}\`.`);
    }
    if (endMs === null) {
      errors.push(`Soak end could not parse as a timestamp: \`${endValue}\`.`);
    }
    return errors;
  }

  if (endMs <= startMs) {
    return ['Soak end must be after Soak start.'];
  }

  const spec = TIER_SPECS[tier];
  const elapsedHours = (endMs - startMs) / 3_600_000;
  if (elapsedHours < spec.soakHours) {
    return [
      `${tier} soak duration (${formatHours(elapsedHours)}h) is below the `
      + `${spec.soakHours}h minimum. Soak start: \`${startValue}\`; Soak end: \`${endValue}\`.`,
    ];
  }

  return errors;
}

function extractShaField(body: string, field: string): string | null {
  const value = extractEvidenceFieldValue(body, field);
  if (value === null) return null;
  const m = SHA_RE.exec(value);
  return m ? m[0].toLowerCase() : null;
}

function validateNonEmptyEvidenceField(body: string, field: string): string | null {
  const value = extractEvidenceFieldValue(body, field);
  if (value === null || value.trim().length > 0) return null;
  return `${field} must include auditable evidence, not an empty value.`;
}

function validateStagingTagEvidence(body: string): string | null {
  const field = 'Staging tag URL or N/A explanation:';
  const value = extractEvidenceFieldValue(body, field);
  if (value === null || value.trim().length === 0) return null;

  const hasUrl = /\bhttps?:\/\/\S+/i.test(value);
  const hasExplanation = /\b(?:n\/a|not applicable|no staging tag|not needed)\b/i.test(value);
  return hasUrl || hasExplanation
    ? null
    : `${field} must contain a staging URL or an explicit N/A explanation.`;
}

function validatePassingEvidenceField(
  body: string,
  field: string,
  passPattern: RegExp,
  message: string,
): string | null {
  const value = extractEvidenceFieldValue(body, field);
  if (value === null || value.trim().length === 0 || passPattern.test(value)) return null;
  return message;
}

// "Not filled in yet" markers — never acceptable as evidence on any tier.
// Anchored to the whole (trimmed) value so a legitimate sentence that merely
// mentions one of these words is not falsely rejected.
const INCOMPLETE_VALUE_PATTERNS = [
  /^pending\.?$/i,
  /^tbd\.?$/i,
  /^to[\s-]?be[\s-]?(?:determined|announced|filled(?:[\s-]?in)?)\.?$/i,
  /^tba\.?$/i,
  /^todo\.?$/i,
  /^to[\s-]?do\.?$/i,
  /^planned\.?$/i,
  /^future\.?$/i,
  /^fixme\.?$/i,
  /^wip\.?$/i,
  /^work[\s-]?in[\s-]?progress\.?$/i,
  /^fill[\s-]?in\.?$/i,
  /^placeholder\.?$/i,
  /^coming[\s-]?soon\.?$/i,
  /^see[\s-]?above\.?$/i,
  /^xxx+\.?$/i,
  /^\?+\.?$/i,
  /^-+\.?$/i,
  /^_+\.?$/i,
  /^\.{2,}\.?$/i,
  /^…\.?$/i,
  /^<[^>]*>\.?$/i,
];
const INCOMPLETE_CONTEXT_WORDS =
  '(?:evidence|soak|run|capture|verification|verify|test|proof|result|preflight|deploy|observation|timestamp|start|end)';
const INCOMPLETE_PHRASE_PATTERNS = [
  /\bnot[\s-]?started\b/i,
  /\bto[\s-]?be[\s-]?(?:run|captured)\b/i,
  /\bwill\s+(?:run|start|finish|capture|verify)\b/i,
  new RegExp(String.raw`\b(?:planned|future)\s+${INCOMPLETE_CONTEXT_WORDS}\b`, 'i'),
  new RegExp(String.raw`\b${INCOMPLETE_CONTEXT_WORDS}\s+(?:planned|future)\b`, 'i'),
];

// "Not applicable" markers — legitimate for some fields (e.g. `Migration
// applied: none`) but never for a concrete deploy artifact.
const NOT_APPLICABLE_VALUE_RE = /^(?:n\/?a|n\.?a\.?|none|not[\s-]?applicable|null|nil)\.?$/i;
const URL_RE = /\bhttps?:\/\/\S+/i;
const IMAGE_DIGEST_RE = /\bsha256:[0-9a-f]{64}\b/i;

function isIncompletePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return INCOMPLETE_VALUE_PATTERNS.some((re) => re.test(trimmed))
    || INCOMPLETE_PHRASE_PATTERNS.some((re) => re.test(trimmed));
}

function isNotApplicablePlaceholder(value: string): boolean {
  return NOT_APPLICABLE_VALUE_RE.test(value.trim());
}

/**
 * Non-empty AND not a "not filled in yet" placeholder (PENDING/TBD/…).
 * N/A-style answers are allowed — use {@link validateArtifactEvidenceField}
 * for fields where N/A is also unacceptable.
 */
function validateFilledEvidenceField(body: string, field: string): string | null {
  const value = extractEvidenceFieldValue(body, field);
  if (value === null) return null; // label absent → missingFields() owns this
  const trimmed = value.trim();
  if (trimmed.length === 0) return `${field} must include auditable evidence, not an empty value.`;
  if (isIncompletePlaceholder(trimmed)) {
    return `${field} is a placeholder (\`${trimmed}\`), not auditable evidence — fill in the real value from the staging deploy.`;
  }
  return null;
}

/**
 * A concrete artifact that a real T2/T3 soak necessarily produces (worker
 * revision, image digest, deploy-log id, Cloud Run URL). Neither a "not filled
 * in" placeholder nor an "N/A" is acceptable here.
 */
function validateArtifactEvidenceField(body: string, field: string): string | null {
  const filled = validateFilledEvidenceField(body, field);
  if (filled !== null) return filled;
  const value = extractEvidenceFieldValue(body, field);
  if (value !== null && isNotApplicablePlaceholder(value)) {
    return `${field} must reference a real staging deploy artifact; \`${value.trim()}\` is not auditable evidence for a T2/T3 soak.`;
  }
  return null;
}

function validateCloudRunUrlEvidence(body: string): string | null {
  const field = 'Cloud Run service/tag URL:';
  const artifact = validateArtifactEvidenceField(body, field);
  if (artifact !== null) return artifact;
  const value = extractEvidenceFieldValue(body, field);
  if (value === null || value.trim().length === 0) return null;
  return URL_RE.test(value)
    ? null
    : `${field} must contain the Cloud Run service or tag URL.`;
}

function validateImageDigestEvidence(body: string): string | null {
  const field = 'Image digest:';
  const artifact = validateArtifactEvidenceField(body, field);
  if (artifact !== null) return artifact;
  const value = extractEvidenceFieldValue(body, field);
  if (value === null || value.trim().length === 0) return null;
  return IMAGE_DIGEST_RE.test(value)
    ? null
    : `${field} must contain the immutable sha256:<64 hex> image digest for the tested worker image.`;
}

// Concrete deploy artifacts: a placeholder or N/A here means the deploy did
// not actually happen for this evidence.
const T2_T3_ARTIFACT_FIELDS = [
  'Worker revision:',
  'Staging deploy log id:',
];

// Remaining evidence fields that must at least be filled in (PENDING/TBD/empty
// rejected). N/A-style answers stay allowed where legitimate (e.g. `Migration
// applied: none`). T3-only fields are simply absent from a T2 body —
// validateFilledEvidenceField no-ops on a missing label.
const T2_T3_FILLED_FIELDS = [
  'Staging branch:',
  'Staging project ref:',
  'E2E result:',
  'Migration applied:',
  'Rollback rehearsed:',
  'Trigger A fires:',
  'Trigger B fires:',
  'Daily flush observation:',
  'Per-org isolation check:',
];

// ───────────────────────────────────────────────────────────────────────────
// Frontend-T2 targeted evidence mode.
//
// A declared-T2 PR can be frontend-only even when it is T1 by path (copy/UI
// contract) or T2 by sensitive frontend path. Such a PR ships no worker code, no
// migration, and no SDK/contract change, so it can never produce the worker
// artifacts / clean worker preflight the standard T2 block demands. Instead it
// satisfies T2 only when RM explicitly approves targeted evidence and the body
// names changed behavior, targeted evidence, and load/async-cycle proof.
//
// This path is reachable ONLY through `isFrontendOnlyChange(files)` — see
// check(). Any worker- or migration-touching T2 PR keeps the unchanged
// worker-artifact requirements.
// ───────────────────────────────────────────────────────────────────────────
export const T2_FRONTEND_FIELDS = [
  'Tier:',
  'PR head SHA:',
  'RM-approved targeted evidence:',
  'Async-cycle floor:',
  'E2E result:',
  'CI/E2E green:',
  'Rollback plan:',
];

// ───────────────────────────────────────────────────────────────────────────
// Architecturally-unsoakable evidence mode.
//
// A PR can be required-tier T2 purely by touching an OFFLINE package/SDK/CLI
// surface (the `packages/…` / `sdks/` half of the SDK PATH_RULE). Those
// packages ship no worker code, no migration, and are not the served Cloud Run
// HTTP contract — they are distributed as standalone libraries/CLIs run offline
// by consumers (pytest / vitest / parity). Such a PR can NEVER produce the
// worker artifacts (Worker revision, Image digest, Cloud Run URL, Staging
// deploy-log id) or the clean_mirror preflight the standard T2 block demands —
// there is no worker runtime to soak. Demanding those was an impossible
// catch-22 that blocked #1411 (verifier-cli + arkova-py).
//
// Instead it satisfies T2 with test/parity evidence (vitest/pytest/parity green
// at head), an N/A-with-justification staging tag, and an `### Unsoakable-surface
// note` attesting that no worker runtime exists to soak.
//
// This path is reachable ONLY through `isOfflinePackageOnlyChange(files)` — see
// check(). Any worker/migration/served-contract-touching T2 PR keeps the
// unchanged worker-artifact requirements (fail-closed).
// ───────────────────────────────────────────────────────────────────────────
export const T2_UNSOAKABLE_FIELDS = [
  'Tier:',
  'PR head SHA:',
  'Test evidence:',
  'CI green:',
  'Staging tag URL or N/A explanation:',
];

// Unsoakable-surface note: an offline-package PR substitutes this for the worker
// artifacts it cannot produce. The sub-fields attest that no worker runtime
// exists to soak + name the offline surfaces; the SAME real-approver guard as
// the other alternate-evidence notes applies.
const UNSOAKABLE_NOTE_REQUIRED_FIELDS = [
  'No worker runtime:',
  'Surfaces touched:',
  'Approved by:',
];

const UNSOAKABLE_NOTE_HEADER_RE = /^###\s+Unsoakable-surface\s+note\b/im;

const HEALTH_TOKEN_RE = /(?:^|[\s`"'(])(?:\/health\b|healthcheck\b)/i;
const HEALTH_CONTEXT_TERMS = [
  'webhook',
  'docusign',
  'retry',
  'envelope',
  'batch',
  'anchor',
  'cron',
  'queue',
  'deadman',
  'dlq',
  'proof',
  'verify',
  'verification',
  'export',
  'ai',
  'billing',
  'rate-limit',
  'rate limit',
  'chain',
  'treasury',
  'migration',
  'slo',
];

function hasChangedBehaviorContext(lower: string): boolean {
  return HEALTH_CONTEXT_TERMS.some((term) => lower.includes(term))
    || /\/api\/(?!health\b)/.test(lower);
}

function isGenericHealthOnlyEvidence(value: string): boolean {
  const lower = value.toLowerCase();
  return HEALTH_TOKEN_RE.test(lower) && !hasChangedBehaviorContext(lower);
}

const LOAD_EVIDENCE_TERMS = [
  'load',
  'concurr',
  'parallel',
  'fan-out',
  'fan out',
  'burst',
  'rate-limit',
  'rate limit',
  'throughput',
  'p95',
  'latency',
  'k6',
  'vu',
  'virtual user',
  'stress',
  'rps',
  'queue',
  'retry',
  'drain',
  '10k',
  'anchors/sec',
  'deliveries',
];
const QUALIFIED_REQUEST_RE =
  /\b(?:concurrent|parallel|simultaneous|burst|high[- ]volume|rate[- ]limited)\s+requests?\b/i;
const NUMERIC_REQUEST_RE = /\b\d+\s*(?:rps|qps|reqs?|requests?)\b/i;

function isSpecificLoadEvidence(value: string): boolean {
  const lower = value.toLowerCase();
  return LOAD_EVIDENCE_TERMS.some((term) => lower.includes(term))
    || QUALIFIED_REQUEST_RE.test(value)
    || NUMERIC_REQUEST_RE.test(value);
}

function validateLoadConcurrencyEvidence(body: string): string | null {
  const field = 'Load/concurrency evidence:';
  const filled = validateFilledEvidenceField(body, field);
  if (filled !== null) return filled;

  const value = extractEvidenceFieldValue(body, field);
  if (value === null) {
    return `${field} is required and must name the changed-behavior proof under heavy-user/load/concurrency conditions.`;
  }
  if (isNotApplicablePlaceholder(value)) {
    return `${field} must name real heavy-user/load/concurrency evidence; \`${value.trim()}\` is not merge-grade soak evidence.`;
  }
  if (isGenericHealthOnlyEvidence(value)) {
    return `${field} must exercise the changed behavior under load; generic \`/health\` coverage is only supporting worker-health evidence.`;
  }
  return isSpecificLoadEvidence(value)
    ? null
    : `${field} must name load/concurrency proof for the changed behavior (for example tests/load, k6 VUs, p95/error-rate thresholds, queue drain, retry fan-out, or rate-limit evidence).`;
}

const RM_TARGETED_APPROVAL_FIELD = 'RM-approved targeted evidence:';
const ASYNC_CYCLE_FLOOR_FIELD = 'Async-cycle floor:';

function validateRmTargetedApproval(body: string): string[] {
  const approval = extractEvidenceFieldValue(body, RM_TARGETED_APPROVAL_FIELD);
  if (approval === null) return [];

  const errors = [
    validateFilledEvidenceField(body, RM_TARGETED_APPROVAL_FIELD),
  ].filter((error): error is string => error !== null);

  if (!/\bapproved\b/i.test(approval) || !/\b(?:carson|rm|release manager)\b/i.test(approval)) {
    errors.push(`${RM_TARGETED_APPROVAL_FIELD} must name the release manager approval for targeted evidence.`);
  }
  return errors;
}

function validateAsyncCycleFloor(body: string): string[] {
  const floor = extractEvidenceFieldValue(body, ASYNC_CYCLE_FLOOR_FIELD);
  if (floor === null) return [`${ASYNC_CYCLE_FLOOR_FIELD} is required when RM-approved targeted evidence is used.`];
  const errors = [
    validateFilledEvidenceField(body, ASYNC_CYCLE_FLOOR_FIELD),
  ].filter((error): error is string => error !== null);
  return errors;
}

function changedBehaviorErrors(body: string): string[] {
  const errors = [
    validateFilledEvidenceField(body, 'Changed behavior:'),
    validateFilledEvidenceField(body, 'Targeted evidence:'),
    validateLoadConcurrencyEvidence(body),
  ].filter((error): error is string => error !== null);

  if (extractEvidenceFieldValue(body, 'Changed behavior:') === null) {
    errors.push('Changed behavior: is required and must name the behavior changed by this PR.');
  }
  const targetedEvidence = extractEvidenceFieldValue(body, 'Targeted evidence:');
  if (targetedEvidence === null) {
    errors.push('Targeted evidence: is required and must name the changed behavior exercised by the evidence.');
  } else if (isGenericHealthOnlyEvidence(targetedEvidence)) {
    errors.push('Targeted evidence: must exercise the changed behavior; generic `/health` coverage is only supporting worker-health evidence.');
  }

  return errors;
}

/**
 * Frontend-T2 targeted evidence validation. Mirrors the standard T2
 * changed-behavior/load checks, but swaps the worker-artifact/preflight
 * requirements for RM-approved targeted UI evidence. Returns the list of error
 * strings (empty = ok).
 */
function frontendT2Errors(body: string): string[] {
  const errors: (string | null)[] = [];

  // Section + required field labels.
  if (!hasEvidenceSection(body)) {
    return [
      'PR body is missing a `## Staging Soak Evidence` section. '
      + 'Use docs/staging/PR_TEMPLATE.md (frontend-T2 block) as a starting point.',
    ];
  }
  const missing = missingFields(body, 'T2_FRONTEND');
  if (missing.length > 0) {
    errors.push(
      '`## Staging Soak Evidence` section is missing required fields for the '
      + 'frontend-T2 evidence path: '
      + missing.map((f) => `\`${f}\``).join(', ') + '.',
    );
  }

  // `CI/E2E green:` must be non-empty AND state a passing result. The
  // non-empty check runs first because validatePassingEvidenceField
  // short-circuits to PASS on an empty value — without it a bare
  // `- CI/E2E green:` line would attest nothing, weaker than the T1 path
  // (which runs validateNonEmptyEvidenceField over every required field).
  errors.push(
    ...validateRmTargetedApproval(body),
    ...validateAsyncCycleFloor(body),
    validateFilledEvidenceField(body, 'E2E result:'),
    validateNonEmptyEvidenceField(body, 'Rollback plan:'),
    validateNonEmptyEvidenceField(body, 'CI/E2E green:'),
    validatePassingEvidenceField(
      body,
      'CI/E2E green:',
      /\b(?:green|pass(?:ed|es)?|success(?:ful)?)\b/i,
      'CI/E2E green: must state that CI/E2E is green.',
    ),
    ...changedBehaviorErrors(body),
  );

  return errors.filter((e): e is string => e !== null);
}

/**
 * Architecturally-unsoakable evidence validation. Mirrors the spirit of the
 * alternate T2 / T1 auditable-value checks (real test/parity result, real CI
 * green, real N/A-justified staging tag, named approver) but swaps the
 * worker-artifact requirements for a `### Unsoakable-surface note` attesting
 * that no worker runtime exists to soak. Returns the list of error strings
 * (empty = ok).
 */
function unsoakableT2Errors(body: string): string[] {
  const errors: (string | null)[] = [];

  if (!hasEvidenceSection(body)) {
    return [
      'PR body is missing a `## Staging Soak Evidence` section. '
      + 'Use docs/staging/PR_TEMPLATE.md (unsoakable-surface block) as a starting point.',
    ];
  }

  const missing = missingFields(body, 'T2_UNSOAKABLE');
  if (missing.length > 0) {
    errors.push(
      '`## Staging Soak Evidence` section is missing required fields for the '
      + 'architecturally-unsoakable (offline package/SDK) evidence path: '
      + missing.map((f) => `\`${f}\``).join(', ') + '.',
    );
  }

  // `Test evidence:` must be filled (no placeholder) AND state a passing result
  // (pytest/vitest/parity green). The non-empty check runs first because
  // validatePassingEvidenceField short-circuits to PASS on an empty value.
  errors.push(
    validateFilledEvidenceField(body, 'Test evidence:'),
    validatePassingEvidenceField(
      body,
      'Test evidence:',
      /\b(?:green|pass(?:ed|es)?|success(?:ful)?|ok|\d+\s*\/\s*\d+)\b/i,
      'Test evidence: must state a passing test/parity result (e.g. pytest/vitest/parity green).',
    ),
    validateNonEmptyEvidenceField(body, 'CI green:'),
    validatePassingEvidenceField(
      body,
      'CI green:',
      /\b(?:green|pass(?:ed|es)?|success(?:ful)?)\b/i,
      'CI green: must state that CI is green.',
    ),
    // The staging tag MUST be an explicit N/A-with-justification (or a URL, for
    // symmetry with the T1 validator) — a bare "skipped" is not auditable.
    validateStagingTagEvidence(body),
    validateFilledEvidenceField(body, 'Staging tag URL or N/A explanation:'),
    ...changedBehaviorErrors(body),
  );

  // The worker artifacts are substituted by an unsoakable-surface note.
  const note = hasUnsoakableSurfaceNote(body);
  if (!note.valid) {
    if (note.missing.length > 0) {
      errors.push(
        '`### Unsoakable-surface note` is missing required sub-fields: '
        + note.missing.map((f) => `\`${f}\``).join(', ')
        + '. The note must attest that no worker runtime exists to soak '
        + '(offline package/SDK) and carry a named `Approved by:`.',
      );
    } else {
      errors.push(
        'Architecturally-unsoakable evidence requires a `### Unsoakable-surface '
        + 'note` section attesting that no worker runtime exists to soak '
        + '(offline package/SDK: no Cloud Run deploy, no worker revision, no '
        + 'image digest, no staging deploy-log id, no migration).',
      );
    }
  }

  return errors.filter((e): e is string => e !== null);
}

function requiredValueErrors(body: string, tier: Tier): string[] {
  if (tier === 'T0') return [];

  if (tier === 'T1') {
    const emptyFieldErrors = TIER_SPECS.T1.requiredFields
      .filter((field) => field !== 'Tier:' && field !== 'PR head SHA:')
      .map((field) => validateNonEmptyEvidenceField(body, field));

    return [
      ...emptyFieldErrors,
      validateStagingTagEvidence(body),
      validatePassingEvidenceField(
        body,
        'Health/smoke result:',
        /\b(?:green|pass(?:ed|es)?|ok|healthy)\b/i,
        'Health/smoke result: must state a passing health/smoke result.',
      ),
      validatePassingEvidenceField(
        body,
        'CI/E2E green:',
        /\b(?:green|pass(?:ed|es)?|success(?:ful)?)\b/i,
        'CI/E2E green: must state that CI/E2E is green.',
      ),
    ].filter((error): error is string => error !== null);
  }

  // T2 / T3 — the stricter, symmetric analog of the T1 checks above. Deploy
  // evidence must carry real, auditable values; the SHA / scope / preflight /
  // soak fields have their own dedicated validators and are skipped here to
  // avoid duplicate errors (CLAUDE.md §1.11A: PENDING deploy evidence on dirty
  // staging must not pass CI).
  return [
    ...T2_T3_ARTIFACT_FIELDS.map((field) => validateArtifactEvidenceField(body, field)),
    validateCloudRunUrlEvidence(body),
    validateImageDigestEvidence(body),
    ...T2_T3_FILLED_FIELDS.map((field) => validateFilledEvidenceField(body, field)),
  ].filter((error): error is string => error !== null);
}

function normalizeSha(value: string | undefined): string | null {
  if (!value) return null;
  const m = SHA_RE.exec(value);
  return m ? m[0].toLowerCase() : null;
}

function hasCleanMirrorPreflight(value: string): boolean {
  const lower = value.toLowerCase();
  if (/\b(?:soak_artifact|fixture_seeded)\b/.test(lower)) return false;
  if (/\bdiagnostic[- ]?only\b/.test(lower)) return false;
  if (/\b(?:dirty|contaminated|staging[- ]only|pr[- ]only|prod(?:uction)? divergence|unexplained prod divergence)\b/.test(lower)) return false;
  if (/\bduplicate migration (?:names|versions) (?:found|present|detected)\b/.test(lower)) return false;
  return /["']?environment_type["']?\s*[:=]\s*["']?clean_mirror["']?/.test(lower);
}

function normalizeEvidenceScope(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function evidenceScopeErrors(body: string): string[] {
  const evidenceScope = extractEvidenceFieldValue(body, 'Evidence scope:');
  if (evidenceScope === null) {
    return ['Evidence scope must be one of: merge-grade shared staging, merge-grade isolated staging.'];
  }

  const normalized = normalizeEvidenceScope(evidenceScope);
  if (/\bdiagnostic[- ]?only\b/i.test(normalized)) {
    return ['Evidence scope is diagnostic-only; diagnostic evidence is not merge-grade staging evidence.'];
  }

  if (ALLOWED_EVIDENCE_SCOPES.has(normalized)) return [];

  return ['Evidence scope must be one of: merge-grade shared staging, merge-grade isolated staging.'];
}

const RESIDUAL_RISK_HEADER_RE = /^###\s+Residual-risk\s+note\b/im;

const RESIDUAL_RISK_REQUIRED_FIELDS = [
  'Contamination type:',
  'Affected rows:',
  'Impact on this PR:',
  'Reason not cleaned:',
  'Approved by:',
];

/**
 * Validate a `### Residual-risk note` section against a required-field list.
 * Shared by the DB-contamination exception ({@link hasResidualRiskException})
 * and the unsoakable-package note. Enforces the real-approver guard on
 * `Approved by:` for both.
 */
function validateResidualRiskNote(
  body: string,
  requiredFields: readonly string[],
  headerRe: RegExp = RESIDUAL_RISK_HEADER_RE,
): { valid: boolean; missing: string[] } {
  const headerMatch = headerRe.exec(body);
  if (!headerMatch) return { valid: false, missing: [] };
  const sectionStart = headerMatch.index + headerMatch[0].length;
  const nextHeading = body.slice(sectionStart).search(/^#{1,3}\s/m);
  const section = nextHeading === -1
    ? body.slice(sectionStart)
    : body.slice(sectionStart, sectionStart + nextHeading);
  const missing: string[] = [];
  for (const field of requiredFields) {
    const re = new RegExp(String.raw`^[\s\-*]*${escapeRegExp(field)}`, 'im');
    if (!re.test(section)) missing.push(field);
  }
  // `Approved by:` must name a real approver. A present-but-empty or
  // placeholder value (pending/tbd/n/a) is a self-waiver and does NOT grant
  // the exception/path, which would otherwise bypass the gate's protections
  // (CLAUDE.md §1.11A).
  if (requiredFields.includes('Approved by:') && !missing.includes('Approved by:')) {
    const approver = extractEvidenceFieldValue(section, 'Approved by:');
    const trimmed = approver?.trim() ?? '';
    if (trimmed.length === 0 || isIncompletePlaceholder(trimmed) || isNotApplicablePlaceholder(trimmed)) {
      missing.push('Approved by: (must name a real approver, not a blank or placeholder)');
    }
  }
  return { valid: missing.length === 0, missing };
}

export function hasResidualRiskException(body: string): { valid: boolean; missing: string[] } {
  return validateResidualRiskNote(body, RESIDUAL_RISK_REQUIRED_FIELDS);
}

export function hasUnsoakableSurfaceNote(body: string): { valid: boolean; missing: string[] } {
  return validateResidualRiskNote(
    body,
    UNSOAKABLE_NOTE_REQUIRED_FIELDS,
    UNSOAKABLE_NOTE_HEADER_RE,
  );
}

function preflightResultErrors(body: string): string[] {
  const preflightResult = extractEvidenceFieldValue(body, 'Preflight result:');
  if (preflightResult === null || hasCleanMirrorPreflight(preflightResult)) return [];

  const riskException = hasResidualRiskException(body);
  if (riskException.valid) return [];
  if (riskException.missing.length > 0) {
    return [
      `Preflight is not clean_mirror but the residual-risk note is missing required sub-fields: `
      + riskException.missing.map((f) => `\`${f}\``).join(', ')
      + `. Add a \`### Residual-risk note\` section with all required fields.`,
    ];
  }

  return ['Preflight result must capture `environment_type=clean_mirror`; dirty or diagnostic preflight output is not merge-grade evidence. Alternatively, add a `### Residual-risk note` section documenting the exception (see CLAUDE.md §1.11A).'];
}

function preflightTimestampErrors(body: string): string[] {
  const preflightTimestampValue = extractEvidenceFieldValue(body, 'Preflight timestamp:');
  if (preflightTimestampValue === null) return [];

  const preflightMs = parseEvidenceTimestamp(preflightTimestampValue);
  if (preflightMs === null) {
    return [`Preflight timestamp could not parse as a timestamp: \`${preflightTimestampValue}\`.`];
  }

  const soakStartValue = extractEvidenceFieldValue(body, 'Soak start:');
  const soakStartMs = soakStartValue === null ? null : parseEvidenceTimestamp(soakStartValue);
  if (soakStartMs !== null && preflightMs > soakStartMs) {
    return ['Preflight timestamp must be at or before Soak start.'];
  }

  return [];
}

const FUTURE_TIMESTAMP_FIELDS = [
  'Preflight timestamp:',
  'Soak start:',
  'Soak end:',
];

function futureTimestampErrors(body: string, nowMs = Date.now()): string[] {
  const errors: string[] = [];
  for (const field of FUTURE_TIMESTAMP_FIELDS) {
    const value = extractEvidenceFieldValue(body, field);
    if (value === null) continue;
    const parsed = parseEvidenceTimestamp(value);
    if (parsed !== null && parsed > nowMs) {
      errors.push(`${field} \`${value}\` is in the future; planned/future evidence cannot start or complete a soak clock.`);
    }
  }
  return errors;
}

function targetedDurationWaiverErrors(body: string, tier: Tier): { valid: boolean; errors: string[] } {
  if (tier !== 'T2') return { valid: false, errors: [] };

  const approval = extractEvidenceFieldValue(body, RM_TARGETED_APPROVAL_FIELD);
  if (approval === null) return { valid: false, errors: [] };

  const errors = [
    ...validateRmTargetedApproval(body),
    ...validateAsyncCycleFloor(body),
  ];

  return { valid: errors.length === 0, errors };
}

function shaEvidenceErrors(opts: {
  body: string;
  field: string;
  expectedSha?: string;
  currentLabel: string;
  staleMessage: string;
}): string[] {
  const evidenceSha = extractShaField(opts.body, opts.field);
  if (!evidenceSha) return [`${opts.field} must contain a 40-character commit SHA.`];

  const expectedSha = normalizeSha(opts.expectedSha);
  if (!expectedSha || evidenceSha === expectedSha) return [];

  return [
    `${opts.field} \`${evidenceSha}\` does not match current ${opts.currentLabel} \`${expectedSha}\`; ${opts.staleMessage}`,
  ];
}

const BASE_DRIFT_IMPACT_FIELD = 'Base drift impact:';
const GIT_BIN = '/usr/bin/git';

function changedFilesBetween(fromSha: string, toSha: string): string[] | null {
  try {
    return execFileSync(
      GIT_BIN,
      ['diff', '--name-only', `${fromSha}..${toSha}`],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Default {@link DiffProvider} for the live CI path: the unified diff of a single
 * file between `baseRef` and `HEAD`. `null` on any failure (no history, deleted,
 * binary), which makes the deploy-worker carve-out fail closed (keeps T2).
 */
function gitFileDiffProvider(baseSha: string): DiffProvider {
  return (file: string): string | null => {
    try {
      const out = execFileSync(
        GIT_BIN,
        ['diff', '--unified=3', `${baseSha}...HEAD`, '--', file],
        { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return out.trim().length > 0 ? out : null;
    } catch {
      return null;
    }
  };
}

/**
 * Default {@link AncestryProvider}: `git merge-base --is-ancestor`.
 * Exit 0 → ancestor, exit 1 → definitively not an ancestor, anything else
 * (128 = bad/unknown object, spawn failure) → `null` so callers fail closed.
 */
function gitAncestryProvider(): AncestryProvider {
  return (ancestorSha: string, descendantSha: string): boolean | null => {
    if (ancestorSha === descendantSha) return true;
    try {
      execFileSync(
        GIT_BIN,
        ['merge-base', '--is-ancestor', ancestorSha, descendantSha],
        { cwd: REPO, stdio: ['ignore', 'ignore', 'ignore'] },
      );
      return true;
    } catch (err) {
      return (err as { status?: number }).status === 1 ? false : null;
    }
  };
}

function hasNamedApprover(value: string): boolean {
  const match = /\bapproved by:\s*([^.;\n]+)/i.exec(value);
  return match !== null && isFilledValue(match[1] ?? null);
}

function impactNoteAttestsNoRuntimeEffect(value: string): boolean {
  const lower = value.toLowerCase();
  return /\b(?:t0|ci[- ]?only|tooling[- ]?only|docs\/tests\/ci)\b/.test(lower)
    && /\bno\b.*\b(?:runtime|schema|migration|staging|soak|deploy)\b.*\b(?:impact|change|effect)\b/.test(lower)
    && hasNamedApprover(value);
}

/**
 * The set of file-path predicates whose intervening main-drift could invalidate
 * THIS PR's completed soak. It is the UNION of:
 *   1. `ownFiles` — the exact files this PR changed (`opts.files`). If main
 *      independently edited one of the exact files the PR soaked, the soak ran
 *      against a now-stale version of that file → re-soak. Matched by exact path
 *      equality against the drift set.
 *   2. `sharedPatterns` — the SHARED PROD-RUNTIME surface ({@link
 *      SHARED_PROD_RUNTIME_RULES} patterns). Files not in this PR's diff but whose
 *      semantics the soak implicitly depends on because they are the same deployed
 *      artifact / DB / queue substrate (migrations, chain, queue/cron, billing,
 *      public API, …). Matched by regex against the drift set.
 */
function prSurfaceMatchers(files: string[]): { ownFiles: Set<string>; sharedPatterns: RegExp[] } {
  return {
    ownFiles: new Set(files),
    sharedPatterns: SHARED_PROD_RUNTIME_RULES.map((rule) => rule.pattern),
  };
}

/**
 * The subset of `driftFiles` (files changed on main between the evidence base and
 * the current base) that INTERSECTS this PR's soak surface — i.e. the drift files
 * that could have invalidated the soak. Empty ⇒ drift is disjoint from the PR
 * surface ⇒ evidence preserved.
 */
function driftFilesIntersectingSurface(
  driftFiles: string[],
  surface: { ownFiles: Set<string>; sharedPatterns: RegExp[] },
): string[] {
  return driftFiles.filter(
    (f) => surface.ownFiles.has(f) || surface.sharedPatterns.some((re) => re.test(f)),
  );
}

/**
 * Path-aware base-drift enforcement. When the evidence's `Base SHA` no longer
 * matches the current base, the intervening main movement is compared against
 * THIS PR's soak surface ({@link prSurfaceMatchers}):
 *
 *   • DISJOINT (no drift file touches the PR's own files or the shared
 *     prod-runtime surface) → evidence preserved, no attestation required.
 *   • INTERSECTS → the soak ran against a now-stale version of a surface the PR
 *     depends on → hard fail (re-soak), with a strictly-narrower fallback: the
 *     operator MAY preserve evidence for the T0-only case by supplying an
 *     approved `Base drift impact:` attestation AND the intervening drift being
 *     classified strictly T0. That fallback exists only so no
 *     currently-passing (T0-drift + attested) PR regresses; it is NOT a general
 *     override for T1+ same-surface drift.
 *   • drift-file list unavailable (`changedFilesBetween` → null and no override)
 *     → fail closed (re-soak).
 */
function baseDriftImpactErrors(
  body: string,
  evidenceBaseSha: string,
  currentBaseSha: string,
  prFiles: string[],
  driftFilesOverride?: string[],
): string[] {
  const driftFiles = driftFilesOverride ?? changedFilesBetween(evidenceBaseSha, currentBaseSha);
  if (driftFiles === null) {
    return [
      `Could not inspect changed files between evidence base \`${evidenceBaseSha}\` and current base \`${currentBaseSha}\`; `
      + 'refresh/re-scope the evidence or run with enough git history to classify base drift.',
    ];
  }

  const surface = prSurfaceMatchers(prFiles);
  const intersecting = driftFilesIntersectingSurface(driftFiles, surface);

  // Disjoint drift — the soak's surface is untouched by the intervening main
  // movement. Evidence preserved; no attestation needed.
  if (intersecting.length === 0) return [];

  // Same-surface drift. Preserve the strictly-narrower legacy escape hatch: an
  // approved `Base drift impact:` attestation for the case where the WHOLE
  // intervening drift is T0-only. Anything above T0 is an unconditional re-soak.
  const driftTier = requiredTierFor(driftFiles);
  if (driftTier.tier === 'T0') {
    const impact = extractEvidenceFieldValue(body, BASE_DRIFT_IMPACT_FIELD);
    if (impact === null || !isFilledValue(impact)) {
      return [
        `Base SHA \`${evidenceBaseSha}\` differs from current base \`${currentBaseSha}\` and the drift touches this PR's soak surface `
        + `(${intersecting.join(', ')}). If the intervening main movement is harmless (T0/CI-only), add \`${BASE_DRIFT_IMPACT_FIELD}\` `
        + 'with the changed files, the no-runtime/schema/staging-impact assessment, and a named approver; '
        + 'otherwise refresh/re-scope the evidence.',
      ];
    }
    if (!impactNoteAttestsNoRuntimeEffect(impact)) {
      return [
        `${BASE_DRIFT_IMPACT_FIELD} must state T0/CI-only drift, explicitly attest no runtime/schema/migration/staging/soak/deploy impact, and name an approver.`,
      ];
    }
    return [];
  }

  return [
    `Base SHA drift from \`${evidenceBaseSha}\` to \`${currentBaseSha}\` touches this PR's soak surface `
    + `(${intersecting.join(', ')}) at ${driftTier.tier} (${driftTier.reason}); `
    + 'existing soak evidence cannot be preserved without release-owner re-scope/retest.',
  ];
}

function baseShaEvidenceErrors(
  body: string,
  prFiles: string[],
  expectedSha?: string,
  driftFilesOverride?: string[],
): string[] {
  const evidenceSha = extractShaField(body, 'Base SHA:');
  if (!evidenceSha) return ['Base SHA: must contain a 40-character commit SHA.'];

  const expected = normalizeSha(expectedSha);
  if (!expected || evidenceSha === expected) return [];

  return baseDriftImpactErrors(body, evidenceSha, expected, prFiles, driftFilesOverride);
}

function stagingIntegrityErrors(
  body: string,
  tier: Tier,
  opts: { headSha?: string; baseSha?: string; baseDriftFiles?: string[]; files?: string[] } = {},
): string[] {
  if (tier === 'T0') return [];

  if (tier === 'T1') {
    return [
      ...shaEvidenceErrors({
        body,
        field: 'PR head SHA:',
        expectedSha: opts.headSha,
        currentLabel: 'PR head',
        staleMessage: 'expedited evidence cannot be copied across commits.',
      }),
    ];
  }

  return [
    ...evidenceScopeErrors(body),
    ...preflightResultErrors(body),
    ...preflightTimestampErrors(body),
    ...shaEvidenceErrors({
      body,
      field: 'PR head SHA:',
      expectedSha: opts.headSha,
      currentLabel: 'PR head',
      staleMessage: 'evidence cannot be copied across commits.',
    }),
    ...baseShaEvidenceErrors(body, opts.files ?? [], opts.baseSha, opts.baseDriftFiles),
  ];
}

interface StagingFilesOnlyResult {
  pass: boolean;
  reason: string;
}

/**
 * T0 changes cannot affect production runtime behavior. They run the normal
 * CI suite but do not need staging evidence.
 */
const STAGING_TOOLING_ALLOW = [
  // Secret-scanner policy is CI-only; it never ships to application runtime.
  /^\.gitleaks\.toml$/,
  /^scripts\/staging\//,
  // CI-only local-Supabase bootstrap for the types/tests/e2e jobs (sourced by
  // ci.yml). Runs exclusively on the runner, never ships to prod runtime → T0.
  /^scripts\/ci-supabase-start\.sh$/,
  /^scripts\/ci\/check-staging-evidence(\.test)?\.ts$/,
  // SCRUM-3026: sanctioned re-trigger helper — mints a fresh PR event
  // (tree-identical empty commit + push, optional PR-body head-SHA bump via
  // `gh pr edit`) so event-driven CI gates re-evaluate CURRENT PR state
  // instead of a stale `gh run rerun` replay of the frozen event payload.
  // Runs only as an operator/agent CLI; never ships to prod runtime.
  /^scripts\/ci\/mint-fresh-event(\.test)?\.sh$/,
  /^scripts\/ci\/check-staging-gcloud-policy(\.test)?\.ts$/,
  /^scripts\/ci\/staging-honesty-preflight(\.test)?\.ts$/,
  // SCRUM-1304 / SCRUM-1681: the SonarCloud quality-gate + New Code Definition
  // drift guard. Runs only in the `sonar-quality-gate-config` CI job, reads the
  // SonarCloud REST API, and never ships to prod runtime → T0 tooling. Same
  // class as the staging-gcloud-policy / handoff-claims gates around it.
  /^scripts\/ci\/check-sonar-quality-gate(\.test)?\.ts$/,
  // SCRUM-2897: evidence-identity gate — a pure body/head-SHA identity checker
  // + tests, wired into ci.yml as a REPORT-ONLY / non-gating job. Runs only in
  // CI (reads PR body/head/draft from the event context); never ships to prod
  // runtime → T0 tooling. Same class as the staging-evidence gate above.
  /^scripts\/ci\/check-evidence-identity(\.test)?\.ts$/,
  // S0-4.2 / S0-4.3 (epic S0-E4): release-pipeline CI tooling. These run only
  // in CI and never ship to prod runtime, so they are T0 tooling.
  /^scripts\/ci\/check-ledger-numeric-integrity(\.test)?\.ts$/,
  /^scripts\/ci\/check-agents-md-migration-collision(\.test)?\.ts$/,
  /^scripts\/ci\/compute-merge-authority(\.test)?\.ts$/,
  // R0 verification/baseline CI gates (SCRUM-1252 / 1254 / R0-3). These run
  // ONLY in CI to lint PR metadata + repo invariants (HANDOFF.md claims,
  // `count: 'exact'` callsite baseline, coverage-threshold monotonicity). They
  // never ship to prod runtime → T0 tooling.
  /^scripts\/ci\/check-handoff-claims(\.test)?\.ts$/,
  // S3.3 (SCRUM-2670): rig-day sequencing gate — enumerates open DB-mutating
  // PRs + prod-green assertion, runs ONLY in CI / operator preflight; never
  // ships to prod runtime -> T0 tooling (same class as the R0 gates above).
  /^scripts\/ci\/check-s33-sequencing-gate(\.test)?\.ts$/,
  /^scripts\/ci\/check-count-exact-baseline(\.test)?\.ts$/,
  /^scripts\/ci\/check-coverage-monotonic(\.test)?\.ts$/,
  /^scripts\/ci\/snapshots\//, // CI baselines/snapshots — tooling, never prod runtime
  // SCRUM-2666: the `npm run lint:copy` banned-terminology gate + its test
  // fixtures. Runs only in CI (ci.yml typecheck-lint job) and locally; never
  // ships to prod runtime → T0 tooling. scripts/fixtures/ holds .txt sources
  // read by scripts/*.test.ts only (never imported, typechecked, or bundled).
  /^scripts\/check-copy-terms(\.test)?\.ts$/,
  /^scripts\/fixtures\//,
  // S0-5.2 (epic S0-E5): config↔reality drift + cross-runtime parity gate (CI tooling).
  /^scripts\/ci\/check-config-drift(\.test)?\.ts$/,
  /^scripts\/ci\/config-drift\//,
  // WEBEXT-04 (SCRUM-2506): CSP↔runtime-deps drift gate — a sibling config↔reality
  // CI gate that parses vercel.json + scans on-device runtime sources. Runs only
  // in CI, never ships to prod runtime, so it is T0 tooling.
  /^scripts\/ci\/check-csp-runtime-deps(\.test)?\.ts$/,
  // SCRUM-3032/3033/3034 (CTO ruling R14, 2026-07-28 Wave 0 / G3): orphaned
  // hook/component export lint. Static-analysis CI gate (TypeScript AST scan
  // over src/), runs only in CI; never ships to prod runtime → T0 tooling,
  // same class as the other scripts/ci/check-*.ts gates above.
  /^scripts\/ci\/check-orphaned-exports(\.test)?\.ts$/,
  /^scripts\/ci\/lib\//,
  // SCRUM-1253 (R0-7): memory feedback-rules CI gates. Per-rule scripts under
  // scripts/ci/feedback-rules/ + the check-feedback-rules.ts orchestrator run
  // only in CI (ci.yml "Feedback rules" step); never imported by src/ or
  // services/worker/src/ → no prod runtime to soak, same class as the other
  // scripts/ci/check-*.ts gates above. Their shared scripts/ci/lib/ciContext.ts
  // helper was already covered by the scripts/ci/lib/ entry; this directory
  // was the missing half, which under-classified PR #1775 to T1.
  /^scripts\/ci\/feedback-rules\//,
  /^scripts\/ci\/check-feedback-rules(\.test)?\.ts$/,
  // BUG-026: MCP tool-claim parity gate + its ratchet. Runs only in the
  // ci.yml "policy-lints" job; it READS services/edge/src/mcp-tools.ts
  // (a static import of TOOL_DEFINITIONS, so a rename fails typecheck) but
  // nothing in src/ or services/*/src/ imports IT — no prod runtime to soak.
  // Same class as the check-* gates above. NOTE the corollary this encodes:
  // a T0 PR can add the gate but can NEVER correct a published surface
  // (public/** is T1, services/edge/src/** and docs/api/** are T2) — which is
  // why the gate ships with a baseline instead of a clean sheet.
  /^scripts\/ci\/check-mcp-claim-parity(\.test)?\.ts$/,
  /^scripts\/ci\/mcp-claim-parity-baseline\.json$/,
  // SCRUM-2977: anti-hollow-soak pre-clock guard set. A pure guard module + CLI
  // + tests, wired into ci.yml as a REPORT-ONLY / non-gating job. Runs only in
  // CI (and locally over a soak-preflight JSON); never ships to prod runtime →
  // T0 tooling. Same class as the check-* gates above.
  /^scripts\/ci\/anti-hollow-soak\//,
  // PI-0.5 G1: KPI-3 explorer-rehearsal harness + clean-room verification tools
  // (partner/auditor-run, dependency-free; never imported by worker or frontend
  // — no prod runtime to soak). DIR-SCOPED on purpose: a blanket scripts/**.mjs
  // carve-out was reviewed and rejected (unconditional T1→T0 for future
  // prod-shaped ops scripts, unlike the import-scan-conditional S33 carve-out).
  // New clean-room tool trees get their own explicit entry here.
  /^scripts\/kpi3\//,
  /^scripts\/clean-room\//,
  /^scripts\/gcp-setup\//,
  /^services\/worker\/scripts\/load-test\//,
  /^tests\/k6\//,
  /^tests\/load\//,
  /^docs\/staging\//,
  /^docs\/ops\/gemini-model-upgrade\.md$/,
  /^docs\/reference\/STAGING_RIG\.md$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/workflows\/staging-evidence\.yml$/,
  /^\.github\/workflows\/deploy-staging\.yml$/,
  /^\.mergify\.yml$/,
  /^\.sonarcloud\.properties$/,
  /^CLAUDE\.md$/,
  /^HANDOFF\.md$/,
  /^\.gitignore$/,
  // Claude agent-harness config. These files configure the local agent session
  // (hooks, on-demand skills, permissions) and have NO prod runtime path — they
  // are never imported, bundled, or deployed. `.claude/hooks/` and
  // `.claude/settings.json` were already T0; `skills/`, the retired `hookify.*`
  // rule files, and `settings.local.json` are the same class and were simply
  // missing, which forced genuinely tooling-only PRs to T1 (added 2026-08-01).
  /^\.claude\/settings\.json$/,
  /^\.claude\/settings\.local\.json$/,
  /^\.claude\/hooks\//,
  /^\.claude\/skills\//,
  /^\.claude\/hookify\..*\.md$/,
  // agents.md is documentation wherever it lives — CLAUDE.md §0 rule 8 already
  // names `**/agents.md` as a doc-only path eligible for direct-to-main. Only
  // the repo-root and scripts/ci/ copies were listed, so a nested one (e.g.
  // scripts/ci/feedback-rules/agents.md) forced an otherwise doc-only PR to T1.
  /(?:^|\/)agents\.md$/,
  // Lockfiles are deterministic re-resolutions of a manifest — T0 at every
  // workspace (root / packages/* / services/* / integrations/*).
  /^package-lock\.json$/,
  /^packages\/[^/]+\/package-lock\.json$/,
  /^services\/[^/]+\/package-lock\.json$/,
  /^integrations\/[^/]+\/package-lock\.json$/,
  // Peripheral package.json MANIFESTS only: packages/* libraries (SDK/embed) and
  // integrations/* connectors are non-core surfaces. Root `package.json` and
  // `services/worker/package.json` are intentionally absent — they govern the prod
  // worker / app runtime dependency tree and must still earn a tier.
  /^packages\/[^/]+\/package\.json$/,
  /^integrations\/[^/]+\/package\.json$/,
  // services/edge is the peripheral Cloudflare edge worker (PR #884), not the
  // deployed Cloud Run worker — its manifest stays T0 by explicit carve-out.
  /^services\/edge\/package\.json$/,
  // PI-0 S2 (SCRUM-2341 / verifier track): @arkova/verifier + @arkova/verifier-cli
  // are new MIT-licensed STANDALONE library/CLI packages. They are NOT imported by
  // the deployed Cloud Run worker (services/worker) or the frontend (src/) — verified
  // no `@arkova/verifier` import exists under services/** or src/**. No migration, no
  // API/contract surface, no prod runtime: they run only in their own clean-room CI
  // job and as a developer/auditor CLI. Zero prod-runtime impact → T0 tooling. (The
  // packages/*/package.json + package-lock.json + eslint.config.js + agents.md within
  // them are already covered by the peripheral-package / lockfile / eslint / agents.md
  // rules; these two prefixes additionally cover their src/, tsconfig, vitest config,
  // fixtures, README, LICENSE, .gitignore, and generator script.)
  /^packages\/verifier\//,
  /^packages\/verifier-cli\//,
  // NOTE: services/worker/src/proof/fixtures/ (PROOF-08, #1357) is ALSO T0, but it
  // matches the T2 `services/worker/src/` PATH_RULE, so it is exempted earlier in
  // isT0OnlyFile() (BEFORE the PATH_RULES short-circuit) rather than here — an entry
  // in this list alone would never be reached for it. See that carve-out for the
  // test-only justification.
  /agents\.md$/,
  /^eslint-rules\//,
  /(^|\/)eslint\.config\.(js|cjs|mjs)$/,
  // SonarCloud analyzer configuration — same class as the eslint config above
  // (PR #798: "lint config is dev-time tooling with no runtime impact"). These
  // files are read only by SonarCloud's analyzer; nothing imports them, no
  // bundle includes them, and no deploy ships them, so a soak has no surface to
  // exercise. Anchored to the repo root because that is the only location
  // SonarCloud reads: `.sonarcloud.properties` is the file Automatic Analysis
  // actually consumes, and `sonar-project.properties` is the CI-scanner
  // filename (deleted 2026-08-01 as inert — kept here so its removal, and any
  // future re-add under a CI-based scanner, classify as T0 tooling).
  /^\.sonarcloud\.properties$/,
  /^sonar-project\.properties$/,
  /^e2e\//,
];

export function isStagingToolingOnly(files: string[]): StagingFilesOnlyResult {
  if (files.length === 0) return { pass: true, reason: 'no changed files' };
  for (const f of files) {
    if (!isT0OnlyFile(f)) {
      return { pass: false, reason: `${f} is outside the T0 docs/tests/CI/tooling allowlist` };
    }
  }
  return { pass: true, reason: 'all touched files are T0 docs/tests/CI/tooling-only' };
}

interface CheckResult {
  ok: boolean;
  errors: string[];
  notes: string[];
}

type RcManifestLoader = (path: string) => string | null | undefined;

interface CheckOptions {
  body: string;
  files: string[];
  headSha?: string;
  baseSha?: string;
  baseDriftFiles?: string[];
  prNumber?: number;
  nowMs?: number;
  rcManifestLoader?: RcManifestLoader;
  /**
   * Per-file unified-diff source for content-aware tier classification (the
   * deploy-worker.yml `uses:`-only carve-out). Defaults to a git-backed provider
   * in {@link main}; tests inject a stub. Absent → carve-out fails closed (T2).
   */
  diffProvider?: DiffProvider;
  /**
   * Git ancestry oracle for RC-manifest base coverage. Defaults to a
   * git-backed provider in {@link main} (staging-evidence.yml checks out
   * with `fetch-depth: 0`, so full history is present). Absent or
   * `null`-answering → base coverage falls back to exact SHA enumeration,
   * i.e. fails closed. See {@link rcCurrentBaseCovered}.
   */
  ancestryProvider?: AncestryProvider;
  /**
   * Complete production-source import scan required by CTO ruling 102498305.
   * Missing/incomplete data or any importer voids the offline-T0 carve-out.
   */
  s33Lane1ImportScan?: S33Lane1ImportScan;
  /**
   * Live-confirmed state of deploy-worker.yml's `deploy-gate` job
   * (`vars.DEPLOY_WORKER_PAUSED === 'true'` at the moment THIS run
   * executed). Populated in {@link main} from `process.env
   * .DEPLOY_WORKER_PAUSED`, which `.github/workflows/staging-evidence.yml`
   * threads through from the live `vars` context — not from anything a PR
   * author controls. `undefined`/`false` means "not positively confirmed
   * paused" and must be treated as unpaused for gating purposes (fail
   * closed on ambiguity). This is the hard precondition for
   * {@link deferredConsolidatedSoakCoverage} (CTO ruling 2026-07-28,
   * SCRUM-2980) — see that function for why.
   */
  deployWorkerPaused?: boolean;
  /**
   * TEMPORARY, VARIABLE-CONTROLLED BYPASS — founder directive 2026-08-01,
   * relayed by the CTO session.
   *
   * When positively `true`, {@link check} short-circuits to a pass without
   * evaluating ANY evidence requirement, so Mergify can drain the CI-green
   * queue ahead of the external pen test that starts 2026-08-02. The
   * consolidated week-long soak that follows the pen test is what actually
   * produces the deferred evidence, and this variable MUST be flipped back
   * to `false` before that soak so the gate grades it.
   *
   * Populated in {@link main} from `process.env.SOAK_GATE_DISABLED`, which
   * `.github/workflows/staging-evidence.yml` threads from the live
   * `vars.SOAK_GATE_DISABLED` repository variable — repo-admin state, not
   * anything a PR author controls. Anything other than the literal string
   * `'true'` is "not engaged" and the gate runs in full (fail closed on
   * ambiguity), mirroring {@link CheckOptions.deployWorkerPaused}.
   *
   * NOTE FOR ANY LATER READER: this is a real, deliberate suspension of the
   * CLAUDE.md §1.11/§1.12 evidence requirement, not a refactor. Every other
   * code path is left untouched precisely so that clearing the variable
   * restores the gate exactly as it was.
   */
  soakGateDisabled?: boolean;
}

/**
 * Hard stop for the bypass window. A suspension of the evidence requirement
 * that can only be ended by someone REMEMBERING to end it is a suspension
 * that becomes permanent; every prior override in this repo's history had to
 * be destroyed by hand (the `staging-soak-skip` label, 2026-05-07) rather
 * than lapsing on its own.
 *
 * Past this instant the variable stops being honored and the gate enforces
 * in full again — the fail-closed direction. Two weeks is deliberately
 * generous against the stated plan (pen test from 2026-08-02, then a
 * week-long consolidated soak). If the window genuinely needs to run longer,
 * extending this constant is a one-line PR that is visible in review, which
 * is the entire point: the extension gets seen, the neglect does not.
 */
const SOAK_GATE_BYPASS_EXPIRES_AT = Date.parse('2026-08-16T00:00:00Z');

/**
 * The banner a bypassed run prints. Deliberately states what was NOT done —
 * a passing check here must never be readable as "evidence present".
 */
const SOAK_GATE_BYPASS_NOTE =
  '⚠️  SOAK GATE BYPASSED — founder directive 2026-08-01, re-enable before the post-pentest '
  + 'consolidated soak. The repository variable SOAK_GATE_DISABLED is set to "true", so this '
  + 'PR\'s staging soak evidence has NOT been evaluated: no tier was computed, no evidence '
  + 'block was read, and no staging soak evidence is claimed to exist for this change. This '
  + 'check passing means only that the bypass is engaged. Clear the SOAK_GATE_DISABLED '
  + 'repository variable (`gh variable set SOAK_GATE_DISABLED --body false`) to restore '
  + 'CLAUDE.md §1.11/§1.12 enforcement in full before the consolidated soak is graded. '
  + 'This bypass stops being honored after 2026-08-16T00:00:00Z regardless of the variable.';

/**
 * `true` only while the bypass is both switched on AND inside its window.
 * Expiry is evaluated against `nowMs` so it is testable; `main()` passes the
 * real clock.
 */
function soakGateBypassEngaged(opts: Pick<CheckOptions, 'soakGateDisabled' | 'nowMs'>): boolean {
  if (opts.soakGateDisabled !== true) return false;
  return (opts.nowMs ?? Date.now()) < SOAK_GATE_BYPASS_EXPIRES_AT;
}

/** Printed when the variable is still set but the window has closed. */
const SOAK_GATE_BYPASS_EXPIRED_NOTE =
  'SOAK_GATE_DISABLED is still set to "true", but the bypass window closed at '
  + '2026-08-16T00:00:00Z — the staging soak evidence gate is enforcing normally again. '
  + 'This is the intended end of the founder directive of 2026-08-01, not a fault. Clear '
  + 'the variable (`gh variable set SOAK_GATE_DISABLED --body false`) so the repo state '
  + 'stops advertising a bypass that no longer applies. If the window genuinely needs to '
  + 'be extended, that is a reviewed one-line change to SOAK_GATE_BYPASS_EXPIRES_AT in '
  + 'scripts/ci/check-staging-evidence.ts — deliberately not something a variable alone '
  + 'can do.';

function addErrors(result: CheckResult, errors: string[]): void {
  if (errors.length === 0) return;
  result.ok = false;
  result.errors.push(...errors);
}

function tierDeclarationErrors(declared: Tier, required: { tier: Tier; reason: string }): string[] {
  if (TIER_RANK[declared] >= TIER_RANK[required.tier]) return [];
  return [
    `Declared tier ${declared} is below required tier ${required.tier} `
    + `for the touched files. Reason: ${required.reason}.`,
  ];
}

function isFrontendT2EvidencePath(declared: Tier, required: Tier, files: string[]): boolean {
  return declared === 'T2'
    && TIER_RANK[required] <= TIER_RANK.T2
    && isFrontendOnlyChange(files);
}

function isUnsoakableEvidencePath(declared: Tier, required: Tier, files: string[]): boolean {
  return declared === 'T2'
    && required === 'T2'
    && isOfflinePackageOnlyChange(files);
}

function frontendT2Result(body: string, headSha?: string): CheckResult {
  const result: CheckResult = { ok: true, errors: [], notes: [] };
  const feErrors = frontendT2Errors(body);
  // Exact-head integrity still applies: frontend evidence cannot be copied
  // across commits any more than worker evidence can.
  const headShaErrors = shaEvidenceErrors({
    body,
    field: 'PR head SHA:',
    expectedSha: headSha,
    currentLabel: 'PR head',
    staleMessage: 'frontend evidence cannot be copied across commits.',
  });

  addErrors(result, [...feErrors, ...headShaErrors]);
  if (result.ok) {
    result.notes.push(
      'frontend-T2 evidence path accepted (frontend-only change; no worker '
      + 'artifacts producible — RM-approved targeted UI evidence with async-cycle '
      + 'floor/load evidence satisfies T2).',
    );
  }
  return result;
}

function unsoakableT2Result(body: string, headSha?: string): CheckResult {
  const result: CheckResult = { ok: true, errors: [], notes: [] };
  const usErrors = unsoakableT2Errors(body);
  // Exact-head integrity still applies: test evidence cannot be copied across
  // commits any more than worker or frontend evidence can.
  const headShaErrors = shaEvidenceErrors({
    body,
    field: 'PR head SHA:',
    expectedSha: headSha,
    currentLabel: 'PR head',
    staleMessage: 'test/parity evidence cannot be copied across commits.',
  });

  addErrors(result, [...usErrors, ...headShaErrors]);
  if (result.ok) {
    result.notes.push(
      'architecturally-unsoakable evidence path accepted (offline package/SDK '
      + 'change; no worker runtime to soak — test/parity evidence + N/A staging '
      + 'tag + unsoakable-surface note satisfy T2).',
    );
  }
  return result;
}

function durationValidation(body: string, declared: Tier): { errors: string[]; notes: string[] } {
  const errors = soakDurationErrors(body, declared);
  if (errors.length === 0) return { errors: [], notes: [] };

  const targetedWaiver = targetedDurationWaiverErrors(body, declared);
  if (targetedWaiver.valid) {
    return {
      errors: [],
      notes: ['T2 soak duration below 12h minimum; RM-approved targeted evidence with async-cycle floor accepted.'],
    };
  }
  return { errors: targetedWaiver.errors.length > 0 ? targetedWaiver.errors : errors, notes: [] };
}

function standardEvidenceErrors(
  body: string,
  declared: Tier,
  opts: { headSha?: string; baseSha?: string; baseDriftFiles?: string[]; files?: string[] },
): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];

  const missing = missingFields(body, declared);
  if (missing.length > 0) {
    errors.push(
      `\`## Staging Soak Evidence\` section is missing required fields for ${declared}: `
      + missing.map((f) => `\`${f}\``).join(', ') + '.',
    );
  }

  const duration = durationValidation(body, declared);
  notes.push(...duration.notes);
  errors.push(
    ...duration.errors,
    ...requiredValueErrors(body, declared),
    ...(declared === 'T1' ? [] : changedBehaviorErrors(body)),
    ...stagingIntegrityErrors(body, declared, opts),
    ...futureTimestampErrors(body),
  );

  const preflightVal = extractEvidenceFieldValue(body, 'Preflight result:');
  const preflightIsClean = preflightVal !== null && hasCleanMirrorPreflight(preflightVal);
  if (errors.length === 0 && !preflightIsClean && hasResidualRiskException(body).valid) {
    notes.push('Preflight is not clean_mirror; residual-risk exception accepted.');
  }

  return { errors, notes };
}

const RC_MANIFEST_FIELD = 'RC manifest path:';
const RC_MANIFEST_PATH_RE = /^docs\/staging\/rc-manifests\/rc-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const RC_MANIFEST_DIR = resolve(REPO, 'docs/staging/rc-manifests');

function resolveRcManifestPath(path: string): string | null {
  if (!RC_MANIFEST_PATH_RE.test(path)) return null;
  const localPath = resolve(REPO, path);
  return localPath.startsWith(`${RC_MANIFEST_DIR}${sep}`) ? localPath : null;
}

function defaultRcManifestLoader(path: string): string | null {
  const localPath = resolveRcManifestPath(path);
  if (localPath === null || !existsSync(localPath)) return null;
  return readFileSync(localPath, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const child = value[key];
  return isRecord(child) ? child : null;
}

function arrayAt(value: Record<string, unknown>, key: string): unknown[] | null {
  const child = value[key];
  return Array.isArray(child) ? child : null;
}

function stringAt(value: Record<string, unknown>, key: string): string | null {
  const child = value[key];
  return typeof child === 'string' ? child : null;
}

function numberAt(value: Record<string, unknown>, key: string): number | null {
  const child = value[key];
  return typeof child === 'number' && Number.isFinite(child) ? child : null;
}

function stringArrayAt(value: Record<string, unknown>, key: string): string[] {
  const child = value[key];
  return Array.isArray(child) ? child.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isFilledValue(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && !isIncompletePlaceholder(trimmed) && !isNotApplicablePlaceholder(trimmed);
}

function requireRcString(
  errors: string[],
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const field = stringAt(value, key);
  if (!isFilledValue(field)) {
    errors.push(`RC manifest ${label} must be a real value, not blank or a placeholder.`);
    return null;
  }
  return field;
}

function requireRcTimestamp(
  errors: string[],
  value: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  const raw = requireRcString(errors, value, key, label);
  if (raw === null) return null;
  const parsed = parseEvidenceTimestamp(raw);
  if (parsed === null) {
    errors.push(`RC manifest ${label} could not parse as a timestamp: \`${raw}\`.`);
  }
  return parsed;
}

function rcTier(value: string | null): Tier | null {
  if (value === null) return null;
  const normalized = value.trim().toUpperCase();
  return DECLARED_TIER_VALUES.has(normalized as Tier) ? normalized as Tier : null;
}

function rcUrlErrors(value: string | null, label: string): string[] {
  if (value === null || !isFilledValue(value)) return [`RC manifest ${label} must be a real URL.`];
  return /\bhttps?:\/\/\S+/i.test(value)
    ? []
    : [`RC manifest ${label} must contain an HTTP(S) URL.`];
}

function rcSoakWindowErrors(
  startMs: number | null,
  endMs: number | null,
  tier: Tier,
  soak: Record<string, unknown>,
): string[] {
  if (startMs === null || endMs === null) return [];
  if (endMs <= startMs) return ['RC manifest soak.end must be after soak.start.'];

  const errors: string[] = [];
  const minimumHours = TIER_SPECS[tier].soakHours;
  const elapsedHours = (endMs - startMs) / 3_600_000;
  if (elapsedHours < minimumHours) {
    errors.push(
      `RC manifest soak duration (${formatHours(elapsedHours)}h) is below the ${minimumHours}h minimum for ${tier}.`,
    );
  }

  const declaredHours = numberAt(soak, 'duration_hours');
  if (declaredHours !== null && declaredHours < minimumHours) {
    errors.push(`RC manifest soak.duration_hours is below the ${minimumHours}h minimum for ${tier}.`);
  }
  return errors;
}

function rcPassingResultErrors(result: string | null): string[] {
  if (result === null || /\b(?:green|pass(?:ed|es)?|success(?:ful)?|ok|healthy)\b/i.test(result)) {
    return [];
  }
  return ['RC manifest soak.result must state a passing result.'];
}

function rcEvidenceTtlErrors(expiresAt: number | null, nowMs: number): string[] {
  if (expiresAt === null || expiresAt > nowMs) return [];
  return ['RC manifest evidence is expired; refresh the release-candidate evidence before merging.'];
}

function rcSoakDurationErrors(
  soak: Record<string, unknown>,
  tier: Tier,
  nowMs: number,
): string[] {
  const errors: string[] = [];
  const startMs = requireRcTimestamp(errors, soak, 'start', 'soak.start');
  const endMs = requireRcTimestamp(errors, soak, 'end', 'soak.end');
  errors.push(...rcSoakWindowErrors(startMs, endMs, tier, soak));

  const result = requireRcString(errors, soak, 'result', 'soak.result');
  errors.push(...rcPassingResultErrors(result));

  requireRcString(errors, soak, 'harness_version', 'soak.harness_version');
  const evidenceLinks = stringArrayAt(soak, 'evidence_links');
  if (evidenceLinks.length === 0) {
    errors.push('RC manifest soak.evidence_links must include at least one evidence link.');
  }

  const expiresAt = requireRcTimestamp(errors, soak, 'expires_at', 'soak.expires_at');
  errors.push(...rcEvidenceTtlErrors(expiresAt, nowMs));

  return errors;
}

/**
 * Base-SHA coverage, exact-enumeration first and git ancestry second.
 *
 * SCRUM-3026 follow-up (2026-08-01) — why ancestry exists at all: an RC
 * manifest is a COMMITTED file. Exact enumeration therefore requires it to
 * list a SHA that will not exist until after it is written, because every
 * merge into `main` (including the merge of the manifest refresh itself)
 * mints a new base SHA for every other open PR in the queue. With a
 * multi-PR train that is not a stale-data problem, it is a live-lock: the
 * act of curing the staleness re-creates it for everyone else.
 *
 * The invariant the enumeration was a proxy for is "the RC's soaked
 * baseline is contained in the history of the base this PR merges into" —
 * i.e. `main` only moved FORWARD from the soaked baseline. That is exactly
 * `git merge-base --is-ancestor <covered> <current-base>`, and it is
 * satisfiable without predicting the future.
 *
 * This does not loosen the gate:
 *   - `currentBaseSha` is the PR's `base.sha` resolved from the GitHub API
 *     by staging-evidence.yml, on a workflow restricted to
 *     `branches: [main, staging, develop]`. It is a protected-branch commit,
 *     never a PR-author-controlled ref.
 *   - A base that does NOT contain the soaked baseline (divergent line, or
 *     a commit older than the RC launch) still fails, exactly as before.
 *   - An unresolvable ancestry answer (`null` — shallow clone, missing
 *     object, git unavailable) fails CLOSED to exact-enumeration behavior.
 */
function shaCoveredByListOrAncestry(
  candidate: string,
  covered: string[],
  ancestry?: AncestryProvider,
): boolean {
  if (covered.includes(candidate)) return true;
  if (!ancestry) return false;
  return covered.some((sha) => ancestry(sha, candidate) === true);
}

function rcCurrentBaseCovered(
  manifest: Record<string, unknown>,
  currentBaseSha?: string,
  ancestry?: AncestryProvider,
): boolean {
  const current = normalizeSha(currentBaseSha);
  if (current === null) return true;

  const allowed = [
    stringAt(manifest, 'train_launch_sha'),
    stringAt(manifest, 'target_main_sha'),
    ...stringArrayAt(manifest, 'allowed_base_shas'),
    ...stringArrayAt(manifest, 'covered_main_shas'),
  ].map((value) => normalizeSha(value ?? undefined)).filter((value): value is string => value !== null);

  return shaCoveredByListOrAncestry(current, allowed, ancestry);
}

function rcPrBaseCovered(
  manifest: Record<string, unknown>,
  pr: Record<string, unknown>,
  currentBaseSha?: string,
  ancestry?: AncestryProvider,
): boolean {
  const prBase = normalizeSha(stringAt(pr, 'base_sha') ?? undefined);
  if (prBase === null) return false;

  const allowed = [
    currentBaseSha,
    stringAt(manifest, 'train_launch_sha'),
    stringAt(manifest, 'target_main_sha'),
    ...stringArrayAt(pr, 'allowed_base_shas'),
  ].map((value) => normalizeSha(value ?? undefined)).filter((value): value is string => value !== null);

  if (allowed.includes(prBase)) return true;

  // The entry recorded the main tip it was soaked against; `main` has since
  // moved on. Forward-only drift is covered; a divergent recorded base is not.
  const current = normalizeSha(currentBaseSha);
  if (current === null || !ancestry) return false;
  return ancestry(prBase, current) === true;
}

// ─────────────────────────────────────────────────────────────────────────
// head_binding: how an included_prs[] entry is bound to the artifact
// ─────────────────────────────────────────────────────────────────────────
//
// DEFAULT — and the only mode that reads as "this evidence covers this
// code" — is `exact`: the entry's `head_sha` must equal the live PR head.
// That is the whole point of the RC manifest when it asserts SOAK COVERAGE,
// and `memory/feedback_pr_head_sha_in_evidence_block.md` exists because it
// was once possible to slip a new commit past completed evidence. Absent
// `head_binding`, nothing about that changes.
//
// `roster` mode covers the case where the manifest is NOT asserting soak
// coverage of this head — where the recorded merge authority is an explicit,
// named, time-boxed human exception (CLAUDE.md §1.12 "Carson-approved
// residual-risk exception") and the real soak is scheduled AFTER the merge.
// In that situation exact-head binding proves nothing about safety (there is
// no artifact-bound evidence to protect) while costing a manifest re-commit
// per push — the same live-lock as the base problem. So roster mode swaps
// artifact binding for something that IS meaningful and is not forgeable by
// the PR author acting alone:
//   - the exception lives in the MANIFEST (its own PR, its own review),
//   - it names a human `approver`,
//   - it carries an `expires_at` that is enforced, so the relaxation cannot
//     silently become permanent,
//   - it must list this PR number in `applies_to[]`, so it cannot be a
//     blanket amnesty, and
//   - the check summary always says plainly that merge authority here is a
//     RECORDED HUMAN EXCEPTION, not soak coverage.
// Everything else — approval_status, tier floor, environment, soak window,
// soak freshness, migration_plan — is enforced unchanged.
const HEAD_BINDING_EXACT = 'exact';
const HEAD_BINDING_ROSTER = 'roster';

interface HeadBindingPolicy {
  mode: typeof HEAD_BINDING_EXACT | typeof HEAD_BINDING_ROSTER;
  exceptionId: string | null;
}

const EXACT_HEAD_BINDING: HeadBindingPolicy = { mode: HEAD_BINDING_EXACT, exceptionId: null };

function resolveHeadBindingPolicy(
  manifest: Record<string, unknown>,
  errors: string[],
): HeadBindingPolicy {
  const binding = objectAt(manifest, 'head_binding');
  if (binding === null) return EXACT_HEAD_BINDING;

  const raw = stringAt(binding, 'mode');
  const mode = (raw ?? '').trim().toLowerCase();
  if (mode === HEAD_BINDING_EXACT) return EXACT_HEAD_BINDING;
  if (mode === HEAD_BINDING_ROSTER) {
    return { mode: HEAD_BINDING_ROSTER, exceptionId: stringAt(binding, 'exception_id') };
  }
  errors.push(
    `RC manifest head_binding.mode \`${raw ?? ''}\` is not a recognized value. Supported: `
    + `"${HEAD_BINDING_EXACT}" (default — the entry's head_sha must equal the live PR head) or `
    + `"${HEAD_BINDING_ROSTER}" (entry matched by PR number; merge authority is a named, `
    + 'time-boxed exceptions[] entry rather than soak coverage of this head). Omit '
    + 'head_binding entirely for exact binding.',
  );
  return EXACT_HEAD_BINDING;
}

function numberArrayAt(value: Record<string, unknown>, key: string): number[] {
  const raw = arrayAt(value, key);
  if (raw === null) return [];
  return raw
    .map((entry) => (typeof entry === 'number' ? entry : Number.parseInt(String(entry), 10)))
    .filter((entry) => Number.isFinite(entry));
}

function findManifestException(
  manifest: Record<string, unknown>,
  exceptionId: string,
): Record<string, unknown> | null {
  const wanted = exceptionId.trim();
  for (const entry of arrayAt(manifest, 'exceptions') ?? []) {
    if (!isRecord(entry)) continue;
    if ((stringAt(entry, 'id') ?? '').trim() === wanted) return entry;
  }
  return null;
}

function rosterHeadBindingErrors(
  manifest: Record<string, unknown>,
  policy: HeadBindingPolicy,
  entryHead: string | null,
  currentHead: string,
  opts: CheckOptions,
  notes: string[],
): string[] {
  const errors: string[] = [];
  const exceptionId = policy.exceptionId;
  if (!isFilledValue(exceptionId)) {
    return [
      'RC manifest head_binding.mode="roster" requires head_binding.exception_id naming an '
      + 'entry in exceptions[]. Roster mode is only valid as the mechanical expression of a '
      + 'recorded, named, time-boxed merge-authority exception.',
    ];
  }

  const exception = findManifestException(manifest, exceptionId!);
  if (exception === null) {
    return [
      `RC manifest head_binding.exception_id \`${exceptionId}\` matches no exceptions[] entry `
      + '(compared against exceptions[].id).',
    ];
  }

  const label = `exceptions[${exceptionId}]`;
  const approver = requireRcString(errors, exception, 'approver', `${label}.approver`);
  requireRcString(errors, exception, 'text', `${label}.text`);
  requireRcTimestamp(errors, exception, 'recorded_at', `${label}.recorded_at`);
  const expiresAt = requireRcTimestamp(errors, exception, 'expires_at', `${label}.expires_at`);

  const nowMs = opts.nowMs ?? Date.now();
  if (expiresAt !== null && expiresAt <= nowMs) {
    errors.push(
      `RC manifest ${label}.expires_at has expired; a merge-authority exception cannot be `
      + 'renewed by the passage of time. Re-record it with a new expiry, or produce real soak '
      + 'evidence and return this manifest to exact head binding.',
    );
  }

  const appliesTo = numberArrayAt(exception, 'applies_to');
  if (appliesTo.length === 0) {
    errors.push(
      `RC manifest ${label}.applies_to must list the PR numbers the exception covers — a `
      + 'blanket exception is not accepted.',
    );
  } else if (opts.prNumber === undefined || !appliesTo.includes(opts.prNumber)) {
    errors.push(
      `RC manifest ${label}.applies_to does not list PR #${opts.prNumber ?? 'unknown'}; roster `
      + 'head binding only applies to the PRs the exception names.',
    );
  }

  if (errors.length > 0) return errors;

  notes.push(
    `⚠️  RECORDED HUMAN EXCEPTION (${exceptionId}): the RC manifest entry records head `
    + `\`${entryHead ?? 'missing'}\` but this PR's live head is \`${currentHead}\`. Merge `
    + `authority for this head is NOT soak coverage — it is the exception recorded in the `
    + `manifest, approved by ${approver}, expiring ${stringAt(exception, 'expires_at')}. Real `
    + 'evidence for this head is still owed by the scheduled consolidated soak.',
  );
  return [];
}

function findCoveredRcPr(
  includedPrs: unknown[],
  opts: { headSha?: string; prNumber?: number },
): Record<string, unknown> | null {
  const normalizedHead = normalizeSha(opts.headSha);
  for (const entry of includedPrs) {
    if (!isRecord(entry)) continue;
    const number = numberAt(entry, 'number');
    const head = normalizeSha(stringAt(entry, 'head_sha') ?? undefined);
    if (opts.prNumber !== undefined && number === opts.prNumber) return entry;
    if (normalizedHead !== null && head === normalizedHead) return entry;
  }
  return null;
}

function parseRcManifest(path: string, raw: string, errors: string[]): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    errors.push(`RC manifest \`${path}\` is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`);
    return null;
  }

  if (!isRecord(parsed)) {
    errors.push(`RC manifest \`${path}\` must be a JSON object.`);
    return null;
  }
  return parsed;
}

/**
 * Fields common to BOTH the normal (approved) and deferred-consolidated-soak
 * RC-manifest evidence paths: schema version, core identity/provenance
 * fields, and current-base coverage. Approval semantics differ between the
 * two paths (approved vs the literal "pending") and are validated
 * separately by each caller — this helper deliberately does not touch
 * `approval_status`/`approval_actor`/`approval_time`.
 */
function requireRcCoreIdentityFields(
  manifest: Record<string, unknown>,
  opts: CheckOptions,
  errors: string[],
): void {
  const schemaVersion = numberAt(manifest, 'schema_version');
  if (schemaVersion !== 1) {
    errors.push('RC manifest schema_version must be 1.');
  }

  requireRcString(errors, manifest, 'rc_id', 'rc_id');
  requireRcTimestamp(errors, manifest, 'created_at', 'created_at');
  requireRcString(errors, manifest, 'created_by', 'created_by');
  requireRcString(errors, manifest, 'release_owner', 'release_owner');
  requireRcString(errors, manifest, 'train_launch_sha', 'train_launch_sha');

  if (!rcCurrentBaseCovered(manifest, opts.baseSha, opts.ancestryProvider)) {
    errors.push(
      'RC manifest does not cover the current base SHA; update the manifest or re-check main '
      + 'drift. (The base is covered when it is listed in train_launch_sha / target_main_sha / '
      + 'allowed_base_shas / covered_main_shas, OR when git ancestry shows it descends from one '
      + 'of those — an unresolvable ancestry answer fails closed to the listed set.)',
    );
  }
}

function validateRcManifestMetadata(
  manifest: Record<string, unknown>,
  opts: CheckOptions,
  errors: string[],
): void {
  requireRcCoreIdentityFields(manifest, opts, errors);

  const approvalStatus = requireRcString(errors, manifest, 'approval_status', 'approval_status');
  if (approvalStatus !== null && approvalStatus.trim().toLowerCase() !== 'approved') {
    errors.push('RC manifest approval_status must be approved.');
  }
  requireRcString(errors, manifest, 'approval_actor', 'approval_actor');
  requireRcTimestamp(errors, manifest, 'approval_time', 'approval_time');
}

function validateCoveredRcPr(
  manifest: Record<string, unknown>,
  includedPrs: unknown[],
  declared: Tier,
  required: { tier: Tier; reason: string },
  files: string[],
  opts: CheckOptions,
  errors: string[],
  notes: string[],
): Record<string, unknown> | null {
  if (includedPrs.length === 0) {
    errors.push('RC manifest included_prs must list at least one PR.');
  }

  // Resolved unconditionally so an unrecognized mode fails closed even on a
  // manifest whose recorded head happens to still match.
  const headBinding = resolveHeadBindingPolicy(manifest, errors);

  const coveredPr = findCoveredRcPr(includedPrs, opts);
  if (coveredPr === null) {
    errors.push('RC manifest does not include the current PR head SHA.');
    return null;
  }

  const entryHead = normalizeSha(stringAt(coveredPr, 'head_sha') ?? undefined);
  const currentHead = normalizeSha(opts.headSha);
  if (currentHead !== null && entryHead !== currentHead) {
    if (headBinding.mode === HEAD_BINDING_ROSTER) {
      errors.push(
        ...rosterHeadBindingErrors(manifest, headBinding, entryHead, currentHead, opts, notes),
      );
    } else {
      errors.push(`RC manifest current PR entry head SHA \`${entryHead ?? 'missing'}\` does not match current PR head \`${currentHead}\`.`);
    }
  }
  if (!rcPrBaseCovered(manifest, coveredPr, opts.baseSha, opts.ancestryProvider)) {
    errors.push('RC manifest current PR entry base SHA does not match the current base, train launch SHA, target main SHA, an allowed base SHA, or an ancestor of the current base.');
  }

  const manifestTier = rcTier(stringAt(coveredPr, 'risk_tier'));
  if (manifestTier === null) {
    errors.push('RC manifest current PR entry risk_tier must be T1, T2, or T3.');
  } else {
    if (TIER_RANK[manifestTier] < TIER_RANK[required.tier]) {
      errors.push(`RC manifest risk_tier ${manifestTier} is below required tier ${required.tier} for this PR. Reason: ${required.reason}.`);
    }
    if (TIER_RANK[manifestTier] < TIER_RANK[declared]) {
      errors.push(`RC manifest risk_tier ${manifestTier} is below declared tier ${declared}.`);
    }
  }
  requireRcString(errors, coveredPr, 'owner', 'included_prs[].owner');
  requireRcString(errors, coveredPr, 'ci_summary', 'included_prs[].ci_summary');
  requireRcString(errors, coveredPr, 'rollback_note', 'included_prs[].rollback_note');
  if (files.some(touchesMigrationFile) && stringArrayAt(coveredPr, 'migration_files').length === 0) {
    errors.push('RC manifest included_prs[].migration_files must list migration files for a migration-bearing PR.');
  }
  return coveredPr;
}

function validateRcEnvironment(manifest: Record<string, unknown>, errors: string[]): void {
  const environment = objectAt(manifest, 'environment');
  if (environment === null) {
    errors.push('RC manifest environment must be an object.');
    return;
  }

  const scope = normalizeEvidenceScope(stringAt(environment, 'evidence_scope') ?? '');
  if (!ALLOWED_EVIDENCE_SCOPES.has(scope)) {
    errors.push('RC manifest environment.evidence_scope must be merge-grade shared staging or merge-grade isolated staging.');
  }

  const stagingApiBase = stringAt(environment, 'staging_api_base');
  errors.push(...rcUrlErrors(stagingApiBase, 'environment.staging_api_base'));
  if (stagingApiBase !== null && /https?:\/\/arkova-worker-staging[-.]/i.test(stagingApiBase)) {
    errors.push('RC manifest environment.staging_api_base must not point at the main shared staging URL; use a PR tag URL or isolated service URL.');
  }
  errors.push(...rcUrlErrors(stringAt(environment, 'staging_url'), 'environment.staging_url'));
  requireRcString(errors, environment, 'revision', 'environment.revision');
  requireRcString(errors, environment, 'deploy_tag', 'environment.deploy_tag');
  requireRcString(errors, environment, 'image_digest', 'environment.image_digest');
  requireRcString(errors, environment, 'supabase_project_ref', 'environment.supabase_project_ref');
  requireRcString(errors, environment, 'deploy_log_id', 'environment.deploy_log_id');

  const preflight = requireRcString(errors, environment, 'preflight_result', 'environment.preflight_result');
  if (preflight !== null && !hasCleanMirrorPreflight(preflight)) {
    errors.push('RC manifest environment.preflight_result must capture `environment_type=clean_mirror`.');
  }
}

function rcEffectiveTier(coveredPr: Record<string, unknown> | null, declared: Tier): Tier {
  return coveredPr === null ? declared : rcTier(stringAt(coveredPr, 'risk_tier')) ?? declared;
}

function validateRcSoak(
  manifest: Record<string, unknown>,
  effectiveTier: Tier,
  opts: CheckOptions,
  errors: string[],
): void {
  const soak = objectAt(manifest, 'soak');
  if (soak === null) {
    errors.push('RC manifest soak must be an object.');
    return;
  }
  errors.push(...rcSoakDurationErrors(soak, effectiveTier, opts.nowMs ?? Date.now()));
}

function touchesMigrationFile(file: string): boolean {
  return file.startsWith('supabase/migrations/');
}

function validateRcMigrationPlan(
  manifest: Record<string, unknown>,
  effectiveTier: Tier,
  files: string[],
  errors: string[],
): void {
  if (!files.some(touchesMigrationFile) && effectiveTier !== 'T3') return;

  const migrationPlan = objectAt(manifest, 'migration_plan');
  if (migrationPlan === null) {
    errors.push('RC manifest migration_plan is required for T3 or migration-bearing PRs.');
    return;
  }
  if (stringArrayAt(migrationPlan, 'order').length === 0) {
    errors.push('RC manifest migration_plan.order must list migration train order.');
  }
  requireRcString(errors, migrationPlan, 'rollback_proof', 'migration_plan.rollback_proof');
  requireRcString(errors, migrationPlan, 'reapply_proof', 'migration_plan.reapply_proof');
}

// ─────────────────────────────────────────────────────────────────────────
// Deferred-consolidated-soak mode (CTO ruling 2026-07-28, SCRUM-2980)
// ─────────────────────────────────────────────────────────────────────────
//
// The 2026-08 launch wave deliberately merges T2/T3 worker + migration PRs
// BEFORE their 72h consolidated soak matures (docs/release/
// wave-merge-choreography-2026-08.md), then soaks the INTEGRATED head on
// main, then un-pauses a single deploy. That sequencing is only sound
// because deploy-worker.yml's `deploy-gate` job (vars.DEPLOY_WORKER_PAUSED)
// makes "merge" and "reach prod" two separable events — see
// .github/workflows/agents.md "Deploy-worker pause gate" for the deploy
// side of this control.
//
// This block is the merge-gate side of the same trade: it lets a PR pass
// the Staging Soak Evidence Gate WITHOUT real soak evidence, ONLY when BOTH
// of the following are true, and it is designed so NEITHER can be forged by
// a PR author acting alone:
//   1. The PR is explicitly listed in `included_prs[]` of an RC manifest
//      JSON file (its own PR, its own review) whose top-level `soak_mode`
//      field is the exact literal "deferred_consolidated_soak" — never a
//      label, never a PR-body string, never anything the PR under test
//      controls by itself.
//   2. `vars.DEPLOY_WORKER_PAUSED` is POSITIVELY confirmed engaged for the
//      CURRENT run (opts.deployWorkerPaused === true, threaded from the
//      live `vars` context by staging-evidence.yml — see {@link
//      CheckOptions.deployWorkerPaused}). Missing/false/anything else is
//      "not confirmed" and fails closed — this function never assumes
//      paused-by-default.
//
// The check summary MUST always say plainly that evidence is DEFERRED and
// NOT satisfied when this path is taken — a passing check here is never
// allowed to read as "evidence present." See the ⚠️ note emitted below.
const DEFERRED_CONSOLIDATED_SOAK_MODE = 'deferred_consolidated_soak';

function isDeferredConsolidatedSoakManifest(manifest: Record<string, unknown>): boolean {
  return stringAt(manifest, 'soak_mode') === DEFERRED_CONSOLIDATED_SOAK_MODE;
}

/**
 * Metadata checks for deferred mode. Deliberately narrower than {@link
 * validateRcManifestMetadata}: it does NOT require `approval_actor` /
 * `approval_time` (legitimately blank while pending) and it inverts the
 * approval_status assertion — deferred mode requires the literal "pending",
 * never "approved" (that combination is a contradiction: "approved" claims
 * real evidence exists, which deferred mode by definition does not have).
 */
function deferredConsolidatedSoakMetadataErrors(
  manifest: Record<string, unknown>,
  opts: CheckOptions,
  errors: string[],
): void {
  requireRcCoreIdentityFields(manifest, opts, errors);

  // Deliberately NOT requireRcString() here: "pending" is a legitimate,
  // REQUIRED exact value in deferred mode, but requireRcString()/isFilledValue()
  // treat the bare word "pending" as an incomplete-placeholder value (it's in
  // INCOMPLETE_VALUE_PATTERNS, for the unrelated "someone forgot to fill this
  // in" case elsewhere in this file) and would reject it before the actual
  // comparison below ever ran.
  const approvalStatusRaw = stringAt(manifest, 'approval_status');
  if (approvalStatusRaw === null || approvalStatusRaw.trim().toLowerCase() !== 'pending') {
    errors.push(
      'RC manifest declares soak_mode="deferred_consolidated_soak" but approval_status is not '
      + 'the literal string "pending". Deferred mode is, by definition, evidence that has not yet '
      + 'been produced — "approved" while deferred is active is a contradiction the gate rejects. '
      + 'Once the real soak completes: remove soak_mode, fill in real environment/soak/'
      + 'migration_plan evidence, THEN flip approval_status to "approved" through the normal '
      + '(non-deferred) path.',
    );
  }
}

/** The hard precondition: fails closed unless positively confirmed. */
function deferredConsolidatedSoakDeployGateErrors(opts: CheckOptions): string[] {
  if (opts.deployWorkerPaused === true) return [];
  return [
    'RC manifest declares soak_mode="deferred_consolidated_soak", but this run could not '
    + 'positively confirm the deploy-worker.yml deploy gate (vars.DEPLOY_WORKER_PAUSED) is '
    + 'engaged. Deferred-consolidated-soak evidence is coupled to the deploy pause BY DESIGN — '
    + 'merging without real soak evidence is only safe when the merge cannot also trigger a prod '
    + 'deploy. Set the DEPLOY_WORKER_PAUSED repository variable to the literal string "true" '
    + 'before this mode can activate, or provide real staging soak evidence instead.',
  ];
}

function deferredConsolidatedSoakCoverage(
  declared: Tier,
  required: { tier: Tier; reason: string },
  files: string[],
  opts: CheckOptions,
  parsed: Record<string, unknown>,
  path: string,
): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];

  // Hard precondition FIRST — fail closed before evaluating anything else
  // in the manifest if the deploy gate cannot be positively confirmed.
  errors.push(...deferredConsolidatedSoakDeployGateErrors(opts));
  if (errors.length > 0) return { errors, notes };

  deferredConsolidatedSoakMetadataErrors(parsed, opts, errors);

  const includedPrs = arrayAt(parsed, 'included_prs') ?? [];
  const coveredPr = validateCoveredRcPr(parsed, includedPrs, declared, required, files, opts, errors, notes);
  if (coveredPr === null) return { errors, notes };

  if (errors.length === 0) {
    const rcId = stringAt(parsed, 'rc_id') ?? path;
    notes.push(
      `⚠️  DEFERRED-CONSOLIDATED-SOAK MODE (${rcId}): staging soak evidence is DEFERRED and is `
      + 'NOT satisfied for this PR. This check passes ONLY because (a) the PR is explicitly '
      + 'listed in a repo-reviewed RC manifest with soak_mode="deferred_consolidated_soak", and '
      + '(b) vars.DEPLOY_WORKER_PAUSED was positively confirmed engaged on this run, so merging '
      + 'this PR cannot trigger a prod deploy. Real evidence is still owed: the 72h consolidated '
      + 'soak runs against the integrated head AFTER this wave merges, per '
      + 'docs/release/72h-soak-runbook-2026-08.md. approval_status on the manifest remains '
      + '"pending" until that soak completes and the manifest returns to the normal '
      + '(non-deferred) evidence path.',
    );
  }
  return { errors, notes };
}

function rcManifestCoverage(
  body: string,
  declared: Tier,
  required: { tier: Tier; reason: string },
  files: string[],
  opts: CheckOptions,
): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  const path = extractEvidenceFieldValue(body, RC_MANIFEST_FIELD);
  if (path === null) return { errors, notes };

  if (!hasEvidenceSection(body)) {
    errors.push('RC manifest coverage must be declared under a `## Staging Soak Evidence` section.');
  }

  if (resolveRcManifestPath(path) === null) {
    errors.push(
      'RC manifest path must be a local JSON file under `docs/staging/rc-manifests/rc-*.json`; arbitrary URLs or paths are not allowed.',
    );
    return { errors, notes };
  }

  const raw = (opts.rcManifestLoader ?? defaultRcManifestLoader)(path);
  if (!raw) {
    errors.push(`RC manifest \`${path}\` was not found in the checked-out PR tree.`);
    return { errors, notes };
  }

  const parsed = parseRcManifest(path, raw, errors);
  if (parsed === null) return { errors, notes };

  const soakModeRaw = stringAt(parsed, 'soak_mode');
  if (soakModeRaw !== null && soakModeRaw !== DEFERRED_CONSOLIDATED_SOAK_MODE) {
    errors.push(
      `RC manifest soak_mode "${soakModeRaw}" is not a recognized value. The only supported `
      + `value is "${DEFERRED_CONSOLIDATED_SOAK_MODE}"; omit the field entirely to use the `
      + 'normal (non-deferred) evidence path.',
    );
    return { errors, notes };
  }
  if (isDeferredConsolidatedSoakManifest(parsed)) {
    return deferredConsolidatedSoakCoverage(declared, required, files, opts, parsed, path);
  }

  validateRcManifestMetadata(parsed, opts, errors);
  const includedPrs = arrayAt(parsed, 'included_prs') ?? [];
  const coveredPr = validateCoveredRcPr(parsed, includedPrs, declared, required, files, opts, errors, notes);
  const effectiveTier = rcEffectiveTier(coveredPr, declared);
  validateRcEnvironment(parsed, errors);
  validateRcSoak(parsed, effectiveTier, opts, errors);
  validateRcMigrationPlan(parsed, effectiveTier, files, errors);

  if (errors.length === 0) {
    const rcId = stringAt(parsed, 'rc_id') ?? path;
    notes.push(`RC manifest coverage accepted for ${rcId}; long soak evidence is centralized at the release-candidate level.`);
  }
  return { errors, notes };
}

export function check(opts: CheckOptions): CheckResult {
  const { body, files } = opts;
  const result: CheckResult = { ok: true, errors: [], notes: [] };

  // TEMPORARY BYPASS (founder directive 2026-08-01) — must be the first thing
  // this function does. It short-circuits ahead of tier classification so the
  // banner below is the ONLY reason a bypassed run passes; letting T0 (or any
  // other path) answer first would hide that the gate was suspended.
  // See CheckOptions.soakGateDisabled.
  if (soakGateBypassEngaged(opts)) {
    result.notes.push(SOAK_GATE_BYPASS_NOTE);
    return result;
  }
  if (opts.soakGateDisabled === true) {
    // Set but expired: fall through into the full gate, and say why so the
    // sudden return of red checks is self-explaining rather than a mystery.
    result.notes.push(SOAK_GATE_BYPASS_EXPIRED_NOTE);
  }

  const required = requiredTierFor(files, {
    diffProvider: opts.diffProvider,
    s33Lane1ImportScan: opts.s33Lane1ImportScan,
  });
  if (required.tier === 'T0') {
    result.notes.push(`T0 CI-only PR (${required.reason}) — no staging soak evidence required.`);
    return result;
  }

  const declared = extractDeclaredTier(body);
  if (!declared) {
    // Accumulate onto `result` rather than returning a fresh object: notes
    // pushed before this point (e.g. the expired-bypass explanation) are the
    // context that makes this failure legible, and a literal `notes: []`
    // silently threw them away.
    addErrors(result, [
      `PR body is missing a tier declaration. Add a line \`Tier: ${required.tier}\` under a `
      + `\`## Staging Soak Evidence\` section. Required tier: ${required.tier} (${required.reason}).`,
    ]);
    return result;
  }

  addErrors(result, tierDeclarationErrors(declared, required));

  const rcManifestPath = extractEvidenceFieldValue(body, RC_MANIFEST_FIELD);
  if (rcManifestPath !== null) {
    const rc = rcManifestCoverage(body, declared, required, files, opts);
    addErrors(result, rc.errors);
    result.notes.push(...rc.notes);
    return result;
  }

  // ── Frontend-T2 evidence path (decision (a)) ──
  // Activates ONLY when the PR is T2 by requirement AND declaration AND every
  // changed file is purely frontend. Tier classification is unchanged; this
  // only swaps which evidence T2 accepts for that narrow case.
  if (isFrontendT2EvidencePath(declared, required.tier, files)) {
    const frontendResult = frontendT2Result(body, opts.headSha);
    addErrors(result, frontendResult.errors);
    result.notes.push(...frontendResult.notes);
    return result;
  }

  // ── Architecturally-unsoakable evidence path ──
  // Activates ONLY when the PR is T2 by requirement AND declaration AND every
  // changed file is an offline package/SDK path (no worker runtime to soak).
  // Tier classification is unchanged; this only swaps which evidence T2 accepts
  // for a surface that CANNOT be soaked. Unblocks #1411 (verifier-cli + arkova-py).
  if (isUnsoakableEvidencePath(declared, required.tier, files)) {
    const unsoakableResult = unsoakableT2Result(body, opts.headSha);
    addErrors(result, unsoakableResult.errors);
    result.notes.push(...unsoakableResult.notes);
    return result;
  }

  if (!hasEvidenceSection(body)) {
    addErrors(result, [
      'PR body is missing a `## Staging Soak Evidence` section. '
      + 'Use docs/staging/PR_TEMPLATE.md as a starting point.',
    ]);
    return result;
  }

  const standard = standardEvidenceErrors(body, declared, opts);
  addErrors(result, standard.errors);
  result.notes.push(...standard.notes);
  return result;
}

function main(): void {
  // TEMPORARY BYPASS (founder directive 2026-08-01) — checked before ANY
  // repo/git resolution, so an unrelated base-ref or head-ref resolution
  // failure cannot red a run that is supposed to be bypassed. Emitted as a
  // `::warning::` as well as stdout so it surfaces in the Actions annotation
  // panel, not just the folded log. See CheckOptions.soakGateDisabled.
  const soakGateDisabled = process.env.SOAK_GATE_DISABLED === 'true';
  if (soakGateBypassEngaged({ soakGateDisabled })) {
    console.log(`ℹ️  ${SOAK_GATE_BYPASS_NOTE}`);
    console.error(`::warning title=Staging soak evidence gate BYPASSED::${SOAK_GATE_BYPASS_NOTE}`);
    return;
  }
  if (soakGateDisabled) {
    console.error(`::warning title=Soak-gate bypass window has closed::${SOAK_GATE_BYPASS_EXPIRED_NOTE}`);
  }

  // Required base: fail closed if it can't resolve (getBaseRef exits 1).
  const baseRef = getBaseRef({ required: true })!;
  const files = changedFiles();
  const currentHeadSha = resolveCommitOrFail(
    process.env.HEAD_REF_SHA || process.env.GITHUB_SHA || 'HEAD',
    'CI head ref',
  );
  const parsedPrNumber = Number.parseInt(process.env.PR_NUMBER ?? '', 10);
  const prNumber = Number.isFinite(parsedPrNumber) ? parsedPrNumber : undefined;
  const result = check({
    body: prBody,
    files,
    headSha: currentHeadSha,
    baseSha: baseRef,
    prNumber,
    diffProvider: gitFileDiffProvider(baseRef),
    ancestryProvider: gitAncestryProvider(),
    s33Lane1ImportScan: gitS33Lane1ImportScan(),
    // Live-threaded from `vars.DEPLOY_WORKER_PAUSED` by
    // .github/workflows/staging-evidence.yml — see CheckOptions.deployWorkerPaused
    // for why this must be a literal 'true' string match, not truthiness.
    deployWorkerPaused: process.env.DEPLOY_WORKER_PAUSED === 'true',
    // Always false here — the engaged case returned above. Passed anyway so
    // the CLI and the library agree on the contract.
    soakGateDisabled,
  });

  for (const note of result.notes) console.log(`ℹ️  ${note}`);
  if (result.ok) {
    console.log('✅ Staging soak evidence gate passed.');
    return;
  }
  for (const err of result.errors) console.error(`::error::${err}`);
  console.error('');
  console.error('See CLAUDE.md §1.11 (universal staging) and §1.12 (soak tier matrix) for context.');
  console.error(`See ${resolve(REPO, 'docs/staging/README.md')} for the rig + workflow.`);
  process.exit(1);
}

const isDirectInvocation = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  const invokedPath = resolve(process.argv[1]);
  const modulePath = resolve(new URL(import.meta.url).pathname);
  return invokedPath === modulePath;
})();

if (isDirectInvocation) {
  if (!existsSync(REPO)) {
    console.error(`::error::REPO root ${REPO} does not exist.`);
    process.exit(1);
  }
  main();
}
