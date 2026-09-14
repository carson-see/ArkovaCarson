import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

interface CapturedRequest { url: string; method: string; apiKey?: string; body: string }

describe('mock API integration', () => {
  const requests: CapturedRequest[] = [];
  const redirectedRequests: CapturedRequest[] = [];
  let origin = '';
  let redirectedOrigin = '';
  let directory = '';
  let redirectHealth = false;
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
      if (request.url === '/health' && redirectHealth) {
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
      response.end(JSON.stringify(
        request.url === '/api/v1/anchor'
          ? { public_id: 'ARK-CLI-1', fingerprint: JSON.parse(body).fingerprint, status: 'PENDING' }
          : { status: 'healthy' },
      ));
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

  it('fails closed on redirect and sends no request or key to the second origin', async () => {
    redirectHealth = true;
    let stdout = '';
    let stderr = '';
    const code = await main(['health'], {
      env: { ARKOVA_API_KEY: 'ak_redirect_secret', ARKOVA_BASE_URL: origin },
      stdin: async () => '', stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    });
    redirectHealth = false;

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(stderr)).toEqual({ error: { code: 'unexpected_error', message: 'Command failed' } });
    expect(redirectedRequests).toEqual([]);
    expect(stderr).not.toContain('ak_redirect_secret');
  });
});
