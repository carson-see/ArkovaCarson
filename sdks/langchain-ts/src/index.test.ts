/**
 * LangChain Tools Tests
 *
 * Story: PH2-AGENT-06 (SCRUM-403)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ArkovaVerifyTool,
  ArkovaAnchorStatusTool,
  ArkovaSearchTool,
  ArkovaAttestTool,
  ArkovaBatchVerifyTool,
  ArkovaVerifySignatureTool,
  getArkovaTools,
  VERIFY_BATCH_SYNC_LIMIT,
  DISABLED_CAPABILITY_PHRASE,
  type ArkovaToolConfig,
} from './index.js';

const mockConfig: ArkovaToolConfig = {
  apiKey: 'ak_test_123',
  baseUrl: 'https://test.arkova.io',
  timeoutMs: 5000,
};

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('ArkovaVerifyTool', () => {
  it('should have correct name and description', () => {
    const tool = new ArkovaVerifyTool(mockConfig);
    expect(tool.name).toBe('arkova_verify_anchor');
    expect(tool.description).toContain('Verify');
  });

  it('should return valid result for SECURED credential', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        public_id: 'ARK-TEST-DOC-123',
        status: 'SECURED',
        issuer: 'Test University',
        credential_type: 'degree',
        anchored_at: '2026-01-01T00:00:00Z',
      }),
    });

    const tool = new ArkovaVerifyTool(mockConfig);
    const result = JSON.parse(await tool.call('ARK-TEST-DOC-123'));

    expect(result.valid).toBe(true);
    expect(result.public_id).toBe('ARK-TEST-DOC-123');
    expect(result.status).toBe('SECURED');
  });

  it('should return not found for 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const tool = new ArkovaVerifyTool(mockConfig);
    const result = JSON.parse(await tool.call('NONEXISTENT'));

    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should handle network errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const tool = new ArkovaVerifyTool(mockConfig);
    const result = JSON.parse(await tool.call('ARK-TEST-DOC-123'));

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Network failure');
  });

  it('should pass API key in header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ public_id: 'X', status: 'SECURED' }),
    });

    const tool = new ArkovaVerifyTool(mockConfig);
    await tool.call('X');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.arkova.io/api/v1/verify/X',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'ak_test_123' }),
      }),
    );
  });
});

describe('ArkovaSearchTool', () => {
  it('should URL-encode the query', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    const tool = new ArkovaSearchTool(mockConfig);
    await tool.call('John Doe');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('q=John%20Doe'),
      expect.any(Object),
    );
  });

  // F3 parity with mcp-server: a disabled semantic-search capability must
  // not read as an empty result.
  it('discloses a disabled search capability instead of swallowing the 503', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'service_unavailable', message: 'Semantic search is not currently enabled' }),
    });

    const tool = new ArkovaSearchTool(mockConfig);
    const result = JSON.parse(await tool.call('test'));

    expect(result.error).toContain('disabled');
    expect(result.error).toContain('NOT an empty result');
    expect(result.error).toContain('Semantic search is not currently enabled');
  });
});

describe('ArkovaAttestTool', () => {
  it('should POST attestation body as JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        public_id: 'ARK-TEST-ATT-123',
        status: 'DRAFT',
        attestation_type: 'VERIFICATION',
      }),
    });

    const tool = new ArkovaAttestTool(mockConfig);
    const input = JSON.stringify({
      attestation_type: 'VERIFICATION',
      subject_identifier: 'ARK-TEST-DOC-123',
      summary: 'Verified employment',
    });

    const result = JSON.parse(await tool.call(input));
    expect(result.public_id).toBe('ARK-TEST-ATT-123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.arkova.io/api/v1/attestations',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('ArkovaBatchVerifyTool', () => {
  it('should POST batch of public IDs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [{ public_id: 'ARK-1', status: 'SECURED' }] }),
    });

    const tool = new ArkovaBatchVerifyTool(mockConfig);
    const result = JSON.parse(await tool.call('["ARK-1"]'));

    expect(result.results).toBeDefined();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.arkova.io/api/v1/verify/batch',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('should reject non-array input', async () => {
    const tool = new ArkovaBatchVerifyTool(mockConfig);
    const result = JSON.parse(await tool.call('"not-array"'));
    expect(result.error).toContain('array');
  });

  // D6/F7 parity with mcp-server: SYNC_THRESHOLD=20 server-side; above that
  // the worker returns 202+job_id with no results and this tool cannot
  // fetch them.
  it('should reject >20 IDs', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `ARK-${i}`);
    const tool = new ArkovaBatchVerifyTool(mockConfig);
    const result = JSON.parse(await tool.call(JSON.stringify(ids)));
    expect(result.error).toContain('20');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should accept exactly 20 IDs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    const ids = Array.from({ length: 20 }, (_, i) => `ARK-${i}`);
    const tool = new ArkovaBatchVerifyTool(mockConfig);
    const result = JSON.parse(await tool.call(JSON.stringify(ids)));
    expect(result.error).toBeUndefined();
    expect(mockFetch).toHaveBeenCalled();
  });
});

describe('ArkovaVerifySignatureTool', () => {
  it('should verify a signature', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ valid: true, signature_id: 'ARK-SIG-1' }),
    });

    const tool = new ArkovaVerifySignatureTool(mockConfig);
    const result = JSON.parse(await tool.call('ARK-SIG-1'));

    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.arkova.io/api/v1/verify-signature',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('should handle 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const tool = new ArkovaVerifySignatureTool(mockConfig);
    const result = JSON.parse(await tool.call('ARK-SIG-NONE'));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found');
  });

  // F4 parity with mcp-server: a disabled AdES signature capability must
  // not read as "not found" or as a negative verification result.
  it('discloses a disabled signature capability instead of swallowing the 503', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'AdES signature service is not currently enabled', code: 'ADES_SIGNATURES_DISABLED' }),
    });

    const tool = new ArkovaVerifySignatureTool(mockConfig);
    const result = JSON.parse(await tool.call('ARK-SIG-1'));

    expect(result.valid).toBe(false);
    expect(result.error).toContain('disabled');
    expect(result.error).toContain('NOT a "not found" or negative verification result');
    // Unified chain is message ?? error ?? code; this body has no `message`,
    // so `error` wins where the old private fallback (message ?? code) picked
    // the code. Removing that divergence is the point of the shared helper.
    expect(result.error).toContain('AdES signature service is not currently enabled');
  });
});

describe('getArkovaTools', () => {
  it('should return all 6 tools', () => {
    const tools = getArkovaTools(mockConfig);
    expect(tools).toHaveLength(6);
    expect(tools.map(t => t.name)).toEqual([
      'arkova_verify_anchor',
      'arkova_anchor_status',
      'arkova_search_anchors',
      'arkova_create_attestation',
      'arkova_batch_verify',
      'arkova_verify_signature',
    ]);
  });
});

// F5 — CLAUDE.md §1.3 bans crypto/blockchain terminology in user-visible
// strings. Tool name/description text is the surface an agent framework
// reads to decide when to call a tool — treat it like UI copy. Mirrors the
// standing guard in sdks/mcp-server/src/index.test.ts.
describe('Tool terminology guard (CLAUDE.md §1.3 + F8 credential scrub)', () => {
  const banned = /\b(wallet|gas|hash|block|transaction|crypto|blockchain|bitcoin|testnet|mainnet|utxo|broadcast)\b/i;
  const tools = getArkovaTools(mockConfig);

  it('should not use §1.3-banned terminology in any tool name or description', () => {
    for (const tool of tools) {
      expect(tool.name, `tool name "${tool.name}"`).not.toMatch(banned);
      expect(tool.description, `${tool.name} description: "${tool.description}"`).not.toMatch(banned);
    }
  });

  // F8 — "credential" in an agent tool namespace reads as authentication
  // secrets, not as a verified record. No tool NAME may contain
  // "credential", and no description may contain "credentials" (plural).
  it('should not use "credential" in any tool name', () => {
    for (const tool of tools) {
      expect(tool.name.toLowerCase(), `tool name "${tool.name}"`).not.toContain('credential');
    }
  });

  it('should not use "credentials" (plural) in any tool description', () => {
    for (const tool of tools) {
      expect(tool.description.toLowerCase(), `${tool.name} description: "${tool.description}"`).not.toContain('credentials');
    }
  });

  // F6 — the API only ever matches public_id on this route; there is no
  // fingerprint lookup path for it.
  it('should not claim public_id can be a document fingerprint', () => {
    const verifyTool = tools.find(t => t.name === 'arkova_verify_anchor')!;
    expect(verifyTool.description.toLowerCase()).not.toContain('fingerprint');
  });
});


// Parity with sdks/mcp-server: the disclosure must exist on every handler's
// non-OK path, from one helper and one phrase — not on 2 of 6 with divergent
// body-field fallbacks.
describe('503 disabled-capability disclosure (all 6 tools)', () => {
  const cases: Array<{ label: string; run: () => Promise<string>; detail: string; body: unknown }> = [
    {
      label: 'ArkovaVerifyTool',
      run: () => new ArkovaVerifyTool(mockConfig).call('ARK-DOC-1'),
      detail: 'Verification is not currently enabled',
      body: { error: 'service_unavailable', message: 'Verification is not currently enabled' },
    },
    {
      label: 'ArkovaAnchorStatusTool',
      run: () => new ArkovaAnchorStatusTool(mockConfig).call('ARK-DOC-1'),
      detail: 'Anchor status is not currently enabled',
      body: { message: 'Anchor status is not currently enabled' },
    },
    {
      label: 'ArkovaSearchTool',
      run: () => new ArkovaSearchTool(mockConfig).call('test'),
      detail: 'Semantic search is not currently enabled',
      body: { error: 'service_unavailable', message: 'Semantic search is not currently enabled' },
    },
    {
      label: 'ArkovaAttestTool',
      run: () => new ArkovaAttestTool(mockConfig).call('{"attestation_type":"VERIFICATION"}'),
      // `error` only — exercises the middle link of message ?? error ?? code.
      detail: 'Attestations are not currently enabled',
      body: { error: 'Attestations are not currently enabled' },
    },
    {
      label: 'ArkovaBatchVerifyTool',
      run: () => new ArkovaBatchVerifyTool(mockConfig).call('["ARK-DOC-1"]'),
      // `code` only — exercises the last link.
      detail: 'BATCH_VERIFY_DISABLED',
      body: { code: 'BATCH_VERIFY_DISABLED' },
    },
    {
      label: 'ArkovaVerifySignatureTool',
      run: () => new ArkovaVerifySignatureTool(mockConfig).call('ARK-SIG-1'),
      detail: 'AdES signature service is not currently enabled',
      body: { error: 'AdES signature service is not currently enabled', code: 'ADES_SIGNATURES_DISABLED' },
    },
  ];

  for (const c of cases) {
    it(`${c.label} discloses a 503 with the canonical phrase and the server detail`, async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: () => Promise.resolve(c.body),
      });

      const result = JSON.parse(await c.run());

      expect(result.error).toContain(DISABLED_CAPABILITY_PHRASE);
      expect(result.error).toContain(c.detail);
    });
  }

  it('falls back to service_unavailable when the 503 body is unreadable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = JSON.parse(await new ArkovaSearchTool(mockConfig).call('test'));

    expect(result.error).toContain(DISABLED_CAPABILITY_PHRASE);
    expect(result.error).toContain('service_unavailable');
  });

  it('leaves a 404 unchanged — not found is a real answer, not a disabled capability', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) });

    const result = JSON.parse(await new ArkovaVerifyTool(mockConfig).call('ARK-NOPE'));

    expect(result.error).toBe('Record not found');
    expect(JSON.stringify(result)).not.toContain(DISABLED_CAPABILITY_PHRASE);
  });

  it('leaves a 400 unchanged, surfacing the server error field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'validation_error' }),
    });

    const result = JSON.parse(await new ArkovaAttestTool(mockConfig).call('{"attestation_type":"X"}'));

    expect(result.error).toBe('validation_error');
    expect(result.error).not.toContain(DISABLED_CAPABILITY_PHRASE);
  });
});

// Pinned constant, not a literal. Sources: packages/sdk/src/client.ts
// VERIFY_BATCH_SYNC_LIMIT and services/worker/src/api/v1/batch.ts
// SYNC_THRESHOLD — neither importable from this standalone package.
describe('VERIFY_BATCH_SYNC_LIMIT', () => {
  it('pins the synchronous batch limit at 20', () => {
    expect(VERIFY_BATCH_SYNC_LIMIT).toBe(20);
  });

  it('is the value the batch tool description and over-cap message quote', async () => {
    const tool = new ArkovaBatchVerifyTool(mockConfig);
    expect(tool.description).toContain(`up to ${VERIFY_BATCH_SYNC_LIMIT} public IDs`);

    const tooMany = Array.from({ length: VERIFY_BATCH_SYNC_LIMIT + 1 }, (_, i) => `ARK-${i}`);
    const result = JSON.parse(await tool.call(JSON.stringify(tooMany)));

    expect(result.error).toContain(`Maximum ${VERIFY_BATCH_SYNC_LIMIT} public IDs`);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
