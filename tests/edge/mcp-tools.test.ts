import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleAgentSearch,
  type SupabaseConfig,
} from '../../services/edge/src/mcp-tools';

const config: SupabaseConfig = {
  supabaseUrl: 'https://supabase.test',
  supabaseKey: 'service-role-key',
  userId: 'user-1',
};

describe('handleAgentSearch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('honors the advertised 100-result limit for record searches', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify([
      {
        public_id: 'ARK-REC-001',
        title: 'Record 1',
        credential_type: 'CONTRACT',
        status: 'SECURED',
        created_at: '2026-05-01T00:00:00Z',
      },
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleAgentSearch(
      { q: 'contract', type: 'record', max_results: 100 },
      config,
    );

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://supabase.test/rest/v1/rpc/search_public_credentials',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ p_query: 'contract', p_limit: 100 }),
      }),
    );
  });

  it('escapes Postgres LIKE wildcards before record search RPC calls', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleAgentSearch(
      { q: 'contract%_\\', type: 'record', max_results: 10 },
      config,
    );

    expect(result.isError).toBeUndefined();
    const requestInit = fetchMock.mock.calls[0]?.[1];
    if (!requestInit) {
      throw new Error('Expected record search RPC request options');
    }
    expect(JSON.parse(requestInit.body as string)).toEqual({
      p_query: String.raw`contract\%\_\\`,
      p_limit: 10,
    });
  });
});
