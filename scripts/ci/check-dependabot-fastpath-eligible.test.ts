import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiredTierFor } from './check-staging-evidence.js';

const SCRIPT = resolve(import.meta.dirname, 'check-dependabot-fastpath-eligible.ts');

function runFastpathProbe(files: string[]): { eligible: string | undefined; stdout: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'dependabot-fastpath-'));
  const filesPath = resolve(dir, 'changed-files.txt');
  const outputPath = resolve(dir, 'output');
  writeFileSync(filesPath, files.length > 0 ? `${files.join('\n')}\n` : '');
  writeFileSync(outputPath, '');
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', SCRIPT], {
      cwd: resolve(import.meta.dirname, '..', '..'),
      env: {
        ...process.env,
        CHANGED_FILES_PATH: filesPath,
        GITHUB_OUTPUT: outputPath,
      },
      encoding: 'utf8',
    });
    const output = readFileSync(outputPath, 'utf8');
    const eligible = /^eligible=(.+)$/mu.exec(output)?.[1];
    return { eligible, stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Dependabot T0 fast-path probe (Actions-budget hygiene, 2026-09-21)', () => {
  // These fixtures pin the SAME real classifier the workflow calls
  // (requiredTierFor), so a future PATH_RULES/isT0OnlyFile edit that changes
  // one of these classifications is caught here too — the probe script must
  // never drift from its own source of truth.
  it('agrees with requiredTierFor() that a peripheral package manifest+lock bump is T0', () => {
    const files = ['packages/sdk/package.json', 'packages/sdk/package-lock.json'];
    expect(requiredTierFor(files).tier).toBe('T0');
  });

  it('agrees with requiredTierFor() that a root manifest+lock bump together is NOT T0', () => {
    // Root package.json is deliberately NOT in the T0 lockfile/manifest
    // carve-out (isT0OnlyFile's comment: "those govern the prod worker / app
    // runtime dependency tree, so a manifest bump there must still earn a
    // tier") — only the lockfile half is exempt, so the pair together is T1.
    const files = ['package.json', 'package-lock.json'];
    expect(requiredTierFor(files).tier).not.toBe('T0');
  });

  it('agrees with requiredTierFor() that a worker chain-path change is T3', () => {
    expect(requiredTierFor(['services/worker/src/chain/client.ts']).tier).toBe('T3');
  });

  it('CLI: reports eligible=true for a T0-only Dependabot changed-file set', () => {
    const { eligible, stdout } = runFastpathProbe(['packages/sdk/package.json', 'packages/sdk/package-lock.json']);
    expect(eligible).toBe('true');
    expect(stdout).toContain('ELIGIBLE');
  });

  it('CLI: reports eligible=false and falls through for a T3 changed-file set', () => {
    const { eligible, stdout } = runFastpathProbe(['services/worker/src/chain/client.ts']);
    expect(eligible).toBe('false');
    expect(stdout).toContain('NOT ELIGIBLE');
  });

  it('CLI: fails closed (eligible=false) on an empty changed-file list', () => {
    const { eligible } = runFastpathProbe([]);
    expect(eligible).toBe('false');
  });

  it('CLI: fails closed (eligible=false, exit 0) when CHANGED_FILES_PATH is unset', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'dependabot-fastpath-'));
    const outputPath = resolve(dir, 'output');
    writeFileSync(outputPath, '');
    try {
      const result = execFileSync(process.execPath, ['--import', 'tsx', SCRIPT], {
        cwd: resolve(import.meta.dirname, '..', '..'),
        env: {
          ...process.env,
          CHANGED_FILES_PATH: undefined,
          GITHUB_OUTPUT: outputPath,
        },
        encoding: 'utf8',
      });
      expect(result).toContain('missing or unreadable');
      expect(readFileSync(outputPath, 'utf8')).toContain('eligible=false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
