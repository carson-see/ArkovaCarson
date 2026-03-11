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

// Forbidden terms (case-insensitive)
const FORBIDDEN_TERMS = [
  'wallet',
  'gas',
  String.raw`\bhash\b`, // \b for word boundary to avoid matching 'hashmap', etc in code
  String.raw`\bblock\b`,
  'transaction',
  'crypto',
  'cryptocurrency',
  'bitcoin',
  'blockchain',
  'mining',
  String.raw`\btoken\b`,
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
];

interface Violation {
  file: string;
  line: number;
  term: string;
  context: string;
}

function globToRegex(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
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
  // Skip CSS class names (e.g. Tailwind "block" means display:block)
  if (line.includes('className=')) {
    return true;
  }
  // Skip Web Crypto API usage and "cryptographic" adjective
  if (line.includes('crypto.subtle') || line.includes('crypto.getRandomValues') || line.includes('cryptographic')) {
    return true;
  }
  return false;
}

/**
 * Finds forbidden term violations in a single line.
 */
function findTermViolations(line: string, lineNum: number, filePath: string): Violation[] {
  const results: Violation[] = [];
  for (const term of FORBIDDEN_TERMS) {
    const regex = new RegExp(term, 'gi');
    const match = line.match(regex);
    if (!match) continue;

    const hasString = line.includes('"') || line.includes("'") || line.includes('`');
    const hasJsxText = line.includes('>') && line.includes('<');

    if (hasString || hasJsxText) {
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

main();
