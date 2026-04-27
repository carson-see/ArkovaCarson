/**
 * SCRUM-900 PROOF-SIG-01 — public-key registry route tests.
 *
 * The route serves the static JSON registry. We assert:
 *   - 200 + correct payload when the file is reachable
 *   - 503 with structured error when it isn't (deploy mis-step, file
 *     missing). 503 is the right status — the registry is the only
 *     way callers can verify signed bundles offline; if it's gone,
 *     verification cannot proceed and we should fail loud.
 *   - long Cache-Control on success so CDNs hold the registry between
 *     rotations (which require a redeploy, so cache invalidation is
 *     implicit).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

describe('SCRUM-900 proof-keys.public.json route', () => {
  let workerRoot: string;

  beforeEach(async () => {
    workerRoot = await mkdtemp(join(tmpdir(), 'scrum-900-keys-'));
  });

  afterEach(async () => {
    await rm(workerRoot, { recursive: true, force: true });
  });

  it('returns 200 with the registry when the file is present', async () => {
    // The route resolves the file relative to its own dirname under dist/.
    // To exercise it without rebuilding the bundle, we re-import the
    // route module after writing the file at the path it expects.
    const { proofKeysRouter, __testOverridePath } = await import('./proof-keys.js');
    const path = join(workerRoot, 'proof-keys.public.json');
    await writeFile(
      path,
      JSON.stringify({
        registry_version: '1.0.0',
        updated_at: '2026-04-27T00:00:00Z',
        keys: [
          {
            id: 'arkova-proof-2026-q2',
            alg: 'Ed25519',
            status: 'active',
            public_key_pem:
              '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n',
            created_at: '2026-04-27T00:00:00Z',
          },
        ],
      }),
    );
    __testOverridePath(path);

    const app = express();
    app.use(proofKeysRouter);
    const res = await request(app).get('/.well-known/arkova-keys.json');
    expect(res.status).toBe(200);
    expect(res.body.registry_version).toBe('1.0.0');
    expect(res.body.keys[0].id).toBe('arkova-proof-2026-q2');
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('returns 503 with explanatory error when the registry file is missing', async () => {
    const { proofKeysRouter, __testOverridePath } = await import('./proof-keys.js');
    __testOverridePath(join(workerRoot, 'does-not-exist.json'));

    const app = express();
    app.use(proofKeysRouter);
    const res = await request(app).get('/.well-known/arkova-keys.json');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('not configured');
  });
});
