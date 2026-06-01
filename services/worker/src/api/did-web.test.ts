/**
 * SCRUM-1922 R-CTDL-FR9 — did:web endpoint tests.
 *
 * Exercises the public DID document resolver for:
 *   - Arkova platform DID  (did:web:arkova.xyz)
 *   - Issuing-org sub-DIDs (did:web:arkova.xyz:orgs:{public_id})
 *
 * The published Ed25519 verification key is sourced from the SAME static
 * registry the proof-bundle endpoint serves (services/worker/proof-keys.public.json).
 * Because the committed registry ships with `keys: []`, the happy-path tests
 * write a fixture registry containing a REAL Ed25519 keypair's public PEM and
 * point the route at it via `__testOverridePath` (mirroring proof-keys.test.ts).
 *
 * We assert valid W3C DID Core + did:web shape, the OKP/Ed25519 publicKeyJwk
 * (with `x` matching the published key), controller wiring, the LinkedDomains
 * service, Content-Type: application/did+json, the 503 (no active key) path,
 * the 404 (unknown / suspended org) path, and the public-id charset guard.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import express from 'express';
import request from 'supertest';

import {
  createDidWebRouter,
  __testOverridePath,
  type DidWebOrgRow,
} from './did-web.js';

const ARKOVA_DID = 'did:web:arkova.xyz';
const KEY_ID = 'arkova-proof-2026-q2';

/** Build a real Ed25519 keypair and return the SPKI PEM + its expected JWK. */
function makeKeyMaterial(): { pem: string; jwk: { kty: string; crv: string; x: string } } {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const jwk = createPublicKey(pem).export({ format: 'jwk' }) as {
    kty: string;
    crv: string;
    x: string;
  };
  return { pem, jwk };
}

const SAMPLE_ORG: DidWebOrgRow = {
  public_id: 'ORG-MI-CLE',
  display_name: 'Michigan Legal Education Board',
  website_url: 'https://example.edu/cle',
  suspended: false,
};

describe('SCRUM-1922 did:web router', () => {
  let workerRoot: string;
  let key: ReturnType<typeof makeKeyMaterial>;

  beforeEach(async () => {
    workerRoot = await mkdtemp(join(tmpdir(), 'scrum-1922-did-'));
    key = makeKeyMaterial();
  });

  afterEach(async () => {
    // Reset the route's registry path so other suites see the real default.
    __testOverridePath(null);
    await rm(workerRoot, { recursive: true, force: true });
  });

  async function writeRegistry(keys: unknown[]): Promise<void> {
    const path = join(workerRoot, 'proof-keys.public.json');
    await writeFile(
      path,
      JSON.stringify({
        registry_version: '1.0.0',
        updated_at: '2026-04-27T00:00:00Z',
        keys,
      }),
    );
    __testOverridePath(path);
  }

  function appWith(deps: Parameters<typeof createDidWebRouter>[0] = {}): express.Express {
    const app = express();
    app.use(createDidWebRouter(deps));
    return app;
  }

  function activeKeyEntry(): Record<string, unknown> {
    return {
      id: KEY_ID,
      alg: 'Ed25519',
      status: 'active',
      public_key_pem: key.pem,
      created_at: '2026-04-27T00:00:00Z',
    };
  }

  // ─── Arkova platform DID ─────────────────────────────────────────────

  describe('GET /.well-known/did.json (Arkova platform DID)', () => {
    it('serves a valid W3C DID document with the published Ed25519 key', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(appWith()).get('/.well-known/did.json');

      expect(res.status).toBe(200);
      const doc = res.body;
      expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1');
      expect(doc.id).toBe(ARKOVA_DID);

      // verificationMethod is an OKP/Ed25519 JsonWebKey2020 referencing the active key id.
      expect(Array.isArray(doc.verificationMethod)).toBe(true);
      const vm = doc.verificationMethod[0];
      expect(vm.id).toBe(`${ARKOVA_DID}#${KEY_ID}`);
      expect(vm.type).toBe('JsonWebKey2020');
      expect(vm.controller).toBe(ARKOVA_DID);
      expect(vm.publicKeyJwk.kty).toBe('OKP');
      expect(vm.publicKeyJwk.crv).toBe('Ed25519');
      expect(vm.publicKeyJwk.x).toBe(key.jwk.x);
      // Never publish the private scalar.
      expect(vm.publicKeyJwk.d).toBeUndefined();

      // assertionMethod + authentication reference the same key id.
      expect(doc.assertionMethod).toContain(`${ARKOVA_DID}#${KEY_ID}`);
      expect(doc.authentication).toContain(`${ARKOVA_DID}#${KEY_ID}`);
    });

    it('advertises the platform homepage as a LinkedDomains service', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(appWith()).get('/.well-known/did.json');

      const svc = res.body.service.find(
        (s: { type: string }) => s.type === 'LinkedDomains',
      );
      expect(svc).toBeDefined();
      expect(svc.serviceEndpoint).toBe('https://arkova.xyz');
    });

    it('responds with Content-Type application/did+json and a cache header', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(appWith()).get('/.well-known/did.json');

      expect(res.headers['content-type']).toContain('application/did+json');
      expect(res.headers['cache-control']).toContain('max-age');
    });

    it('prefers the active key when retired keys are also present', async () => {
      const retired = makeKeyMaterial();
      await writeRegistry([
        {
          id: 'arkova-proof-2025-q4',
          alg: 'Ed25519',
          status: 'retired',
          public_key_pem: retired.pem,
          created_at: '2025-10-01T00:00:00Z',
          retired_at: '2026-04-01T00:00:00Z',
        },
        activeKeyEntry(),
      ]);
      const res = await request(appWith()).get('/.well-known/did.json');

      expect(res.status).toBe(200);
      expect(res.body.verificationMethod[0].id).toBe(`${ARKOVA_DID}#${KEY_ID}`);
      expect(res.body.verificationMethod[0].publicKeyJwk.x).toBe(key.jwk.x);
    });

    it('returns 503 when the registry file is missing', async () => {
      __testOverridePath(join(workerRoot, 'does-not-exist.json'));
      const res = await request(appWith()).get('/.well-known/did.json');

      expect(res.status).toBe(503);
      expect(res.body.error).toBeDefined();
    });

    it('returns 503 when the registry has no active key', async () => {
      await writeRegistry([
        {
          id: 'arkova-proof-2025-q4',
          alg: 'Ed25519',
          status: 'retired',
          public_key_pem: key.pem,
          created_at: '2025-10-01T00:00:00Z',
          retired_at: '2026-04-01T00:00:00Z',
        },
      ]);
      const res = await request(appWith()).get('/.well-known/did.json');

      expect(res.status).toBe(503);
    });

    it('returns 503 when the active key PEM is not an Ed25519 key', async () => {
      // An RSA SPKI PEM is structurally valid but the wrong key type — the
      // builder must refuse to publish a malformed verification method.
      const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const rsaPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
      await writeRegistry([
        {
          id: KEY_ID,
          alg: 'Ed25519',
          status: 'active',
          public_key_pem: rsaPem,
          created_at: '2026-04-27T00:00:00Z',
        },
      ]);
      const res = await request(appWith()).get('/.well-known/did.json');

      expect(res.status).toBe(503);
    });
  });

  // ─── Issuing-org sub-DID ─────────────────────────────────────────────

  describe('GET /orgs/:orgPublicId/.well-known/did.json (org DID)', () => {
    it('serves a valid org DID document controlled by the Arkova DID', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(
        appWith({ lookupOrg: async () => SAMPLE_ORG }),
      ).get('/orgs/ORG-MI-CLE/.well-known/did.json');

      expect(res.status).toBe(200);
      const doc = res.body;
      expect(doc.id).toBe(`${ARKOVA_DID}:orgs:ORG-MI-CLE`);
      // Arkova controls org sub-DIDs.
      expect(doc.controller).toBe(ARKOVA_DID);
      // Same published key, re-bound under the org DID.
      const vm = doc.verificationMethod[0];
      expect(vm.id).toBe(`${ARKOVA_DID}:orgs:ORG-MI-CLE#${KEY_ID}`);
      expect(vm.controller).toBe(ARKOVA_DID);
      expect(vm.publicKeyJwk.x).toBe(key.jwk.x);
      expect(doc.assertionMethod).toContain(`${ARKOVA_DID}:orgs:ORG-MI-CLE#${KEY_ID}`);
    });

    it('carries the org display name and homepage service', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(
        appWith({ lookupOrg: async () => SAMPLE_ORG }),
      ).get('/orgs/ORG-MI-CLE/.well-known/did.json');

      expect(res.body.name).toBe('Michigan Legal Education Board');
      const svc = res.body.service.find(
        (s: { type: string }) => s.type === 'LinkedDomains',
      );
      expect(svc.serviceEndpoint).toBe('https://example.edu/cle');
    });

    it('omits the homepage service when the org has no website_url', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(
        appWith({
          lookupOrg: async () => ({ ...SAMPLE_ORG, website_url: null }),
        }),
      ).get('/orgs/ORG-MI-CLE/.well-known/did.json');

      expect(res.status).toBe(200);
      const services = res.body.service ?? [];
      expect(
        services.some((s: { type: string }) => s.type === 'LinkedDomains'),
      ).toBe(false);
      // Name is still present.
      expect(res.body.name).toBe('Michigan Legal Education Board');
    });

    it('sets Content-Type application/did+json on org docs', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(
        appWith({ lookupOrg: async () => SAMPLE_ORG }),
      ).get('/orgs/ORG-MI-CLE/.well-known/did.json');

      expect(res.headers['content-type']).toContain('application/did+json');
    });

    it('returns 404 for an unknown org', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(
        appWith({ lookupOrg: async () => null }),
      ).get('/orgs/ORG-DOES-NOT-EXIST/.well-known/did.json');

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });

    it('returns 404 for a suspended org (no resolvable identity)', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(
        appWith({ lookupOrg: async () => ({ ...SAMPLE_ORG, suspended: true }) }),
      ).get('/orgs/ORG-MI-CLE/.well-known/did.json');

      expect(res.status).toBe(404);
    });

    it('returns 503 when no active key exists even if the org is found', async () => {
      __testOverridePath(join(workerRoot, 'does-not-exist.json'));
      const res = await request(
        appWith({ lookupOrg: async () => SAMPLE_ORG }),
      ).get('/orgs/ORG-MI-CLE/.well-known/did.json');

      expect(res.status).toBe(503);
    });

    it('returns 503 when the active key PEM is not an Ed25519 key (org route)', async () => {
      const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const rsaPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
      await writeRegistry([
        {
          id: KEY_ID,
          alg: 'Ed25519',
          status: 'active',
          public_key_pem: rsaPem,
          created_at: '2026-04-27T00:00:00Z',
        },
      ]);
      const res = await request(
        appWith({ lookupOrg: async () => SAMPLE_ORG }),
      ).get('/orgs/ORG-MI-CLE/.well-known/did.json');

      expect(res.status).toBe(503);
    });

    it('rejects a malformed org public id with 400 BEFORE any lookup', async () => {
      await writeRegistry([activeKeyEntry()]);
      let lookupCalled = false;
      const res = await request(
        appWith({
          lookupOrg: async () => {
            lookupCalled = true;
            return SAMPLE_ORG;
          },
        }),
      ).get('/orgs/' + encodeURIComponent('bad id:with:colons') + '/.well-known/did.json');

      expect(res.status).toBe(400);
      expect(lookupCalled).toBe(false);
    });

    it.each([
      ['contains a colon', 'org:evil'],
      ['contains a slash (encoded)', encodeURIComponent('a/b')],
      ['contains percent', encodeURIComponent('a%2eb')],
      ['too long', 'A'.repeat(129)],
      ['leading dot', '.evil'],
    ])('rejects org public id that %s', async (_label, badId) => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(
        appWith({ lookupOrg: async () => SAMPLE_ORG }),
      ).get(`/orgs/${badId}/.well-known/did.json`);

      expect(res.status).toBe(400);
    });

    it('accepts a well-formed prefixed org public id', async () => {
      await writeRegistry([activeKeyEntry()]);
      const res = await request(
        appWith({
          lookupOrg: async (publicId: string) => ({ ...SAMPLE_ORG, public_id: publicId }),
        }),
      ).get('/orgs/AEV-ABC123DEF456/.well-known/did.json');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(`${ARKOVA_DID}:orgs:AEV-ABC123DEF456`);
    });
  });
});
