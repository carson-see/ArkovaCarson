/**
 * Arkova SDK Client Tests (PH1-SDK-01)
 *
 * Tests SDK methods with mocked fetch. No real API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Arkova, ArkovaError } from './client';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Arkova', () => {
  it('creates client with default config', () => {
    const client = new Arkova();
    expect(client).toBeDefined();
  });

  it('creates client with API key', () => {
    const client = new Arkova({ apiKey: 'ak_test_123' });
    expect(client).toBeDefined();
  });
});

describe('fingerprint', () => {
  it('generates SHA-256 hash of string data', async () => {
    const client = new Arkova();
    const fp = await client.fingerprint('hello world');
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    // Known SHA-256 of "hello world"
    expect(fp).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('generates consistent hashes', async () => {
    const client = new Arkova();
    const fp1 = await client.fingerprint('test data');
    const fp2 = await client.fingerprint('test data');
    expect(fp1).toBe(fp2);
  });
});

describe('anchor', () => {
  it('sends fingerprint to API and returns receipt', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        public_id: 'ARK-2026-001',
        fingerprint: 'abc123',
        status: 'PENDING',
        created_at: '2026-01-01T00:00:00Z',
      }),
    });

    const receipt = await client.anchor('test document');
    expect(receipt.publicId).toBe('ARK-2026-001');
    expect(receipt.status).toBe('PENDING');
    expect(receipt.createdAt).toBe('2026-01-01T00:00:00Z');

    // Verify API call
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/anchor'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-API-Key': 'ak_test',
        }),
      }),
    );
  });

  it('throws ArkovaError on failure', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });

    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Invalid fingerprint' }),
    });

    await expect(client.anchor('test')).rejects.toThrow(ArkovaError);
    await expect(client.anchor('test')).rejects.toThrow('Invalid fingerprint');
  });
});

describe('verify', () => {
  it('verifies by public ID', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        verified: true,
        status: 'ACTIVE',
        issuer_name: 'University of Michigan',
        credential_type: 'DEGREE',
        issued_date: '2025-05-15',
        expiry_date: null,
        anchor_timestamp: '2026-01-01T00:00:00Z',
        network_receipt_id: 'tx-abc',
        record_uri: 'https://app.arkova.ai/verify/ARK-2026-001',
      }),
    });

    const result = await client.verify('ARK-2026-001');
    expect(result.verified).toBe(true);
    expect(result.status).toBe('ACTIVE');
    expect(result.issuerName).toBe('University of Michigan');
    expect(result.networkReceiptId).toBe('tx-abc');
  });
});

describe('query', () => {
  it('returns retrieval results', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            record_id: 'rec-1',
            source: 'edgar',
            source_url: 'https://sec.gov/filing/123',
            record_type: '10-K',
            title: 'Apple Annual Report',
            relevance_score: 0.91,
            anchor_proof: { chain_tx_id: 'tx-abc', content_hash: 'hash-1' },
          },
        ],
        count: 1,
        query: 'apple revenue',
      }),
    });

    const result = await client.query('apple revenue');
    expect(result.count).toBe(1);
    expect(result.results[0].recordId).toBe('rec-1');
    expect(result.results[0].anchorProof?.chainTxId).toBe('tx-abc');
  });
});

describe('verifyBatch', () => {
  it('returns empty array for empty input', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });
    const results = await client.verifyBatch([]);
    expect(results).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects more than 20 IDs with batch_too_large error (sync threshold)', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });
    const ids = Array.from({ length: 21 }, (_, i) => `ARK-${i}`);
    await expect(client.verifyBatch(ids)).rejects.toThrow(ArkovaError);
    await expect(client.verifyBatch(ids)).rejects.toMatchObject({ code: 'batch_too_large' });
  });

  it('throws async_job_not_supported if server returns 202 despite client-side cap', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ job_id: 'job-xyz', total: 5, expires_at: '2026-04-12T00:00:00Z' }),
    });
    await expect(client.verifyBatch(['ARK-1', 'ARK-2'])).rejects.toMatchObject({
      statusCode: 202,
      code: 'async_job_not_supported',
    });
  });

  it('returns mapped results in input order', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            verified: true,
            status: 'ACTIVE',
            issuer_name: 'University A',
            credential_type: 'DEGREE',
            issued_date: '2025-01-01',
            expiry_date: null,
            anchor_timestamp: '2026-01-01T00:00:00Z',
            network_receipt_id: 'tx-1',
            record_uri: 'https://app.arkova.ai/verify/ARK-1',
          },
          {
            verified: false,
            status: 'REVOKED',
            issuer_name: 'University B',
            credential_type: 'DEGREE',
            issued_date: '2024-01-01',
            expiry_date: null,
            anchor_timestamp: '2025-01-01T00:00:00Z',
            network_receipt_id: 'tx-2',
            record_uri: 'https://app.arkova.ai/verify/ARK-2',
          },
        ],
      }),
    });

    const results = await client.verifyBatch(['ARK-1', 'ARK-2']);
    expect(results).toHaveLength(2);
    expect(results[0].verified).toBe(true);
    expect(results[0].issuerName).toBe('University A');
    expect(results[1].verified).toBe(false);
    expect(results[1].status).toBe('REVOKED');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/verify/batch'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws ArkovaError with code on API failure', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate_limit_exceeded', message: 'Too many requests' }),
    });
    await expect(client.verifyBatch(['ARK-1'])).rejects.toMatchObject({
      statusCode: 429,
      code: 'rate_limit_exceeded',
    });
  });
});

describe('webhooks namespace', () => {
  describe('create', () => {
    it('registers a webhook and returns the secret once', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          id: 'wh-1',
          url: 'https://example.com/hooks',
          events: ['anchor.secured', 'anchor.revoked'],
          is_active: true,
          description: 'prod',
          created_at: '2026-04-11T10:00:00Z',
          updated_at: '2026-04-11T10:00:00Z',
          secret: 'a'.repeat(64),
          warning: 'Save this secret now.',
        }),
      });

      const result = await client.webhooks.create({
        url: 'https://example.com/hooks',
        events: ['anchor.secured', 'anchor.revoked'],
        description: 'prod',
      });

      expect(result.id).toBe('wh-1');
      expect(result.url).toBe('https://example.com/hooks');
      expect(result.isActive).toBe(true);
      expect(result.secret).toBe('a'.repeat(64));
      expect(result.warning).toContain('Save this secret');
    });

    it('throws ArkovaError with code on invalid URL', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_url', message: 'private network' }),
      });
      await expect(
        client.webhooks.create({ url: 'https://10.0.0.1/hooks' }),
      ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_url' });
    });
  });

  describe('list', () => {
    it('returns mapped webhooks with pagination metadata', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          webhooks: [
            {
              id: 'wh-1',
              url: 'https://a.example.com',
              events: ['anchor.secured'],
              is_active: true,
              description: null,
              created_at: '2026-04-11T10:00:00Z',
              updated_at: '2026-04-11T10:00:00Z',
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      });

      const result = await client.webhooks.list();
      expect(result.webhooks).toHaveLength(1);
      expect(result.webhooks[0].isActive).toBe(true);
      expect(result.total).toBe(1);
      expect(result.limit).toBe(50);
    });

    it('passes limit and offset query params', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ webhooks: [], total: 0, limit: 10, offset: 20 }),
      });
      await client.webhooks.list({ limit: 10, offset: 20 });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/[?&]limit=10/),
        expect.anything(),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/[?&]offset=20/),
        expect.anything(),
      );
    });
  });

  describe('get', () => {
    it('returns a single webhook by id', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'wh-1',
          url: 'https://example.com/hooks',
          events: ['anchor.secured'],
          is_active: true,
          description: null,
          created_at: '2026-04-11T10:00:00Z',
          updated_at: '2026-04-11T10:00:00Z',
        }),
      });
      const result = await client.webhooks.get('wh-1');
      expect(result.id).toBe('wh-1');
      expect(result.isActive).toBe(true);
    });

    it('throws 404 ArkovaError on unknown id', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'not_found', message: 'no such webhook' }),
      });
      await expect(client.webhooks.get('wh-missing')).rejects.toMatchObject({
        statusCode: 404,
        code: 'not_found',
      });
    });
  });

  describe('update', () => {
    it('sends PATCH with snake_case is_active', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'wh-1',
          url: 'https://example.com/hooks',
          events: ['anchor.secured'],
          is_active: false,
          description: null,
          created_at: '2026-04-11T10:00:00Z',
          updated_at: '2026-04-11T11:00:00Z',
        }),
      });
      const result = await client.webhooks.update('wh-1', { isActive: false });
      expect(result.isActive).toBe(false);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body).toEqual({ is_active: false });
      expect(callArgs[1].method).toBe('PATCH');
    });

    it('passes through partial updates', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'wh-1',
          url: 'https://new.example.com/hooks',
          events: ['anchor.secured', 'anchor.expired'],
          is_active: true,
          description: 'updated',
          created_at: '2026-04-11T10:00:00Z',
          updated_at: '2026-04-11T11:00:00Z',
        }),
      });
      await client.webhooks.update('wh-1', {
        url: 'https://new.example.com/hooks',
        events: ['anchor.secured', 'anchor.expired'],
        description: 'updated',
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.url).toBe('https://new.example.com/hooks');
      expect(body.events).toEqual(['anchor.secured', 'anchor.expired']);
      expect(body.description).toBe('updated');
      expect(body.is_active).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('sends DELETE and returns void on 204', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
      await expect(client.webhooks.delete('wh-1')).resolves.toBeUndefined();
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });

    it('throws ArkovaError on failure', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'not_found', message: 'gone' }),
      });
      await expect(client.webhooks.delete('wh-missing')).rejects.toMatchObject({
        statusCode: 404,
        code: 'not_found',
      });
    });
  });

  describe('test', () => {
    it('sends a synthetic test event', async () => {
      const client = new Arkova({ apiKey: 'ak_test' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, status_code: 200, event_id: 'test_abc' }),
      });
      const result = await client.webhooks.test('wh-1');
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.eventId).toBe('test_abc');
    });
  });
});

describe('ArkovaError', () => {
  it('exposes statusCode and code', () => {
    const err = new ArkovaError('boom', 400, 'validation_error');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('validation_error');
    expect(err.message).toBe('boom');
    expect(err.name).toBe('ArkovaError');
  });

  it('allows code to be optional for backwards compat', () => {
    const err = new ArkovaError('boom', 500);
    expect(err.code).toBeUndefined();
  });
});

describe('ask', () => {
  it('returns context mode response', async () => {
    const client = new Arkova({ apiKey: 'ak_test' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        answer: 'Apple reported $394B revenue in 2025.',
        citations: [
          {
            record_id: 'rec-1',
            source: 'edgar',
            source_url: 'https://sec.gov/filing/123',
            title: 'Apple 10-K',
            relevance_score: 0.92,
            excerpt: 'Total revenue: $394 billion',
            anchor_proof: { chain_tx_id: 'tx-abc', content_hash: 'hash-1' },
          },
        ],
        confidence: 0.88,
        model: 'gemini-2.5-flash',
        query: 'apple revenue 2025',
      }),
    });

    const result = await client.ask('apple revenue 2025');
    expect(result.answer).toContain('$394B');
    expect(result.citations).toHaveLength(1);
    expect(result.confidence).toBe(0.88);
    expect(result.citations[0].anchorProof?.chainTxId).toBe('tx-abc');
  });
});
