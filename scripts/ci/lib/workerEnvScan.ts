/**
 * Shared scanner for SCRUM-1258 (R1-4) — finds `process.env.X` reads in
 * `services/worker/src/`. Used by both the CI lint and the baseline regenerator
 * so they cannot drift.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

export interface EnvReference {
  file: string; // repo-relative
  identifier: string;
}

const ALLOWLIST_PATTERNS = [
  /^services\/worker\/src\/config\.ts$/,
  /^services\/worker\/src\/lib\/env\.ts$/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /\/tests\//,
  /\/__tests__\//,
];

// Two patterns so bracket-access can't escape the lint:
//   process.env.FOO            ← dot-access
//   process.env['FOO']         ← bracket-access with literal
//   process.env["FOO"]
// Dynamic bracket-access (process.env[someVar]) is rejected separately.
const ENV_DOT_REGEX = /process\.env\.([A-Z_][A-Z_0-9]*)/g;
const ENV_BRACKET_LITERAL_REGEX = /process\.env\[\s*['"]([A-Z_][A-Z_0-9]*)['"]\s*\]/g;
const ENV_BRACKET_DYNAMIC_REGEX = /process\.env\[\s*[^'"\]\s][^\]]*\]/g;

function isAllowed(file: string): boolean {
  return ALLOWLIST_PATTERNS.some((re) => re.test(file));
}

export interface DynamicBracketUse {
  file: string;
  snippet: string;
}

export interface ScanResult {
  /** Static reads we can name — both dot- and bracket-literal forms. */
  refs: EnvReference[];
  /** `process.env[someVar]` uses we can't statically name. */
  dynamic: DynamicBracketUse[];
}

function collectMatches(body: string, regex: RegExpWithGroup, refs: EnvReference[], file: string): void {
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(body)) !== null) {
    refs.push({ file, identifier: match[1] });
  }
}

type RegExpWithGroup = RegExp;

export function scanWorkerEnvReads(repo: string): EnvReference[] {
  return scanWorkerEnv(repo).refs;
}

export function scanWorkerEnv(repo: string): ScanResult {
  // git ls-files keeps us aligned with what's actually checked in (no
  // node_modules, no dist artifacts).
  const files = execSync('git ls-files services/worker/src', { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((p) => p.endsWith('.ts') && !isAllowed(p));

  const refs: EnvReference[] = [];
  const dynamic: DynamicBracketUse[] = [];
  for (const file of files) {
    const body = readFileSync(resolve(repo, file), 'utf8');
    collectMatches(body, ENV_DOT_REGEX, refs, file);
    collectMatches(body, ENV_BRACKET_LITERAL_REGEX, refs, file);

    let match: RegExpExecArray | null;
    ENV_BRACKET_DYNAMIC_REGEX.lastIndex = 0;
    while ((match = ENV_BRACKET_DYNAMIC_REGEX.exec(body)) !== null) {
      dynamic.push({ file, snippet: match[0] });
    }
  }
  return { refs, dynamic };
}

/**
 * Identifier-only key. Renames of files that already had a baselined read
 * preserve the (was-allowed) status — the lint only fires on truly NEW
 * identifiers, not on refactors that move an existing read to another file.
 */
export function refKey(r: EnvReference): string {
  return r.identifier;
}
