/**
 * CLI integration — runs main() in-process with a temp proof file. The
 * on-chain path is skipped via --offline so the test needs NO network
 * (clean-room). Also asserts the terminology ban on user-facing output.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { loadSyntheticFixtures, FIXTURES_DIR } from './helpers.js';

let dir: string;
let goodPath: string;
let badPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'arkova-verify-'));
  const fixtures = loadSyntheticFixtures();
  const good = fixtures.find((f) => f.name === 'odd-leaf-pass')!;
  const bad = fixtures.find((f) => f.name === 'tampered-fingerprint-fail')!;
  goodPath = join(dir, 'good.json');
  badPath = join(dir, 'bad.json');
  writeFileSync(goodPath, JSON.stringify(good.packet));
  writeFileSync(badPath, JSON.stringify(bad.packet));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function captureStdout(): { restore: () => void; output: () => string } {
  let buf = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk);
    return true;
  });
  return { restore: () => spy.mockRestore(), output: () => buf };
}

describe('arkova-verify CLI (offline / clean-room)', () => {
  it('exits 0 and prints VERIFIED for a good packet (recompute-only)', async () => {
    const cap = captureStdout();
    const code = await main([goodPath, '--offline']);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.output()).toContain('VERDICT: VERIFIED');
  });

  it('exits 1 and prints NOT VERIFIED for a tampered packet', async () => {
    const cap = captureStdout();
    const code = await main([badPath, '--offline']);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.output()).toContain('VERDICT: NOT VERIFIED');
  });

  it('--json emits a machine-readable report', async () => {
    const cap = captureStdout();
    const code = await main([goodPath, '--offline', '--json']);
    cap.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.output());
    expect(parsed.ok).toBe(true);
    expect(parsed.steps.find((s: { id: string }) => s.id === 'recompute').status).toBe('pass');
  });

  it('refuses an Arkova --rpc endpoint (exit 2)', async () => {
    const cap = captureStdout();
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await main([goodPath, '--rpc', 'https://api.arkova.io']);
    cap.restore();
    errSpy.mockRestore();
    expect(code).toBe(2);
  });

  it('prints help with no args (exit 2) and with --help (exit 0)', async () => {
    const cap1 = captureStdout();
    const code1 = await main([]);
    cap1.restore();
    expect(code1).toBe(2);
    expect(cap1.output()).toContain('arkova-verify');

    const cap2 = captureStdout();
    const code2 = await main(['--help']);
    cap2.restore();
    expect(code2).toBe(0);
  });

  it('verifies the issuer signature when --key is supplied', async () => {
    const signedPath = join(FIXTURES_DIR, 'signed-bundle.json');
    const keyPath = join(FIXTURES_DIR, 'published-keys.json');
    const cap = captureStdout();
    const code = await main([signedPath, '--offline', '--key', keyPath]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.output()).toContain('Issuer signature:       VERIFIED');
  });
});

describe('terminology ban on user-facing output (CLAUDE.md §1.3)', () => {
  const BANNED = /\b(Wallet|Gas|Hash|Transaction|Crypto|Blockchain|Bitcoin|Testnet|Mainnet|UTXO|Broadcast)\b/;

  it('the rendered report contains no banned crypto terms', async () => {
    const cap = captureStdout();
    await main([goodPath, '--offline']);
    cap.restore();
    expect(cap.output()).not.toMatch(BANNED);
  });

  it('the help text contains no banned crypto terms', async () => {
    const cap = captureStdout();
    await main(['--help']);
    cap.restore();
    // "Bitcoin" appears nowhere user-facing; "block" lowercase is allowed only as
    // part of "Blockstream" (a node vendor name) — assert the standalone bans.
    expect(cap.output()).not.toMatch(BANNED);
  });
});
