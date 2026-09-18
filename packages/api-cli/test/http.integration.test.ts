import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Arkova } from 'arkova';
import { main } from '../src/cli.js';

interface CapturedRequest { url: string; method: string; apiKey?: string; body: string }

async function waitForSourcePaths(requests: CapturedRequest[], start: number, expected: string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = new Set(requests.slice(start).map((request) => request.url));
    if (expected.every((path) => observed.has(path))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('source requests did not settle');
}

describe('mock API integration', () => {
  const requests: CapturedRequest[] = [];
  const redirectedRequests: CapturedRequest[] = [];
  let origin = '';
  let redirectedOrigin = '';
  let directory = '';
  const redirectPaths = new Set<string>();
  const redirectedServer = createServer((request, response) => {
    redirectedRequests.push({
      url: request.url ?? '', method: request.method ?? '',
      apiKey: request.headers['x-api-key'] as string | undefined, body: '',
    });
    response.end('{}');
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        url: request.url ?? '', method: request.method ?? '',
        apiKey: request.headers['x-api-key'] as string | undefined, body,
      });
      if (request.url && redirectPaths.has(request.url)) {
        response.statusCode = 302;
        response.setHeader('location', `${redirectedOrigin}/collect`);
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (body.includes('force-malicious-error')) {
        response.statusCode = 400;
        response.end(JSON.stringify({
          error: 'ak_mock_secret',
          message: 'fixture bytes must stay local',
        }));
        return;
      }
      response.statusCode = request.url === '/api/v1/anchor' ? 201 : 200;
      const record = {
        public_id: 'ARK-FIXTURE', verified: true, status: 'SECURED', issuer_name: 'Fixture issuer',
        credential_type: 'OTHER', issued_date: null, expiry_date: null, anchor_timestamp: null,
        network_receipt_id: null, record_uri: '/verify/ARK-FIXTURE',
      };
      response.end(JSON.stringify(request.url === '/api/v1/anchor'
        ? { public_id: 'ARK-CLI-1', fingerprint: JSON.parse(body).fingerprint, status: 'PENDING' }
        : request.url === '/api/v2/anchors/ARK-FIXTURE' || request.url === '/api/v1/verify/ARK-FIXTURE'
          ? record
          : request.url?.startsWith('/api/v1/folders?') ? { folders: [] } : { status: 'healthy' }));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => redirectedServer.listen(0, '127.0.0.1', resolve));
    const redirectedAddress = redirectedServer.address();
    if (!redirectedAddress || typeof redirectedAddress === 'string') throw new Error('redirect server did not bind');
    redirectedOrigin = `http://127.0.0.1:${redirectedAddress.port}`;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock server did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    directory = await mkdtemp(join(tmpdir(), 'arkova-api-cli-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => redirectedServer.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('uses the SDK API-key lifecycle and never uploads local bytes', async () => {
    const path = join(directory, 'private-document.txt');
    await writeFile(path, 'fixture bytes must stay local');
    let stdout = '';
    let stderr = '';
    const code = await main(['anchor', path, '--action', 'queue'], {
      env: { ARKOVA_API_KEY: 'ak_mock_secret', ARKOVA_BASE_URL: origin },
      stdin: async () => '', stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    });

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ public_id: 'ARK-CLI-1', status: 'PENDING' });
    expect(requests[0]).toMatchObject({ url: '/api/v1/anchor', method: 'POST', apiKey: 'ak_mock_secret' });
    expect(requests[0].body).not.toContain('fixture bytes must stay local');
    expect(JSON.parse(requests[0].body)).toEqual({
      fingerprint: '6dd89df40d5d161acaf7ba0676c1e66a121d638f5780e24b76355f8624ebb413',
      action: 'queue',
    });
    expect(stdout + stderr).not.toContain('ak_mock_secret');
  });

  it('does not echo a malicious API error containing credentials or file content', async () => {
    const path = join(directory, 'malicious-error-document.txt');
    await writeFile(path, 'fixture bytes must stay local');
    let stdout = '';
    let stderr = '';
    const code = await main(['anchor', path, '--description', 'force-malicious-error'], {
      env: { ARKOVA_API_KEY: 'ak_mock_secret', ARKOVA_BASE_URL: origin },
      stdin: async () => '', stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    });

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(stderr)).toEqual({
      error: { code: 'api_error', message: 'Arkova API request failed', status: 400 },
    });
    expect(stderr).not.toContain('ak_mock_secret');
    expect(stderr).not.toContain('fixture bytes must stay local');
    expect(requests[1].body).not.toContain('fixture bytes must stay local');
  });

  it.each([
    { name: 'read', args: ['read', 'ARK-FIXTURE'], assert: (value: Record<string, unknown>) => value.publicId === 'ARK-FIXTURE' },
    { name: 'verify', args: ['verify', 'ARK-FIXTURE'], assert: (value: Record<string, unknown>) => value.verified === true },
    {
      name: 'probe', args: ['probe', 'ARK-FIXTURE', '--org-id', 'org-fixture'],
      assert: (value: Record<string, unknown>) =>
        (value.record as Record<string, unknown>).publicId === 'ARK-FIXTURE' &&
        (value.verification as Record<string, unknown>).verified === true &&
        Array.isArray(value.folders),
    },
  ])('accepts valid direct $name responses from the configured origin', async ({ args, assert }) => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, {
      env: { ARKOVA_API_KEY: 'ak_direct_success', ARKOVA_BASE_URL: origin },
      stdin: async () => '', stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    });

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(assert(JSON.parse(stdout) as Record<string, unknown>)).toBe(true);
  });

  const redirectCases = [
    { name: 'health', args: ['health'], redirectPath: '/health', sourcePaths: ['/health'] },
    { name: 'read', args: ['read', 'ARK-FIXTURE'], redirectPath: '/api/v2/anchors/ARK-FIXTURE', sourcePaths: ['/api/v2/anchors/ARK-FIXTURE'] },
    { name: 'verify', args: ['verify', 'ARK-FIXTURE'], redirectPath: '/api/v1/verify/ARK-FIXTURE', sourcePaths: ['/api/v1/verify/ARK-FIXTURE'] },
    ...[
      ['/health', 'health'],
      ['/api/v2/anchors/ARK-FIXTURE', 'read'],
      ['/api/v1/verify/ARK-FIXTURE', 'verify'],
      ['/api/v1/folders?owner_scope=ORG&org_id=org-fixture', 'folders'],
    ].map(([redirectPath, leg]) => ({
      name: `probe ${leg}`,
      args: ['probe', 'ARK-FIXTURE', '--org-id', 'org-fixture'],
      redirectPath,
      sourcePaths: [
        '/health',
        '/api/v2/anchors/ARK-FIXTURE',
        '/api/v1/verify/ARK-FIXTURE',
        '/api/v1/folders?owner_scope=ORG&org_id=org-fixture',
      ],
    })),
  ];

  it.each(redirectCases)('fails $name closed on redirects without forwarding the API key', async ({ args, redirectPath, sourcePaths }) => {
    redirectPaths.clear();
    redirectPaths.add(redirectPath);
    redirectedRequests.length = 0;
    const sourceStart = requests.length;
    let stdout = '';
    let stderr = '';
    const code = await main(args, {
      env: { ARKOVA_API_KEY: 'ak_redirect_secret', ARKOVA_BASE_URL: origin },
      stdin: async () => '', stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    }, { clientFactory: (config) => new Arkova({ ...config, retry: { retries: 0 } }) });
    await waitForSourcePaths(requests, sourceStart, sourcePaths);
    redirectPaths.clear();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(stderr)).toEqual({ error: { code: 'unexpected_error', message: 'Command failed' } });
    const sourceRequests = requests.slice(sourceStart);
    expect(sourceRequests.map((request) => request.url)).toEqual(expect.arrayContaining(sourcePaths));
    expect(sourceRequests.filter((request) => sourcePaths.includes(request.url)))
      .toEqual(expect.arrayContaining(sourcePaths.map((url) => expect.objectContaining({ url, apiKey: 'ak_redirect_secret' }))));
    expect(redirectedRequests).toEqual([]);
    expect(stderr).not.toContain('ak_redirect_secret');
  });
});
