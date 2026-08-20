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
 * spawns a real `node` process against the symlink — the same path a user
 * running `npx -y arkova-mcp-server` (or the Claude Desktop config this
 * package's own README documents) actually takes.
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

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distCli = join(packageRoot, 'dist', 'cli.js');

let binSymlinkDir: string;
let binSymlinkPath: string;
let child: ChildProcessWithoutNullStreams | undefined;

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

afterEach(() => {
  if (child && !child.killed) {
    child.kill();
    child = undefined;
  }
});

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: unknown;
}

function driveStdioSession(
  env: NodeJS.ProcessEnv,
): Promise<{ initialize: JsonRpcMessage; toolsList: JsonRpcMessage; stderr: string }> {
  return new Promise((resolve, reject) => {
    child = spawn('node', [binSymlinkPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    let buf = '';
    const responses: JsonRpcMessage[] = [];
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) {
          try {
            responses.push(JSON.parse(line));
          } catch {
            // ignore non-JSON lines
          }
        }
      }
    });

    child.on('error', reject);

    const timer = setTimeout(() => {
      reject(new Error(`stdio session timed out. stderr so far: ${stderr}`));
    }, 8_000);

    function send(msg: JsonRpcMessage): void {
      child?.stdin.write(`${JSON.stringify(msg)}\n`);
    }

    function waitFor(id: number): Promise<JsonRpcMessage> {
      return new Promise((res) => {
        const iv = setInterval(() => {
          const found = responses.find((r) => r.id === id);
          if (found) {
            clearInterval(iv);
            res(found);
          }
        }, 25);
      });
    }

    (async () => {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cli-bin-regression-test', version: '0.0.1' },
        },
      });
      const initialize = await waitFor(1);

      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const toolsList = await waitFor(2);

      clearTimeout(timer);
      resolve({ initialize, toolsList, stderr });
    })().catch(reject);
  });
}

describe('bin invocation via a real npm-style symlink', () => {
  it('starts the stdio server and answers initialize + tools/list when run through the symlink', async () => {
    const { initialize, toolsList } = await driveStdioSession({
      ...process.env,
      ARKOVA_API_KEY: 'ak_live_test_placeholder',
      PATH: process.env.PATH,
    });

    expect(initialize.result).toBeDefined();
    expect((initialize.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe(
      'arkova-mcp-server',
    );

    expect(toolsList.result).toBeDefined();
    const tools = (toolsList.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBe(10);
  }, 15_000);

  it('warns to stderr (not a crash) when ARKOVA_API_KEY is unset, through the same symlinked entry point', async () => {
    const env = { ...process.env, PATH: process.env.PATH };
    delete env.ARKOVA_API_KEY;

    const { stderr } = await driveStdioSession(env);

    expect(stderr).toContain('ARKOVA_API_KEY is not set');
  }, 15_000);
});
