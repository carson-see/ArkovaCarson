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
    listAnchors: vi.fn(),
    agents: {
      register: vi.fn(), list: vi.fn(), get: vi.fn(), update: vi.fn(), revoke: vi.fn(),
      createKey: vi.fn(), admitComputeId: vi.fn(),
    },
  };
}

describe('private anchor list command', () => {
  it('translates relative time and forwards explicit tag scope without public search fallback', async () => {
    const api = client(); const output = io();
    vi.mocked(api.listAnchors).mockResolvedValue({ anchors: [], nextCursor: 'next' });
    expect(await main(['anchors', 'list', '--since', '24h', '--tag', 'acme', '--tag-scope', 'organization', '--limit', '100'], output.value, { client: api, now: () => new Date('2026-09-27T12:00:00Z') })).toBe(0);
    expect(api.listAnchors).toHaveBeenCalledWith({ since: '2026-09-26T12:00:00.000Z', tag: 'acme', tagScope: 'organization', limit: 100 });
    expect(output.stdout()).toContain('"nextCursor":"next"');
    expect(output.stdout()).toContain('"since":"2026-09-26T12:00:00.000Z"');
    expect(output.stdout()).toContain('"nextPageOptions"');
    expect(api.request).not.toHaveBeenCalled();
  });

  it('does not silently recompute a relative window on a later cursor page', async () => {
    const api = client(); const output = io();
    expect(await main(['anchors', 'list', '--since', '24h', '--cursor', 'next'], output.value, { client: api, now: () => new Date('2026-09-28T12:00:00Z') })).toBe(2);
    expect(output.stderr()).toContain('use the resolved query.since timestamp');
    expect(api.listAnchors).not.toHaveBeenCalled();
  });

  it('rejects ambiguous tags and invalid limits before any request', async () => {
    const api = client();
    expect(await main(['anchors', 'list', '--tag', 'acme'], io().value, { client: api })).toBe(2);
    expect(await main(['anchors', 'list', '--tag', '', '--tag-scope', 'organization'], io().value, { client: api })).toBe(2);
    expect(await main(['anchors', 'list', '--cursor', ''], io().value, { client: api })).toBe(2);
    expect(await main(['anchors', 'list', '--limit', '101'], io().value, { client: api })).toBe(2);
    expect(api.listAnchors).not.toHaveBeenCalled();
  });
});

describe('agent lifecycle commands', () => {
  it('calls every generic SDK operation and prints JSON', async () => {
    const api = client();
    vi.mocked(api.agents.register).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(api.agents.list).mockResolvedValue([]);
    vi.mocked(api.agents.get).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(api.agents.update).mockResolvedValue({ id: 'agent-1', status: 'suspended' } as never);
    vi.mocked(api.agents.revoke).mockResolvedValue({ status: 'revoked', agentId: 'agent-1' });
    vi.mocked(api.agents.createKey).mockResolvedValue({ key: 'ak_once' } as never);
    for (const args of [
      ['agent', 'register', '--name', 'Verifier', '--scope', 'verify'],
      ['agent', 'list'], ['agent', 'get', 'agent-1'],
      ['agent', 'update', 'agent-1', '--status', 'suspended'],
      ['agent', 'revoke', 'agent-1'], ['agent', 'key', 'create', 'agent-1'],
    ]) expect(await main(args, io().value, { client: api })).toBe(0);
    expect(api.agents.register).toHaveBeenCalledWith({ name: 'Verifier', allowedScopes: ['verify'] });
    expect(api.agents.update).toHaveBeenCalledWith('agent-1', { status: 'suspended' });
    expect(api.agents.createKey).toHaveBeenCalledWith('agent-1');
  });

  it('reads a ComputeID request file and does not echo it to stderr', async () => {
    const api = client();
    vi.mocked(api.agents.admitComputeId).mockResolvedValue({ key: 'ak_admitted' } as never);
    const output = io();
    const passport = '11111111-1111-4111-8111-111111111111';
    const request = { passport_id: passport, verification_receipt: { passport_id: passport, status: 'active', issued_at: '2026-09-26T00:00:00Z', expires_at: '2026-09-27T00:00:00Z', key_id: '0123456789abcdef', receipt_signature: 'signed-secret', receipt_algorithm: 'EdDSA', receipt_payload: '{}' } };
    const code = await main(['agent', 'computeid', 'admit', '--request-json', 'receipt.json'], output.value, {
      client: api, readFile: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(request))),
    });
    expect(code).toBe(0);
    expect(api.agents.admitComputeId).toHaveBeenCalledWith({ passportId: passport, verificationReceipt: request.verification_receipt });
    expect(output.stderr()).not.toContain('signed-secret');
  });

  it('rejects invalid lifecycle values before calling the SDK', async () => {
    const api = client(); const output = io();
    expect(await main(['agent', 'register', '--name', 'x', '--scope', 'agents:nope'], output.value, { client: api })).toBe(2);
    expect(await main(['agent', 'register', '--name', 'x', '--callback-url', 'https://'], output.value, { client: api })).toBe(2);
    expect(await main(['agent', 'update', 'agent-1', '--status', 'revoked'], output.value, { client: api })).toBe(2);
    expect(await main(['agent', 'computeid', 'admit', '--request-json', 'bad.json'], output.value, {
      client: api, readFile: vi.fn().mockResolvedValue(Buffer.from('{"passport_id":"bad","verification_receipt":{}}')),
    })).toBe(2);
    expect(api.agents.register).not.toHaveBeenCalled();
    expect(api.agents.update).not.toHaveBeenCalled();
    expect(api.agents.admitComputeId).not.toHaveBeenCalled();
  });

  it('treats an empty agent update as usage error without calling the SDK', async () => {
    const api = client(); const output = io();
    expect(await main(['agent', 'update', 'agent-1'], output.value, { client: api })).toBe(2);
    expect(JSON.parse(output.stderr())).toEqual({
      error: { code: 'usage_error', message: 'agent update requires at least one field' },
    });
    expect(api.agents.update).not.toHaveBeenCalled();
  });

  it('returns only bounded safe API error details', async () => {
    const api = client(); const output = io({ ARKOVA_API_KEY: 'ak_caller' });
    vi.mocked(api.agents.list).mockRejectedValue(new ArkovaError(
      'denied', 403, 'insufficient_scope', undefined, undefined,
      { required: 'agents:manage', granted: ['verify'], missing: ['agents:manage'], retryable: false,
        request_id: 'ak_caller', reason: 'bad\n', secret: 'ak_must_not_escape',
        permitted: Array.from({ length: 33 }, () => 'verify'), arbitrary: { raw: true } },
    ));
    expect(await main(['agent', 'list'], output.value, { client: api })).toBe(1);
    expect(JSON.parse(output.stderr())).toEqual({ error: {
      code: 'insufficient_scope', message: 'Arkova API request failed', status: 403,
      details: { required: 'agents:manage', granted: ['verify'], missing: ['agents:manage'],
        retryable: false, request_id: '[REDACTED]' },
    } });
    expect(output.stderr()).not.toContain('ak_must_not_escape');
    expect(output.stderr()).not.toContain('arbitrary');
    expect(output.stderr()).not.toContain('ak_caller');
    expect(output.stderr()).not.toContain('bad\\n');
  });

  it('redacts a returned one-time key if stdout fails after success', async () => {
    const api = client(); const secret = 'ak_once_returned'; let stderr = '';
    vi.mocked(api.agents.createKey).mockResolvedValue({ key: secret } as never);
    const code = await main(['agent', 'key', 'create', 'agent-1'], {
      env: { ARKOVA_API_KEY: 'ak_caller' }, stdin: async () => '',
      stdout: () => { throw new Error(`write failed for ${secret}`); },
      stderr: (text) => { stderr += text; },
    }, { client: api });
    expect(code).toBe(1);
    expect(stderr).not.toContain(secret);
  });
});

describe('arkova API CLI', () => {
  it('prints JSON help without requiring credentials', async () => {
    const output = io({});
    const code = await main(['--help'], output.value);
    expect(code).toBe(0);
    const help = JSON.parse(output.stdout()) as { command: string; output: string; usage: string[] };
    expect(help).toMatchObject({ command: 'arkova', output: 'json' });
    expect(help.usage).toContain('arkova agent register --name name [--description text] [--type value] [--scope value] [--framework value] [--version value] [--callback-url https-url] [--metadata-json file]');
    expect(help.usage).toContain('arkova agent update <agent-id> [--name name] [--description text] [--scope value] [--status active|suspended] [--framework value] [--version value] [--callback-url https-url|--clear-callback-url]');
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

  it('reads the caller-scoped durable submission status', async () => {
    const api = client();
    vi.mocked(api.request).mockResolvedValue({
      public_id: 'ARK-1', action: 'instant', anchor_status: 'PENDING',
      credit_state: 'pending', instant_status: 'NEEDS_CREDIT', retryable: true,
      updated_at: '2026-09-19T00:00:00Z',
    });
    const output = io();

    const code = await main(['status', 'ARK-1'], output.value, { client: api });

    expect(code).toBe(0);
    expect(api.request).toHaveBeenCalledWith('/api/v1/anchor/ARK-1/submission-status');
    expect(JSON.parse(output.stdout())).toMatchObject({
      public_id: 'ARK-1', instant_status: 'NEEDS_CREDIT', retryable: true,
    });
  });

  it('rejects raw-document fields from import JSON before any request', async () => {
    const api = client();
    const output = io();
    const readFile = vi.fn().mockResolvedValue(Buffer.from(JSON.stringify([{
      fingerprint: 'a'.repeat(64), filename: 'row.pdf', fingerprint_provided: true, data: 'private bytes',
    }])));
    expect(await main(['import', './rows.json', '--action', 'queue'], output.value, { client: api, readFile })).toBe(2);
    expect(api.request).not.toHaveBeenCalled();
    expect(output.stdout() + output.stderr()).not.toContain('private bytes');
  });

  it('rejects a zero file_size from import JSON before any request', async () => {
    const api = client();
    const output = io();
    const readFile = vi.fn().mockResolvedValue(Buffer.from(JSON.stringify([{
      fingerprint: 'a'.repeat(64), filename: 'row.pdf', fingerprint_provided: true, file_size: 0,
    }])));
    expect(await main(['import', './rows.json', '--action', 'queue'], output.value, { client: api, readFile })).toBe(2);
    expect(api.request).not.toHaveBeenCalled();
    expect(output.stdout() + output.stderr()).toContain('file_size');
  });

  it('uses exact folder CRUD, nesting, connector, and bulk move contracts', async () => {
    const api = client();
    vi.mocked(api.request)
      .mockResolvedValueOnce({ folders: [] })
      .mockResolvedValueOnce({ folder: { id: 'folder-1' } })
      .mockResolvedValueOnce({ folder: { id: 'folder-1', name: 'Renamed' } })
      .mockResolvedValueOnce({ folder: { id: 'folder-1', parent_folder_id: null } })
      .mockResolvedValueOnce({ folder: { id: 'folder-1', connector_provider: 'google_drive' } })
      .mockResolvedValueOnce({ folder: { id: 'folder-1', connector_provider: null } })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ moved: ['record-1'], failed: [] });
    const output = io();

    expect(await main(['folder', 'list', '--scope', 'ORG', '--org-id', 'org-1'], output.value, { client: api })).toBe(0);
    expect(await main(['folder', 'create', '--name', 'Cases', '--scope', 'ORG', '--org-id', 'org-1'], output.value, { client: api })).toBe(0);
    expect(await main(['folder', 'update', 'folder-1', '--name', 'Renamed'], output.value, { client: api })).toBe(0);
    expect(await main(['folder', 'update', 'folder-1', '--root'], output.value, { client: api })).toBe(0);
    expect(await main(['folder', 'connector', 'folder-1', '--provider', 'google_drive', '--source-id', 'drive-folder', '--connection-id', 'connection-1'], output.value, { client: api })).toBe(0);
    expect(await main(['folder', 'connector', 'folder-1', '--clear'], output.value, { client: api })).toBe(0);
    expect(await main(['folder', 'delete', 'folder-1'], output.value, { client: api })).toBe(0);
    expect(await main(['folder', 'move', '--record-id', 'record-1', '--folder-id', 'folder-1'], output.value, { client: api })).toBe(0);

    expect(api.request).toHaveBeenNthCalledWith(1, '/api/v1/folders?owner_scope=ORG&org_id=org-1');
    expect(api.request).toHaveBeenNthCalledWith(2, '/api/v1/folders', {
      method: 'POST', body: JSON.stringify({ name: 'Cases', owner_scope: 'ORG', org_id: 'org-1' }),
    });
    expect(api.request).toHaveBeenNthCalledWith(3, '/api/v1/folders/folder-1', {
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(api.request).toHaveBeenNthCalledWith(4, '/api/v1/folders/folder-1', {
      method: 'PATCH', body: JSON.stringify({ parent_folder_id: null }),
    });
    expect(api.request).toHaveBeenNthCalledWith(5, '/api/v1/folders/folder-1/connector', {
      method: 'PUT', body: JSON.stringify({ provider: 'google_drive', source_id: 'drive-folder', connection_id: 'connection-1' }),
    });
    expect(api.request).toHaveBeenNthCalledWith(6, '/api/v1/folders/folder-1/connector', {
      method: 'PUT', body: JSON.stringify({ provider: null, source_id: null, connection_id: null }),
    });
    expect(api.request).toHaveBeenNthCalledWith(7, '/api/v1/folders/folder-1', { method: 'DELETE' });
    expect(api.request).toHaveBeenNthCalledWith(8, '/api/v1/folders/bulk-move', {
      method: 'POST', body: JSON.stringify({ record_public_ids: ['record-1'], folder_id: 'folder-1' }),
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

  it('runs a read-only recurring probe across health, read, verify, and folders', async () => {
    const api = client();
    vi.mocked(api.request)
      .mockResolvedValueOnce({ status: 'healthy', git_sha: 'abc' })
      .mockResolvedValueOnce({ folders: [{ public_id: 'FLD-1' }] });
    vi.mocked(api.getAnchor).mockResolvedValue({ publicId: 'ARK-1', status: 'PENDING' } as never);
    vi.mocked(api.verify).mockResolvedValue({ verified: false, status: 'PENDING' } as never);
    const output = io();

    const code = await main(['probe', 'ARK-1', '--org-id', 'org-1'], output.value, { client: api });
    expect(code).toBe(0);
    expect(api.request).toHaveBeenNthCalledWith(1, '/health');
    expect(api.getAnchor).toHaveBeenCalledWith('ARK-1');
    expect(api.verify).toHaveBeenCalledWith('ARK-1');
    expect(api.request).toHaveBeenNthCalledWith(2, '/api/v1/folders?owner_scope=ORG&org_id=org-1');
    expect(JSON.parse(output.stdout())).toEqual({
      health: { status: 'healthy', git_sha: 'abc' },
      record: { publicId: 'ARK-1', status: 'PENDING' },
      verification: { verified: false, status: 'PENDING' },
      folders: [{ public_id: 'FLD-1' }],
    });
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
