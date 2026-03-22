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

    mockFetch.mockResolvedValueOnce({
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
        record_uri: 'https://app.arkova.io/verify/ARK-2026-001',
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
        model: 'gemini-2.0-flash',
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
