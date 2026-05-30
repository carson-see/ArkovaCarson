#!/usr/bin/env tsx
/**
 * Copy Terms Lint Script
 *
 * Scans source files for forbidden UI terminology.
 * Run with: npm run lint:copy
 *
 * Exit codes:
 * - 0: No forbidden terms found
 * - 1: Forbidden terms found (CI should fail)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Forbidden terms (case-insensitive)
// Use custom boundaries (?<![-\w]) / (?![-\w]) rather than \b so that hyphenated
// CSS values like "inline-block" / "flex-block" are NOT flagged as the word "block".
export const FORBIDDEN_TERMS = [
  String.raw`(?<![-\w])wallet(?![-\w])`,
  String.raw`(?<![-\w])gas(?![-\w])`,
  String.raw`(?<![-\w])block height(?![-\w])`,
  String.raw`(?<![-\w])block hash(?![-\w])`,
  String.raw`(?<![-\w])hash(?![-\w])`,
  String.raw`(?<![-\w])block(?![-\w])`,
  String.raw`(?<![-\w])transaction(?![-\w])`,
  // SCRUM-2149(d): boundaries on crypto/bitcoin/blockchain so they NO LONGER
  // match inside identifiers/type-names. Pre-2149 these were bare strings and
  // false-positived on `BitcoinNetwork`, `Cryptographic`, `BITCOIN_NETWORK`.
  // `cryptographic` (the allowed adjective) also dies on the right boundary.
  String.raw`(?<![-\w])crypto(?![-\w])`,
  String.raw`(?<![-\w])cryptocurrency(?![-\w])`,
  String.raw`(?<![-\w])bitcoin(?![-\w])`,
  String.raw`(?<![-\w])blockchain(?![-\w])`,
  String.raw`(?<![-\w])mining(?![-\w])`,
  String.raw`(?<![-\w])token(?![-\w])`,

  // SCRUM-2149(b): §1.3 parity — Testnet / Mainnet / UTXO / Broadcast were in
  // the constitution's banned list but missing here. Same hyphen/word
  // boundaries so they don't match inside `mainnetConfig`, `broadcastTx`, etc.
  // (the structural-position filter additionally drops type-union members,
  // object keys, URL segments, and bare code values — see classifyMatch).
  String.raw`(?<![-\w])testnet(?![-\w])`,
  String.raw`(?<![-\w])mainnet(?![-\w])`,
  String.raw`(?<![-\w])utxo(?![-\w])`,
  String.raw`(?<![-\w])broadcast(?![-\w])`,

  // UX-03 (SCRUM-1029): engineering-copy leaks seen in 2026-04-18 UAT.
  // API-keys page surfaced a raw error "Ensure the worker service is running"
  // to end users. These terms should never appear in user-facing strings —
  // if the error needs to mention infra, rewrite as "service" or "connection".
  String.raw`(?<![-\w])worker service(?![-\w])`,
  // CIBA-HARDEN-05: use [A-Za-z0-9] boundaries (not \w) so the pattern matches
  // inside identifiers where adjacent chars include `_`, e.g. the env-var name
  // SUPABASE_SERVICE_ROLE_KEY leaking into an error string. \w includes `_`
  // which used to defeat the boundary and miss the most common leak vector.
  String.raw`(?<![A-Za-z0-9])service_role(?![A-Za-z0-9])`,
  String.raw`(?<![A-Za-z0-9])service role(?![A-Za-z0-9])`,
  // CIBA-HARDEN-05: PostgRESTError is the common TitleCase variant — match it
  // too. Keep only the left ASCII-alnum boundary (no right boundary) so
  // CamelCase continuations like "PostgRESTError" hit while genuine words
  // (there's nothing English starting with "postgrest") don't false-positive.
  String.raw`(?<![A-Za-z0-9])postgrest`,

  // SCRUM-1092 / SCRUM-1672: the generic document action is "Secure Document".
  // "Issue Credential" is allowed only in src/lib/copy.ts for the restricted
  // verified-org issuance flow; component/page literals remain banned.
  String.raw`(?<![-\w])issue credential(?![-\w])`,
];

export const LAUNCH_BLOCKER_COPY_TERMS = [
  'placeholder and will be updated',
  'following legal review',
  'prior to production launch',
  'to be replaced with legal-reviewed copy',
  'legal-reviewed copy before production launch',
];

// Directory prefixes scanned for UI copy. SCRUM-2149(a): the pre-2149 scope was
// ONLY src/components + src/pages, leaving src/lib, src/hooks, and the PUBLIC
// embeddable widget (packages/embed/src) unscanned — banned terms there reached
// users while `lint:copy` stayed green. These are the roots `shouldCheck()`
// admits and the roots `main()` walks (kept in sync — see collectCandidateFiles).
const INCLUDE_ROOTS = [
  'src/components/',
  'src/pages/',
  'src/lib/',
  'src/hooks/',
  'packages/embed/src/',
];

// Files/patterns to exclude
const EXCLUDE_PATTERNS = [
  'src/lib/copy.ts', // This file documents the rules
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/node_modules/**',
  '**/dist/**',
  'src/components/ui/**', // UI primitives don't contain user-facing copy
  'src/components/admin/treasury/**', // Internal ops dashboard — uses technical terms by design
];

export interface Violation {
  file: string;
  line: number;
  term: string;
  context: string;
}

/** One recorded pre-existing violation in scripts/ci/snapshots/copy-terms-baseline.json. */
export interface BaselineEntry {
  file: string;
  line: number;
  term: string;
  reason: string;
}

function globToRegex(pattern: string): RegExp {
  const regexStr = pattern
    .replaceAll('.', '\\.')
    .replaceAll('**', '\0DOUBLESTAR\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0DOUBLESTAR\0', '.*');
  return new RegExp(`^${regexStr}$`);
}

function getAllFiles(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        getAllFiles(fullPath, files);
      }
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * True when `filePath` is in scope for the copy-term scan. Exported for unit
 * tests. Accepts absolute or repo-relative paths and normalises to POSIX
 * separators so the prefix/glob checks behave identically on Windows.
 */
export function shouldCheck(filePath: string): boolean {
  const relativePath = (
    path.isAbsolute(filePath) ? path.relative(process.cwd(), filePath) : filePath
  ).split(path.sep).join('/');

  // Check exclusions first (copy.ts vocabulary file, tests, ui primitives,
  // treasury admin, node_modules/dist).
  for (const pattern of EXCLUDE_PATTERNS) {
    if (globToRegex(pattern).test(relativePath)) {
      return false;
    }
  }

  return INCLUDE_ROOTS.some((root) => relativePath.startsWith(root));
}

// Pre-compile once. Building a new RegExp per line × 13 terms × 224 files was
// the bulk of `lint:copy` runtime.
const FORBIDDEN_REGEXES = FORBIDDEN_TERMS.map((t) => new RegExp(t, 'gi'));
const LAUNCH_BLOCKER_REGEXES = LAUNCH_BLOCKER_COPY_TERMS.map((t) => new RegExp(t, 'gi'));

/**
 * Returns true if the line should be skipped (comments, imports, crypto API).
 * className attribute values are stripped separately by
 * {@link stripClassNameAttributes} so JSX text on the same line still gets scanned.
 */
export function shouldSkipLine(line: string, trimmed: string): boolean {
  // Skip comments and imports
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('import ')
  ) {
    return true;
  }
  // Skip Web Crypto API usage and "cryptographic" adjective
  if (line.includes('crypto.subtle') || line.includes('crypto.getRandomValues') || line.includes('cryptographic')) {
    return true;
  }
  // Skip DOM API parameters (e.g. scrollIntoView({ block: 'nearest' }))
  if (line.includes('scrollIntoView')) {
    return true;
  }
  // Skip URL search params (e.g. searchParams.get('token')) — these are URL keys, not UI copy
  if (line.includes('searchParams.get')) {
    return true;
  }
  return false;
}

function stripIgnoredAttributeValues(line: string): string {
  return line.replaceAll(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|\{[^}]*\})/g, 'className=');
}

function hasInlineJsxText(line: string): boolean {
  let searchFrom = 0;

  while (searchFrom < line.length) {
    const closeTagStart = line.indexOf('>', searchFrom);
    if (closeTagStart === -1) return false;

    const nextOpenTag = line.indexOf('<', closeTagStart + 1);
    if (nextOpenTag === -1) return false;

    const text = line.slice(closeTagStart + 1, nextOpenTag).trimStart();
    if (text.length > 0 && !text.startsWith('{')) {
      return true;
    }

    searchFrom = nextOpenTag + 1;
  }

  return false;
}

/**
 * Sanitises a JSX/TS line so the term scan only sees user-visible copy.
 * Strips className/class attribute values (Tailwind utilities like
 * "inline-block" are noise) and JSX comments `{/* … *​/}` (so engineering
 * notes can mention banned terms without tripping the lint).
 *
 * Exported for unit tests.
 */
export function stripClassNameAttributes(line: string): string {
  let out = line.replaceAll(/className\s*=\s*"[^"]*"/g, 'className=""');
  out = out.replaceAll(/className\s*=\s*'[^']*'/g, "className=''");
  // Brace-walk so `className={\`text-${x} block\`}` and
  // `className={cn('a', isOpen && 'b')}` strip cleanly — a naive `.*?` would
  // stop at the first `}` inside a `${…}` or nested call.
  out = stripBraceExpressions(out);
  out = out.replaceAll(/\bclass\s*=\s*"[^"]*"/g, 'class=""');
  out = out.replaceAll(/\{\/\*[\s\S]*?\*\/\}/g, '');
  return out;
}

function stripBraceExpressions(line: string): string {
  const prefix = /className\s*=\s*\{/g;
  let result = line;
  let match: RegExpExecArray | null;
  while ((match = prefix.exec(result)) !== null) {
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let i = startIdx;
    while (i < result.length && depth > 0) {
      const ch = result[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth !== 0) break; // unbalanced — leave the rest of the line alone
    result = result.slice(0, match.index) + 'className={}' + result.slice(i);
    prefix.lastIndex = match.index + 'className={}'.length;
  }
  return result;
}

/**
 * True for `type X = …` / `interface X …` declaration lines. SCRUM-2149(d):
 * a string-literal union member (`'testnet' | 'mainnet'`) or a type name
 * (`BitcoinNetwork`) is never user-visible copy, so the whole line is exempt.
 * Pre-compiled (module scope) to keep the per-line cost bounded.
 */
const TYPE_DECL_LINE_RE = /^\s*(?:export\s+)?(?:declare\s+)?(?:type|interface)\s+[A-Za-z_$]/;
function isTypeDeclarationLine(line: string): boolean {
  return TYPE_DECL_LINE_RE.test(line);
}

/**
 * Structural-position classifier (SCRUM-2149(d)). Returns true when the matched
 * term sits in a code position that is NEVER user-visible copy, so it must not
 * be flagged. Covers the four categories the ticket names — identifiers, type
 * unions, object keys, property access — plus URL segments and bare in-code
 * value strings. Only flags genuine copy: JSX text and quoted display strings.
 *
 * @param line        the className-stripped line
 * @param matchIndex  start index of the matched term
 * @param matchLength length of the matched term
 */
function isCodeIdentifier(line: string, matchIndex: number, matchLength: number): boolean {
  // Whole-line exemption: TS type/interface declarations.
  if (isTypeDeclarationLine(line)) return true;

  const prev = matchIndex > 0 ? line[matchIndex - 1] : '';
  const after = line.slice(matchIndex + matchLength);

  // `<Hash …>` — JSX component name.
  if (prev === '<') return true;
  // `</Hash>` — closing tag.
  if (prev === '/' && matchIndex >= 2 && line[matchIndex - 2] === '<') return true;
  // `obj.bitcoin` — property access. Require an identifier char before the
  // dot so a sentence-ending `.` followed by a banned word in the next
  // sentence ("…secure. Bitcoin is…") doesn't get masked.
  if (prev === '.' && matchIndex >= 2 && /[A-Za-z0-9_]/.test(line[matchIndex - 2])) return true;

  // Object-key position: `mainnet:` or `'mainnet':` / `"mainnet":` followed by
  // a colon (not `::` and not the `?:` ternary — require the colon to begin a
  // value, i.e. it is immediately followed by whitespace/quote/brace/value,
  // and the key is not part of a larger expression). We accept an optional
  // closing quote between the term and the colon (quoted keys).
  if (/^["']?\s*:(?![:=])/.test(after)) {
    // Guard against ternary `cond ? 'mainnet' : x` where the term is the
    // THEN-branch value: that has a `?` earlier with no colon between. The
    // colon here would be the ternary's. Only treat as a key when the term
    // starts the (trimmed) segment after `{`, `,`, or line start.
    const before = line.slice(0, matchIndex);
    const lastSep = Math.max(before.lastIndexOf('{'), before.lastIndexOf(','), before.lastIndexOf(';'));
    const segment = before.slice(lastSep + 1).trim();
    // segment is empty (term starts the key) or just an opening quote.
    if (segment === '' || segment === '"' || segment === "'") return true;
  }

  // URL context: the term is part of a URL literal. Either an explicit scheme
  // appears before it inside the current string, or the term is a path segment
  // (`/term`) — chain-explorer URLs render `/block/`, `/tx/`, `/testnet`.
  if (prev === '/') {
    // `/block/...` or `https://host/testnet` — preceded by a slash that is part
    // of a path (the char before the slash is not whitespace/`<`, i.e. it is a
    // URL host/segment char or `}` from a `${…}` template).
    if (matchIndex >= 2) {
      const beforeSlash = line[matchIndex - 2];
      if (/[A-Za-z0-9.}/]/.test(beforeSlash)) return true;
    }
  }

  // Bare in-code value string: the match is wrapped in quotes whose ENTIRE
  // content is exactly the term (a discrete enum/list/config value, e.g.
  // `'token'`, `|| 'mainnet'`, `['utxo']`). Such a string is not a sentence of
  // copy. EXCLUSION: when the quote is a JSX/HTML attribute value (`attr="…"`),
  // i.e. the char before the opening quote is `=`, it IS user-visible copy and
  // must still flag (`placeholder="Wallet address"`).
  const quote = prev;
  if (quote === '"' || quote === "'" || quote === '`') {
    const closer = after[0];
    if (closer === quote) {
      // opening quote is at matchIndex-1; char before it decides attr vs value.
      const beforeQuote = matchIndex >= 2 ? line[matchIndex - 2] : '';
      if (beforeQuote !== '=') return true;
    }
  }

  return false;
}

// =============================================================================
// SCRUM-2149(c) — raw DB-enum render heuristic.
// =============================================================================

/**
 * Curated, deliberately-small set of DB/status enum field names that must be
 * routed through a display mapper (e.g. ANCHOR_STATUS_LABELS / formatCredentialType
 * in src/lib/copy.ts) before reaching the user. Rendering one of these RAW as a
 * JSX expression child (`{anchor.status}`) dumps the DB enum value (SECURED,
 * REVOKED, …) straight into the UI — the core SCRUM-2149 concern that literal
 * term-scanning cannot see. Keep this list short to avoid false positives;
 * widen only with a documented reason.
 */
export const RISKY_ENUM_FIELDS = [
  'status',
  'anchor_status',
  'network',
  'credential_type',
] as const;

const RAW_ENUM_CHILD_RE = new RegExp(
  // (1) a boundary char that is NOT `$` (template literal) and NOT `=` (JSX
  //     attribute) and NOT an identifier char (property continuation); then
  // (2) `{ ident(?.|.)<field> }` with only the curated fields.
  String.raw`(^|[^$=\w.])\{\s*[A-Za-z_$][\w$]*\??\.(?:${RISKY_ENUM_FIELDS.join('|')})\s*\}`,
);

/**
 * Detects a raw DB-enum render: a bare `{X.<riskyfield>}` used as a JSX
 * expression CHILD (between `>` and `<`, or alone on an indented line) rather
 * than passed into a display component. Conservative by construction:
 *
 *   FLAGS    `{result.status}` (child), `>{r.credential_type}<`
 *   IGNORES  `${res.status}` (template/HTTP code), `status={x.status}` (attr),
 *            `{x.public_id}` (field not in the risky set), and anything in a
 *            non-`.tsx` file (the pattern is JSX-specific).
 *
 * Exported for unit tests.
 */
export function findRawEnumRenders(line: string, lineNum: number, filePath: string): Violation[] {
  if (!filePath.endsWith('.tsx')) return [];

  const m = RAW_ENUM_CHILD_RE.exec(line);
  if (!m) return [];

  const exprStart = m.index + m[1].length; // index of the `{`
  const trimmed = line.trim();
  const exprOnly = /^\{\s*[A-Za-z_$][\w$]*\??\.[A-Za-z_]+\s*\}$/.test(trimmed);

  // Inline JSX child: the expression is immediately preceded (ignoring space)
  // by `>` and immediately followed (ignoring space) by `<`.
  const before = line.slice(0, exprStart).replace(/\s+$/, '');
  const afterExpr = line.slice(exprStart).replace(/^\{[^}]*\}/, '').replace(/^\s+/, '');
  const inlineChild = before.endsWith('>') && afterExpr.startsWith('<');

  if (!exprOnly && !inlineChild) return [];

  const expr = line.slice(exprStart).match(/^\{\s*([^}]*?)\s*\}/);
  const field = expr ? expr[1] : line.slice(exprStart);
  return [
    {
      file: filePath,
      line: lineNum,
      term: `raw enum render: {${field}}`,
      context: trimmed.substring(0, 80),
    },
  ];
}

// =============================================================================
// SCRUM-2148 — grandfather baseline.
// =============================================================================

const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ci',
  'snapshots',
  'copy-terms-baseline.json',
);

/** Normalise to repo-relative POSIX separators so the key is OS-stable. */
function normaliseFile(file: string): string {
  const rel = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
  return rel.split(/[\\/]/).join('/');
}

function baselineKey(file: string, line: number): string {
  return `${normaliseFile(file)}:${line}`;
}

/**
 * Load the shipped grandfather baseline. Returns [] (and the linter therefore
 * fails on every violation) if the file is missing or malformed — fail-closed,
 * never fail-open on a corrupted baseline.
 */
export function loadBaseline(baselinePath: string = BASELINE_PATH): BaselineEntry[] {
  try {
    const raw = fs.readFileSync(baselinePath, 'utf-8');
    const parsed = JSON.parse(raw) as { violations?: BaselineEntry[] };
    if (!parsed || !Array.isArray(parsed.violations)) return [];
    return parsed.violations.filter(
      (e): e is BaselineEntry =>
        !!e && typeof e.file === 'string' && Number.isInteger(e.line) && typeof e.term === 'string',
    );
  } catch {
    return [];
  }
}

export interface BaselinePartition {
  /** New violations not in the baseline — these fail the build. */
  fresh: Violation[];
  /** Violations matched to a baseline entry — tolerated. */
  grandfathered: Violation[];
  /** Baseline entries with no matching current violation — likely fixed; prompt cleanup. */
  stale: BaselineEntry[];
}

/**
 * Split current violations into {fresh, grandfathered} against the baseline and
 * surface {stale} baseline entries. Match key = normalised file + line; the
 * recorded `term` is informational (heuristic wording may evolve), so it is not
 * part of the key. Pure — exported for unit tests.
 */
export function partitionAgainstBaseline(
  violations: Violation[],
  baseline: BaselineEntry[],
): BaselinePartition {
  const baselineKeys = new Set(baseline.map((e) => baselineKey(e.file, e.line)));
  const matchedKeys = new Set<string>();

  const fresh: Violation[] = [];
  const grandfathered: Violation[] = [];

  for (const v of violations) {
    const key = baselineKey(v.file, v.line);
    if (baselineKeys.has(key)) {
      grandfathered.push(v);
      matchedKeys.add(key);
    } else {
      fresh.push(v);
    }
  }

  const stale = baseline.filter((e) => !matchedKeys.has(baselineKey(e.file, e.line)));
  return { fresh, grandfathered, stale };
}

export function findTermViolations(line: string, lineNum: number, filePath: string): Violation[] {
  const results: Violation[] = [];
  const cleaned = stripClassNameAttributes(line);

  for (const regex of LAUNCH_BLOCKER_REGEXES) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      results.push({
        file: filePath,
        line: lineNum,
        term: match[0],
        context: cleaned.trim().substring(0, 80),
      });
    }
  }

  // SCRUM-2149(c): raw DB-enum render heuristic (JSX-child {X.status}). Runs on
  // the cleaned line (so className braces are already neutralised) and is gated
  // to .tsx inside findRawEnumRenders.
  results.push(...findRawEnumRenders(cleaned, lineNum, filePath));

  // Quote/JSX context is a per-line property; computing it once per term
  // saves 6×n includes() calls when the line has many term matches.
  const hasString = cleaned.includes('"') || cleaned.includes("'") || cleaned.includes('`');
  const hasJsxText = cleaned.includes('>') && cleaned.includes('<');
  if (!hasString && !hasJsxText) return results;

  for (const regex of FORBIDDEN_REGEXES) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      if (isCodeIdentifier(cleaned, match.index, match[0].length)) continue;
      results.push({
        file: filePath,
        line: lineNum,
        term: match[0],
        context: cleaned.trim().substring(0, 80),
      });
    }
  }
  return results;
}

function checkFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }

    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }

    if (shouldSkipLine(line, trimmed)) {
      continue;
    }

    violations.push(...findTermViolations(line, i + 1, filePath));
  }

  return violations;
}

/**
 * Walk every INCLUDE_ROOT and return the de-duplicated set of in-scope files.
 * SCRUM-2149(a): `packages/embed/src` lives OUTSIDE `src/`, so a single
 * `getAllFiles('src')` walk (the pre-2149 behaviour) could never reach the
 * public widget. We derive the walk roots from INCLUDE_ROOTS so coverage and
 * the `shouldCheck()` predicate can never silently drift apart.
 */
function collectCandidateFiles(): string[] {
  const seen = new Set<string>();
  // Distinct top-level dirs to walk (`src` once, `packages/embed/src` once).
  const walkDirs = new Set(
    INCLUDE_ROOTS.map((root) => root.split('/')[0]).map((top) => path.join(process.cwd(), top)),
  );
  const out: string[] = [];
  for (const dir of walkDirs) {
    for (const f of getAllFiles(dir)) {
      if (!seen.has(f) && shouldCheck(f)) {
        seen.add(f);
        out.push(f);
      }
    }
  }
  return out;
}

function main(): void {
  console.log('Checking UI copy for forbidden terms...\n');

  const filesToCheck = collectCandidateFiles();

  if (filesToCheck.length === 0) {
    console.log('No UI files to check (src/components, src/pages, src/lib, src/hooks, packages/embed/src).');
    console.log('This is expected if no UI components exist yet.\n');
    process.exit(0);
  }

  console.log(`Checking ${filesToCheck.length} file(s)...\n`);

  const allViolations: Violation[] = [];

  for (const file of filesToCheck) {
    const violations = checkFile(file);
    allViolations.push(...violations);
  }

  // SCRUM-2148: partition against the grandfather baseline. Only NEW (fresh)
  // violations fail the build; recorded pre-existing ones are tolerated.
  const baseline = loadBaseline();
  const { fresh, grandfathered, stale } = partitionAgainstBaseline(allViolations, baseline);

  if (grandfathered.length > 0) {
    console.log(
      `Tolerating ${grandfathered.length} grandfathered violation(s) from copy-terms-baseline.json (pre-existing; SCRUM-2148 follow-up).\n`,
    );
  }

  // A stale baseline entry means the underlying violation was fixed (or moved):
  // surface it as a non-fatal nudge to keep the baseline from rotting. Do NOT
  // fail the build on stale entries — line drift from unrelated edits is common.
  if (stale.length > 0) {
    console.log(`⚠️  ${stale.length} stale baseline entr(y/ies) — no longer violating, please remove from copy-terms-baseline.json:`);
    for (const e of stale) {
      console.log(`    - ${e.file}:${e.line} ("${e.term}")`);
    }
    console.log('');
  }

  if (fresh.length === 0) {
    console.log('No NEW forbidden terms found. UI copy is compliant.\n');
    process.exit(0);
  }

  console.log(`Found ${fresh.length} NEW violation(s):\n`);

  for (const v of fresh) {
    const relativePath = path.relative(process.cwd(), v.file);
    console.log(`  ${relativePath}:${v.line}`);
    console.log(`    Term: "${v.term}"`);
    console.log(`    Context: ${v.context}`);
    console.log('');
  }

  console.log('Forbidden terms in UI copy:');
  console.log('  - wallet → use "Fee Account" / "Billing Account"');
  console.log('  - hash → use "fingerprint"');
  console.log('  - block, transaction → use "record" / "Network Receipt"');
  console.log('  - crypto, bitcoin, blockchain, testnet, mainnet, utxo, broadcast → remove or rephrase');
  console.log('  - raw enum render ({x.status} / {x.credential_type} …) → route through a display mapper in src/lib/copy.ts');
  console.log('  - public launch blocker copy → remove placeholder/legal-review disclaimers from public UI');
  console.log('');
  console.log('See src/lib/copy.ts for approved terminology.');
  console.log('If a violation is genuinely pre-existing and cannot be fixed here (e.g. a file');
  console.log('locked by another open PR), add it to scripts/ci/snapshots/copy-terms-baseline.json');
  console.log('with a file:line + reason. NEVER baseline a violation you are introducing.\n');

  process.exit(1);
}

// Only run main when executed directly (not when imported by the test file).
// CIBA-HARDEN-05: exporting FORBIDDEN_TERMS required guarding the top-level
// main() call so vitest can import without triggering process.exit(0).
const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main();
}
