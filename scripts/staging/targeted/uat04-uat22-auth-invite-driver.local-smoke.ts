/** Opt-in local runtime smoke. No outbound email: sender is captured in-process. */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { capturedSendEmail } = vi.hoisted(() => ({
  capturedSendEmail: vi.fn(async () => ({ success: true, messageId: 'local-capture' })),
}));
vi.mock('../../../services/worker/src/email/sender.js', () => ({ sendEmail: capturedSendEmail }));

import { anchorRouter } from '../../../services/worker/src/routes/anchor.js';
import { adminRouter } from '../../../services/worker/src/routes/admin.js';
import { setRateLimitStore } from '../../../services/worker/src/utils/rateLimit.js';
import { runLocalDriverSmoke } from './uat04-uat22-auth-invite-driver.js';

const dbUrl = process.env.DB_URL ?? '';

function localQuery(query: string): Promise<unknown[]> {
  const trimmed = query.trim();
  if (!/^select\b/i.test(trimmed)) {
    execFileSync('psql', [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', query], { stdio: 'ignore' });
    return Promise.resolve([]);
  }
  const wrapped = `SELECT COALESCE(json_agg(q), '[]'::json) FROM (${trimmed}) AS q`;
  const output = execFileSync('psql', [dbUrl, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', wrapped], { encoding: 'utf8' });
  return Promise.resolve(JSON.parse(output.trim()) as unknown[]);
}

describe('UAT04/UAT22 driver local admission runtime', () => {
  let server: Server;
  let workerUrl: string;

  beforeAll(async () => {
    if (process.env.UAT0422_LOCAL_DRIVER_SMOKE !== '1') throw new Error('Explicit local smoke opt-in is required');
    if (!dbUrl) throw new Error('DB_URL is required');
    const database = new URL(dbUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol)
        || !['127.0.0.1', 'localhost'].includes(database.hostname)) {
      throw new Error('DB_URL must point to loopback PostgreSQL');
    }
    process.env.BUILD_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const app = express();
    app.use(express.json());
    app.get('/health', (_req, res) => res.json({ status: 'ok', git_sha: process.env.BUILD_SHA }));
    app.use('/api', anchorRouter);
    app.use('/api', adminRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolveReady) => server.once('listening', resolveReady));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local worker did not bind a TCP port');
    workerUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  });

  it('runs real Auth/TOTP/PostgREST/handlers and removes every owned fixture', async () => {
    const result = await runLocalDriverSmoke({
      supabaseUrl: process.env.API_URL!,
      anonKey: process.env.ANON_KEY!,
      serviceKey: process.env.SERVICE_ROLE_KEY!,
      workerUrl,
      expectedEmailConfigured: false,
      queryLocalDatabase: localQuery,
      resetLocalRateLimit: async () => setRateLimitStore(new Map()),
    });

    expect(result).toMatchObject({ scope: 'local-only', cleanedUp: true });
    expect(result.checks.length).toBeGreaterThan(20);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(capturedSendEmail).toHaveBeenCalled();
    const leftovers = await localQuery(`SELECT
      (SELECT count(*) FROM auth.users WHERE email LIKE '%uat04-22-0911%')::int AS users,
      (SELECT count(*) FROM public.organizations WHERE display_name LIKE 'UAT0422 %')::int AS organizations`);
    expect(leftovers).toEqual([{ users: 0, organizations: 0 }]);
  }, 60_000);
});
