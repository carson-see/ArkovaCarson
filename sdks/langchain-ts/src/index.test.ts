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
  getArkovaTools,
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
    expect(tool.name).toBe('arkova_verify_credential');
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

describe('getArkovaTools', () => {
  it('should return all 4 tools', () => {
    const tools = getArkovaTools(mockConfig);
    expect(tools).toHaveLength(4);
    expect(tools.map(t => t.name)).toEqual([
      'arkova_verify_credential',
      'arkova_anchor_status',
      'arkova_search_credentials',
      'arkova_create_attestation',
    ]);
  });
});
