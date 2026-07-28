/**
 * MixedBatchUploadWizard tests (SCRUM-2911 W1, founder P0 2026-07-28).
 *
 * Covers: per-file client-side fingerprinting, the §1.6 boundary (no
 * File/Blob/ArrayBuffer ever reaches `fetch`), honest duplicate/failure
 * rendering, and large-batch behavior.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MixedBatchUploadWizard } from './MixedBatchUploadWizard';
import { MIXED_BATCH_LABELS } from '@/lib/copy';

const mockGenerateFingerprint = vi.fn();
vi.mock('@/lib/fileHasher', () => ({
  generateFingerprint: (...args: unknown[]) => mockGenerateFingerprint(...args),
}));

const mockWorkerFetch = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => mockWorkerFetch(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function fp(n: number): string {
  return n.toString(16).padStart(64, '0');
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) };
}

function makeFiles(n: number, prefix = 'file'): File[] {
  return Array.from({ length: n }, (_, i) => new File([`content-${i}`], `${prefix}-${i}.pdf`, { type: 'application/pdf' }));
}

describe('MixedBatchUploadWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateFingerprint.mockImplementation(async (file: File) => {
      // Deterministic per-file fingerprint derived from name so assertions
      // can correlate results back to specific files.
      const idx = Number(file.name.match(/-(\d+)\./)?.[1] ?? 0);
      return fp(idx + 1);
    });
  });

  it('fingerprints every file client-side before submitting (per-file hashing)', async () => {
    const files = makeFiles(3);
    mockWorkerFetch.mockResolvedValueOnce(jsonResponse(201, {
      queued: 3,
      duplicates: [],
      errors: [],
      anchors: files.map((_, i) => ({ public_id: `ARK-${i}`, fingerprint: fp(i + 1) })),
    }));

    render(<MixedBatchUploadWizard files={files} />);

    await waitFor(() => {
      expect(mockGenerateFingerprint).toHaveBeenCalledTimes(3);
    });
    files.forEach((f) => {
      expect(mockGenerateFingerprint).toHaveBeenCalledWith(f);
    });

    await waitFor(() => {
      expect(screen.getByTestId('mixed-batch-results')).toBeInTheDocument();
    });
  });

  // §1.6 — documents never leave the browser. Only the fingerprint string,
  // filename, and a coarse extension string may leave in the request body.
  it('never passes a File, Blob, or ArrayBuffer to fetch — only fingerprint strings', async () => {
    const files = makeFiles(2);
    mockWorkerFetch.mockResolvedValueOnce(jsonResponse(201, {
      queued: 2,
      duplicates: [],
      errors: [],
      anchors: files.map((_, i) => ({ public_id: `ARK-${i}`, fingerprint: fp(i + 1) })),
    }));

    render(<MixedBatchUploadWizard files={files} />);

    await waitFor(() => expect(mockWorkerFetch).toHaveBeenCalledTimes(1));

    const [endpoint, options] = mockWorkerFetch.mock.calls[0];
    expect(endpoint).toBe('/api/v1/anchor/bulk/self-service');
    expect(typeof options.body).toBe('string'); // JSON string, not a File/Blob/FormData

    // Walk every value in the call args — none may be a File/Blob/ArrayBuffer.
    const seen = new Set<unknown>();
    function assertNoRawBytes(value: unknown): void {
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      expect(value instanceof File).toBe(false);
      expect(value instanceof Blob).toBe(false);
      expect(value instanceof ArrayBuffer).toBe(false);
      if (Array.isArray(value)) {
        value.forEach(assertNoRawBytes);
      } else {
        Object.values(value as Record<string, unknown>).forEach(assertNoRawBytes);
      }
    }
    assertNoRawBytes(mockWorkerFetch.mock.calls[0]);

    // The body itself must decode to plain fingerprint/filename/document_type rows.
    const parsed = JSON.parse(options.body as string);
    expect(parsed.anchors).toEqual([
      { fingerprint: fp(1), filename: 'file-0.pdf', document_type: 'pdf' },
      { fingerprint: fp(2), filename: 'file-1.pdf', document_type: 'pdf' },
    ]);
  });

  it('renders duplicates and failures honestly, never silently swallowed', async () => {
    const files = makeFiles(3);
    mockWorkerFetch.mockResolvedValueOnce(jsonResponse(201, {
      queued: 1,
      duplicates: [{ row: 1, fingerprint: fp(2) }],
      errors: [{ row: 2, message: 'Failed to create anchor record.' }],
      anchors: [{ public_id: 'ARK-0', fingerprint: fp(1) }],
    }));

    render(<MixedBatchUploadWizard files={files} />);

    await waitFor(() => {
      expect(screen.getByText(`1 ${MIXED_BATCH_LABELS.SUMMARY_SECURED}`)).toBeInTheDocument();
    });
    expect(screen.getByText(`1 ${MIXED_BATCH_LABELS.SUMMARY_DUPLICATE}`)).toBeInTheDocument();
    expect(screen.getByText(`1 ${MIXED_BATCH_LABELS.SUMMARY_FAILED}`)).toBeInTheDocument();

    const results = screen.getByTestId('mixed-batch-results');
    expect(results.textContent).toContain('file-0.pdf');
    expect(results.textContent).toContain('file-1.pdf');
    expect(results.textContent).toContain('file-2.pdf');
    expect(results.textContent).toContain(MIXED_BATCH_LABELS.STATUS_DUPLICATE);
    expect(results.textContent).toContain('Failed to create anchor record.');
  });

  it('reports fingerprint failures as failed results without submitting them', async () => {
    mockGenerateFingerprint.mockImplementation(async (file: File) => {
      if (file.name.includes('bad')) throw new Error('Fingerprint generation timed out.');
      return fp(1);
    });
    const files = [
      new File(['ok'], 'good.pdf', { type: 'application/pdf' }),
      new File(['bad'], 'bad.pdf', { type: 'application/pdf' }),
    ];
    mockWorkerFetch.mockResolvedValueOnce(jsonResponse(201, {
      queued: 1,
      duplicates: [],
      errors: [],
      anchors: [{ public_id: 'ARK-0', fingerprint: fp(1) }],
    }));

    render(<MixedBatchUploadWizard files={files} />);

    await waitFor(() => {
      expect(screen.getByTestId('mixed-batch-results')).toBeInTheDocument();
    });

    // Only the successfully-hashed file was submitted.
    const [, options] = mockWorkerFetch.mock.calls[0];
    const parsed = JSON.parse(options.body as string);
    expect(parsed.anchors).toHaveLength(1);
    expect(parsed.anchors[0].filename).toBe('good.pdf');

    const results = screen.getByTestId('mixed-batch-results');
    expect(results.textContent).toContain('bad.pdf');
    expect(results.textContent).toContain('Fingerprint generation timed out.');
    expect(screen.getByText(`1 ${MIXED_BATCH_LABELS.SUMMARY_FAILED}`)).toBeInTheDocument();
  });

  it('shows the organization-required message on a 403 from the bridge endpoint', async () => {
    const files = makeFiles(1);
    mockWorkerFetch.mockResolvedValueOnce(jsonResponse(403, {
      error: 'organization_required',
      message: MIXED_BATCH_LABELS.ORG_REQUIRED,
    }));

    render(<MixedBatchUploadWizard files={files} />);

    await waitFor(() => {
      expect(screen.getByText(MIXED_BATCH_LABELS.ORG_REQUIRED)).toBeInTheDocument();
    });
  });

  it('handles a large batch (50 files) — hashes and submits all of them', async () => {
    const files = makeFiles(50);
    mockWorkerFetch.mockResolvedValueOnce(jsonResponse(201, {
      queued: 50,
      duplicates: [],
      errors: [],
      anchors: files.map((_, i) => ({ public_id: `ARK-${i}`, fingerprint: fp(i + 1) })),
    }));

    render(<MixedBatchUploadWizard files={files} />);

    await waitFor(() => {
      expect(mockGenerateFingerprint).toHaveBeenCalledTimes(50);
    });
    await waitFor(() => {
      expect(mockWorkerFetch).toHaveBeenCalledTimes(1); // single chunk (< 200-row cap)
    });

    const [, options] = mockWorkerFetch.mock.calls[0];
    const parsed = JSON.parse(options.body as string);
    expect(parsed.anchors).toHaveLength(50);

    await waitFor(() => {
      expect(screen.getByText(`50 ${MIXED_BATCH_LABELS.SUMMARY_SECURED}`)).toBeInTheDocument();
    });
  });

  it('calls onCancel when the wizard is dismissed after completion', async () => {
    const files = makeFiles(1);
    mockWorkerFetch.mockResolvedValueOnce(jsonResponse(201, {
      queued: 1,
      duplicates: [],
      errors: [],
      anchors: [{ public_id: 'ARK-0', fingerprint: fp(1) }],
    }));
    const onCancel = vi.fn();

    render(<MixedBatchUploadWizard files={files} onCancel={onCancel} />);

    await waitFor(() => {
      expect(screen.getByText(MIXED_BATCH_LABELS.DONE)).toBeInTheDocument();
    });
    await act(async () => {
      screen.getByText(MIXED_BATCH_LABELS.DONE).click();
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
