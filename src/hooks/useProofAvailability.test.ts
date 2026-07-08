/**
 * useProofAvailability tests — FE-PROOF-GATE (SCRUM-2501)
 *
 * Exercises the fetch → classify pipeline against WORKER_URL /proof, mocking
 * `global.fetch` with the real response shapes from
 * docs/reference/FE_PROOF_GATE_CONTRACT.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/workerClient', () => ({
  WORKER_URL: 'https://worker.test',
}));

import { useProofAvailability } from './useProofAvailability';

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
  } as Response;
}

describe('useProofAvailability', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not fetch when disabled', () => {
    renderHook(() => useProofAvailability('ARK-1', false));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when publicId is missing', () => {
    renderHook(() => useProofAvailability(undefined, true));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls GET /api/v1/verify/:publicId/proof against WORKER_URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, proof_bundle: null }));
    renderHook(() => useProofAvailability('ARK-1', true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.test/api/v1/verify/ARK-1/proof',
      expect.objectContaining({ signal: expect.anything() }),
    ));
  });

  it('state 1 — 200 + verified true + proof_bundle -> available with the verbatim bundle', async () => {
    const bundle = { fingerprint: 'f', merkle_root: 'r', merkle_proof: [], merkle_index: 0, leaf_count: 1, tx_id: null, block_height: null, block_hash: null, block_header: null, op_return_payload: null, block_timestamp: null, proof_schema_version: 1, signature: null };
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, proof_bundle: bundle }));

    const { result } = renderHook(() => useProofAvailability('ARK-1', true));

    await waitFor(() => expect(result.current.state).toBe('available'));
    expect(result.current.proofBundle).toEqual(bundle);
    expect(result.current.loading).toBe(false);
  });

  it('state 1b — 200 + proof_bundle null -> empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, proof_bundle: null }));
    const { result } = renderHook(() => useProofAvailability('ARK-1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe('empty');
  });

  it.each([
    [404, 'No Merkle proof available for this record. It may not have been batch-anchored.', 'empty'],
    [404, 'Record not found', 'record-missing'],
    [429, 'rate limited', 'transient'],
  ] as const)('status %i with body %s -> %s', async (status, error, expected) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error }));
    const { result } = renderHook(() => useProofAvailability('ARK-1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe(expected);
  });

  it('5xx -> retry', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal server error' }));
    const { result } = renderHook(() => useProofAvailability('ARK-1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe('retry');
  });

  it('network failure -> retry', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useProofAvailability('ARK-1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe('retry');
  });

  it('verified:false on 200 -> retry, never available', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: false, proof_bundle: { fake: true } }));
    const { result } = renderHook(() => useProofAvailability('ARK-1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toBe('retry');
    expect(result.current.proofBundle).toBeNull();
  });

  it('retry() re-fetches', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal server error' }));
    const { result } = renderHook(() => useProofAvailability('ARK-1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    result.current.retry();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
