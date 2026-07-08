/**
 * VerifierProofDownload Tests — FE-PROOF-GATE (SCRUM-2501)
 *
 * Pins the full proof-availability state machine against the
 * `/api/v1/verify/:publicId/proof` contract
 * (docs/reference/FE_PROOF_GATE_CONTRACT.md): state 1, state 1b, state 2
 * (the honest core), state 3 (not SECURED — status gate, no fetch), Record
 * not found, 429, and 5xx.
 *
 * @see UF-07, FE-PROOF-GATE / SCRUM-2501
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VerifierProofDownload } from './VerifierProofDownload';

vi.mock('@/lib/workerClient', () => ({
  WORKER_URL: 'https://worker.test',
}));

const PROOF_BUNDLE = {
  fingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  merkle_root: 'a'.repeat(64),
  merkle_proof: [{ hash: 'b'.repeat(64), position: 'left' as const }],
  merkle_index: 2,
  leaf_count: 8,
  tx_id: 'c'.repeat(64),
  block_height: 900123,
  block_hash: 'd'.repeat(64),
  block_header: 'e'.repeat(160),
  op_return_payload: `41524b56${'a'.repeat(64)}`,
  block_timestamp: '2026-07-01T00:00:00Z',
  proof_schema_version: 1,
  signature: null,
};

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body } as Response;
}

// Mock URL.createObjectURL
const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test');
const mockRevokeObjectURL = vi.fn();
Object.assign(URL, {
  createObjectURL: mockCreateObjectURL,
  revokeObjectURL: mockRevokeObjectURL,
});

async function withMockDownloadAnchor(run: (mockClick: ReturnType<typeof vi.fn>) => Promise<void>) {
  const original = document.createElement.bind(document);
  const mockClick = vi.fn();
  const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
    if (tag === 'a') {
      return { href: '', download: '', click: mockClick, setAttribute: vi.fn() } as unknown as HTMLAnchorElement;
    }
    return original(tag, options);
  });

  try {
    await run(mockClick);
  } finally {
    spy.mockRestore();
  }
}

describe('VerifierProofDownload', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------
  // SECURED-only status gate (unchanged behavior) — no fetch at all when
  // status isn't SECURED/ACTIVE.
  // ---------------------------------------------------------------------

  it.each(['PENDING', 'SUBMITTED', 'REVOKED', 'EXPIRED', 'SUPERSEDED'])(
    'returns null and does not fetch for %s anchors (SECURED-only download gate)',
    status => {
      const { container } = render(<VerifierProofDownload publicId="ARK-1" status={status} />);
      expect(container).toBeEmptyDOMElement();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  // ---------------------------------------------------------------------
  // State 1 — 200 + verified true + proof_bundle -> live download control.
  // ---------------------------------------------------------------------

  it('state 1: renders the download control for SECURED + 200 + bundle', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, proof_bundle: PROOF_BUNDLE }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByText('JSON Proof Package')).toBeInTheDocument());
    expect(screen.queryByTestId('proof-not-yet-available')).not.toBeInTheDocument();
  });

  it('state 1: renders for the ACTIVE public alias too', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, proof_bundle: PROOF_BUNDLE }));
    render(<VerifierProofDownload publicId="ARK-1" status="ACTIVE" />);

    await waitFor(() => expect(screen.getByText('JSON Proof Package')).toBeInTheDocument());
  });

  it('state 1: downloaded artifact is the proof_bundle object verbatim, never a hand-assembled subset', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, proof_bundle: PROOF_BUNDLE }));
    await withMockDownloadAnchor(async mockClick => {
      render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);
      await waitFor(() => expect(screen.getByText('JSON Proof Package')).toBeInTheDocument());

      fireEvent.click(screen.getByText('JSON Proof Package'));

      await waitFor(() => expect(mockCreateObjectURL).toHaveBeenCalled());
      expect(mockClick).toHaveBeenCalled();
      const [blob] = mockCreateObjectURL.mock.calls[0] as [Blob];
      const downloaded = JSON.parse(await blob.text());
      expect(downloaded).toEqual(PROOF_BUNDLE);
    });
  });

  it('state 1: fetches GET /api/v1/verify/:publicId/proof', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, proof_bundle: PROOF_BUNDLE }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.test/api/v1/verify/ARK-1/proof',
      expect.objectContaining({ signal: expect.anything() }),
    ));
  });

  // ---------------------------------------------------------------------
  // State 1b — 200 + proof_bundle: null -> honest empty-state, same as state 2.
  // ---------------------------------------------------------------------

  it('state 1b: 200 with proof_bundle null renders the honest empty-state, no download control', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: true, proof_bundle: null }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByTestId('proof-not-yet-available')).toBeInTheDocument());
    expect(screen.queryByText('JSON Proof Package')).not.toBeInTheDocument();
    expect(screen.getByText(/Secured & Anchored/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------
  // State 2 (THE MOST IMPORTANT STATE) — 404 "No Merkle proof available…"
  // -> honest empty-state. NO download control, NO error toast.
  // ---------------------------------------------------------------------

  it('state 2: 404 "No Merkle proof available…" renders the honest empty-state', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, {
      error: 'No Merkle proof available for this record. It may not have been batch-anchored.',
    }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByTestId('proof-not-yet-available')).toBeInTheDocument());
  });

  it('state 2: renders NO download control', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, {
      error: 'No Merkle proof available for this record. It may not have been batch-anchored.',
    }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByTestId('proof-not-yet-available')).toBeInTheDocument());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('JSON Proof Package')).not.toBeInTheDocument();
  });

  it('state 2: renders NO error toast / alert role', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, {
      error: 'No Merkle proof available for this record. It may not have been batch-anchored.',
    }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByTestId('proof-not-yet-available')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('state 2: copy affirms Secured standing first and does not promise a date or say "generating"', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, {
      error: 'No Merkle proof available for this record. It may not have been batch-anchored.',
    }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByTestId('proof-not-yet-available')).toBeInTheDocument());
    const text = screen.getByTestId('proof-not-yet-available').textContent ?? '';
    expect(text).toMatch(/Secured/i);
    expect(text.toLowerCase()).not.toContain('generating');
    expect(text.toLowerCase()).not.toMatch(/\b(202[6-9]|20[3-9]\d)\b/); // no promised date/year
  });

  // ---------------------------------------------------------------------
  // Record not found — real error state, distinct from state 2.
  // ---------------------------------------------------------------------

  it('"Record not found" 404 renders a distinct real-error state, not the state-2 empty-state', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Record not found' }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByTestId('proof-record-missing')).toBeInTheDocument());
    expect(screen.queryByTestId('proof-not-yet-available')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------
  // 429 — transient. Render nothing.
  // ---------------------------------------------------------------------

  it('429 renders nothing (neither empty-state nor error)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: 'rate limited' }));
    const { container } = render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  // ---------------------------------------------------------------------
  // 5xx — retryable affordance, never state-2 copy.
  // ---------------------------------------------------------------------

  it('5xx renders a retryable "could not load" affordance, never state-2 copy', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal server error' }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByTestId('proof-retry')).toBeInTheDocument());
    expect(screen.queryByTestId('proof-not-yet-available')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('5xx retry button re-fetches', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal server error' }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByTestId('proof-retry')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('verified:false on 200 never offers the download (ops/error state)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { verified: false, proof_bundle: PROOF_BUNDLE }));
    render(<VerifierProofDownload publicId="ARK-1" status="SECURED" />);

    await waitFor(() => expect(screen.getByTestId('proof-retry')).toBeInTheDocument());
    expect(screen.queryByText('JSON Proof Package')).not.toBeInTheDocument();
  });
});
