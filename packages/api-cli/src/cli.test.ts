import { describe, expect, it, vi } from 'vitest';
import { ArkovaError } from 'arkova';
import { main, type CliClient } from './cli.js';

function io(env: Record<string, string> = { ARKOVA_API_KEY: 'ak_secret' }) {
  let stdout = '';
  let stderr = '';
  return {
    value: {
      env,
      stdin: async () => '',
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function client(): CliClient {
  return {
    request: vi.fn(),
    getAnchor: vi.fn(),
    verify: vi.fn(),
    fingerprint: vi.fn(),
  };
}

describe('arkova API CLI', () => {
  it('prints JSON help without requiring credentials', async () => {
    const output = io({});
    const code = await main(['--help'], output.value);
    expect(code).toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({ command: 'arkova', output: 'json' });
    expect(output.stderr()).toBe('');
  });

  it('anchors only a local fingerprint with private metadata', async () => {
    const api = client();
    vi.mocked(api.fingerprint).mockResolvedValue('a'.repeat(64));
    vi.mocked(api.request).mockResolvedValue({ public_id: 'ARK-1', status: 'PENDING' });
    const output = io();
    const readFile = vi.fn().mockResolvedValue(Buffer.from('private file bytes'));
    const code = await main([
      'anchor', './private.pdf', '--action', 'instant', '--description', 'Agreement',
      '--tag', 'legal', '--org-tag', 'q3',
    ], output.value, { client: api, readFile });

    expect(code).toBe(0);
    expect(api.fingerprint).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(api.request).toHaveBeenCalledWith('/api/v1/anchor', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        fingerprint: 'a'.repeat(64), description: 'Agreement', action: 'instant',
        private_tags: { user: ['legal'], organization: ['q3'] },
      }),
    }), { idempotent: true });
    expect(JSON.stringify(vi.mocked(api.request).mock.calls)).not.toContain('private file bytes');
    expect(output.stdout()).not.toContain('private file bytes');
    expect(output.stderr()).not.toContain('ak_secret');
  });

  it('uses exact folder list, create, and bulk move contracts', async () => {
    const api = client();
    vi.mocked(api.request)
      .mockResolvedValueOnce({ folders: [] })
      .mockResolvedValueOnce({ folder: { id: 'folder-1' } })
      .mockResolvedValueOnce({ moved: ['record-1'], failed: [] });
    const output = io();

    expect(await main(['folder', 'list', '--scope', 'ORG', '--org-id', 'org-1'], output.value, { client: api })).toBe(0);
    expect(await main(['folder', 'create', '--name', 'Cases', '--scope', 'ORG', '--org-id', 'org-1'], output.value, { client: api })).toBe(0);
    expect(await main(['folder', 'move', '--record-id', 'record-1', '--folder-id', 'folder-1'], output.value, { client: api })).toBe(0);

    expect(api.request).toHaveBeenNthCalledWith(1, '/api/v1/folders?owner_scope=ORG&org_id=org-1');
    expect(api.request).toHaveBeenNthCalledWith(2, '/api/v1/folders', {
      method: 'POST', body: JSON.stringify({ name: 'Cases', owner_scope: 'ORG', org_id: 'org-1' }),
    });
    expect(api.request).toHaveBeenNthCalledWith(3, '/api/v1/folders/bulk-move', {
      method: 'POST', body: JSON.stringify({ anchor_ids: ['record-1'], folder_id: 'folder-1' }),
    });
  });

  it('reads stdin config without echoing its API key', async () => {
    const api = client();
    vi.mocked(api.request).mockResolvedValue({ status: 'healthy' });
    const output = io({});
    output.value.stdin = async () => JSON.stringify({ apiKey: 'ak_stdin_secret', baseUrl: 'https://api.example.test' });
    const factory = vi.fn().mockReturnValue(api);
    const code = await main(['--config', '-', 'health'], output.value, { clientFactory: factory });
    expect(code).toBe(0);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'ak_stdin_secret' }));
    expect(output.stdout() + output.stderr()).not.toContain('ak_stdin_secret');
  });

  it('writes structured errors to stderr and never echoes credentials', async () => {
    const output = io({ ARKOVA_API_KEY: 'ak_do_not_print' });
    const code = await main(['folder', 'create'], output.value);
    expect(code).toBe(2);
    expect(output.stdout()).toBe('');
    expect(JSON.parse(output.stderr())).toMatchObject({ error: { code: 'usage_error' } });
    expect(output.stderr()).not.toContain('ak_do_not_print');
  });

  it('bounds API errors even when a server echoes secrets or document content', async () => {
    const api = client();
    vi.mocked(api.request).mockRejectedValue(
      new ArkovaError('ak_do_not_print private file bytes', 400, 'ak_do_not_print'),
    );
    const output = io({ ARKOVA_API_KEY: 'ak_do_not_print' });
    const code = await main(['health'], output.value, { client: api });
    expect(code).toBe(1);
    expect(output.stdout()).toBe('');
    expect(JSON.parse(output.stderr())).toEqual({
      error: { code: 'api_error', message: 'Arkova API request failed', status: 400 },
    });
    expect(output.stderr()).not.toContain('ak_do_not_print');
    expect(output.stderr()).not.toContain('private file bytes');
  });
});
