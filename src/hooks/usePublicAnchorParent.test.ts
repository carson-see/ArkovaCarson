/**
 * usePublicAnchorParent tests
 *
 * PR #3190 review finding 2: the public verification page's `get_public_anchor`
 * RPC does not emit `parent_public_id`/`version_number` (confirmed against
 * production). `get_anchor_lineage` does, but is SECURITY DEFINER with EXECUTE
 * granted to neither anon nor authenticated — the browser cannot call it.
 * `GET /api/v1/verify/:publicId` (services/worker/src/api/v1/verify.ts) is a
 * genuinely public, anonymous-GET-allowed endpoint that ALREADY surfaces
 * `parent_public_id` (API-RICH-01) without any backend change — the same
 * router family `useProofAvailability` already calls from this exact page for
 * `/proof`. This hook calls the sibling base route for just that one field.
 *
 * Response shape is taken from the documented OpenAPI schema in
 * services/worker/src/api/v1/docs.ts (`parent_public_id: { type: 'string',
 * nullable: true }`) and the handler's own `VerificationResult` type in
 * verify.ts — not invented.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/workerClient', () => ({
  WORKER_URL: 'https://worker.test',
}));

import { usePublicAnchorParent } from './usePublicAnchorParent';

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body } as Response;
}

describe('usePublicAnchorParent', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not fetch when disabled', () => {
    renderHook(() => usePublicAnchorParent('ARK-1', false));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when publicId is missing', () => {
    renderHook(() => usePublicAnchorParent(undefined, true));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls GET /api/v1/verify/:publicId (the base route, not /proof) against WORKER_URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, status: 'SUPERSEDED' }));
    renderHook(() => usePublicAnchorParent('ARK-DOC-7RFUVV', true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.test/api/v1/verify/ARK-DOC-7RFUVV',
      expect.objectContaining({ signal: expect.anything() }),
    ));
  });

  it('returns the real parent_public_id when the endpoint provides one (the documented API-RICH-01 shape)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      verified: true,
      status: 'SECURED',
      parent_public_id: 'ARK-DOC-OLDER',
      version_number: 2,
    }));

    const { result } = renderHook(() => usePublicAnchorParent('ARK-DOC-NEWER', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parentPublicId).toBe('ARK-DOC-OLDER');
  });

  it('returns null when the endpoint omits parent_public_id (the root/no-parent case)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, status: 'SUPERSEDED' }));

    const { result } = renderHook(() => usePublicAnchorParent('ARK-DOC-7RFUVV', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parentPublicId).toBeNull();
  });

  it('degrades to null (never throws, never blocks the page) on a 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { verified: false, error: 'Record not found' }));

    const { result } = renderHook(() => usePublicAnchorParent('ARK-MISSING', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parentPublicId).toBeNull();
  });

  it('degrades to null on a network failure — this is a supplementary fetch, never a page-blocking one', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => usePublicAnchorParent('ARK-DOC-7RFUVV', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parentPublicId).toBeNull();
  });

  it('ignores a non-string parent_public_id (never trusts an unexpected shape)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, parent_public_id: 12345 }));

    const { result } = renderHook(() => usePublicAnchorParent('ARK-DOC-7RFUVV', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parentPublicId).toBeNull();
  });
});
