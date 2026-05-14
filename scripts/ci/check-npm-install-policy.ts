#!/usr/bin/env -S npx tsx
/**
 * Supply-chain guardrail: CI and deploy helper installs must suppress npm
 * lifecycle scripts unless a line carries an explicit install-scripts-ok
 * justification. Install hooks are a common malware execution path.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOW_MARKER = 'install-scripts-ok:';
const CHECKED_DIRS = [
  '.github/workflows',
  'scripts',
];
const CHECKED_EXTENSIONS = new Set(['.sh', '.yml', '.yaml']);
const CHECKED_DOCKERFILE_NAMES = new Set(['Dockerfile']);
const SKIPPED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'output',
  'playwright-report',
]);
const comparePath = (a: string, b: string): number => a.localeCompare(b);

export interface Violation {
  file: string;
  line: number;
  text: string;
}

function normalizeRelPath(path: string): string {
  return path.split(sep).join('/');
}

function hasCheckedExtension(path: string): boolean {
  return [...CHECKED_EXTENSIONS].some((ext) => path.endsWith(ext));
}

function isDockerfileName(name: string): boolean {
  return CHECKED_DOCKERFILE_NAMES.has(name) || name.endsWith('.Dockerfile');
}

export function collectInstallPolicyFiles(repo: string): string[] {
  const files = new Set<string>();

  function addFile(absPath: string): void {
    files.add(normalizeRelPath(relative(repo, absPath)));
  }

  function walkCheckedDir(absDir: string): void {
    if (!existsSync(absDir)) return;

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walkCheckedDir(absPath);
        continue;
      }

      if (!entry.isFile() || !hasCheckedExtension(entry.name)) continue;
      addFile(absPath);
    }
  }

  function walkDockerfiles(absDir: string): void {
    if (!existsSync(absDir)) return;

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walkDockerfiles(absPath);
        continue;
      }

      if (!entry.isFile() || !isDockerfileName(entry.name)) continue;
      addFile(absPath);
    }
  }

  for (const dir of CHECKED_DIRS) {
    walkCheckedDir(join(repo, dir));
  }
  walkDockerfiles(repo);

  return [...files].sort(comparePath);
}

function isCommentOnly(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('#') || trimmed.startsWith('//');
}

function isYamlNameLine(line: string): boolean {
  return /^\s*-\s*name:/.test(line) || /^\s*name:/.test(line);
}

function stripQuotedStrings(line: string): string {
  return line
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .replace(/'([^'\\]|\\.)*'/g, "''");
}

function commandTextForLine(line: string): string {
  const trimmedStart = line.trimStart();
  if (!trimmedStart.startsWith('run:')) return line;
  return trimmedStart.slice('run:'.length).trimStart();
}

function startsInlineComment(text: string, index: number): boolean {
  if (index > 0 && !/\s/.test(text[index - 1])) return false;
  return text[index] === '#' || (text[index] === '/' && text[index + 1] === '/');
}

function stripInlineComments(text: string): string {
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (startsInlineComment(text, index)) {
      return text.slice(0, index).trimEnd();
    }
  }

  return text;
}

function isEchoOnlyMention(line: string): boolean {
  const commandText = stripInlineComments(commandTextForLine(line)).trim();
  if (!/^echo\b/.test(commandText)) return false;

  const withoutQuotedStrings = stripQuotedStrings(commandText);
  return !/(?:&&|\|\||;|\|)/.test(withoutQuotedStrings);
}

function hasNpmInstall(line: string): boolean {
  return /\bnpm\s+(ci|install)\b/.test(line);
}

function hasSafeIgnoreScripts(line: string): boolean {
  if (/--ignore-scripts=false\b/.test(line)) return false;
  return /--ignore-scripts(?:=true)?\b/.test(line);
}

function hasAllowMarker(lines: string[], index: number): boolean {
  for (const nearby of [index, index - 1, index - 2]) {
    if (nearby < 0) continue;
    const markerAt = lines[nearby].indexOf(ALLOW_MARKER);
    if (markerAt === -1) continue;
    return lines[nearby].slice(markerAt + ALLOW_MARKER.length).trim().length > 0;
  }
  return false;
}

export function scanTextForUnsafeNpmInstalls(file: string, text: string): Violation[] {
  const lines = text.split(/\r?\n/);
  const violations: Violation[] = [];

  lines.forEach((line, index) => {
    if (isCommentOnly(line) || isYamlNameLine(line)) return;
    if (isEchoOnlyMention(line)) return;

    const commandText = stripInlineComments(commandTextForLine(line));
    if (!hasNpmInstall(commandText)) return;
    if (hasSafeIgnoreScripts(commandText)) return;
    if (hasAllowMarker(lines, index)) return;

    violations.push({
      file,
      line: index + 1,
      text: line.trim(),
    });
  });

  return violations;
}

function main(): void {
  const repo = resolve(import.meta.dirname, '..', '..');
  const files = collectInstallPolicyFiles(repo);
  const violations = files.flatMap((file) =>
    scanTextForUnsafeNpmInstalls(file, readFileSync(join(repo, file), 'utf8')),
  );

  if (violations.length === 0) {
    console.log(`✅ npm install policy passed (${files.length} file(s) scanned).`);
    return;
  }

  console.error(`::error::Found ${violations.length} npm install command(s) that can run lifecycle scripts.`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} → ${violation.text}`);
  }
  console.error('');
  console.error('Fix: add --ignore-scripts to npm ci/install commands.');
  console.error(`If lifecycle scripts are truly required, add a nearby comment containing "${ALLOW_MARKER} <reason>".`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
