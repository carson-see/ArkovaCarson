/**
 * Block new `if (error || <empty>)` swallows in worker job code.
 *
 * WHY (SCRUM-3836). `detectReorgs` collapsed a failed Supabase query and an
 * empty result into one branch:
 *
 *     if (error || !rows || rows.length === 0) return { checked: 0 };
 *
 * with no log, and the route returned HTTP 200. On prod the candidate query was
 * being killed by `statement_timeout=60s` (unindexed scan over 3.8M anchors), so
 * reorg detection reported healthy while inspecting ZERO anchors — 1,108
 * consecutive runs. Chain-safety code on the anchor lifecycle, silent for months.
 *
 * The defect is not one bad line, it is a SHAPE. A careful census finds the
 * instance you are looking at; a detector finds the class. This is the ratchet:
 * the existing occurrences are baselined, and no NEW one can land.
 *
 * A site is a violation when an `if (error || ...)` guard has no
 * `logger.error`/`logger.warn` in the following few lines. Splitting the branches
 * (handle `error` separately, log it, return something the caller can tell apart)
 * clears it.
 *
 * Override label: `error-swallow-reviewed`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const JOBS_DIR = 'services/worker/src/jobs';
const OVERRIDE_LABEL = 'error-swallow-reviewed';
const LOOKAHEAD = 5;

/**
 * Known occurrences as of SCRUM-3836. Burn-down tracked there. Entries are
 * `basename:line` — a shifted line reads as NEW, which is the intended
 * strictness: touching one of these files means re-checking its swallows.
 * Do NOT add to this list. Fix the site instead.
 */
export const BASELINE = new Set<string>([
]);

const GUARD = /\bif\s*\(\s*error\s*\|\|/;
/**
 * A site is fine if the failure is made LOUD — either logged, or thrown with the
 * error carried along. `throw new Error(... error?.message ...)` surfaces just as
 * well as a log; what must not happen is a silent return of an empty/None value
 * that the caller cannot tell apart from "no data".
 */
const LOUD = /logger\.(error|warn)\s*\(|\bthrow\b/;

export interface Violation { file: string; line: number; text: string }

export function scanSource(basename: string, source: string): Violation[] {
  const lines = source.split('\n');
  const out: Violation[] = [];
  lines.forEach((line, i) => {
    if (!GUARD.test(line)) return;
    const window = lines.slice(i, i + 1 + LOOKAHEAD).join('\n');
    if (LOUD.test(window)) return;
    out.push({ file: basename, line: i + 1, text: line.trim() });
  });
  return out;
}

function main(): void {
  const labels = (process.env.PR_LABELS ?? '').split(',').map((l) => l.trim());
  if (labels.includes(OVERRIDE_LABEL)) {
    console.log(`[error-swallow] override label "${OVERRIDE_LABEL}" present — skipping.`);
    return;
  }

  const files = readdirSync(JOBS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const found: Violation[] = [];
  for (const f of files) {
    found.push(...scanSource(f, readFileSync(join(JOBS_DIR, f), 'utf8')));
  }

  const fresh = found.filter((v) => !BASELINE.has(`${v.file}:${v.line}`));
  const fixed = [...BASELINE].filter(
    (b) => !found.some((v) => `${v.file}:${v.line}` === b),
  );

  console.log(
    `[error-swallow] ${files.length} job file(s) scanned, `
    + `${found.length} swallow(s) found, ${BASELINE.size} baselined, ${fresh.length} new.`,
  );
  if (fixed.length > 0) {
    console.log(
      `[error-swallow] ${fixed.length} baselined site(s) no longer match — `
      + `remove them from BASELINE to keep the ratchet tight:\n  ${fixed.join('\n  ')}`,
    );
  }

  if (fresh.length === 0) return;

  console.error('\nNew `if (error || ...)` swallow with no logger.error/warn:\n');
  for (const v of fresh) console.error(`  ${v.file}:${v.line}\n    ${v.text}`);
  console.error(
    '\nA failed query is not an empty result. Handle `error` in its own branch,'
    + '\nlog it, and return something the caller can distinguish — see'
    + '\nservices/worker/src/jobs/chain-maintenance.ts (`completed` / `reason`).'
    + `\nOverride label: ${OVERRIDE_LABEL}\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.includes('check-error-swallow')) main();
