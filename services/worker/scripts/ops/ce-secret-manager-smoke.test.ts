import { describe, expect, it, vi } from 'vitest';
import {
  CE_SECRET_REDACTED,
  buildCeRegistryRequests,
  isRealCtidForSmoke,
  parseCeSmokeArgs,
  redactCeSecret,
  resolveCeApiKeyFromSecretManager,
  runCeSecretManagerSmoke,
  summarizeCeResponse,
} from './ce-secret-manager-smoke.js';

// SCRUM-2376 (CE-05) — Secret-Manager runtime smoke.
//
// These tests run in CI in mock/offline mode. They assert the *resolution path*
// (key comes from Secret Manager, never env-baked), redaction (the secret value
// is never logged or echoed), and bounded read-only payloads — without ever
// touching live GCP or the live Credential Engine Registry.

const FAKE_KEY = 'ce-live-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX-secret';
const SECRET_NAME = 'projects/arkova-prod/secrets/credential-engine-api-key';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('redactCeSecret', () => {
  it('replaces the secret value with a fixed token regardless of where it appears', () => {
    const line = `Authorization: Bearer ${FAKE_KEY} resolved`;
    const out = redactCeSecret(line, FAKE_KEY);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain(CE_SECRET_REDACTED);
  });

  it('is a no-op when the secret is empty (never redacts everything to nothing)', () => {
    expect(redactCeSecret('plain text', '')).toBe('plain text');
  });

  it('redacts every occurrence', () => {
    const out = redactCeSecret(`${FAKE_KEY} and again ${FAKE_KEY}`, FAKE_KEY);
    expect(out).not.toContain(FAKE_KEY);
    // Count literal token occurrences (the token has regex-special chars).
    expect(out.split(CE_SECRET_REDACTED).length - 1).toBe(2);
  });
});

describe('resolveCeApiKeyFromSecretManager', () => {
  it('fetches the key from Secret Manager (NOT from env) via versions/latest:access', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { payload: { data: Buffer.from(FAKE_KEY, 'utf8').toString('base64') } }),
    );
    const getAccessToken = vi.fn().mockResolvedValue('access-token-redacted');

    const key = await resolveCeApiKeyFromSecretManager({
      secretName: SECRET_NAME,
      fetchImpl,
      getAccessToken,
    });

    expect(key).toBe(FAKE_KEY);
    // Resolution path proof: hit Secret Manager's access endpoint with a bearer token.
    const calledUrl = String(fetchImpl.mock.calls[0][0]);
    expect(calledUrl).toContain('secretmanager.googleapis.com');
    expect(calledUrl).toContain(`${SECRET_NAME}/versions/latest:access`);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-token-redacted');
    expect(getAccessToken).toHaveBeenCalledOnce();
  });

  it('rejects an env-baked key: there is no process.env fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    const getAccessToken = vi.fn().mockResolvedValue('tok');

    await expect(
      resolveCeApiKeyFromSecretManager({ secretName: SECRET_NAME, fetchImpl, getAccessToken }),
    ).rejects.toThrow(/Secret Manager/);
  });

  it('rejects a malformed secret resource name before any network call', async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveCeApiKeyFromSecretManager({ secretName: 'not-a-secret-name', fetchImpl, getAccessToken: vi.fn() }),
    ).rejects.toThrow(/projects\/\{project\}\/secrets\/\{secret\}/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never includes the secret value in a Secret Manager failure error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    try {
      await resolveCeApiKeyFromSecretManager({ secretName: SECRET_NAME, fetchImpl, getAccessToken: vi.fn().mockResolvedValue('t') });
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as Error).message).not.toContain(FAKE_KEY);
    }
  });
});

describe('buildCeRegistryRequests', () => {
  it('builds 3-5 READ-ONLY (GET) Registry examples (Graph Search + GetRecord)', () => {
    const reqs = buildCeRegistryRequests({ baseUrl: 'https://sandbox.credentialengine.org', sampleCtid: 'ce-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    expect(reqs.length).toBeGreaterThanOrEqual(3);
    expect(reqs.length).toBeLessThanOrEqual(5);
    for (const r of reqs) {
      expect(r.method).toBe('GET'); // read-only only — never POST/PUT/DELETE to the Registry
      expect(r.url.startsWith('https://sandbox.credentialengine.org')).toBe(true);
    }
    expect(reqs.some((r) => r.kind === 'graph-search')).toBe(true);
    expect(reqs.some((r) => r.kind === 'get-record')).toBe(true);
  });

  it('bounds Graph Search result sizes (no unbounded scans)', () => {
    const reqs = buildCeRegistryRequests({ baseUrl: 'https://sandbox.credentialengine.org' });
    const search = reqs.find((r) => r.kind === 'graph-search');
    expect(search?.url).toMatch(/[?&]take=\d{1,2}(&|$)/); // small page size
  });
});

describe('summarizeCeResponse — bounded, secret-free logging', () => {
  it('emits only bounded metadata (status + small counts/snippet), never the API key', () => {
    const summary = summarizeCeResponse({
      kind: 'graph-search',
      status: 200,
      body: { totalResults: 1234, data: [{ 'ceterms:ctid': 'ce-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }] },
      apiKey: FAKE_KEY,
    });
    const text = JSON.stringify(summary);
    expect(text).not.toContain(FAKE_KEY);
    expect(summary.status).toBe(200);
    // bounded: a snippet, not the whole payload
    expect(summary.bodySnippet.length).toBeLessThanOrEqual(280);
  });

  it('truncates a large body to a bounded snippet', () => {
    const big = { data: 'x'.repeat(10_000) };
    const summary = summarizeCeResponse({ kind: 'get-record', status: 200, body: big, apiKey: FAKE_KEY });
    expect(summary.bodySnippet.length).toBeLessThanOrEqual(280);
  });
});

describe('isRealCtidForSmoke', () => {
  it('agrees with the CE-02 real-CTID definition (ce- + uuid only)', () => {
    expect(isRealCtidForSmoke('ce-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(true);
    expect(isRealCtidForSmoke('ce-ARK-2026')).toBe(false);
    expect(isRealCtidForSmoke('urn:ctid:x')).toBe(false);
  });
});

describe('parseCeSmokeArgs', () => {
  it('defaults to mock/offline mode (safe for CI)', () => {
    const args = parseCeSmokeArgs([]);
    expect(args.mode).toBe('mock');
  });

  it('parses --live and --secret-name and --ctid', () => {
    const args = parseCeSmokeArgs(['--live', '--secret-name', SECRET_NAME, '--ctid', 'ce-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);
    expect(args.mode).toBe('live');
    expect(args.secretName).toBe(SECRET_NAME);
    expect(args.sampleCtid).toBe('ce-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });
});

describe('runCeSecretManagerSmoke (mock mode end-to-end)', () => {
  it('resolves a key from Secret Manager, runs read-only examples, and logs only redacted/bounded output', async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      if (String(url).includes('versions/latest:access')) {
        return Promise.resolve(
          jsonResponse(200, { payload: { data: Buffer.from(FAKE_KEY, 'utf8').toString('base64') } }),
        );
      }
      // Registry read-only call (Graph Search / GetRecord)
      return Promise.resolve(jsonResponse(200, { totalResults: 1, data: [{ 'ceterms:ctid': 'ce-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }] }));
    });

    const result = await runCeSecretManagerSmoke({
      mode: 'mock',
      secretName: SECRET_NAME,
      baseUrl: 'https://sandbox.credentialengine.org',
      sampleCtid: 'ce-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      fetchImpl,
      getAccessToken: vi.fn().mockResolvedValue('tok'),
      log: (line: string) => logs.push(line),
    });

    expect(result.keyResolvedFromSecretManager).toBe(true);
    expect(result.examples.length).toBeGreaterThanOrEqual(3);
    expect(result.examples.every((e) => e.method === 'GET')).toBe(true);

    // The most important assertion: the secret NEVER appears in any log line.
    const joined = logs.join('\n');
    expect(joined).not.toContain(FAKE_KEY);
    // And we DID log the redaction token (proving the key was handled + masked).
    expect(joined).toContain(CE_SECRET_REDACTED);
    // Bounded: no log line dumps a giant payload.
    for (const line of logs) expect(line.length).toBeLessThanOrEqual(400);
  });

  it('records example failures instead of throwing, so the smoke documents Registry errors', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (String(url).includes('versions/latest:access')) {
        return Promise.resolve(jsonResponse(200, { payload: { data: Buffer.from(FAKE_KEY, 'utf8').toString('base64') } }));
      }
      return Promise.resolve(jsonResponse(503, { error: 'registry unavailable' }));
    });

    const result = await runCeSecretManagerSmoke({
      mode: 'mock',
      secretName: SECRET_NAME,
      baseUrl: 'https://sandbox.credentialengine.org',
      fetchImpl,
      getAccessToken: vi.fn().mockResolvedValue('tok'),
      log: () => {},
    });

    expect(result.keyResolvedFromSecretManager).toBe(true);
    expect(result.examples.every((e) => e.status === 503)).toBe(true);
    expect(result.examples.every((e) => e.ok === false)).toBe(true);
  });
});
