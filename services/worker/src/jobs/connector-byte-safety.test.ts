/**
 * SCRUM-2492 (§1.6A) — connector-byte handling hardening: the mandated
 * multi-MB runtime leak test (L6).
 *
 * Drives a ≥5 MB document Buffer through EVERY failure-path sink and asserts
 * the raw bytes appear in NONE of them:
 *   1. a thrown connector error's message / serialized fields,
 *   2. `job_queue.last_error` (via the real `failJob`),
 *   3. captured `logger.error` / `logger.warn` output (real pino + redaction),
 *   4. a Sentry event fed through the real `scrubPiiFromEvent`.
 *
 * The canary buffer is filled with 0x25 ('%'), a PRINTABLE byte — so if any
 * sink leaked the raw bytes it would show up as a long run of '%' (which the
 * generic PII scrubbers would NOT catch, since '%' is not PII). Detecting the
 * absence of that run is therefore a true test of the byte-safety guards, not
 * of the pre-existing PII redaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino, { type Logger as PinoLogger } from 'pino';

// Mutable capture for the mocked Supabase `.update({...})` payloads. Declared
// via vi.hoisted so the vi.mock factory (hoisted to the top) can close over it.
const { dbUpdatePayloads } = vi.hoisted(() => ({ dbUpdatePayloads: [] as Array<Record<string, unknown>> }));

// Mock ONLY the db module (so failJob's write is captured). The real
// utils/logger.js stays in place so its byte-redaction exports remain
// importable and the real logger object can be spied on.
vi.mock('../utils/db.js', () => ({
  db: {
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        dbUpdatePayloads.push(payload);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  },
}));
vi.mock('../config.js', () => ({
  config: { logLevel: 'silent', nodeEnv: 'test' },
}));
vi.mock('../utils/correlationId.js', () => ({
  getCorrelationId: () => undefined,
}));

// ── Canary: a 5 MiB document filled with a printable byte ('%' = 0x25). ──
const FIVE_MB = 5 * 1024 * 1024;
const CANARY_BYTE = 0x25; // '%'
const documentBytes = Buffer.alloc(FIVE_MB, CANARY_BYTE);
// A run of '%' long enough that no incidental usage could collide.
const CANARY_RUN = '%'.repeat(64);

/** Assert a captured sink output carries no run of raw canary bytes. */
function expectNoCanary(haystack: string): void {
  expect(haystack.includes(CANARY_RUN)).toBe(false);
  // Also assert the serialized-Buffer shape never leaked.
  expect(haystack.includes('"type":"Buffer"')).toBe(false);
  expect(/"data"\s*:\s*\[\s*37\s*,\s*37/.test(haystack)).toBe(false);
}

// ──────────────────────────────────────────────────────────────────────────
// 1 + 3. job_queue.last_error (real failJob) + captured logger.warn output.
// ──────────────────────────────────────────────────────────────────────────
describe('SCRUM-2492 L6 — last_error never carries document bytes', () => {
  beforeEach(() => {
    dbUpdatePayloads.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts a stringified 5MB buffer out of last_error (failed + dead)', async () => {
    const { failJob, sanitizeLastError } = await import('../utils/jobQueue.js');
    const { logger } = await import('../utils/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    // The realistic leak vector: a Buffer coerced to a string error message.
    const leakedMessage = `fetch failed: ${documentBytes.toString()}`;

    // Non-terminal failure (status 'failed') and terminal (status 'dead').
    await failJob('job-1', leakedMessage, 1, 3);
    await failJob('job-2', leakedMessage, 3, 3);

    expect(dbUpdatePayloads).toHaveLength(2);
    for (const payload of dbUpdatePayloads) {
      const lastError = String(payload.last_error ?? '');
      expectNoCanary(lastError);
      // The sanitizer collapses byte-runs to its token.
      expect(lastError).toBe('[redacted: binary content]');
    }

    // The dead-letter warn log (job-2 hit max attempts) must not carry bytes.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnSerialized = JSON.stringify(warnSpy.mock.calls[0]);
    expectNoCanary(warnSerialized);

    // Direct unit check of the exported sanitizer on raw byte inputs.
    expect(sanitizeLastError(documentBytes)).toBe('[redacted: binary content]');
    expect(sanitizeLastError(new Uint8Array(documentBytes))).toBe('[redacted: binary content]');
    expect(sanitizeLastError(JSON.stringify(documentBytes))).toBe('[redacted: binary content]');
    // A normal error message round-trips unchanged (bounded).
    expect(sanitizeLastError('docusign_integration_lookup_failed')).toBe(
      'docusign_integration_lookup_failed',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3. Real pino logger + redaction: bytes on ANY key are stripped at log time.
// ──────────────────────────────────────────────────────────────────────────
describe('SCRUM-2492 L6 — pino strips document bytes from log output', () => {
  it('redacts a 5MB Buffer reaching logger.error on arbitrary keys', async () => {
    const { redactBinaryValues, REDACTED_BYTES_TOKEN } = await import('../utils/logger.js');

    // Build a real pino logger with the SAME redaction wiring as utils/logger,
    // writing to an in-memory capture so we can inspect the emitted JSON.
    let captured = '';
    // pino CJS/ESM interop: runtime may be `{ default: fn }` (same bridge as
    // utils/logger.ts). The `any` cast is required because the namespace import
    // type has no call signature.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinoFn = ((pino as any).default ?? pino) as (opts: unknown, stream?: unknown) => PinoLogger;
    const captureStream = { write: (chunk: string) => { captured += chunk; } };
    const testLogger = pinoFn(
      {
        level: 'info',
        formatters: { log: (obj: Record<string, unknown>) => redactBinaryValues(obj) },
      },
      captureStream,
    );

    testLogger.error(
      {
        documentBytes,
        nested: { deeply: { payload: documentBytes } },
        typedArray: new Uint8Array(documentBytes),
        arrayBuffer: documentBytes.buffer.slice(0, 16),
        serialized: { type: 'Buffer', data: [37, 37, 37, 37, 37] },
        safe: 'docusign_integration_lookup_failed',
      },
      'DocuSign document fetch failed',
    );

    expectNoCanary(captured);
    expect(captured).toContain(REDACTED_BYTES_TOKEN);
    // The safe, non-byte field survives.
    expect(captured).toContain('docusign_integration_lookup_failed');
  });

  it('redactBinaryValues leaves byteLength and fingerprint metadata intact', async () => {
    const { redactBinaryValues, REDACTED_BYTES_TOKEN } = await import('../utils/logger.js');
    const out = redactBinaryValues({
      byteLength: documentBytes.byteLength,
      fingerprint: 'a'.repeat(64),
      documentBytes,
    });
    expect(out).toEqual({
      byteLength: FIVE_MB,
      fingerprint: 'a'.repeat(64),
      documentBytes: REDACTED_BYTES_TOKEN,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4. Sentry: scrubPiiFromEvent drops binary by type across the whole event.
// ──────────────────────────────────────────────────────────────────────────
describe('SCRUM-2492 L6 — Sentry scrub drops document bytes by type', () => {
  it('strips a 5MB Buffer from extra, contexts, exception, and nested keys', async () => {
    const { scrubPiiFromEvent, scrubPiiFromBreadcrumb, REDACTED_BYTES_TOKEN } = await import(
      '../utils/sentry.js'
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event: any = {
      message: 'DocuSign document fetch failed',
      extra: {
        documentBytes,
        unexpectedKey: new Uint8Array(documentBytes),
        serialized: { type: 'Buffer', data: [37, 37, 37, 37] },
      },
      contexts: {
        connector: { payload: documentBytes, byteLength: documentBytes.byteLength },
      },
      exception: {
        values: [{ type: 'DocusignApiError', value: 'fetch failed', stacktrace: { frames: [] } }],
      },
      tags: { provider: 'docusign' },
    };

    const scrubbed = scrubPiiFromEvent(event);
    const serialized = JSON.stringify(scrubbed);
    expectNoCanary(serialized);
    expect(scrubbed?.extra?.documentBytes).toBe(REDACTED_BYTES_TOKEN);
    expect((scrubbed?.extra as Record<string, unknown>)?.unexpectedKey).toBe(REDACTED_BYTES_TOKEN);
    // Non-byte metadata is preserved.
    expect((scrubbed?.contexts?.connector as Record<string, unknown>)?.byteLength).toBe(FIVE_MB);
    expect(scrubbed?.tags?.provider).toBe('docusign');

    // Breadcrumb path too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const crumb: any = { category: 'connector', data: { documentBytes } };
    const scrubbedCrumb = scrubPiiFromBreadcrumb(crumb);
    expectNoCanary(JSON.stringify(scrubbedCrumb));
    expect((scrubbedCrumb?.data as Record<string, unknown>)?.documentBytes).toBe(REDACTED_BYTES_TOKEN);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. Thrown connector error carries no document bytes (byte-safe by construction).
// ──────────────────────────────────────────────────────────────────────────
describe('SCRUM-2492 L6 — thrown connector errors carry no document bytes', () => {
  it('DocusignApiError from a failing 5MB document fetch has no bytes', async () => {
    const { fetchDocusignCombinedDocument, DocusignApiError } = await import(
      '../integrations/oauth/docusign.js'
    );

    // A failing (non-2xx) response whose BODY is the 5 MB document.
    const fetchImpl = vi.fn(async () =>
      new Response(documentBytes, { status: 502, headers: { 'content-type': 'application/pdf' } }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await fetchDocusignCombinedDocument({
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        envelopeId: 'env-1',
        accessToken: 'token',
        deps: { fetchImpl },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DocusignApiError);
    const error = caught as InstanceType<typeof DocusignApiError>;
    expect(error.status).toBe(502);
    // The error is byte-safe by construction: message + status only, no body.
    expect('body' in error).toBe(false);
    expectNoCanary(error.message);
    expectNoCanary(error.stack ?? '');
    // Enumerable own props (what a logger/Sentry serializer would copy) are clean.
    expectNoCanary(JSON.stringify({ ...error, message: error.message, stack: error.stack }));
  });

  it('DriveApiError is byte-safe by construction', async () => {
    const { DriveApiError } = await import('../integrations/oauth/drive.js');
    const err = new DriveApiError('Drive files.get failed', 403);
    expect('body' in err).toBe(false);
    expect(err.status).toBe(403);
    expectNoCanary(JSON.stringify({ ...err, message: err.message }));
  });
});
