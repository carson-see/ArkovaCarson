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
  'wallet',
  'gas',
  String.raw`(?<![-\w])hash(?![-\w])`,
  String.raw`(?<![-\w])block(?![-\w])`,
  'transaction',
  'crypto',
  'cryptocurrency',
  'bitcoin',
  'blockchain',
  'mining',
  String.raw`(?<![-\w])token(?![-\w])`,

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

  // SCRUM-1092: "Issue Credential" renamed to "Secure Document"
  String.raw`(?<![-\w])issue credential(?![-\w])`,
];

// File patterns to check (UI-facing files)
// These patterns define which files are scanned for UI copy
const _INCLUDE_PATTERNS = [
  'src/components/**/*.tsx',
  'src/components/**/*.ts',
  'src/pages/**/*.tsx',
  'src/pages/**/*.ts',
  // Exclude the copy.ts file itself (it documents forbidden terms)
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

interface Violation {
  file: string;
  line: number;
  term: string;
  context: string;
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

function shouldCheck(filePath: string): boolean {
  const relativePath = path.relative(process.cwd(), filePath);

  // Check exclusions first
  for (const pattern of EXCLUDE_PATTERNS) {
    if (globToRegex(pattern).test(relativePath)) {
      return false;
    }
  }

  // For now, check all .tsx files in src/components and src/pages
  if (relativePath.startsWith('src/components/') || relativePath.startsWith('src/pages/')) {
    return true;
  }

  return false;
}

// Pre-compile once. Building a new RegExp per line × 13 terms × 224 files was
// the bulk of `lint:copy` runtime.
const FORBIDDEN_REGEXES = FORBIDDEN_TERMS.map((t) => new RegExp(t, 'gi'));

/**
 * Returns true if the line should be skipped (comments, imports, crypto API).
 * className attribute values are stripped separately by
 * {@link stripClassNameAttributes} so JSX text on the same line still gets scanned.
 */
function shouldSkipLine(line: string, trimmed: string): boolean {
  // Skip comments and imports
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ')) {
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
 * Returns true when the matched term is a JSX component name (`<Hash …>`,
 * `</Hash>`) or an object property access (`health.checks.bitcoin.network`)
 * rather than user-visible copy. `/hash-help` in JSX text MUST NOT match —
 * a bare `/` is therefore not a sufficient prefix; only `</` (the JSX
 * closing-tag form) is.
 */
function isCodeIdentifier(line: string, matchIndex: number): boolean {
  if (matchIndex === 0) return false;
  const prev = line[matchIndex - 1];
  if (prev === '<') return true;
  // `</Hash>` — closing tag.
  if (prev === '/' && matchIndex >= 2 && line[matchIndex - 2] === '<') return true;
  // `obj.bitcoin` — property access. Require an identifier char before the
  // dot so a sentence-ending `.` followed by a banned word in the next
  // sentence ("…secure. Bitcoin is…") doesn't get masked.
  if (prev === '.' && matchIndex >= 2 && /[A-Za-z0-9_]/.test(line[matchIndex - 2])) return true;
  return false;
}

function findTermViolations(line: string, lineNum: number, filePath: string): Violation[] {
  const results: Violation[] = [];
  const cleaned = stripClassNameAttributes(line);
  // Quote/JSX context is a per-line property; computing it once per term
  // saves 6×n includes() calls when the line has many term matches.
  const hasString = cleaned.includes('"') || cleaned.includes("'") || cleaned.includes('`');
  const hasJsxText = cleaned.includes('>') && cleaned.includes('<');
  if (!hasString && !hasJsxText) return results;

  for (const regex of FORBIDDEN_REGEXES) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      if (isCodeIdentifier(cleaned, match.index)) continue;
      results.push({
        file: filePath,
        line: lineNum,
        term: match[0],
        context: line.trim().substring(0, 80),
      });
    }
  }
  return results;
}

function checkFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (shouldSkipLine(line, trimmed)) {
      continue;
    }

    violations.push(...findTermViolations(line, i + 1, filePath));
  }

  return violations;
}

function main(): void {
  console.log('Checking UI copy for forbidden terms...\n');

  const srcDir = path.join(process.cwd(), 'src');
  const allFiles = getAllFiles(srcDir);
  const filesToCheck = allFiles.filter(shouldCheck);

  if (filesToCheck.length === 0) {
    console.log('No UI files to check (src/components or src/pages).');
    console.log('This is expected if no UI components exist yet.\n');
    process.exit(0);
  }

  console.log(`Checking ${filesToCheck.length} file(s)...\n`);

  const allViolations: Violation[] = [];

  for (const file of filesToCheck) {
    const violations = checkFile(file);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log('No forbidden terms found. UI copy is compliant.\n');
    process.exit(0);
  }

  console.log(`Found ${allViolations.length} violation(s):\n`);

  for (const v of allViolations) {
    const relativePath = path.relative(process.cwd(), v.file);
    console.log(`  ${relativePath}:${v.line}`);
    console.log(`    Term: "${v.term}"`);
    console.log(`    Context: ${v.context}`);
    console.log('');
  }

  console.log('Forbidden terms in UI copy:');
  console.log('  - wallet → use "vault"');
  console.log('  - hash → use "fingerprint"');
  console.log('  - block, transaction → use "record"');
  console.log('  - crypto, bitcoin, blockchain → remove or rephrase');
  console.log('');
  console.log('See src/lib/copy.ts for approved terminology.\n');

  process.exit(1);
}

// Only run main when executed directly (not when imported by the test file).
// CIBA-HARDEN-05: exporting FORBIDDEN_TERMS required guarding the top-level
// main() call so vitest can import without triggering process.exit(0).
const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main();
}
