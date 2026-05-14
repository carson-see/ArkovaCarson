#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1821: staging deploys must go through scripts/staging/deploy.sh.
 *
 * Raw `gcloud run deploy` / `gcloud run services update` commands against
 * arkova-worker-staging bypass lease checks, collision detection, tag routing,
 * and staging_deploy_log audit rows.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOW_MARKER = 'staging-gcloud-ok:';
const MAX_COMMAND_LINES = 25;
const CHECKED_DIRS = [
  '.github/workflows',
  'scripts',
  'docs/ops',
  'docs/reference',
  'docs/runbooks',
  'docs/staging',
];
const CHECKED_EXTENSIONS = new Set(['.md', '.sh', '.yml', '.yaml']);
const DOCS_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt']);
const DEPLOY_WRAPPER = 'scripts/staging/deploy.sh';

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

function isDocsFile(path: string): boolean {
  const normalized = normalizeRelPath(path);
  return [...DOCS_EXTENSIONS].some((ext) => normalized.endsWith(ext));
}

function collectFiles(repo: string): string[] {
  const files: string[] = [];

  function walk(absDir: string): void {
    if (!existsSync(absDir)) return;

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
        continue;
      }
      if (!entry.isFile() || !hasCheckedExtension(entry.name)) continue;
      files.push(normalizeRelPath(relative(repo, absPath)));
    }
  }

  for (const dir of CHECKED_DIRS) {
    walk(join(repo, dir));
  }

  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
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

function commandWindow(lines: string[], index: number): string {
  const commandLines = [lines[index]];
  let cursor = index;

  while (
    commandLines.length < MAX_COMMAND_LINES
    && cursor + 1 < lines.length
    && /\\\s*$/.test(lines[cursor])
  ) {
    cursor += 1;
    commandLines.push(lines[cursor]);
  }

  return commandLines
    .join(' ')
    .replace(/\\\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRawStagingDeployCommand(text: string): boolean {
  return /\bgcloud\s+run\s+(?:deploy|services\s+update)\b/.test(text)
    && /\barkova-worker-staging\b/.test(text);
}

export function scanTextForRawStagingGcloud(file: string, text: string): Violation[] {
  const normalizedFile = normalizeRelPath(file);
  if (normalizedFile === DEPLOY_WRAPPER) return [];

  const lines = text.split(/\r?\n/);
  const violations: Violation[] = [];
  const seen = new Set<number>();
  const docsHeuristicsAllowed = isDocsFile(normalizedFile);

  lines.forEach((line, index) => {
    if (!/\bgcloud\s+run\s+(?:deploy|services\s+update)\b/.test(line)) return;
    if (docsHeuristicsAllowed && hasAllowMarker(lines, index)) return;

    const window = commandWindow(lines, index);
    const commandAt = line.search(/\bgcloud\s+run\s+(?:deploy|services\s+update)\b/);
    const prefix = commandAt === -1 ? '' : line.slice(0, commandAt).trim();
    // The 60-char cutoff filters runbook/table prefixes only observed in docs references.
    // This accepted tradeoff keeps commandWindow/isRawStagingDeployCommand scanning low-noise.
    if (docsHeuristicsAllowed && prefix.length > 60) return;
    if (!isRawStagingDeployCommand(window)) return;

    const lineNumber = index + 1;
    if (seen.has(lineNumber)) return;
    seen.add(lineNumber);
    violations.push({
      file,
      line: lineNumber,
      text: window,
    });
  });

  return violations;
}

function main(): void {
  const repo = resolve(import.meta.dirname, '..', '..');
  const files = collectFiles(repo);
  const violations = files.flatMap((file) =>
    scanTextForRawStagingGcloud(file, readFileSync(join(repo, file), 'utf8')),
  );

  if (violations.length === 0) {
    console.log(`✅ staging gcloud policy passed (${files.length} file(s) scanned).`);
    return;
  }

  console.error(`::error::Found ${violations.length} raw staging gcloud deploy/update command(s).`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} → ${violation.text}`);
  }
  console.error('');
  console.error('Fix: use scripts/staging/deploy.sh so lease checks, tag routing, and staging_deploy_log audit rows run.');
  console.error(`For docs-only historical transcripts, add a nearby "${ALLOW_MARKER} <reason>" comment.`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
