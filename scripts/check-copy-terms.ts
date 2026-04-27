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
  String.raw`(?<![-\w])block height(?![-\w])`,
  String.raw`(?<![-\w])block hash(?![-\w])`,
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

/**
 * Returns true if the line should be skipped (comments, imports, CSS classes, crypto API).
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

function stripIgnoredAttributeValues(line: string): string {
  return line.replace(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|\{[^}]*\})/g, 'className=');
}

/**
 * Finds forbidden term violations in a single line.
 */
export function findTermViolations(line: string, lineNum: number, filePath: string): Violation[] {
  const results: Violation[] = [];
  const searchableLine = stripIgnoredAttributeValues(line);
  for (const term of FORBIDDEN_TERMS) {
    const regex = new RegExp(term, 'gi');
    const match = searchableLine.match(regex);
    if (!match) continue;

    const hasString = searchableLine.includes('"') || searchableLine.includes("'") || searchableLine.includes('`');
    const hasJsxText = />\s*[^<{][^<]*</.test(searchableLine);

    if (hasString || hasJsxText) {
      results.push({
        file: filePath,
        line: lineNum,
        term: match[0],
        context: searchableLine.trim().substring(0, 80),
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
