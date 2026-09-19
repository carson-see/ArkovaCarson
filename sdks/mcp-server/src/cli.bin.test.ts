/**
 * arkova-mcp-server bin (`npx`/`.bin`) invocation regression test
 *
 * `cli.test.ts` drives `createServer()` in-process via `InMemoryTransport`,
 * which is the right tool for protocol-shape coverage but cannot catch a
 * bug in the file's own "am I the process entry point?" self-check, because
 * importing the module under vitest never runs that check the way a real
 * `node <bin>` invocation does.
 *
 * npm ALWAYS installs a package's `bin` target as a symlink — locally under
 * `node_modules/.bin/<name>`, the same way for a global install, and the
 * same way `npx` stages its temp cache. This test reproduces exactly that:
 * it builds the real `dist/cli.js`, symlinks it the way npm would, and
 * connects a real MCP `Client` to it over the SDK's own `StdioClientTransport`
 * — which spawns a real `node` process against the symlink, the same path a
 * user running `npx -y arkova-mcp-server` (or the Claude Desktop config
 * this package's own README documents) actually takes. Using the SDK's own
 * client/transport (rather than hand-rolled process spawning + line-buffered
 * JSON-RPC framing) still exercises the real symlinked process; it just
 * lets the SDK own the protocol plumbing instead of reimplementing it.
 *
 * This is a regression test for a real bug: the previous entry-point guard
 * (`import.meta.url === \`file://${process.argv[1]}\``) compared a
 * symlink-resolved URL against an unresolved argv path, so it was false for
 * every real (symlinked) invocation — `main()` never ran, the compiled bin
 * printed nothing and exited 0, and the tool server never started. Running
 * `node dist/cli.js` directly (bypassing the symlink) masked this, which is
 * exactly why `cli.test.ts`'s in-process tests never caught it.
 *
 * Story: npm publication prep (2026-08-18) — clean-room verification finding.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distCli = join(packageRoot, 'dist', 'cli.js');

let binSymlinkDir: string;
let binSymlinkPath: string;
let client: Client | undefined;

beforeAll(() => {
  // Build fresh so this test exercises the same dist/ the package actually
  // ships — a stale dist/ from a prior run would defeat the point.
  execFileSync('npm', ['run', 'build'], { cwd: packageRoot, stdio: 'pipe' });
  expect(existsSync(distCli)).toBe(true);

  // Reproduce npm's own bin-install layout: a symlink named after the
  // package's `bin` key, pointing at the compiled entry file — not a copy.
  binSymlinkDir = mkdtempSync(join(tmpdir(), 'arkova-mcp-bin-test-'));
  binSymlinkPath = join(binSymlinkDir, 'arkova-mcp-server');
  symlinkSync(distCli, binSymlinkPath);
}, 30_000);

afterAll(() => {
  if (binSymlinkDir) {
    rmSync(binSymlinkDir, { recursive: true, force: true });
  }
});

afterEach(async () => {
  if (client) {
    await client.close();
    client = undefined;
  }
});

/**
 * Builds a transport that spawns `node <binSymlinkPath>` — a real process
 * through the real symlink — the way `StdioClientTransport` would for any
 * real MCP client. `pipeStderr` opts into capturing the child's stderr via
 * a PassThrough stream instead of inheriting the test runner's own stderr.
 */
function symlinkTransport(env: NodeJS.ProcessEnv, pipeStderr: boolean): StdioClientTransport {
  return new StdioClientTransport({
    command: 'node',
    args: [binSymlinkPath],
    env: env as Record<string, string>,
    stderr: pipeStderr ? 'pipe' : undefined,
  });
}

describe('bin invocation via a real npm-style symlink', () => {
  it('starts the stdio server and answers initialize + tools/list when run through the symlink', async () => {
    const transport = symlinkTransport(
      { ...process.env, ARKOVA_API_KEY: 'ak_live_test_placeholder', PATH: process.env.PATH },
      false,
    );
    client = new Client({ name: 'cli-bin-regression-test', version: '0.0.1' });
    // connect() spawns the process (via transport.start()) and drives the
    // initialize handshake — the SDK equivalent of the old send-then-waitFor.
    await client.connect(transport);

    expect(client.getServerVersion()?.name).toBe('arkova-mcp-server');

    const { tools } = await client.listTools();
    expect(tools.length).toBe(9);
  }, 15_000);

  it('warns to stderr (not a crash) when ARKOVA_API_KEY is unset, through the same symlinked entry point', async () => {
    const env = { ...process.env, PATH: process.env.PATH };
    delete env.ARKOVA_API_KEY;

    const transport = symlinkTransport(env, true);
    let stderr = '';
    // Attach before connect()/start() — the stream is a PassThrough created
    // in the transport's constructor specifically so no early output is
    // lost while a caller wires up its listener.
    transport.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    client = new Client({ name: 'cli-bin-regression-test', version: '0.0.1' });
    await client.connect(transport);
    // A full round trip (mirrors the margin the previous hand-rolled
    // harness had by completing tools/list before asserting) so the
    // 'data' event for the early stderr write has had a turn to fire.
    await client.listTools();

    expect(stderr).toContain('ARKOVA_API_KEY is not set');
  }, 15_000);
});
