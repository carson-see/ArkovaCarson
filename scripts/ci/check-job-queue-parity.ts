#!/usr/bin/env tsx
/**
 * job_queue producer/consumer parity guard.
 *
 * WHY THIS EXISTS
 *
 * The worker has NO central job dispatcher. A `job_queue` type is handled if
 * and only if some file happens to call `claimJob` / `processNextJob` with
 * that same literal string. Nothing connects the two ends — not a registry,
 * not a type, not a route table. So enqueuing a type nobody drains is not a
 * loud error, it is *silence*: the row inserts as `pending, attempts:0` and is
 * never claimed, never retried, never dead-lettered, and never counted as a
 * failure anywhere. It looks exactly like a queue that is simply empty.
 *
 * That class shipped twice, and both instances were billing defects:
 *
 *   anchor.fast_track          A credit was DEBITED, then this job was
 *   (rule-action-dispatcher)   enqueued as the entire "acceleration" the
 *                              credit bought. With no consumer, the document
 *                              was anchored by the ordinary nightly batch —
 *                              i.e. exactly what the FREE path gets. The
 *                              customer paid for nothing, while the shipped
 *                              `law-firm-contract` rule template promised
 *                              "Instantly secure ... as soon as all parties
 *                              complete e-signature."
 *
 *   ai_credits.reconcile_refund  Enqueued when an AI-credit refund failed
 *   (api/v1/ai-extract-batch)    AFTER a successful debit, specifically so the
 *                                overcharge would be "surfaced, not dropped"
 *                                (its own agents.md contract). With no
 *                                consumer it was dropped, silently, forever.
 *
 * Both were found by reading code, not by any test, alert, dashboard, or
 * gate — which is the argument for this file. A census finds the instances; a
 * detector finds the class.
 *
 * WHAT IT ENFORCES
 *
 *   1. Every job type passed to `submitJob({ type })` has at least one
 *      `claimJob` / `processNextJob` consumer.
 *   2. Every consumed type has at least one producer (a drain wired to
 *      nothing is dead code that reads as coverage).
 *   3. Every type expression on both sides resolves to a string literal.
 *      An unresolvable expression FAILS — a guard that cannot see the type
 *      cannot certify it.
 *   4. Nothing outside the queue-internals modules touches the `job_queue`
 *      table directly. `submitJob` is the only enqueue API; a raw
 *      `.from('job_queue').insert(...)` elsewhere would route around checks
 *      1-3 entirely and reintroduce the whole class.
 *
 * SCOPE BOUNDARY (deliberate, not an oversight): run leases
 * (`jobs/run-lease.ts`) and resumable checkpoints
 * (`jobs/proofJobCheckpoint.ts`) also store rows in `job_queue`, but they are
 * NOT queued work — they are read back by their own owner through direct
 * selects, never through `claim_next_job`, and they never go through
 * `submitJob`. They are allow-listed by path (rule 4) rather than special-
 * cased by type name, so adding a new lease/checkpoint owner is an explicit,
 * reviewable edit to this file.
 *
 * KNOWN LIMITATIONS (documented rather than silently wrong):
 *   - "Has a consumer" is not "is drained in production". A consumer still
 *     needs a Cloud Scheduler binding in scripts/gcp-setup/cloud-scheduler.sh
 *     (in-process node-cron is dormant under Cloud Run CPU throttling, per the
 *     PROOF-03 finding). `professional_education.metadata_extraction` and
 *     `docusign.notarization_completed` currently have cron ROUTES but no
 *     scheduler entry. Closing that needs a live-GCP read, which this static
 *     check cannot do; it is a separate gate, not a reason to weaken this one.
 *   - Constant resolution is by NAME across the worker tree, not by module
 *     resolution. Two different modules exporting the same const name with
 *     different values makes that name ambiguous, and an ambiguous name fails
 *     closed (rule 3) rather than resolving to an arbitrary one.
 *   - Only string-literal-initialized constants resolve. A computed or
 *     re-assigned job type fails closed by design.
 *
 * Usage: tsx scripts/ci/check-job-queue-parity.ts
 * Exit 0 = every produced type has a consumer. Exit 1 = orphan (or the check
 * could not verify).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

import { REPO, isMainModule } from './lib/ciContext.js';

/** Worker source root, repo-relative, POSIX separators. */
export const WORKER_SRC = 'services/worker/src';

/**
 * Modules that ARE the queue plumbing. Excluded from every rule: they legally
 * call claimJob with a parameter (jobQueue.ts defines it) and legally write
 * `job_queue` rows that are not queued work (leases, checkpoints).
 */
export const QUEUE_INTERNALS_ALLOWLIST: readonly string[] = [
  // The queue implementation itself — submitJob/claimJob/failJob/completeJob.
  'services/worker/src/utils/jobQueue.ts',
  // Cross-instance run leases (SCALE-3 / SCRUM-3031). Lease rows are claimed
  // by CAS on the row, never by claim_next_job.
  'services/worker/src/jobs/run-lease.ts',
  // Resumable proof-job checkpoints. Read back by their owning job's scope
  // key, never drained as work.
  'services/worker/src/jobs/proofJobCheckpoint.ts',
];

const PRODUCER_FNS = new Set(['submitJob']);
const CONSUMER_FNS = new Set(['claimJob', 'processNextJob']);

export interface JobTypeReference {
  /** Resolved `job_queue.type` literal, or null when it could not be resolved. */
  type: string | null;
  /** Source text of the type expression, for the failure message. */
  expression: string;
  /** Repo-relative path, POSIX separators. */
  file: string;
  /** 1-based line number. */
  line: number;
}

export interface JobQueueScan {
  producers: JobTypeReference[];
  consumers: JobTypeReference[];
  /** Direct `.from('job_queue')` outside the queue-internals allow-list. */
  unmanagedTableAccess: Array<{ file: string; line: number }>;
}

export interface CheckResult {
  ok: boolean;
  lines: string[];
}

function isExcludedFile(file: string): boolean {
  return (
    file.endsWith('.test.ts')
    || file.endsWith('.spec.ts')
    || file.endsWith('.d.ts')
    || file.includes('/__tests__/')
    || file.includes('/__mocks__/')
    || QUEUE_INTERNALS_ALLOWLIST.includes(file)
  );
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function forEachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => forEachNode(child, visit));
}

/**
 * Unwrap the wrappers that sit between a declaration and its literal. The repo
 * convention is `export const X = 'a.b' as const;` (an `AsExpression`), so
 * missing this would silently fail-closed on the very constants this guard is
 * meant to follow — which is exactly what the first run did.
 */
function unwrap(node: ts.Node): ts.Node {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
    return unwrap(node.expression);
  }
  if (ts.isParenthesizedExpression(node)) return unwrap(node.expression);
  return node;
}

function literalValue(node: ts.Node): string | null {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  return null;
}

/**
 * name -> literal value, across the worker tree. A name bound to more than one
 * distinct literal is AMBIGUOUS and is dropped, so it resolves to null and
 * fails closed rather than silently picking a winner.
 */
export function collectStringConstants(files: ReadonlyMap<string, string>): Map<string, string> {
  const seen = new Map<string, Set<string>>();

  for (const [file, source] of files) {
    if (isExcludedFile(file)) continue;
    forEachNode(parse(file, source), (node) => {
      if (!ts.isVariableDeclaration(node)) return;
      if (!ts.isIdentifier(node.name) || !node.initializer) return;
      const value = literalValue(node.initializer);
      if (value === null) return;
      const bucket = seen.get(node.name.text) ?? new Set<string>();
      bucket.add(value);
      seen.set(node.name.text, bucket);
    });
  }

  const resolved = new Map<string, string>();
  for (const [name, values] of seen) {
    if (values.size === 1) resolved.set(name, [...values][0]);
  }
  return resolved;
}

/** Resolve a `type:` expression to its literal, or null when it cannot be. */
function resolveTypeExpression(node: ts.Node, constants: ReadonlyMap<string, string>): string | null {
  const direct = literalValue(node);
  if (direct !== null) return direct;
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return constants.get(inner.text) ?? null;
  return null;
}

/** The callee's simple name: `submitJob(...)` and `q.submitJob(...)` both yield "submitJob". */
function calleeName(call: ts.CallExpression): string | null {
  const target = call.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) return target.name.text;
  return null;
}

/** Pull the `type` property expression out of a `submitJob({ ... })` argument. */
function submissionTypeNode(call: ts.CallExpression): ts.Node | null {
  const [arg] = call.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;

  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'type') return prop.initializer;
    // `submitJob({ type, payload })` shorthand.
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'type') return prop.name;
  }
  return null;
}

function reference(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  constants: ReadonlyMap<string, string>,
): JobTypeReference {
  return {
    type: resolveTypeExpression(node, constants),
    expression: node.getText(sourceFile),
    file,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
  };
}

/** `.from('job_queue')` — the raw-table escape hatch around `submitJob`. */
function isJobQueueTableAccess(call: ts.CallExpression): boolean {
  if (calleeName(call) !== 'from') return false;
  const [arg] = call.arguments;
  return arg !== undefined && literalValue(arg) === 'job_queue';
}

export function scanJobQueueUsage(files: ReadonlyMap<string, string>): JobQueueScan {
  const constants = collectStringConstants(files);
  const scan: JobQueueScan = { producers: [], consumers: [], unmanagedTableAccess: [] };

  for (const [file, source] of files) {
    if (isExcludedFile(file)) continue;
    const sourceFile = parse(file, source);

    forEachNode(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const name = calleeName(node);

      if (name !== null && PRODUCER_FNS.has(name)) {
        const typeNode = submissionTypeNode(node);
        if (typeNode) {
          scan.producers.push(reference(file, sourceFile, typeNode, constants));
        } else {
          // A submitJob call whose type we cannot even locate is worse than an
          // unresolved identifier — record it as unresolved, not as absent.
          scan.producers.push({
            type: null,
            expression: node.getText(sourceFile).slice(0, 120),
            file,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          });
        }
        return;
      }

      if (name !== null && CONSUMER_FNS.has(name) && node.arguments.length > 0) {
        scan.consumers.push(reference(file, sourceFile, node.arguments[0], constants));
        return;
      }

      if (isJobQueueTableAccess(node)) {
        scan.unmanagedTableAccess.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      }
    });
  }

  return scan;
}

function site(ref: JobTypeReference): string {
  return `${ref.file}:${ref.line}`;
}

export function runJobQueueParityCheck(scan: JobQueueScan): CheckResult {
  const lines: string[] = [];

  // ── Vacuity guards. Reporting "no orphans" from a tree we failed to read is
  //    the exact failure mode this check exists to prevent.
  if (scan.producers.length === 0) {
    return {
      ok: false,
      lines: [
        'job_queue parity: found no submitJob producers at all — the guard could not verify anything.',
        `Expected enqueue sites under ${WORKER_SRC}. Either the scan path is wrong or submitJob was renamed.`,
        'Failing closed rather than certifying a tree that was never read.',
      ],
    };
  }
  if (scan.consumers.length === 0) {
    return {
      ok: false,
      lines: [
        'job_queue parity: found no claimJob/processNextJob consumers at all.',
        'Every produced job type would be orphaned. Failing closed — see the note above.',
      ],
    };
  }

  // ── Rule 3 first: unresolved expressions make the whole set untrustworthy.
  const unresolved = [...scan.producers, ...scan.consumers].filter((ref) => ref.type === null);
  if (unresolved.length > 0) {
    lines.push(
      `${unresolved.length} job type expression(s) could not be resolved to a string literal:`,
      ...unresolved.map((ref) => `  ${site(ref)}  ->  ${ref.expression}`),
      '',
      'This guard matches producers to consumers by literal value, so an unresolvable',
      'expression cannot be certified either way. Use a `const X = \'a.b\'` exported from one',
      'module and imported on both sides (the DRIVE_FILE_CHANGED_JOB_TYPE convention).',
      '',
    );
  }

  const producedTypes = new Set(scan.producers.map((p) => p.type).filter((t): t is string => t !== null));
  const consumedTypes = new Set(scan.consumers.map((c) => c.type).filter((t): t is string => t !== null));

  // Explicit comparator: a bare `.sort()` orders by UTF-16 code unit, which is
  // not reliable alphabetical ordering for the failure listing below (S2871).
  const byName = (a: string, b: string): number => a.localeCompare(b);

  const orphanProducers = [...producedTypes].filter((t) => !consumedTypes.has(t)).sort(byName);
  const orphanConsumers = [...consumedTypes].filter((t) => !producedTypes.has(t)).sort(byName);

  if (orphanProducers.length > 0) {
    lines.push(
      `${orphanProducers.length} job type(s) are ENQUEUED but nothing drains them:`,
      '',
    );
    for (const type of orphanProducers) {
      const sites = scan.producers.filter((p) => p.type === type).map(site);
      lines.push(`  ${type}`, ...sites.map((s) => `      enqueued at ${s}`));
    }
    lines.push(
      '',
      'A job_queue type with no claimJob/processNextJob call NEVER runs, and produces no',
      'error to say so: the row sits `pending` forever — no retry, no dead letter, no alert.',
      'It is indistinguishable from an empty queue. Both prior instances of this were',
      'billing defects (anchor.fast_track charged a credit for acceleration that never',
      'happened; ai_credits.reconcile_refund silently dropped a customer overcharge).',
      '',
      'Fix by writing a consumer AND wiring it to a trigger (a cron route in',
      'services/worker/src/routes/cron.ts plus a Cloud Scheduler entry in',
      'scripts/gcp-setup/cloud-scheduler.sh), or by removing the enqueue and doing the',
      'work directly. Do NOT silence this by deleting the guard.',
      '',
    );
  }

  if (orphanConsumers.length > 0) {
    lines.push(
      `${orphanConsumers.length} job type(s) are DRAINED but nothing enqueues them:`,
      '',
    );
    for (const type of orphanConsumers) {
      const sites = scan.consumers.filter((c) => c.type === type).map(site);
      lines.push(`  ${type}`, ...sites.map((s) => `      drained at ${s}`));
    }
    lines.push(
      '',
      'A drain with no producer is dead code that reads as coverage — it makes the queue',
      'look wired while the real producer may be enqueuing a different spelling.',
      '',
    );
  }

  if (scan.unmanagedTableAccess.length > 0) {
    lines.push(
      `${scan.unmanagedTableAccess.length} direct job_queue table access(es) outside the queue internals:`,
      ...scan.unmanagedTableAccess.map((a) => `  ${a.file}:${a.line}`),
      '',
      '`submitJob` is the only enqueue API. A raw `.from(\'job_queue\')` write routes around',
      'the producer/consumer parity rules above, so an orphan enqueued this way would be',
      'invisible to this guard — reopening the class it exists to close.',
      '',
      'If this is a lease or a resumable checkpoint (NOT queued work), add the module to',
      'QUEUE_INTERNALS_ALLOWLIST in this file, with a comment saying why it is not work.',
      '',
    );
  }

  if (lines.length > 0) {
    return {
      ok: false,
      lines: ['job_queue producer/consumer parity FAILED.', '', ...lines],
    };
  }

  return {
    ok: true,
    lines: [
      `✅ job_queue parity OK — ${producedTypes.size} enqueued type(s), all with a consumer; `
      + `${scan.producers.length} enqueue site(s), ${scan.consumers.length} drain site(s); `
      + 'no unmanaged job_queue writes.',
    ],
  };
}

/** Read every worker `.ts` source, keyed by repo-relative POSIX path. */
export function loadWorkerSources(root: string = REPO): Map<string, string> {
  const files = new Map<string, string>();
  const srcRoot = join(root, WORKER_SRC);

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      files.set(relative(root, full).split(sep).join('/'), readFileSync(full, 'utf8'));
    }
  };

  walk(srcRoot);
  return files;
}

function main(): void {
  const result = runJobQueueParityCheck(scanJobQueueUsage(loadWorkerSources()));

  if (result.ok) {
    for (const line of result.lines) console.log(line);
    return;
  }

  for (const line of result.lines) console.error(line);
  console.error(`::error title=job_queue parity::${result.lines[0]}`);
  process.exit(1);
}

if (isMainModule(import.meta.url, process.argv[1])) main();
