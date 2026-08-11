#!/usr/bin/env -S npx tsx
/**
 * DPA Schedule 1 / clause 4.6 — every request handler that creates an anchor
 * must enforce the caller org's field policy.
 *
 * THE GAP THIS PREVENTS:
 *   `utils/orgFieldPolicy.ts` (migration 0405) rejects a request carrying a
 *   field the caller's organisation is contractually forbidden from sending.
 *   It only does that on routes that actually call it. When it shipped it was
 *   wired into `anchor-submit.ts` and `anchor-bulk.ts` — but five other
 *   request handlers also INSERT into `anchors`, and every one of them was a
 *   way for a configured org to send a prohibited field and get a 201.
 *
 *   A manual census does not hold this closed. The census that found those
 *   five was assembled by grepping for files containing BOTH `from('anchors')`
 *   and `.insert(` anywhere in the file — which named four files that only
 *   ever SELECT from anchors (`batch.ts`, `credentials-ctdl.ts`,
 *   `signatures.ts`, `attestations.ts`) and MISSED two that genuinely insert
 *   (`cle-verify.ts`, `version-resolution.ts`). Four false positives and two
 *   false negatives, from a careful reading. The next route to be added would
 *   miss the guard silently, and nothing would fail.
 *
 * THE INVARIANT:
 *   A file under `services/worker/src/api/` that inserts into `anchors` must
 *   call `enforceOrgFieldPolicy`.
 *
 * WHY THE DIRECTORY IS THE BOUNDARY, NOT AN ALLOWLIST:
 *   `services/worker/src/jobs/` also creates anchors — the connector
 *   ingestion drain, the public-records cron, the org-rule dispatcher. Those
 *   are service-originated: there is no inbound partner request, no request
 *   body to inspect, and no `Response` to write a 400 to. `enforceOrgFieldPolicy`
 *   takes an express `Response` and cannot be applied to them at all; covering
 *   that path needs a different control with quarantine semantics rather than
 *   an HTTP rejection (see `services/worker/src/jobs/agents.md`).
 *
 *   Expressing that as a directory rule rather than a list of exempt filenames
 *   means a NEW job file inherits the exemption correctly and a NEW route file
 *   inherits the requirement correctly. An allowlist would have to be edited by
 *   the same person who forgot the guard.
 *
 * DETECTION SHAPE:
 *   Only `from('anchors')` whose NEXT chained call is `.insert(` counts. All
 *   164 other `from('anchors')` occurrences in the worker are reads, and a read
 *   has nothing to reject. This is deliberately narrow: it means a genuinely
 *   novel way of writing the insert (a dynamic table name, a raw RPC) is not
 *   caught. Those are rare and reviewable; a silently-missing guard on a
 *   conventional route is neither.
 *
 * Override: PR labeled `anchor-field-policy-exempt`. Use it only for a route
 * that provably cannot carry caller-supplied data, and say why in the PR body.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GIT_BIN, REPO, isMainModule } from './lib/ciContext.js';

const OVERRIDE_LABEL = 'anchor-field-policy-exempt';
const GUARD_FN = 'enforceOrgFieldPolicy';

/** The handler surface. Anything here can receive an inbound request body. */
const REQUEST_HANDLER_DIR = 'services/worker/src/api/';

const prLabels = (process.env.PR_LABELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export interface Finding {
  file: string;
  line: number;
  context: string;
}

/**
 * Strip `//` and block comments so a commented-out insert, or an insert quoted
 * in a doc comment explaining this very rule, does not register as real code.
 * Replaces with spaces to keep byte offsets (and therefore line numbers) exact.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function lineNumber(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}

function lineContext(text: string, idx: number): string {
  const start = text.lastIndexOf('\n', idx) + 1;
  const end = text.indexOf('\n', idx);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 120);
}

/**
 * Offsets of every `from('anchors')` whose next chained call is `.insert(`.
 *
 * Requiring `.insert(` to be the IMMEDIATELY next call — only whitespace
 * between `)` and `.insert(` — is what keeps this from flagging the ~164
 * `from('anchors').select(...)` reads. postgrest-js builders put `.insert()`
 * first in the chain, so a real insert always has this shape.
 */
export function findAnchorInserts(src: string): number[] {
  const code = stripComments(src);
  const offsets: number[] = [];
  const from = /\.from\(\s*['"]anchors['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = from.exec(code)) !== null) {
    const rest = code.slice(match.index + match[0].length);
    if (/^\s*\.(insert|upsert)\s*\(/.test(rest)) offsets.push(match.index);
  }
  return offsets;
}

/** True when the file calls the guard (not merely mentions it in prose). */
export function callsFieldPolicyGuard(src: string): boolean {
  const code = stripComments(src);
  return new RegExp(`\\b${GUARD_FN}\\s*\\(`).test(code);
}

export function scan(): Finding[] {
  const files = execFileSync(GIT_BIN, ['ls-files', REQUEST_HANDLER_DIR], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'));

  const findings: Finding[] = [];
  for (const file of files) {
    const src = readFileSync(resolve(REPO, file), 'utf8');
    const inserts = findAnchorInserts(src);
    if (inserts.length === 0) continue;
    if (callsFieldPolicyGuard(src)) continue;
    // Report the first insert only — one finding per file keeps the failure
    // message about the file that needs the guard, not each statement in it.
    findings.push({
      file,
      line: lineNumber(src, inserts[0]),
      context: lineContext(src, inserts[0]),
    });
  }
  return findings;
}

function main(): void {
  const findings = scan();
  if (findings.length === 0) {
    console.log('✅ Every anchor-creating request handler enforces the org field policy.');
    return;
  }

  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`⚠️  PR labeled \`${OVERRIDE_LABEL}\` — allowing ${findings.length} file(s).`);
    for (const f of findings) console.log(`  ${f.file}:${f.line} → ${f.context}`);
    return;
  }

  console.error(
    `::error::DPA clause 4.6: ${findings.length} request handler(s) insert into \`anchors\` without calling ${GUARD_FN}:`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.context}`);
  }
  console.error('');
  console.error('A configured org can send a contractually prohibited field through these routes');
  console.error('and receive a 201. The control has to reject the field independently of the');
  console.error('counterparty agreeing to stop sending it, which means every write path enforces it.');
  console.error('');
  console.error('Add, after the Zod parse and BEFORE any dedup short-circuit, quota check or insert:');
  console.error('');
  console.error(`  if (!(await ${GUARD_FN}({ orgId, body: req.body, res, scope: '<route>' }))) return;`);
  console.error('');
  console.error('Pass the RAW `req.body`, not the parsed output — see services/worker/src/utils/orgFieldPolicy.ts.');
  console.error('Service-originated anchor creation (services/worker/src/jobs/) is out of scope by design.');
  process.exit(1);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
