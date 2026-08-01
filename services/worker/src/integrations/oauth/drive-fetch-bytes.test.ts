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
  DriveDocumentTooLargeError,
  MAX_DRIVE_DOCUMENT_BYTES,
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

// ─── Size cap ────────────────────────────────────────────────────────────────
// The fetch trigger is "any file changed in a watched folder", so the byte count
// is chosen by whoever can write to that folder, while the worker shares a 2 GiB
// Cloud Run container with the anchoring / confirmation / billing crons. An
// uncapped Buffer here lets one large upload OOM-kill every in-flight job.
describe('fetchDriveFileBytes — MAX_DRIVE_DOCUMENT_BYTES cap', () => {
  function oversizedDeclaredResponse(declaredBytes: number) {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    return {
      response: {
        ok: true,
        status: 200,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === 'content-length' ? String(declaredBytes) : null,
        },
        arrayBuffer,
      } as unknown as Response,
      arrayBuffer,
    };
  }

  it('rejects on Content-Length BEFORE reading a single byte', async () => {
    const { response, arrayBuffer } = oversizedDeclaredResponse(MAX_DRIVE_DOCUMENT_BYTES + 1);
    const fetchImpl = vi.fn(async (..._args: unknown[]) => response);

    await expect(
      fetchDriveFileBytes({
        fileId: 'huge',
        accessToken: 'tok',
        mimeType: 'application/pdf',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toBeInstanceOf(DriveDocumentTooLargeError);

    // The whole point: the body was never materialized.
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('still rejects when Content-Length is absent or lies (streamed body)', async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB
    const chunksNeeded = Math.ceil(MAX_DRIVE_DOCUMENT_BYTES / chunk.byteLength) + 2;
    let pulled = 0;
    const response = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < chunksNeeded; i += 1) {
            pulled += 1;
            yield chunk;
          }
        },
      },
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    } as unknown as Response;

    await expect(
      fetchDriveFileBytes({
        fileId: 'liar',
        accessToken: 'tok',
        mimeType: 'application/pdf',
        deps: { fetchImpl: vi.fn(async () => response) as unknown as typeof fetch },
      }),
    ).rejects.toBeInstanceOf(DriveDocumentTooLargeError);

    // We stopped pulling at the cap rather than draining the whole stream.
    expect(pulled).toBeLessThan(chunksNeeded);
  });

  it('carries only a byte count — never a body, buffer, or filename (§1.6A)', async () => {
    const { response } = oversizedDeclaredResponse(MAX_DRIVE_DOCUMENT_BYTES + 42);
    let caught: unknown;
    try {
      await fetchDriveFileBytes({
        fileId: 'secret-payslip.pdf',
        accessToken: 'tok',
        mimeType: 'application/pdf',
        deps: { fetchImpl: vi.fn(async () => response) as unknown as typeof fetch },
      });
    } catch (e) {
      caught = e;
    }

    const err = caught as DriveDocumentTooLargeError;
    expect(err).toBeInstanceOf(DriveDocumentTooLargeError);
    expect(err.byteLength).toBe(MAX_DRIVE_DOCUMENT_BYTES + 42);
    expect(err.limit).toBe(MAX_DRIVE_DOCUMENT_BYTES);
    expect(err.message).not.toContain('secret-payslip');
    expect(JSON.stringify(err)).not.toContain('secret-payslip');
    expect((err as unknown as { body?: unknown }).body).toBeUndefined();
    expect((err as unknown as { bytes?: unknown }).bytes).toBeUndefined();
  });

  it('lets a normal-sized document through unchanged', async () => {
    const bytes = Buffer.from('%PDF-1.7 a perfectly ordinary credential');
    const fetchImpl = vi.fn(async (..._args: unknown[]) => okBytesResponse(bytes));
    const result = await fetchDriveFileBytes({
      fileId: 'fine',
      accessToken: 'tok',
      mimeType: 'application/pdf',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(result.bytes.equals(bytes)).toBe(true);
  });
});
