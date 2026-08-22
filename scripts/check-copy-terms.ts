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

// §1.3 worker-email parity: outbound EMAIL is user-visible copy generated in
// `services/worker/`, which INCLUDE_ROOTS never reached — `lint:copy` stayed
// green while customer subjects/bodies went unscanned, even though both email
// agents.md files already carried the rule with nothing enforcing it.
//
// Scope is deliberately NOT all of services/worker/src: §1.3 bans these terms
// in USER-VISIBLE strings and explicitly allows internal code to use technical
// names, so scanning the worker wholesale would bury the gate in false
// positives (`.select('tx_hash')`, `crypto.randomBytes`, 'broadcast' log
// lines). Two admission paths instead:
//
//   ROOTS      — modules whose ENTIRE contents are email copy by construction
//                (template builders + the shared branded layout helpers).
//   COMPOSERS  — files elsewhere under services/worker/src that the CONTENT
//                detector proves build email copy (a `subject`/`html` literal
//                or a wrapTemplate() call, in a module wired to the email
//                infrastructure). Content-derived on purpose: a hand-maintained
//                path census rots the moment the next digest job lands, which
//                is exactly how `jobs/queue-digest.ts` came to be unscanned.
const WORKER_COPY_ROOTS = [
  'services/worker/src/email/',
  'services/worker/src/emails/',
];

/** Walk root for COMPOSER detection (a superset of WORKER_COPY_ROOTS). */
const WORKER_SRC_ROOT = 'services/worker/src/';

// Wired to the email infrastructure: imports the sender / shared template
// helpers, or calls sendEmail(). Necessary but NOT sufficient — a pure sender
// (`sendEmail({ to, subject, html })` where both came from a builder) composes
// no copy of its own and stays out of scope; its copy is scanned once, at the
// builder in email/templates.ts.
const EMAIL_INFRA_RE =
  /from\s+['"][^'"]*(?:email\/sender|email\/index|emails\/_template)(?:\.js)?['"]|\bsendEmail\s*\(/;

// Composes copy: a `subject` assigned a STRING/TEMPLATE literal, an `html`
// template literal, or a wrapTemplate() call. `subject: string;` (a type
// member) and `subject,` (shorthand pass-through) deliberately do not match.
const EMAIL_COPY_LITERAL_RE =
  /\bwrapTemplate\s*\(|\bsubject\s*[:=]\s*[`'"]|\bhtml\s*[:=]\s*`/;

/**
 * True when `content` both reaches the email infrastructure AND builds email
 * copy of its own — i.e. the file is an email-copy COMPOSER whose strings ship
 * to a recipient's inbox. Conservative by construction: a comment that merely
 * mentions `wrapTemplate` only ever widens the scan (more copy checked), never
 * narrows it. Exported for unit tests.
 */
export function isEmailCopyComposer(content: string): boolean {
  return EMAIL_INFRA_RE.test(content) && EMAIL_COPY_LITERAL_RE.test(content);
}

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

/** Repo-relative POSIX form of `filePath` (absolute paths are made relative). */
function toRelativePosix(filePath: string, root: string = process.cwd()): string {
  return (path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath)
    .split(path.sep)
    .join('/');
}

/**
 * True when `filePath` is in scope for the copy-term scan. Exported for unit
 * tests. Accepts absolute or repo-relative paths and normalises to POSIX
 * separators so the prefix/glob checks behave identically on Windows.
 *
 * `content` is OPTIONAL and only ever WIDENS scope: a file under
 * services/worker/src that is not in a worker copy root is admitted when — and
 * only when — its content proves it composes email copy
 * ({@link isEmailCopyComposer}). Without content the answer for such a path is
 * `false`, so every caller that wants worker-email coverage must read the file
 * (see collectCandidateFiles) rather than guessing from the path.
 */
function isExcluded(relativePath: string): boolean {
  return EXCLUDE_PATTERNS.some((pattern) => globToRegex(pattern).test(relativePath));
}

export function shouldCheck(filePath: string, content?: string): boolean {
  const relativePath = toRelativePosix(filePath);

  // Check exclusions first (tests, ui primitives, treasury admin,
  // node_modules/dist).
  if (isExcluded(relativePath)) return false;

  if (INCLUDE_ROOTS.some((root) => relativePath.startsWith(root))) return true;
  if (WORKER_COPY_ROOTS.some((root) => relativePath.startsWith(root))) return true;

  // Worker email-copy composers outside those roots (jobs/*-digest.ts …).
  // Everything else under services/worker/src is internal code, which §1.3
  // explicitly permits to use technical names.
  if (relativePath.startsWith(WORKER_SRC_ROOT) && content !== undefined) {
    return isEmailCopyComposer(content);
  }

  return false;
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
 * Neutralise the one CSS declaration that collides with a banned term.
 *
 * §1.3 worker-email parity: HTML email bodies carry INLINE CSS
 * (`style="display: block; padding: 12px;"` on a button) because email clients
 * strip stylesheets — and `display: block` is the only banned term that is a
 * legitimate CSS value. The frontend never hit this: `className` values are
 * stripped wholesale and `style={{ display: 'block' }}` is a bare in-code value
 * string. Only the `display:`/`block` PAIR is blanked — never the whole
 * attribute — so visible copy sitting beside the style attribute is still
 * scanned (`style="display: block">Open your Bitcoin wallet</a>` still flags).
 */
function stripCssPresentation(line: string): string {
  return line.replaceAll(/\bdisplay\s*:\s*block\b/gi, 'display:_');
}

/**
 * Sanitises a JSX/TS line so the term scan only sees user-visible copy.
 * Strips className/class attribute values (Tailwind utilities like
 * "inline-block" are noise), inline `display: block` CSS, and JSX comments (so
 * engineering notes can mention banned terms without tripping the lint).
 *
 * Exported for unit tests.
 */
export function stripClassNameAttributes(line: string): string {
  let out = stripCssPresentation(line);
  out = out.replaceAll(/className\s*=\s*"[^"]*"/g, 'className=""');
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
 * Collect one {@link Violation} per match of every regex in `regexes` against
 * `haystack`. Extracted so the three scan passes in {@link findTermViolations}
 * (launch-blocker terms, raw-copy terms, code-aware terms) share one loop
 * instead of three copies of the same regex/exec/push nest.
 *
 * `context` is supplied by the caller rather than derived from `haystack`: a
 * pass may scan a transformed variant of the line (raw-copy mode blanks `{…}`
 * expressions) while still reporting the original cleaned line as the snippet.
 * `isSuppressed` — when supplied — drops a match the pass considers a code
 * position rather than copy.
 */
function collectTermMatches(
  regexes: RegExp[],
  haystack: string,
  lineNum: number,
  filePath: string,
  context: string,
  isSuppressed?: (haystack: string, match: RegExpExecArray) => boolean,
): Violation[] {
  const found: Violation[] = [];
  for (const regex of regexes) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(haystack)) !== null) {
      if (isSuppressed?.(haystack, match)) continue;
      found.push({ file: filePath, line: lineNum, term: match[0], context });
    }
  }
  return found;
}

/**
 * True when a forbidden-term match sits in a code position that is never copy
 * ({@link isCodeIdentifier}) AND the term is one the structural filter is
 * ALLOWED to silence. A secret / launch-blocker leak is never suppressed —
 * see the non-suppressible guard in {@link isNonSuppressibleTerm}.
 */
function isSuppressedCodePosition(haystack: string, match: RegExpExecArray): boolean {
  return (
    isCodeIdentifier(haystack, match.index, match[0].length) && !isNonSuppressibleTerm(match[0])
  );
}

/**
 * @param rawCopyContinuation PR #1433 follow-up: true when {@link scanFileContent}
 *   determined this line is RAW COPY continued from a previous line — the
 *   middle of a wrapped `<p>…</p>` JSX paragraph, or the middle of a wrapped
 *   paragraph inside a multi-line template literal (worker email HTML, the
 *   src/lib/copy.ts disclaimer, an embed-widget string). Such a
 *   line often has neither a quote char nor a same-line `<`/`>` pair, so the
 *   quote/JSX short-circuit below would skip it — the blind spot that let the
 *   literal "Bitcoin blockchain" ship to prod in src/components/verification.
 *   In this mode the line is user-visible copy BY CONSTRUCTION: balanced `{…}`
 *   expressions are blanked out (they are code — including a template's
 *   `${…}` interpolations — and are scanned via their own lines' normal path)
 *   and every remaining forbidden-term match flags with no isCodeIdentifier
 *   suppression (there are no code positions in raw text).
 */
export function findTermViolations(
  line: string,
  lineNum: number,
  filePath: string,
  rawCopyContinuation = false,
): Violation[] {
  const cleaned = stripClassNameAttributes(line);
  // Reported snippet. Always derived from the CLEANED line, never from the
  // haystack a pass scans — raw-copy mode scans a brace-blanked variant.
  const context = cleaned.trim().substring(0, 80);

  const results = collectTermMatches(LAUNCH_BLOCKER_REGEXES, cleaned, lineNum, filePath, context);

  // SCRUM-2149(c): raw DB-enum render heuristic (JSX-child {X.status}). Runs on
  // the cleaned line (so className braces are already neutralised) and is gated
  // to .tsx inside findRawEnumRenders.
  results.push(...findRawEnumRenders(cleaned, lineNum, filePath));

  if (rawCopyContinuation) {
    const textOnly = blankJsxExpressions(cleaned);
    results.push(...collectTermMatches(FORBIDDEN_REGEXES, textOnly, lineNum, filePath, context));
    return results;
  }

  // Quote/JSX context is a per-line property; computing it once per term
  // saves 6×n includes() calls when the line has many term matches.
  const hasString = cleaned.includes('"') || cleaned.includes("'") || cleaned.includes('`');
  const hasJsxText = cleaned.includes('>') && cleaned.includes('<');
  if (!hasString && !hasJsxText) return results;

  results.push(
    ...collectTermMatches(
      FORBIDDEN_REGEXES,
      cleaned,
      lineNum,
      filePath,
      context,
      isSuppressedCodePosition,
    ),
  );
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

// =============================================================================
// Cross-line TEMPLATE-LITERAL text tracking — the non-JSX half of PR #1433.
//
// Copy inside a multi-line template literal has the SAME blind spot the JSX
// tracker above closes for .tsx: a wrapped paragraph's middle line
//     `      secured to the Bitcoin blockchain and can be verified at any time.`
// carries no quote char and no same-line `<`/`>` pair, so findTermViolations
// short-circuits on `!hasString && !hasJsxText` and the term ships. The JSX
// machine cannot help — it only runs on .tsx.
//
// Worker email bodies were the first instance (HTML inside a template
// literal). The frontend `.ts` roots INCLUDE_ROOTS already admits have it too,
// and the motivating case is `src/lib/copy.ts` itself: DISCLAIMER_LABELS.body
// is the platform legal disclaimer — the most compliance-sensitive string we
// ship — and every line after the first was unscanned. So the gate was green
// over the one paragraph §1.3 most exists to police, in the very file its
// failure message points offenders at.
//
// Deliberately minimal: one boolean (are we inside an unterminated backtick
// string?), no JSX/tag parsing. Only lines that are FULLY inside a template
// literal — no backtick of their own, no `<` — are force-scanned as raw copy;
// markup lines keep the normal per-line rules (which already flag visible text
// between tags, with the URL/quoted-value suppressions intact).
// =============================================================================

/**
 * True for every scanned file that is NOT .tsx — the exact complement of
 * `trackJsx`, so each file gets exactly ONE cross-line raw-copy tracker.
 *
 * Scope is the whole non-.tsx in-scope set rather than a second root list:
 * INCLUDE_ROOTS (+ the worker copy roots and detected composers) is already
 * the curated "this is user-visible copy" admission decision, and a parallel
 * list would be free to drift from it — the exact failure collectCandidateFiles
 * exists to prevent. A content detector is the wrong tool here too: the worker
 * needs `isEmailCopyComposer` because services/worker/src is overwhelmingly
 * internal code, which §1.3 explicitly permits to use technical names; the
 * frontend roots are the opposite, and such a detector would have excluded the
 * copy.ts disclaimer that motivated this.
 *
 * The false-positive vectors this guards against are excluded structurally,
 * not by luck: block-comment lines `continue` in scanFileContent BEFORE the
 * tracker advances (so JSDoc's stray backticks can never open a literal),
 * single-line literals open no continuation, and any line carrying `<` keeps
 * the normal per-line path (SVG/HTML builders like src/lib/badgeSvg.ts).
 * Measured over the in-scope frontend: 7 force-scanned lines total, 6 of them
 * the copy.ts disclaimer and 1 a `${…}` interpolation.
 */
function tracksTemplateText(filePath: string): boolean {
  return !filePath.endsWith('.tsx');
}

/** Template-literal tracker state: are we inside an unterminated backtick? */
type TemplateTextState = { inTemplate: boolean };

/**
 * Advance one character while INSIDE a template literal, and return the next
 * index. A backslash escapes the following character (so `` \` `` does not
 * close the literal); an unescaped backtick closes it.
 */
function stepInsideTemplate(line: string, i: number, state: TemplateTextState): number {
  const ch = line[i];
  if (ch === '\\') return i + 2;
  if (ch === '`') state.inTemplate = false;
  return i + 1;
}

/**
 * Advance one character while OUTSIDE a template literal, and return the next
 * index. A quoted string is skipped wholesale (a backtick inside `'…'` opens
 * nothing); a `//` comment ends the line (returns `line.length`); a backtick
 * opens a template literal.
 */
function stepOutsideTemplate(line: string, i: number, state: TemplateTextState): number {
  const ch = line[i];
  if (ch === '/' && line[i + 1] === '/') return line.length; // line comment — not code
  if (ch === '"' || ch === "'") return skipQuoted(line, i);
  if (ch === '`') state.inTemplate = true;
  return i + 1;
}

/**
 * Advance the minimal template-literal tracker over one line. Skips quoted
 * strings (a backtick inside `'…'` opens nothing) and line comments, and
 * honours backslash escapes. The per-character work lives in the two
 * {@link stepInsideTemplate} / {@link stepOutsideTemplate} halves so neither
 * branch has to be read through the other.
 */
function updateTemplateTextState(line: string, state: TemplateTextState): void {
  let i = 0;
  while (i < line.length) {
    i = state.inTemplate
      ? stepInsideTemplate(line, i, state)
      : stepOutsideTemplate(line, i, state);
  }
}

/** Per-file cursor for the two cross-line trackers scanFileContent carries. */
interface FileScanState {
  /** JSX tag/text tracking is .tsx-only (see scanFileContent). */
  trackJsx: boolean;
  jsx: JsxTextState;
  /** Email template-literal tracking is worker-non-.tsx-only. */
  trackTemplateText: boolean;
  template: TemplateTextState;
}

/**
 * Classify one line against the running block-comment state and return both
 * whether the line is skipped and the state to carry forward. Opening and
 * continuing a block comment collapse to the same answer: the line is skipped,
 * and the comment stays open unless the line closes it.
 */
function stepBlockComment(
  trimmed: string,
  inBlockComment: boolean,
): { skip: boolean; inBlockComment: boolean } {
  if (!inBlockComment && !trimmed.startsWith('/*')) return { skip: false, inBlockComment: false };
  return { skip: true, inBlockComment: !trimmed.includes('*/') };
}

/**
 * Violations still reported on a line that {@link shouldSkipLine} suppressed.
 *
 * A line-skip suppresses vocab false-positives (`crypto.subtle`→"crypto", the
 * DOM `block:` param, URL `token` key). On a real CODE line it must NEVER hide
 * a secret / launch-blocker leak in a same-line shipped string (e.g.
 * `toast('service_role failed'); el.scrollIntoView()`), so those are still
 * scanned for the non-suppressible terms. Comments and imports are exempt —
 * they are not shipped copy and legitimately mention infra terms.
 */
function scanSkippedLine(
  line: string,
  trimmed: string,
  lineNum: number,
  filePath: string,
): Violation[] {
  const isCommentOrImport =
    trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('import ');
  if (isCommentOrImport) return [];
  return findTermViolations(line, lineNum, filePath).filter((v) => isNonSuppressibleTerm(v.term));
}

/** Advance whichever cross-line trackers this file uses over one line. */
function advanceScanState(line: string, scan: FileScanState): void {
  if (scan.trackJsx) updateJsxTextState(line, scan.jsx);
  if (scan.trackTemplateText) updateTemplateTextState(line, scan.template);
}

/**
 * True when the line must be force-scanned as RAW COPY continued from an
 * earlier line. Two sources, one rule:
 *
 *  - JSX element text is the current context (no tag or `{…}` expression is
 *    spanning lines), or
 *  - an email template literal is open and the line neither closes nor
 *    reopens one.
 *
 * Either way the line must carry no tag start (`<`) — a bare `>` is fine, it
 * is prose ("> 6 confirmations"); lines WITH tags go through the normal
 * per-line rules.
 */
function isRawCopyContinuation(line: string, scan: FileScanState): boolean {
  if (line.includes('<')) return false;

  const inJsxText =
    scan.trackJsx &&
    scan.jsx.stack[scan.jsx.stack.length - 1]?.kind === 'text' &&
    scan.jsx.pendingTag === null &&
    !scan.jsx.inBlockComment &&
    !scan.jsx.inTemplate;

  const inEmailTemplate =
    scan.trackTemplateText && scan.template.inTemplate && !line.includes('`');

  return inJsxText || inEmailTemplate;
}

/**
 * Scan one file's CONTENT line-by-line, carrying block-comment state (as
 * before) plus ONE cross-line raw-copy tracker per file: the JSX-text state
 * machine for `.tsx`, the template-literal text tracker for everything else.
 * A line is force-scanned as raw copy when we are inside JSX element text (or
 * inside a template literal), no tag or `{…}` expression is spanning lines,
 * and the line itself has no angle bracket (lines WITH tags are handled by the
 * normal per-line rules). Exported for unit tests; checkFile() delegates here.
 */
export function scanFileContent(content: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');
  const scan: FileScanState = {
    // JSX can only appear in .tsx — running the tag tracker on plain .ts would
    // misread generics/comparisons (`if (a <b)`) with no possible payoff.
    trackJsx: filePath.endsWith('.tsx'),
    jsx: newJsxTextState(),
    trackTemplateText: tracksTemplateText(filePath),
    template: { inTemplate: false },
  };
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const comment = stepBlockComment(trimmed, inBlockComment);
    inBlockComment = comment.inBlockComment;
    if (comment.skip) continue;

    if (shouldSkipLine(line, trimmed)) {
      violations.push(...scanSkippedLine(line, trimmed, i + 1, filePath));
      // Skipped for normal SCANNING only — the line still advances the JSX and
      // template state machines (e.g. a copy line exempted via `cryptographic`
      // is still element text; a skipped line can still open a template).
      advanceScanState(line, scan);
      continue;
    }

    violations.push(
      ...findTermViolations(line, i + 1, filePath, isRawCopyContinuation(line, scan)),
    );
    advanceScanState(line, scan);
  }

  return violations;
}

export function checkFile(filePath: string): Violation[] {
  return scanFileContent(fs.readFileSync(filePath, 'utf-8'), filePath);
}

/**
 * Walk every in-scope root and return the de-duplicated set of files to scan.
 * SCRUM-2149(a): `packages/embed/src` lives OUTSIDE `src/`, so a single
 * `getAllFiles('src')` walk (the pre-2149 behaviour) could never reach the
 * public widget. We derive the walk roots from INCLUDE_ROOTS so coverage and
 * the `shouldCheck()` predicate can never silently drift apart.
 *
 * §1.3 worker-email parity adds `services/worker/src`: files under the two
 * worker copy roots are admitted by path, and every other worker file is read
 * once and admitted only if {@link isEmailCopyComposer} says it builds email
 * copy. Exported (with an injectable `root`) so tests can prove the walker
 * REACHES a file — admitting a path the walk never visits is the exact shape
 * of the SCRUM-2149(a) bug.
 */
export function collectCandidateFiles(root: string = process.cwd()): string[] {
  const seen = new Set<string>();
  // Distinct top-level dirs to walk (`src` once, `packages/embed/src` once)
  // plus the worker source root, walked directly rather than via its `services`
  // top-level so composer detection never reads a sibling service's tree.
  const walkDirs = new Set([
    ...INCLUDE_ROOTS.map((r) => path.join(root, r.split('/')[0])),
    path.join(root, WORKER_SRC_ROOT),
  ]);
  const out: string[] = [];
  for (const dir of walkDirs) {
    for (const f of getAllFiles(dir)) {
      if (seen.has(f)) continue;
      const rel = toRelativePosix(f, root);
      // Path-only admission first — it is the cheap answer and covers every
      // frontend root plus the two worker email roots.
      if (shouldCheck(rel)) {
        seen.add(f);
        out.push(f);
        continue;
      }
      // Content admission is reserved for worker files that survived the
      // exclusion patterns: read once, ask the composer detector.
      if (!rel.startsWith(WORKER_SRC_ROOT) || isExcluded(rel)) continue;
      if (shouldCheck(rel, fs.readFileSync(f, 'utf-8'))) {
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
    console.log(
      'No UI files to check (src/components, src/pages, src/lib, src/hooks, packages/embed/src, worker email copy).',
    );
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
  console.log('  - worker EMAIL copy (services/worker/src/email*, detected digest builders) is in scope too');
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
