import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SonarCloud `githubactions:S6506` — "HTTPS should be enforced on HTTP clients
 * following redirects".
 *
 * `curl -L` follows a `Location` header with no protocol floor, so a server
 * that redirects to `http://` silently downgrades the transfer. In a workflow
 * that is a supply-chain hole (a tampered binary) or, for a health probe, a
 * false reading taken off whatever host the redirect landed on.
 *
 * Two compliant shapes, both accepted here:
 *   - drop `-L` entirely (the endpoint is known not to redirect), or
 *   - keep `-L` and add `--proto '=https'`.
 *
 * `--proto` is a hard ceiling that applies to redirects too — curl refuses with
 * `Protocol "http" disabled (in redirect)` — so `--proto-redir` is optional
 * belt-and-braces, not a substitute. Verified empirically 2026-08-20 against
 * curl 8.7.1, and it is the shape SonarCloud's own compliant example uses.
 *
 * This is a census-proof ratchet rather than a one-time fix: the finding that
 * prompted it (revision-drift.yml) was reported alone, and this detector
 * immediately surfaced a second live site in gitleaks.yml.
 */

const repoRoot = process.cwd();
const workflowDir = path.join(repoRoot, '.github/workflows');

/** A short-flag cluster containing `L` (`-L`, `-sSL`, `-fsSL`), or `--location`. */
const FOLLOWS_REDIRECTS_RE = /(?:^|\s)(?:-(?!-)[A-Za-z]*L[A-Za-z]*|--location(?:-trusted)?)(?=\s|$)/;
/** `--proto '=https'` in any quoting style. */
const HTTPS_PROTO_FLOOR_RE = /--proto[\s=]+['"]?=https['"]?/;

/**
 * Join shell line-continuations so a `curl` split across several YAML lines is
 * evaluated as the single command it actually is.
 */
function joinContinuations(source: string): Array<{ line: number; command: string }> {
  const lines = source.split('\n');
  const commands: Array<{ line: number; command: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trimStart().startsWith('#')) continue; // YAML/shell comment
    let command = lines[i];
    const startLine = i + 1;
    while (command.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      i += 1;
      command = `${command.trimEnd().slice(0, -1)} ${lines[i].trim()}`;
    }
    commands.push({ line: startLine, command });
  }

  return commands;
}

function workflowFiles(): string[] {
  return fs
    .readdirSync(workflowDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

function findViolations(): string[] {
  const violations: string[] = [];

  for (const name of workflowFiles()) {
    const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
    for (const { line, command } of joinContinuations(source)) {
      if (!/\bcurl\b/.test(command)) continue;
      if (!FOLLOWS_REDIRECTS_RE.test(command)) continue;
      if (HTTPS_PROTO_FLOOR_RE.test(command)) continue;
      violations.push(`.github/workflows/${name}:${line} — ${command.trim()}`);
    }
  }

  return violations;
}

describe('workflow curl redirect protocol floor (githubactions:S6506)', () => {
  it('has no curl that follows redirects without --proto \'=https\'', () => {
    expect(findViolations()).toEqual([]);
  });

  it('detects a redirect-following curl that lacks the protocol floor', () => {
    // Guards the guard: a detector that silently matches nothing passes forever.
    expect(FOLLOWS_REDIRECTS_RE.test("curl -fsSL --max-time 15 \"${URL}\"")).toBe(true);
    expect(FOLLOWS_REDIRECTS_RE.test('curl -sSL "https://example.com/x" -o x')).toBe(true);
    expect(FOLLOWS_REDIRECTS_RE.test('curl --location "https://example.com/x"')).toBe(true);
    // Not redirect-following: no L in the cluster, and `--proto-redir` must not
    // be mistaken for a short-flag cluster just because it contains no `L`.
    expect(FOLLOWS_REDIRECTS_RE.test('curl --proto \'=https\' -fsS "https://example.com/x"')).toBe(false);
    expect(FOLLOWS_REDIRECTS_RE.test('curl --proto-redir \'=https\' -fsS "https://example.com/x"')).toBe(false);
    // The floor is recognised in every quoting style curl accepts.
    expect(HTTPS_PROTO_FLOOR_RE.test("curl --proto '=https' -fsSL x")).toBe(true);
    expect(HTTPS_PROTO_FLOOR_RE.test('curl --proto "=https" -fsSL x')).toBe(true);
    expect(HTTPS_PROTO_FLOOR_RE.test('curl --proto =https -fsSL x')).toBe(true);
    // A bare `--proto` that permits more than https is not a floor.
    expect(HTTPS_PROTO_FLOOR_RE.test("curl --proto 'https' -fsSL x")).toBe(false);
  });

  it('joins shell line-continuations before judging a command', () => {
    const joined = joinContinuations('  curl -fsSL \\\n    --proto \'=https\' \\\n    "https://example.com"');
    expect(joined[0].command).toContain("--proto '=https'");
    expect(joined[0].line).toBe(1);
  });
});
