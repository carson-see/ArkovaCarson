import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  acquireSharedFixtureLock,
  sharedFixtureLockPath,
  withSharedFixtureLock,
} from '../../../tests/rls/shared-fixture-lock';

const execFileAsync = promisify(execFile);

describe('shared RLS fixture lock', () => {
  it('serializes owners in separate child processes', async () => {
    const resource = randomUUID();
    const fixture = mkdtempSync(join(tmpdir(), 'arkova-lock-events-'));
    const eventsPath = join(fixture, 'events.log');
    const helperUrl = pathToFileURL(resolve(process.cwd(), 'tests/rls/shared-fixture-lock.ts')).href;

    const owner = (id: string) => execFileAsync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `import { appendFileSync } from 'node:fs';
       import { withSharedFixtureLock } from ${JSON.stringify(helperUrl)};
       await withSharedFixtureLock('policy', ${JSON.stringify(resource)}, async () => {
         appendFileSync(${JSON.stringify(eventsPath)}, 'enter:${id}\\n');
         await new Promise(resolve => setTimeout(resolve, 100));
         appendFileSync(${JSON.stringify(eventsPath)}, 'exit:${id}\\n');
       });`,
    ], { cwd: process.cwd() });

    try {
      await Promise.all([owner('a'), owner('b')]);
      const events = readFileSync(eventsPath, 'utf8').trim().split('\n');
      expect(events).toHaveLength(4);
      expect(events[0]).toMatch(/^enter:[ab]$/);
      expect(events[1]).toBe(`exit:${events[0].slice(-1)}`);
      expect(events[2]).toMatch(/^enter:[ab]$/);
      expect(events[3]).toBe(`exit:${events[2].slice(-1)}`);
      expect(events[0]).not.toBe(events[2]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('does not steal an old but active lock and releases after failure', async () => {
    const resource = randomUUID();
    const release = await acquireSharedFixtureLock('policy', resource);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(sharedFixtureLockPath('policy', resource), old, old);

    await expect(acquireSharedFixtureLock('policy', resource, { waitTimeoutMs: 75 }))
      .rejects.toThrow('Timed out waiting for shared RLS fixture lock: policy');
    release();

    await expect(withSharedFixtureLock('policy', resource, async () => {
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');
    await expect(withSharedFixtureLock('policy', resource, async () => undefined))
      .resolves.toBeUndefined();
  });

  it('maps different credentials and loopback spellings to the same database lock', () => {
    const first = sharedFixtureLockPath('policy', 'postgresql://postgres:one@127.0.0.1:54322/postgres');
    const second = sharedFixtureLockPath('policy', 'postgres://supabase_admin:two@localhost:54322/postgres');
    expect(first).toBe(second);
  });
});
