/**
 * SCRUM-1922 R-CTDL-FR9 — did:web default DB-lookup coverage.
 *
 * The main suite (did-web.test.ts) injects `lookupOrg` to keep the route logic
 * pure. This suite mocks `../utils/db.js` so the DEFAULT (production) org lookup
 * path — a service-role `organizations` read by `public_id` — is exercised end
 * to end, including the supabase query-builder shape, the no-row 404, and the
 * error-becomes-5xx guard (a DB error must never be masked as a 404).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import express from 'express';
import request from 'supertest';

const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

vi.mock('../utils/db.js', () => ({ db: { from } }));

import { didWebRouter, __testOverridePath } from './did-web.js';

const ARKOVA_DID = 'did:web:app.arkova.ai';
const KEY_ID = 'arkova-proof-2026-q2';

function makePem(): { pem: string; x: string } {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const jwk = createPublicKey(pem).export({ format: 'jwk' }) as { x: string };
  return { pem, x: jwk.x };
}

describe('SCRUM-1922 did:web default org lookup (real db path)', () => {
  let workerRoot: string;
  let app: express.Express;

  beforeEach(async () => {
    workerRoot = await mkdtemp(join(tmpdir(), 'scrum-1922-did-db-'));
    const { pem } = makePem();
    const path = join(workerRoot, 'proof-keys.public.json');
    await writeFile(
      path,
      JSON.stringify({
        registry_version: '1.0.0',
        updated_at: '2026-04-27T00:00:00Z',
        keys: [
          {
            id: KEY_ID,
            alg: 'Ed25519',
            status: 'active',
            public_key_pem: pem,
            created_at: '2026-04-27T00:00:00Z',
          },
        ],
      }),
    );
    __testOverridePath(path);

    from.mockClear();
    select.mockClear();
    eq.mockClear();
    maybeSingle.mockReset();

    app = express();
    app.use(didWebRouter); // default instance → defaultLookupOrg → mocked db
  });

  afterEach(async () => {
    __testOverridePath(null);
    await rm(workerRoot, { recursive: true, force: true });
  });

  it('reads organizations by public_id and serves the org DID doc', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        public_id: 'ORG-MI-CLE',
        display_name: 'Michigan Legal Education Board',
        website_url: 'https://example.edu/cle',
        suspended: false,
      },
      error: null,
    });

    const res = await request(app).get('/orgs/ORG-MI-CLE/did.json');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(`${ARKOVA_DID}:orgs:ORG-MI-CLE`);
    // Verify the query was shaped against the right table/column.
    expect(from).toHaveBeenCalledWith('organizations');
    expect(select).toHaveBeenCalledWith('public_id, display_name, website_url, suspended');
    expect(eq).toHaveBeenCalledWith('public_id', 'ORG-MI-CLE');
  });

  it('returns 404 when the db returns no row', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await request(app).get('/orgs/ORG-NONE/did.json');
    expect(res.status).toBe(404);
  });

  it('returns 5xx (not 404) when the db read errors', async () => {
    // A DB error is NOT "no such org" — masking it as 404 hides an outage and
    // lets resolvers cache a false negative. The default lookup throws on
    // `error`, and the route surfaces it as a 503 (mirrors badge.ts).
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await request(app).get('/orgs/ORG-ERR/did.json');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
  });

  it('returns 404 for a suspended org from the db', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        public_id: 'ORG-SUS',
        display_name: 'Suspended Org',
        website_url: null,
        suspended: true,
      },
      error: null,
    });
    const res = await request(app).get('/orgs/ORG-SUS/did.json');
    expect(res.status).toBe(404);
  });
});
