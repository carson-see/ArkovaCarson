/**
 * SCRUM-1586 — block tracked duplicate/source-copy artifacts.
 *
 * This complements the filename-spaces guard. That guard catches any path with
 * literal spaces; this one catches the specific drift patterns that make source
 * authority unclear: Finder-style numbered copies, backup/conflict suffixes,
 * and checked-in repo/worktree copy directories.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.DUPLICATE_ARTIFACTS_REPO_ROOT ?? resolve(SCRIPT_DIR, '..', '..');
const GIT_BIN = process.env.GIT_BIN ?? '/usr/bin/git';

export type DuplicateArtifactKind =
  | 'numbered-copy'
  | 'copy-suffix'
  | 'backup-or-merge-artifact'
  | 'repo-copy-worktree';

export interface DuplicateArtifactViolation {
  path: string;
  segment: string;
  kind: DuplicateArtifactKind;
}

const BACKUP_OR_MERGE_SUFFIXES = ['.bak', '.backup', '.orig', '.rej', '.tmp', '.temp', '.old'];

function stripExtensionChain(segment: string): string {
  let stem = segment;

  while (true) {
    const dot = stem.lastIndexOf('.');
    if (dot <= 0) return stem;

    const extension = stem.slice(dot + 1);
    if (!/^[A-Za-z0-9]+$/.test(extension)) return stem;

    stem = stem.slice(0, dot);
  }
}

function isDigits(value: string): boolean {
  return value.length > 0 && [...value].every((ch) => ch >= '0' && ch <= '9');
}

function hasBackupOrMergeSuffix(segment: string): boolean {
  const lower = segment.toLowerCase();
  return BACKUP_OR_MERGE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function hasNumberedCopySuffix(stem: string): boolean {
  const trimmed = stem.trimEnd();

  if (trimmed.endsWith(')')) {
    const open = trimmed.lastIndexOf('(');
    return open > 0 && isDigits(trimmed.slice(open + 1, -1));
  }

  const lastSpace = trimmed.lastIndexOf(' ');
  return lastSpace > 0 && isDigits(trimmed.slice(lastSpace + 1));
}

function stripTrailingNumber(stem: string): string {
  const trimmed = stem.trimEnd();
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace <= 0) return trimmed;

  const suffix = trimmed.slice(lastSpace + 1);
  return isDigits(suffix) ? trimmed.slice(0, lastSpace).trimEnd() : trimmed;
}

function hasCopySuffix(stem: string): boolean {
  const lower = stripTrailingNumber(stem).toLowerCase();
  return lower.endsWith(' copy') || lower.endsWith(' - copy');
}

function isRepoCopyWorktree(segment: string): boolean {
  const normalized = segment.toLowerCase().replaceAll('_', '-');
  return (
    normalized === 'copy-main'
    || normalized === 'copy-pr'
    || normalized === 'copy-worktree'
    || normalized === 'mvpcopy-main'
    || normalized === 'arkova-copy-main'
    || normalized === 'arkova-mvpcopy-main'
    || normalized.endsWith('-copy-main')
    || normalized.endsWith('-mvpcopy-main')
  );
}

export function classifyDuplicateArtifactPath(filePath: string): DuplicateArtifactViolation[] {
  const violations: DuplicateArtifactViolation[] = [];
  const segments = filePath.split('/').filter(Boolean);

  for (const segment of segments) {
    const stem = stripExtensionChain(segment);

    if (hasBackupOrMergeSuffix(segment)) {
      violations.push({ path: filePath, segment, kind: 'backup-or-merge-artifact' });
      continue;
    }

    if (hasNumberedCopySuffix(stem)) {
      violations.push({ path: filePath, segment, kind: 'numbered-copy' });
      continue;
    }

    if (hasCopySuffix(stem)) {
      violations.push({ path: filePath, segment, kind: 'copy-suffix' });
      continue;
    }

    if (isRepoCopyWorktree(segment)) {
      violations.push({ path: filePath, segment, kind: 'repo-copy-worktree' });
    }
  }

  return violations;
}

export function scanTrackedPaths(paths: string[]): DuplicateArtifactViolation[] {
  return paths.flatMap(classifyDuplicateArtifactPath);
}

function trackedPaths(): string[] {
  return execFileSync(GIT_BIN, ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function main(): void {
  const violations = scanTrackedPaths(trackedPaths());

  if (violations.length === 0) {
    console.log('✅ No tracked duplicate artifacts or repo-copy worktrees found.');
    return;
  }

  console.error(`::error::SCRUM-1586: ${violations.length} duplicate artifact path(s) are tracked:`);
  for (const violation of violations) {
    console.error(`  ${violation.path}  (${violation.kind}: ${violation.segment})`);
  }
  console.error('');
  console.error('Keep only the canonical source file in the repo. Move local worktrees/copies outside');
  console.error('the project path, and delete backup/merge artifacts instead of committing them.');
  process.exit(1);
}

function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
