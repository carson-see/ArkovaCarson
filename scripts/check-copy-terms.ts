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

// Forbidden terms (case-insensitive). Two boundary styles are used deliberately:
//
//   HYPHEN-GUARDED  `(?<![-\w])X(?![-\w])` — a hyphen adjacent to the term blocks
//     the match. Used ONLY for `block` and `gas`, which collide with Tailwind/CSS
//     utilities (`inline-block`, `text-block-fg`, …). The hyphen carve-out is
//     needed there and nowhere else.
//   WORD-BOUNDARY   `(?<!\w)X(?!\w)` — a hyphen adjacent to the term STILL flags.
//     Used for the chain/marketing terms (`bitcoin`, `blockchain`, `crypto`,
//     `cryptocurrency`, `testnet`, `mainnet`, `utxo`, `broadcast`) because
//     hyphenated hero copy like `Bitcoin-anchored` / `Crypto-secured` /
//     `UTXO-based` / `Re-broadcast` is exactly the §1.3 violation we must catch
//     (SCRUM-2149 review B1). className values are already stripped by
//     stripClassNameAttributes() and identifier/type positions are dropped by
//     isCodeIdentifier(), so the hyphen guard is unnecessary for these.
export const FORBIDDEN_TERMS = [
  String.raw`(?<![-\w])wallet(?![-\w])`,
  String.raw`(?<![-\w])gas(?![-\w])`,
  String.raw`(?<![-\w])block height(?![-\w])`,
  String.raw`(?<![-\w])block hash(?![-\w])`,
  String.raw`(?<![-\w])hash(?![-\w])`,
  String.raw`(?<![-\w])block(?![-\w])`,
  String.raw`(?<![-\w])transaction(?![-\w])`,
  // SCRUM-2149(d) + review B1: word boundaries so these NO LONGER match inside
  // identifiers/type-names (`BitcoinNetwork`, `Cryptographic`, `BITCOIN_NETWORK`)
  // — those positions are dropped by isCodeIdentifier() — yet a hyphen-adjacent
  // occurrence in visible copy (`Bitcoin-anchored`, `Crypto-secured`) DOES flag.
  // `cryptographic` (the allowed adjective) is exempted on the shouldSkipLine path.
  String.raw`(?<!\w)crypto(?!\w)`,
  String.raw`(?<!\w)cryptocurrency(?!\w)`,
  String.raw`(?<!\w)bitcoin(?!\w)`,
  String.raw`(?<!\w)blockchain(?!\w)`,
  String.raw`(?<![-\w])mining(?![-\w])`,
  String.raw`(?<![-\w])token(?![-\w])`,

  // SCRUM-2149(b): §1.3 parity — Testnet / Mainnet / UTXO / Broadcast were in
  // the constitution's banned list but missing here. Word boundaries (review
  // B1) so they don't match inside `mainnetConfig`, `broadcastTx`, etc. (those
  // identifier/type/key positions are dropped by isCodeIdentifier) while a
  // hyphen-adjacent occurrence in visible copy (`UTXO-based`) still flags.
  String.raw`(?<!\w)testnet(?!\w)`,
  String.raw`(?<!\w)mainnet(?!\w)`,
  String.raw`(?<!\w)utxo(?!\w)`,
  String.raw`(?<!\w)broadcast(?!\w)`,

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

/**
 * The ONLY terms a copy-terms-allowlist entry may pardon. Deliberately a
 * set-of-one: the sole §1.3-sanctioned term inside src/lib/copy.ts is
 * "Issue Credential" — the restricted verified-organisation issuance action
 * (SCRUM-1672 / §1.3 exception). No other banned term has a sanctioned use in
 * copy.ts, so nothing else is allowlistable.
 */
export const ALLOWLISTABLE_TERMS = new Set<string>(['issue credential']);

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

export function isNonSuppressibleTerm(term: string): boolean {
  const normalised = normaliseTerm(term);
  return (
    normalised === 'service_role' ||
    normalised === 'service role' ||
    normalised === 'postgrest' ||
    normalised === 'worker service' ||
    LAUNCH_BLOCKER_COPY_TERMS.some((launchBlocker) => normaliseTerm(launchBlocker) === normalised)
  );
}

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

/**
 * Sanitises a JSX/TS line so the term scan only sees user-visible copy.
 * Strips className/class attribute values (Tailwind utilities like
 * "inline-block" are noise) and JSX comments (so engineering notes can mention
 * banned terms without tripping the lint).
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
 * True when the match sits in JSX element text — i.e. between a tag-close `>`
 * and a following tag-open `<` on the same line. SCRUM-2149 review N2: such
 * text is user-visible copy, so the URL-path and bare-quoted-value suppressions
 * (which are correct for in-code positions) must NOT fire on it. Examples that
 * MUST stay visible: `<p>Testnet/Mainnet</p>`, `<p>"Bitcoin"</p>`.
 */
function isJsxVisibleText(line: string, matchIndex: number): boolean {
  const before = line.slice(0, matchIndex);
  const lastGt = before.lastIndexOf('>');
  const lastLt = before.lastIndexOf('<');
  // The most recent angle bracket before the match is a tag-close `>` (so we are
  // inside element content, not inside a tag), and another tag opens after it.
  return lastGt > lastLt && line.includes('<', matchIndex);
}

/** `<Hash …>` (component) or `</Hash>` (closing tag) — never user copy. */
function isJsxComponentName(line: string, matchIndex: number, prev: string): boolean {
  if (prev === '<') return true;
  return prev === '/' && matchIndex >= 2 && line[matchIndex - 2] === '<';
}

/**
 * `obj.bitcoin` — property access. Requires an identifier char before the dot
 * so a sentence-ending `.` followed by a banned word in the next sentence
 * ("…secure. Bitcoin is…") is NOT masked.
 */
function isPropertyAccess(line: string, matchIndex: number, prev: string): boolean {
  return prev === '.' && matchIndex >= 2 && /\w/.test(line[matchIndex - 2]);
}

/**
 * Object-key position: `mainnet:` / `'mainnet':` / `"mainnet":` where the colon
 * begins a value (not `::`, not the `?:` ternary). An optional closing quote
 * between the term and the colon is accepted (quoted keys). Guards against a
 * ternary THEN-branch value by requiring the term to START the segment after
 * the nearest `{`, `,`, `;`, or line start.
 */
function isObjectKey(line: string, matchIndex: number, after: string): boolean {
  if (!/^["']?\s*:(?![:=])/.test(after)) return false;
  const before = line.slice(0, matchIndex);
  const lastSep = Math.max(
    before.lastIndexOf('{'),
    before.lastIndexOf(','),
    before.lastIndexOf(';'),
  );
  const segment = before.slice(lastSep + 1).trim();
  return segment === '' || segment === '"' || segment === "'";
}

/**
 * URL segment: a `/term` path segment whose slash is part of a URL (the char
 * before the slash is a host/segment char or `}` from a `${…}` template) —
 * chain-explorer URLs render `/block/`, `/tx/`, `/testnet`.
 */
function isUrlSegment(line: string, matchIndex: number, prev: string): boolean {
  if (prev !== '/' || matchIndex < 2) return false;
  return /[A-Za-z0-9.}/]/.test(line[matchIndex - 2]);
}

/**
 * Bare in-code value string: the match is wrapped in quotes whose ENTIRE
 * content is exactly the term (a discrete enum/list/config value, e.g.
 * `'token'`, `|| 'mainnet'`, `['utxo']`). EXCLUSION: a JSX/HTML attribute value
 * (`attr="…"`, char before the opening quote is `=`) IS user-visible copy and
 * must still flag (`placeholder="Wallet address"`).
 */
function isBareValueString(matchIndex: number, prev: string, after: string, line: string): boolean {
  if (prev !== '"' && prev !== "'" && prev !== '`') return false;
  if (!after.startsWith(prev)) return false; // closing quote must immediately follow
  const beforeQuote = matchIndex >= 2 ? line[matchIndex - 2] : '';
  return beforeQuote !== '=';
}

/**
 * Structural-position filter (SCRUM-2149(d)). Returns true when the matched term
 * sits in a code position that is NEVER user-visible copy, so it must not be
 * flagged. Composed of small named predicates (review N3, keeps cognitive
 * complexity low): JSX component/closing-tag names, property access, TS
 * type/interface declaration lines (union members), object-key position, URL
 * segments, and bare in-code value strings. Only genuine copy — JSX text and
 * quoted display strings — flags.
 *
 * Review N2: the URL-segment and bare-value suppressions are themselves gated
 * on `!isJsxVisibleText`, so they cannot mask a banned word sitting in visible
 * JSX element text (`<p>Testnet/Mainnet</p>`, `<p>"Bitcoin"</p>`).
 *
 * @param line        the className-stripped line
 * @param matchIndex  start index of the matched term
 * @param matchLength length of the matched term
 */
function isCodeIdentifier(line: string, matchIndex: number, matchLength: number): boolean {
  if (isTypeDeclarationLine(line)) return true;

  const prev = matchIndex > 0 ? line[matchIndex - 1] : '';
  const after = line.slice(matchIndex + matchLength);

  if (isJsxComponentName(line, matchIndex, prev)) return true;
  if (isPropertyAccess(line, matchIndex, prev)) return true;
  if (isObjectKey(line, matchIndex, after)) return true;

  // These two suppressions are correct for in-code positions but would bleed
  // onto visible JSX text, so they are skipped when the match is JSX-visible.
  if (!isJsxVisibleText(line, matchIndex)) {
    if (isUrlSegment(line, matchIndex, prev)) return true;
    if (isBareValueString(matchIndex, prev, after, line)) return true;
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

// Strips the leading `{…}` brace expression so the remainder of the line can be
// inspected for the next JSX tag. `[^}]*` is greedy but bounded by the excluded
// `}` delimiter — linear, no super-linear backtracking (cf. SonarCloud S5852).
const LEADING_BRACE_EXPR_RE = /^\{[^}]*\}/;
// Captures the brace-expression body (e.g. `row.status`) for the violation
// message. Non-lazy `[^}]*` (review B3 / S6594: no lazy `*?`, consumed via
// RegExp.exec); the captured body is .trim()'d afterwards rather than peeling
// surrounding whitespace with a `\s*` group, keeping the pattern flat.
const ENUM_FIELD_RE = /^\{([^}]*)\}/;

/**
 * Detects a raw DB-enum render: a bare `{X.<riskyfield>}` used as a JSX
 * expression CHILD rather than passed into a display component. A child is
 * either the whole (trimmed) line, or embedded in element content — a tag has
 * closed (`>`) earlier on the line and another tag (`<`) follows the
 * expression. Review N1: leading text before the `{` (`<div>Label:
 * {row.status}</div>`) no longer defeats detection. Conservative by
 * construction — attribute (`=`) and template (`$`) positions are excluded by
 * RAW_ENUM_CHILD_RE's leading boundary class:
 *
 *   FLAGS    `{result.status}` (child), `>{r.credential_type}<`,
 *            `<div>Label: {row.status}</div>` (leading text)
 *   IGNORES  `${res.status}` (template/HTTP code), `status={x.status}` (attr),
 *            `key={x.status}` (attr), `{x.public_id}` (field not in the risky
 *            set), and anything in a non-`.tsx` file (the pattern is JSX-specific).
 *
 * Known deliberate blind spots (documented in scripts/agents.md): a defaulted
 * child `{x.status || ''}`, a call-result child `{getX().status}`, and a
 * template-literal child are NOT matched — the regex targets the bare
 * `{ident.field}` shape only, by design, to keep false positives near zero.
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

  // JSX expression child: a tag closed (`>`) before the `{…}` on this line AND
  // another tag (`<`) follows it. .trimEnd()/.indexOf avoid the super-linear
  // `\s+$` regex flagged by SonarCloud S5852 (review B3).
  const beforeExpr = line.slice(0, exprStart).trimEnd();
  const afterExpr = line.slice(exprStart).replace(LEADING_BRACE_EXPR_RE, '');
  const inJsxChild = beforeExpr.includes('>') && afterExpr.includes('<');

  if (!exprOnly && !inJsxChild) return [];

  const fieldMatch = ENUM_FIELD_RE.exec(line.slice(exprStart));
  const field = fieldMatch ? fieldMatch[1].trim() : line.slice(exprStart).trim();
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

/**
 * Normalise a term for the baseline match key. Literal forbidden matches keep
 * the source casing of the matched substring (`Hash` vs `hash`), so the key
 * lower-cases and trims to stay stable across casing/whitespace. The dynamic
 * `raw enum render: {field}` term is already deterministic; lower-casing it is
 * harmless.
 */
function normaliseTerm(term: string): string {
  return term.trim().toLowerCase();
}

const MATCH_KEY_SEP = '\\0';

// Match key = normalised file + line + normalised term. SCRUM-2149 fix2:
// `term` is part of the key (NUL-separated at runtime so it can never collide with the
// `:line` segment) so that a NEW, *different* banned term/raw-enum added to an
// already-grandfathered line is reported as `fresh` (→ fails CI) instead of
// being silently tolerated as "existing". A violation is grandfathered only
// when file + line + term all match a recorded baseline entry.
function baselineKey(file: string, line: number, term: string): string {
  return `${normaliseFile(file)}:${line}${MATCH_KEY_SEP}${normaliseTerm(term)}`;
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
 * surface {stale} baseline entries. Match key = normalised file + line + term
 * (SCRUM-2149 fix2): a violation is grandfathered ONLY when its file, line, and
 * term all match a recorded entry. A *different* banned term/raw-enum on an
 * already-baselined line is therefore reported as `fresh` (fails CI) rather than
 * silently tolerated — closing the blind spot where the term was excluded from
 * the key. Pure — exported for unit tests.
 */
export function partitionAgainstBaseline(
  violations: Violation[],
  baseline: BaselineEntry[],
): BaselinePartition {
  const baselineKeys = new Set(baseline.map((e) => baselineKey(e.file, e.line, e.term)));
  const matchedKeys = new Set<string>();

  const fresh: Violation[] = [];
  const grandfathered: Violation[] = [];

  for (const v of violations) {
    const key = baselineKey(v.file, v.line, v.term);
    if (!isNonSuppressibleTerm(v.term) && baselineKeys.has(key)) {
      grandfathered.push(v);
      matchedKeys.add(key);
    } else {
      fresh.push(v);
    }
  }

  const stale = baseline.filter((e) => !matchedKeys.has(baselineKey(e.file, e.line, e.term)));
  return { fresh, grandfathered, stale };
}

// =============================================================================
// UX-03 follow-up — SCRUM-1672 sanctioned-copy allowlist (permanent policy).
// Distinct from the grandfather baseline (transient debt): this file records
// PERMANENT §1.3 carve-outs, keyed on normalised (file, term) with NO line
// number, so it is immune to copy.ts line drift.
// =============================================================================

const ALLOWLIST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ci',
  'snapshots',
  'copy-terms-allowlist.json',
);

/** One sanctioned-copy carve-out. `term` must be in {@link ALLOWLISTABLE_TERMS}. */
export interface AllowlistEntry {
  file: string;
  term: string;
  reason: string;
}

export function loadAllowlist(allowlistPath: string = ALLOWLIST_PATH): AllowlistEntry[] {
  try {
    const raw = fs.readFileSync(allowlistPath, 'utf-8');
    const parsed = JSON.parse(raw) as { allow?: AllowlistEntry[] };
    if (!parsed || !Array.isArray(parsed.allow)) return [];
    return parsed.allow.filter(
      (e): e is AllowlistEntry =>
        !!e &&
        typeof e.file === 'string' &&
        e.file.trim().length > 0 &&
        typeof e.term === 'string' &&
        typeof e.reason === 'string' &&
        e.reason.trim().length > 0 &&
        ALLOWLISTABLE_TERMS.has(normaliseTerm(e.term)) &&
        !isNonSuppressibleTerm(e.term),
    );
  } catch {
    return [];
  }
}

export interface AllowlistPartition {
  /** Violations pardoned by a sanctioned-copy allowlist entry. */
  allowed: Violation[];
  /** Violations NOT pardoned — passed on to the baseline partition. */
  remaining: Violation[];
  /** Allowlist entries with no matching current violation — prompt cleanup. */
  staleAllow: AllowlistEntry[];
}

export function partitionAgainstAllowlist(
  violations: Violation[],
  allowlist: AllowlistEntry[],
): AllowlistPartition {
  const allowKeys = new Set(
    allowlist.map((e) => `${normaliseFile(e.file)}${MATCH_KEY_SEP}${normaliseTerm(e.term)}`),
  );
  const matched = new Set<string>();
  const allowed: Violation[] = [];
  const remaining: Violation[] = [];

  for (const v of violations) {
    const term = normaliseTerm(v.term);
    const key = `${normaliseFile(v.file)}${MATCH_KEY_SEP}${term}`;
    if (ALLOWLISTABLE_TERMS.has(term) && !isNonSuppressibleTerm(v.term) && allowKeys.has(key)) {
      allowed.push(v);
      matched.add(key);
    } else {
      remaining.push(v);
    }
  }

  const staleAllow = allowlist.filter(
    (e) => !matched.has(`${normaliseFile(e.file)}${MATCH_KEY_SEP}${normaliseTerm(e.term)}`),
  );
  return { allowed, remaining, staleAllow };
}

/**
 * @param jsxTextContinuation PR #1433 follow-up: true when {@link scanFileContent}
 *   determined this line is RAW JSX ELEMENT TEXT continued from a previous line
 *   (e.g. the middle of a wrapped `<p>…</p>` paragraph). Such a line often has
 *   neither a quote char nor a same-line `<`/`>` pair, so the quote/JSX
 *   short-circuit below would skip it — the blind spot that let the literal
 *   "Bitcoin blockchain" ship to prod in src/components/verification. In this
 *   mode the line is user-visible copy BY CONSTRUCTION: balanced `{…}` JSX
 *   expressions are blanked out (they are code, scanned via their own lines'
 *   normal path) and every remaining forbidden-term match flags with no
 *   isCodeIdentifier suppression (there are no code positions in raw text).
 */
export function findTermViolations(
  line: string,
  lineNum: number,
  filePath: string,
  jsxTextContinuation = false,
): Violation[] {
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

  if (jsxTextContinuation) {
    const textOnly = blankJsxExpressions(cleaned);
    for (const regex of FORBIDDEN_REGEXES) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(textOnly)) !== null) {
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

  // Quote/JSX context is a per-line property; computing it once per term
  // saves 6×n includes() calls when the line has many term matches.
  const hasString = cleaned.includes('"') || cleaned.includes("'") || cleaned.includes('`');
  const hasJsxText = cleaned.includes('>') && cleaned.includes('<');
  if (!hasString && !hasJsxText) return results;

  for (const regex of FORBIDDEN_REGEXES) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      if (
        isCodeIdentifier(cleaned, match.index, match[0].length) &&
        !isNonSuppressibleTerm(match[0])
      ) {
        continue;
      }
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

// =============================================================================
// PR #1433 follow-up — cross-line JSX element-text tracking.
//
// The per-line scanner cannot see that a line like
//     `      Bitcoin blockchain at the stated time. Arkova does not verify…`
// is user-visible copy: the enclosing `<p …>` and `</p>` are on OTHER lines, so
// the line has no quote char and no same-line `<`/`>` pair and the forbidden-term
// loop short-circuited. scanFileContent() keeps a small line-to-line state
// machine: are we inside JSX element text, inside a tag that spans lines, or
// inside a `{…}` expression opened from element text? Raw-text continuation
// lines are then force-scanned via findTermViolations(…, jsxTextContinuation).
//
// Known, accepted approximations (all strictly narrower than the old blind spot):
//  - a closing tag ends text state, so raw text on the line AFTER an inline
//    element (`…see <b>the guide</b>\n for details`) is treated as code again;
//  - multi-line template literals are not tracked (per-line quote blanking only);
//  - the state machine never parses TypeScript — a `<` preceded by an
//    identifier char (generics `Array<string>`, comparisons `a<b`) is ignored.
// =============================================================================

/** One frame of nesting: JSX element text, or a `{…}` expression opened from it. */
type JsxFrame = { kind: 'text' } | { kind: 'expr'; depth: number };

interface JsxTextState {
  /**
   * Context stack. Empty = plain code. `text` on top = inside JSX element
   * text (raw lines are user-visible copy). `expr` on top = inside a `{…}`
   * expression (code). Nesting composes: `<div>` text → `{cond && (` expr →
   * `<p>` text → … — so copy inside conditional renders / .map() callbacks is
   * tracked, and a closing tag pops back to the PARENT context instead of
   * killing text state (adversarial review round 2, findings 1/5/6/7).
   */
  stack: JsxFrame[];
  /** A tag (`<p` / `</p`) opened on an earlier line, not yet at its `>`.
   *  `inTemplate` = an attribute template literal (`` className={`…${ ``) is
   *  open inside the tag and must close before tag parsing resumes. */
  pendingTag: { closing: boolean; braceDepth: number; inTemplate: boolean } | null;
  /** Inside a `/* … *​/` block comment opened mid-line in code context. */
  inBlockComment: boolean;
  /** Inside a multi-line template literal opened in code context. */
  inTemplate: boolean;
}

function newJsxTextState(): JsxTextState {
  return { stack: [], pendingTag: null, inBlockComment: false, inTemplate: false };
}

/**
 * Blank balanced `{…}` JSX expressions on a raw-text continuation line (they
 * are code — their values are scanned by the normal per-line rules when they
 * span lines, and are never element text). An UNCLOSED `{` blanks to EOL: the
 * rest of the line is the start of a multi-line expression, not copy.
 */
function blankJsxExpressions(line: string): string {
  const out = line.split('');
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== '{') continue;
    let depth = 1;
    let j = i + 1;
    while (j < out.length && depth > 0) {
      if (out[j] === '{') depth++;
      else if (out[j] === '}') depth--;
      j++;
    }
    const end = depth === 0 ? j : out.length;
    for (let k = i; k < end; k++) out[k] = ' ';
    i = end - 1;
  }
  return out.join('');
}

/** Index just past the closing quote of the string starting at `i`, or the
 *  line length if unterminated on this line. Handles backslash escapes. */
function skipQuoted(line: string, i: number): number {
  const quote = line[i];
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === '\\') j += 2;
    else if (line[j] === quote) return j + 1;
    else j++;
  }
  return line.length;
}

/** True when a `/` at `i` starts a REGEX literal rather than division: the
 *  last non-space char before it is an operator/opening punctuator (or line
 *  start). Conservative — a miss just means the regex body is walked as code. */
function startsRegexLiteral(line: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && line[k] === ' ') k--;
  if (k < 0) return true;
  return '=(,;:![&|?{}+*%~^<>'.includes(line[k]);
}

/** Index just past the closing `/` of the regex literal at `i`, or -1 when it
 *  does not terminate on this line (then it was division — walk on). */
function skipRegexLiteral(line: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < line.length) {
    const c = line[j];
    if (c === '\\') j += 2;
    else if (c === '[') { inClass = true; j++; }
    else if (c === ']') { inClass = false; j++; }
    else if (c === '/' && !inClass) return j + 1;
    else j++;
  }
  return -1;
}

const TAG_NOT_A_TAG = -1;
const TAG_SPANS_LINES = -2;

// TSX generic shapes that are NOT JSX tags even though `<Letter` follows an
// operator: `<T extends …>(…)` and `<T,>` — TypeScript itself mandates these
// exact spellings for arrow generics in .tsx BECAUSE of the JSX ambiguity, so
// matching just these two closes the generic-arrow hole (review finding 2).
const GENERIC_PARAM_RE = /^[A-Za-z_$][\w$]*(?:\s+extends\b|\s*,)/;

/**
 * Try to consume a JSX tag starting at the `<` at index `i`. Returns the index
 * to continue from, TAG_NOT_A_TAG when this `<` is not a tag (comparison,
 * generic — caller advances by one), or TAG_SPANS_LINES when the tag continues
 * on the next line (pendingTag recorded). `prose` = we are inside element text,
 * where an abutting prev char (`text</b>`) must NOT veto the tag (review
 * finding 1: the prev-char guard is a CODE-context disambiguator only).
 */
function tryConsumeTag(line: string, i: number, state: JsxTextState, prose: boolean): number {
  const next = line[i + 1] ?? '';
  const closing = next === '/';
  const fragmentOpen = next === '>';

  if (!closing && !fragmentOpen) {
    if (!/[A-Za-z]/.test(next)) return TAG_NOT_A_TAG;
    if (!prose) {
      const prev = i > 0 ? line[i - 1] : '';
      if (/[\w$)\]]/.test(prev)) return TAG_NOT_A_TAG; // Array<string>, x<y
      if (GENERIC_PARAM_RE.test(line.slice(i + 1))) return TAG_NOT_A_TAG; // <T extends …> / <T,>
    }
  }

  if (fragmentOpen) {
    state.stack.push({ kind: 'text' });
    return i + 2;
  }

  const walk = { braceDepth: 0, inTemplate: false };
  const gt = walkTagBody(line, i + (closing ? 2 : 1), walk);
  if (gt === -1) {
    state.pendingTag = { closing, braceDepth: walk.braceDepth, inTemplate: walk.inTemplate };
    return TAG_SPANS_LINES;
  }
  applyTagEnd(state, closing, line[gt - 1] === '/');
  return gt + 1;
}

/**
 * Walk tag-attribute characters from `j` to the tag's `>` at `{}`-depth 0,
 * honouring quoted attribute values, attribute-expression braces, and template
 * literals — a multi-line `` className={`… ${ `` template is opaque until its
 * closing backtick (adversarial review round 2, ApiSandbox className shape).
 * Returns the `>` index, or -1 when the tag continues on the next line (walk
 * state updated for the caller to persist in pendingTag).
 */
function walkTagBody(line: string, j: number, walk: { braceDepth: number; inTemplate: boolean }): number {
  while (j < line.length) {
    if (walk.inTemplate) {
      while (j < line.length && line[j] !== '`') j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length) return -1;
      walk.inTemplate = false;
      j++;
      continue;
    }
    const c = line[j];
    if (c === '"' || c === "'") { j = skipQuoted(line, j); continue; }
    if (c === '`') { walk.inTemplate = true; j++; continue; }
    if (c === '{') { walk.braceDepth++; j++; continue; }
    if (c === '}') { walk.braceDepth = Math.max(0, walk.braceDepth - 1); j++; continue; }
    if (c === '>' && walk.braceDepth === 0) return j;
    j++;
  }
  return -1;
}

/** Apply the stack transition for a completed tag. */
function applyTagEnd(state: JsxTextState, closing: boolean, selfClosing: boolean): void {
  if (closing) {
    // `</p>` / `</>` closes the innermost text frame (back to parent context).
    if (state.stack[state.stack.length - 1]?.kind === 'text') state.stack.pop();
  } else if (!selfClosing) {
    state.stack.push({ kind: 'text' });
  }
}

/** Resume a tag that spans lines; returns index past its `>` or -1 (still open). */
function resumePendingTag(line: string, state: JsxTextState): number {
  const pending = state.pendingTag;
  if (pending === null) return 0;
  const gt = walkTagBody(line, 0, pending);
  if (gt === -1) return -1;
  applyTagEnd(state, pending.closing, gt > 0 && line[gt - 1] === '/');
  state.pendingTag = null;
  return gt + 1;
}

/**
 * Advance the cross-line JSX state machine over one source line.
 *
 * Contexts: element TEXT (top of stack) treats quotes, slashes, and braces'
 * neighbours as prose — only `{` (opens an expression frame) and `<` (a tag)
 * are structural, so apostrophes ("Here's") and URLs in copy can't corrupt
 * state (review finding 3). CODE/EXPR contexts skip strings, template
 * literals, `//` and `/* *​/` comments, and regex literals (review finding 4),
 * count expression braces, and recognise tags with the generic/comparison
 * guard. All tag ends honour `{}` depth and quoted attribute values.
 */
function updateJsxTextState(line: string, state: JsxTextState): void {
  let i = 0;

  if (state.inBlockComment) {
    const e = line.indexOf('*/');
    if (e === -1) return;
    state.inBlockComment = false;
    i = e + 2;
  } else if (state.inTemplate) {
    let j = 0;
    while (j < line.length && line[j] !== '`') j += line[j] === '\\' ? 2 : 1;
    if (j >= line.length) return;
    state.inTemplate = false;
    i = j + 1;
  }

  if (state.pendingTag !== null) {
    const r = resumePendingTag(line.slice(i), state);
    if (r === -1) return;
    i += r;
  }

  while (i < line.length) {
    const top = state.stack[state.stack.length - 1];
    const ch = line[i];

    if (top?.kind === 'text') {
      if (ch === '{') {
        state.stack.push({ kind: 'expr', depth: 1 });
        i++;
      } else if (ch === '<') {
        const r = tryConsumeTag(line, i, state, true);
        if (r === TAG_SPANS_LINES) return;
        i = r === TAG_NOT_A_TAG ? i + 1 : r;
      } else {
        i++; // prose — quotes, slashes, `>` etc. are just copy
      }
      continue;
    }

    // CODE (empty stack) or EXPR frame.
    if (ch === '"' || ch === "'") { i = skipQuoted(line, i); continue; }
    if (ch === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== '`') j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length) { state.inTemplate = true; return; }
      i = j + 1;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') return; // line comment
    if (ch === '/' && line[i + 1] === '*') {
      const e = line.indexOf('*/', i + 2);
      if (e === -1) { state.inBlockComment = true; return; }
      i = e + 2;
      continue;
    }
    if (ch === '/' && startsRegexLiteral(line, i)) {
      const e = skipRegexLiteral(line, i);
      if (e !== -1) { i = e; continue; }
      i++; // unterminated on this line → it was division
      continue;
    }
    if (top !== undefined && ch === '{') { top.depth++; i++; continue; }
    if (top !== undefined && ch === '}') {
      top.depth--;
      if (top.depth === 0) state.stack.pop();
      i++;
      continue;
    }
    if (ch === '<') {
      const r = tryConsumeTag(line, i, state, false);
      if (r === TAG_SPANS_LINES) return;
      i = r === TAG_NOT_A_TAG ? i + 1 : r;
      continue;
    }
    i++;
  }
}

/**
 * Scan one file's CONTENT line-by-line, carrying block-comment state (as
 * before) plus the cross-line JSX-text state machine. A line is force-scanned
 * as raw copy (jsxTextContinuation) when we are inside JSX element text, no
 * tag or `{…}` expression is spanning lines, and the line itself has no angle
 * bracket (lines WITH tags are handled by the normal per-line rules).
 * Exported for unit tests; checkFile() delegates here.
 */
export function scanFileContent(content: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');
  let inBlockComment = false;
  // JSX can only appear in .tsx — running the tag tracker on plain .ts would
  // misread generics/comparisons (`if (a <b)`) with no possible payoff.
  const trackJsx = filePath.endsWith('.tsx');
  const jsx = newJsxTextState();

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
      // A line-skip suppresses vocab false-positives (`crypto.subtle`→"crypto",
      // the DOM `block:` param, URL `token` key). On a real CODE line it must
      // NEVER hide a secret / launch-blocker leak in a same-line shipped string
      // (e.g. `toast('service_role failed'); el.scrollIntoView()`), so we still
      // scan those for the non-suppressible terms. Comments and imports are
      // exempt — they are not shipped copy and legitimately mention infra terms.
      const isCommentOrImport =
        trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('import ');
      if (!isCommentOrImport) {
        violations.push(
          ...findTermViolations(line, i + 1, filePath).filter((v) => isNonSuppressibleTerm(v.term)),
        );
      }
      // Skipped for normal SCANNING only — the line still advances the JSX state
      // machine (e.g. a copy line exempted via `cryptographic` is still text).
      if (trackJsx) updateJsxTextState(line, jsx);
      continue;
    }

    // Force-scan as raw copy when element text is the current context and the
    // line has no tag start (`<`). A bare `>` is fine — it is prose ("> 6
    // confirmations"); lines WITH tags go through the normal per-line rules.
    const isJsxTextContinuation =
      trackJsx &&
      jsx.stack[jsx.stack.length - 1]?.kind === 'text' &&
      jsx.pendingTag === null &&
      !jsx.inBlockComment &&
      !jsx.inTemplate &&
      !line.includes('<');

    violations.push(...findTermViolations(line, i + 1, filePath, isJsxTextContinuation));
    if (trackJsx) updateJsxTextState(line, jsx);
  }

  return violations;
}

export function checkFile(filePath: string): Violation[] {
  return scanFileContent(fs.readFileSync(filePath, 'utf-8'), filePath);
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

  // SCRUM-1672 sanctioned-copy allowlist (permanent §1.3 policy) runs FIRST —
  // it pardons the "Issue Credential" restricted-flow strings in copy.ts.
  const allowlist = loadAllowlist();
  const { allowed, remaining, staleAllow } = partitionAgainstAllowlist(allViolations, allowlist);

  // SCRUM-2148: whatever the allowlist did NOT pardon is partitioned against the
  // grandfather baseline (transient debt). Only NEW (fresh) violations fail.
  const baseline = loadBaseline();
  const { fresh, grandfathered, stale } = partitionAgainstBaseline(remaining, baseline);

  if (allowed.length > 0) {
    console.log(
      `Allowing ${allowed.length} sanctioned copy string(s) via copy-terms-allowlist.json (SCRUM-1672 permanent carve-out).\n`,
    );
  }

  if (staleAllow.length > 0) {
    console.log(
      `⚠️  ${staleAllow.length} stale allowlist entr(y/ies) — no longer matching any violation, consider removing from copy-terms-allowlist.json:`,
    );
    for (const e of staleAllow) {
      console.log(`    - ${e.file} ("${e.term}")`);
    }
    console.log('');
  }

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
