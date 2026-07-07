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

// =============================================================================
// UX-03 follow-up — sanctioned-copy allowlist vocabulary + non-suppressible guard.
// =============================================================================

/**
 * The ONLY terms a copy-terms-allowlist entry may pardon. Deliberately a
 * set-of-one: the sole §1.3-sanctioned term inside src/lib/copy.ts is
 * "Issue Credential" — the restricted verified-organisation issuance action
 * (SCRUM-1672 / §1.3 exception). No other banned term has a sanctioned use in
 * copy.ts, so nothing else is allowlistable. Keeping this tiny bounds the abuse
 * surface: loadAllowlist() drops any entry that names a different term.
 */
export const ALLOWLISTABLE_TERMS = new Set<string>(['issue credential']);

/**
 * Terms that NO suppression channel (the sanctioned-copy allowlist OR the
 * grandfather baseline) may ever silence: engineering-secret leaks
 * (service_role / service role / postgrest), the infra-copy leak "worker
 * service" (UX-03), and every launch-blocker legal placeholder. A violation on
 * one of these ALWAYS lands in `fresh` (fails CI) even if an allowlist/baseline
 * entry nominally matches it. Fail-closed hardening: the baseline is
 * category-blind and could otherwise grandfather a real service_role leak.
 */
const NON_SUPPRESSIBLE_TERMS = new Set<string>([
  'service_role',
  'service role',
  'postgrest',
  'worker service',
  ...LAUNCH_BLOCKER_COPY_TERMS.map((t) => t.trim().toLowerCase()),
]);

/** True when `term` must never be silenced by the allowlist or the baseline. */
export function isNonSuppressibleTerm(term: string): boolean {
  return NON_SUPPRESSIBLE_TERMS.has(term.trim().toLowerCase());
}

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
  // NOTE: src/lib/copy.ts is intentionally NOT excluded — it IS scanned. Its
  // shipped strings are the largest user-facing copy surface; a blanket exclude
  // let banned terms ship silently (UX-03: "worker service" in USAGE_UNAVAILABLE).
  // The sanctioned SCRUM-1672 "Issue Credential" lines pass via the dedicated
  // copy-terms-allowlist.json carve-out, not by excluding the whole file.
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
  // Skip Web Crypto API usage (`crypto.subtle`/`crypto.getRandomValues` — the
  // `.` makes the boundaried `crypto` term match, a false positive). NOTE: we do
  // NOT skip the "cryptographic" adjective — the boundaried `crypto` regex never
  // matches inside "cryptographic" (the trailing `g` blocks `(?!\w)`), so that
  // skip was vestigial AND it hid every OTHER banned term on marketing lines
  // like "SHA-256 cryptographic hash" (a real §1.3 "hash" leak). Removed.
  if (line.includes('crypto.subtle') || line.includes('crypto.getRandomValues')) {
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

// Match key = normalised file + line + normalised term. SCRUM-2149 fix2:
// `term` is part of the key (NUL-separated so it can never collide with the
// `:line` segment) so that a NEW, *different* banned term/raw-enum added to an
// already-grandfathered line is reported as `fresh` (→ fails CI) instead of
// being silently tolerated as "existing". A violation is grandfathered only
// when file + line + term all match a recorded baseline entry.
function baselineKey(file: string, line: number, term: string): string {
  return `${normaliseFile(file)}:${line} ${normaliseTerm(term)}`;
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
    // A secret / launch-blocker leak is NEVER grandfathered, even if a baseline
    // row matches it (fail-closed): those terms are structurally un-suppressible.
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

/**
 * Load the sanctioned-copy allowlist. Fail-closed: a missing/malformed file →
 * [] (nothing pardoned). Each entry must have a non-empty file/term/reason AND
 * name an ALLOWLISTABLE term (and, redundantly, not a non-suppressible one) —
 * an entry naming a secret / launch-blocker / any other term is dropped at
 * load, so the allowlist can never become a channel for silencing those.
 */
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

/**
 * Split violations into {allowed, remaining} against the sanctioned-copy
 * allowlist, surfacing {staleAllow}. A violation is pardoned ONLY when its term
 * is allowlistable (never a secret/launch-blocker — belt-and-suspenders with
 * loadAllowlist's filter) AND a normalised (file, term) allowlist entry
 * matches. Line-independent by design (immune to copy.ts drift). Pure —
 * exported for unit tests.
 */
export function partitionAgainstAllowlist(
  violations: Violation[],
  allowlist: AllowlistEntry[],
): AllowlistPartition {
  const allowKeys = new Set(
    allowlist.map((e) => `${normaliseFile(e.file)}\0${normaliseTerm(e.term)}`),
  );
  const matched = new Set<string>();
  const allowed: Violation[] = [];
  const remaining: Violation[] = [];

  for (const v of violations) {
    const term = normaliseTerm(v.term);
    const key = `${normaliseFile(v.file)}\0${term}`;
    if (ALLOWLISTABLE_TERMS.has(term) && !isNonSuppressibleTerm(v.term) && allowKeys.has(key)) {
      allowed.push(v);
      matched.add(key);
    } else {
      remaining.push(v);
    }
  }

  const staleAllow = allowlist.filter(
    (e) => !matched.has(`${normaliseFile(e.file)}\0${normaliseTerm(e.term)}`),
  );
  return { allowed, remaining, staleAllow };
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
      // Non-suppressible terms (secrets / launch-blockers) are never dropped by a
      // structural-position filter — they have no legitimate code position in a
      // scanned UI file, so a bare-value `'service role'` or an object-key
      // position must still flag. Every other term respects isCodeIdentifier.
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

export function checkFile(filePath: string): Violation[] {
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
      // A line-skip suppresses vocab false-positives (`crypto.subtle`→"crypto",
      // the DOM `block:` param, URL `token` key). On a real CODE line it must
      // NEVER hide a secret / launch-blocker leak in a same-line shipped string
      // (e.g. `toast('service_role failed'); el.scrollIntoView()`), so we still
      // scan those for the non-suppressible terms. Comments and imports are
      // exempt — they are not shipped copy and legitimately mention infra terms
      // (a `// … worker service …` explanatory comment must not flag).
      const isCommentOrImport =
        trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('import ');
      if (!isCommentOrImport) {
        violations.push(
          ...findTermViolations(line, i + 1, filePath).filter((v) => isNonSuppressibleTerm(v.term)),
        );
      }
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
