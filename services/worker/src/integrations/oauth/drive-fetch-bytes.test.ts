/**
 * SCRUM-2903 GD-PROD — fetchDriveFileBytes §1.6A tests.
 *
 * Pre-mortem (a): the document-fetch path must NEVER read/attach the response
 * body on error — an error body can carry document bytes. These tests prove:
 *   - success returns bytes + transport metadata (media & export transports),
 *   - a non-OK response throws DriveApiError with status + message ONLY (no
 *     `detail`, no `body`), and the response body is NOT read.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchDriveFileBytes,
  isGoogleAppsMimeType,
  resolveDriveExportMimeType,
  DriveApiError,
} from './drive.js';

function okBytesResponse(bytes: Buffer, contentType = 'application/pdf') {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: vi.fn(async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    // These MUST NOT be called on the success path either (we use arrayBuffer).
    json: vi.fn(async () => ({ leak: 'should-not-be-read' })),
    text: vi.fn(async () => 'should-not-be-read'),
  } as unknown as Response;
}

describe('fetchDriveFileBytes — transport selection', () => {
  it('uses alt=media for binary (non-Google-native) files', async () => {
    const bytes = Buffer.from('%PDF-1.7 binary payload');
    const fetchImpl = vi.fn(async (..._args: unknown[]) => okBytesResponse(bytes));
    const result = await fetchDriveFileBytes({
      fileId: 'file-123',
      accessToken: 'tok',
      mimeType: 'application/pdf',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const calledUrl = (fetchImpl.mock.calls[0]![0] as string);
    expect(calledUrl).toContain('/files/file-123?alt=media');
    expect(calledUrl).not.toContain('/export');
    expect(result.bytes.equals(bytes)).toBe(true);
    expect(result.exportMimeType).toBeNull();
    expect(result.contentType).toBe('application/pdf');
  });

  it('uses files.export (PDF) for a Google-native doc', async () => {
    const bytes = Buffer.from('exported pdf bytes');
    const fetchImpl = vi.fn(async (..._args: unknown[]) => okBytesResponse(bytes));
    const result = await fetchDriveFileBytes({
      fileId: 'doc-1',
      accessToken: 'tok',
      mimeType: 'application/vnd.google-apps.document',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const calledUrl = (fetchImpl.mock.calls[0]![0] as string);
    expect(calledUrl).toContain('/files/doc-1/export?mimeType=application%2Fpdf');
    expect(result.exportMimeType).toBe('application/pdf');
  });

  it('helpers classify + resolve google-native mime types', () => {
    expect(isGoogleAppsMimeType('application/vnd.google-apps.spreadsheet')).toBe(true);
    expect(isGoogleAppsMimeType('application/pdf')).toBe(false);
    expect(isGoogleAppsMimeType(null)).toBe(false);
    expect(resolveDriveExportMimeType('application/vnd.google-apps.presentation')).toBe('application/pdf');
    // Unknown native family falls back to PDF (never throws).
    expect(resolveDriveExportMimeType('application/vnd.google-apps.form')).toBe('application/pdf');
  });
});

describe('fetchDriveFileBytes — §1.6A error discipline (pre-mortem a)', () => {
  it('throws status+message only and does NOT read the error body', async () => {
    const json = vi.fn(async () => ({ error: 'boom', maybe_bytes: 'x'.repeat(9999) }));
    const text = vi.fn(async () => 'x'.repeat(9999));
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8));
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json,
      text,
      arrayBuffer,
    }) as unknown as Response);

    let caught: unknown;
    try {
      await fetchDriveFileBytes({
        fileId: 'f',
        accessToken: 'tok',
        mimeType: 'application/pdf',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DriveApiError);
    const err = caught as DriveApiError;
    expect(err.status).toBe(403);
    expect(err.message).toBe('Drive file bytes fetch failed');
    // §1.6A: NO detail, NO body — nothing derived from the response payload.
    expect(err.detail).toBeUndefined();
    expect((err as unknown as { body?: unknown }).body).toBeUndefined();
    // The body was never read.
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
