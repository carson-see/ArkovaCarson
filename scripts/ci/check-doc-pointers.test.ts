import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditDocPointers,
  collectScannedDocs,
  loadExemptions,
  readScannedDocs,
  resolutionBases,
  type ScannedDoc,
} from './check-doc-pointers.js';

const REPO = resolve(import.meta.dirname, '..', '..');

/** A hermetic `exists` over an explicit set of repo-relative paths. */
function fakeExists(paths: string[]): (abs: string) => boolean {
  const set = new Set(paths.map((p) => resolve(REPO, p)));
  return (abs) => set.has(abs);
}

function doc(name: string, ...lines: string[]): ScannedDoc {
  return { doc: name, content: lines.join('\n') };
}

describe('scan set', () => {
  const scanned = collectScannedDocs(REPO);

  it('keeps the original governance set', () => {
    expect(scanned).toContain('CLAUDE.md');
    expect(scanned).toContain('AGENTS.md');
    expect(scanned.some((d) => d.startsWith('.claude/hooks/'))).toBe(true);
    expect(scanned.some((d) => d.startsWith('.claude/skills/'))).toBe(true);
    expect(scanned).toContain('memory/README.md');
  });

  // The gap this change closes: nested agents.md are required reading
  // (CLAUDE.md §0.1 step 5) but were invisible to the checker.
  it('includes nested agents.md files', () => {
    expect(scanned).toContain('scripts/ci/agents.md');
    expect(scanned).toContain('.github/workflows/agents.md');
    expect(scanned).toContain('supabase/migrations/agents.md');
    expect(scanned.filter((d) => d.endsWith('agents.md')).length).toBeGreaterThan(50);
  });

  it('includes .github/workflows YAML', () => {
    expect(scanned).toContain('.github/workflows/ci.yml');
    expect(scanned).toContain('.github/workflows/deploy-worker.yml');
  });

  // Regression guard on the deliberate exclusion documented in the script.
  it('still excludes HANDOFF.md, whose ## History may cite deleted files', () => {
    expect(scanned).not.toContain('HANDOFF.md');
  });

  // docs/release/*.md and docs/staging/*.md are dated narrative — runbooks and
  // soak premortems whose pointers are dead by design once the run is over.
  // Their folder-local agents.md files are a different thing and stay in scope.
  it('excludes docs/** narrative but keeps its folder-local agents.md', () => {
    const underDocs = scanned.filter((d) => d.startsWith('docs/'));
    expect(underDocs.every((d) => d.endsWith('/agents.md'))).toBe(true);
    expect(underDocs).toContain('docs/staging/agents.md');
    expect(scanned).not.toContain('docs/release/release-management-runbook.md');
  });
});

describe('resolution bases', () => {
  // packages/verifier-cli/agents.md cites `src/cli.ts` meaning its own src/.
  it('tries the doc directory before the repo root', () => {
    const bases = resolutionBases(REPO, 'packages/verifier-cli/agents.md');
    expect(bases[0]).toBe(resolve(REPO, 'packages/verifier-cli'));
    expect(bases.at(-1)).toBe(REPO);
  });

  // services/worker/src/api/v1/agents.md cites `src/api/_org-auth.ts`,
  // which is package-root-relative, not doc-relative.
  it('includes the nearest package root for a deeply nested doc', () => {
    const bases = resolutionBases(REPO, 'services/worker/src/api/v1/agents.md');
    expect(bases).toContain(resolve(REPO, 'services/worker'));
  });
});

describe('auditDocPointers', () => {
  it('flags a memory/ path that does not resolve', () => {
    const { ok, misses } = auditDocPointers(
      [doc('scripts/ci/agents.md', 'see `memory/project_ghost.md` for why')],
      { repoRoot: REPO, exists: fakeExists([]) },
    );
    expect(ok).toBe(false);
    expect(misses).toEqual([
      { doc: 'scripts/ci/agents.md', line: 1, path: 'memory/project_ghost.md' },
    ]);
  });

  it('accepts a doc-relative path that only resolves next to the doc', () => {
    const { ok, checked } = auditDocPointers(
      [doc('packages/verifier-cli/agents.md', 'entry point is `src/cli.ts`')],
      { repoRoot: REPO, exists: fakeExists(['packages/verifier-cli/src/cli.ts']) },
    );
    expect(ok).toBe(true);
    expect(checked).toBe(1);
  });

  it('accepts a package-root-relative path from a deeply nested doc', () => {
    const { ok } = auditDocPointers(
      [doc('services/worker/src/api/v1/agents.md', 'guard lives in `src/api/_org-auth.ts`')],
      { repoRoot: REPO, exists: fakeExists(['services/worker/src/api/_org-auth.ts']) },
    );
    expect(ok).toBe(true);
  });

  // Workflow YAML: comments are documentation; run:/with: values are not.
  it('reads governance pointers out of workflow comments', () => {
    const { ok, misses } = auditDocPointers(
      [doc('.github/workflows/ci.yml', '      # see memory/project_ghost.md;')],
      { repoRoot: REPO, exists: fakeExists([]) },
    );
    expect(ok).toBe(false);
    expect(misses[0]?.path).toBe('memory/project_ghost.md');
  });

  it('ignores non-comment lines in workflow YAML', () => {
    const { ok, checked } = auditDocPointers(
      [
        doc(
          '.github/workflows/ci.yml',
          '        run: ls -lh services/worker/circuits/artifacts/proof.wasm',
          "        run: node --import tsx src/index.ts",
        ),
      ],
      { repoRoot: REPO, exists: fakeExists([]) },
    );
    expect(ok).toBe(true);
    expect(checked).toBe(0);
  });

  // A workflow step's `working-directory:` makes a bare source path ambiguous,
  // so only governance prefixes are asserted out of workflow comments.
  it('ignores source paths in workflow comments', () => {
    const { ok, checked } = auditDocPointers(
      [doc('.github/workflows/deploy-worker.yml', '        # without this, src/ai/zk-proof.test.ts')],
      { repoRoot: REPO, exists: fakeExists([]) },
    );
    expect(ok).toBe(true);
    expect(checked).toBe(0);
  });

  it('honours an exemption for a documented non-existent path', () => {
    const { ok } = auditDocPointers(
      [doc('scripts/ci/agents.md', 'root-anchored, so `src/lib/sonar-project.properties` still fails')],
      {
        repoRoot: REPO,
        exists: fakeExists([]),
        exemptions: [
          { doc: 'scripts/ci/agents.md', path: 'src/lib/sonar-project.properties', reason: 'negative example' },
        ],
      },
    );
    expect(ok).toBe(true);
  });

  it('does not let an exemption for one doc excuse another doc', () => {
    const { ok } = auditDocPointers(
      [doc('scripts/agents.md', 'see `memory/project_ghost.md`')],
      {
        repoRoot: REPO,
        exists: fakeExists([]),
        exemptions: [{ doc: 'scripts/ci/agents.md', path: 'memory/project_ghost.md', reason: 'x' }],
      },
    );
    expect(ok).toBe(false);
  });

  it('skips globs, placeholders and URLs', () => {
    const { checked } = auditDocPointers(
      [
        doc(
          'CLAUDE.md',
          'supabase/migrations/NNNN_name.sql and scripts/ci/*.ts',
          'https://example.test/memory/project_ghost.md',
          'docs/<topic>.md',
        ),
      ],
      { repoRoot: REPO, exists: fakeExists([]) },
    );
    expect(checked).toBe(0);
  });
});

describe('live repository', () => {
  const exemptions = loadExemptions(REPO);

  it('every exemption names a doc that exists and is in the scan set', () => {
    const scanned = new Set(collectScannedDocs(REPO));
    for (const e of exemptions) {
      expect(existsSync(resolve(REPO, e.doc)), `${e.doc} missing`).toBe(true);
      expect(scanned.has(e.doc), `${e.doc} not scanned`).toBe(true);
      expect(e.reason.length, `${e.doc} → ${e.path} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('every exemption is still needed (a resolving path must not stay exempt)', () => {
    const { misses } = auditDocPointers(readScannedDocs(REPO), {
      repoRoot: REPO,
      exists: existsSync,
    });
    const dead = new Set(misses.map((m) => `${m.doc}|${m.path}`));
    for (const e of exemptions) {
      expect(dead.has(`${e.doc}|${e.path}`), `stale exemption: ${e.doc} → ${e.path}`).toBe(true);
    }
  });

  // The ratchet. This is the assertion that would have caught
  // memory/project_deploy_typecheck_blackout.md when it was first cited.
  it('has no dead pointers across the full scan set', () => {
    const { ok, misses } = auditDocPointers(readScannedDocs(REPO), {
      repoRoot: REPO,
      exists: existsSync,
      exemptions,
    });
    expect(misses.map((m) => `${m.doc}:${m.line} → ${m.path}`)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('scans a meaningful number of references', () => {
    const { checked } = auditDocPointers(readScannedDocs(REPO), {
      repoRoot: REPO,
      exists: existsSync,
      exemptions,
    });
    expect(checked).toBeGreaterThan(1000);
  });
});
