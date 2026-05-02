/**
 * SCRUM-1586 — block tracked duplicate/source-copy artifacts.
 *
 * This complements the filename-spaces guard. That guard catches any path with
 * literal spaces; this one catches the specific drift patterns that make source
 * authority unclear: Finder-style numbered copies, backup/conflict suffixes,
 * and checked-in repo/worktree copy directories.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO = process.env.DUPLICATE_ARTIFACTS_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
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

const BACKUP_OR_MERGE_SUFFIX_RE = /\.(?:bak|backup|orig|rej|tmp|temp|old)$/i;
const NUMBERED_COPY_RE = /(?:^|[^\w])(?:copy\s*)?\(\d+\)$/i;
const SPACE_NUMBERED_COPY_RE = /^.+\s+\d+$/;
const COPY_SUFFIX_RE = /^.+(?:\s+copy|\s+copy\s+\d+|\s+-\s+copy|\s+-\s+copy\s+\d+)$/i;
const REPO_COPY_WORKTREE_RE = /(?:^|[-_])(?:arkova-)?(?:mvpcopy|copy)(?:[-_](?:main|pr|worktree|\d+))?$/i;

function stripExtension(segment: string): string {
  const dot = segment.lastIndexOf('.');
  if (dot <= 0) return segment;
  return segment.slice(0, dot);
}

export function classifyDuplicateArtifactPath(filePath: string): DuplicateArtifactViolation[] {
  const violations: DuplicateArtifactViolation[] = [];
  const segments = filePath.split('/').filter(Boolean);

  for (const segment of segments) {
    const stem = stripExtension(segment);

    if (BACKUP_OR_MERGE_SUFFIX_RE.test(segment)) {
      violations.push({ path: filePath, segment, kind: 'backup-or-merge-artifact' });
      continue;
    }

    if (NUMBERED_COPY_RE.test(stem) || SPACE_NUMBERED_COPY_RE.test(stem)) {
      violations.push({ path: filePath, segment, kind: 'numbered-copy' });
      continue;
    }

    if (COPY_SUFFIX_RE.test(stem)) {
      violations.push({ path: filePath, segment, kind: 'copy-suffix' });
      continue;
    }

    if (REPO_COPY_WORKTREE_RE.test(segment)) {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
