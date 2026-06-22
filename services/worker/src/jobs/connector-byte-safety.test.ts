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

// ──────────────────────────────────────────────────────────────────────────
// 5. boundedErrorDetail: bounded + byte-safe + PII-scrubbed by construction.
//    Restores connector-ops debuggability on NON-document paths (SCRUM-2492
//    follow-up) WITHOUT reopening the byte-leak surface §1.6A closed.
// ──────────────────────────────────────────────────────────────────────────
describe('SCRUM-2492 — boundedErrorDetail (non-document connector error detail)', () => {
  it('returns undefined for null/undefined/empty', async () => {
    const { boundedErrorDetail } = await import('../utils/byte-safety.js');
    expect(boundedErrorDetail(null)).toBeUndefined();
    expect(boundedErrorDetail(undefined)).toBeUndefined();
    expect(boundedErrorDetail('')).toBeUndefined();
    expect(boundedErrorDetail({})).toBe('{}'); // empty object still serializes
  });

  it('stringifies a safe OAuth error body and passes strings through', async () => {
    const { boundedErrorDetail } = await import('../utils/byte-safety.js');
    // The canonical safe OAuth/API error JSON the task calls out.
    const detail = boundedErrorDetail({ error: 'invalid_grant', error_description: 'Token expired' });
    expect(detail).toBe('{"error":"invalid_grant","error_description":"Token expired"}');
    expect(boundedErrorDetail('already a string')).toBe('already a string');
  });

  it('PII-scrubs email / UUID / JWT / token-in-URL out of the detail', async () => {
    const { boundedErrorDetail } = await import('../utils/byte-safety.js');
    const detail = boundedErrorDetail({
      error: 'invalid_request',
      user: 'alice@example.com',
      org_id: '550e8400-e29b-41d4-a716-446655440000',
      assertion: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.abcDEFghiJKL',
      redirect: 'https://x.test/cb?access_token=supersecretvalue123',
    });
    expect(detail).toBeDefined();
    const d = detail as string;
    // Each PII class is removed by the shared sentry/pii-scrub regexes. We assert
    // the security property (raw PII absent) — the exact replacement token can
    // vary where two scrubber patterns overlap (the trailing UUID digit run is
    // matched by the phone pass first), which is fine: no raw value escapes.
    expect(d).not.toContain('alice@example.com');
    expect(d).toContain('[EMAIL]');
    expect(d).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(d).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(d).toContain('[JWT]');
    expect(d).not.toContain('supersecretvalue123');
    expect(d).toContain('[FILTERED]');
    // The safe, non-PII error code survives.
    expect(d).toContain('invalid_request');
  });

  it('caps the detail at ~500 chars', async () => {
    const { boundedErrorDetail } = await import('../utils/byte-safety.js');
    // Varied (non-repeating) content so the low-entropy byte-fill heuristic does
    // not (correctly) redact it — this exercises the length cap, not the guard.
    const varied = Array.from({ length: 5000 }, (_v, i) => String.fromCharCode(97 + (i % 26))).join('');
    const long = boundedErrorDetail(varied);
    expect(long).toBeDefined();
    expect((long as string).length).toBe(500);
  });

  it('redacts a detail built from a byte-bearing body (Buffer / typed-array / ArrayBuffer / serialized shape)', async () => {
    const { boundedErrorDetail, REDACTED_BYTES_TOKEN } = await import('../utils/byte-safety.js');
    // (c) the mandated case: a detail built from raw document bytes is redacted.
    expect(boundedErrorDetail(documentBytes)).toBe(REDACTED_BYTES_TOKEN);
    expect(boundedErrorDetail(new Uint8Array(documentBytes))).toBe(REDACTED_BYTES_TOKEN);
    expect(boundedErrorDetail(documentBytes.buffer.slice(0, 64))).toBe(REDACTED_BYTES_TOKEN);
    expect(boundedErrorDetail({ type: 'Buffer', data: [37, 37, 37, 37, 37] })).toBe(
      REDACTED_BYTES_TOKEN,
    );
    // A string that is actually the 5MB buffer coerced to text is caught too.
    const detail = boundedErrorDetail(documentBytes.toString());
    expect(detail).toBe(REDACTED_BYTES_TOKEN);
    expectNoCanary(detail ?? '');
  });

  it('(a) a NON-document connector error carries a bounded, byte-free, PII-scrubbed detail', async () => {
    const { exchangeDocusignCode, DocusignApiError } = await import(
      '../integrations/oauth/docusign.js'
    );
    const { exchangeCode, DriveApiError } = await import('../integrations/oauth/drive.js');

    // DocuSign token exchange failure → safe OAuth error JSON in the body.
    const dsFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), {
        status: 400,
      }),
    ) as unknown as typeof fetch;
    let dsErr: unknown;
    try {
      await exchangeDocusignCode({
        code: 'bad',
        redirectUri: 'https://x.test/cb',
        deps: {
          env: { DOCUSIGN_INTEGRATION_KEY: 'ik', DOCUSIGN_CLIENT_SECRET: 'cs' } as NodeJS.ProcessEnv,
          fetchImpl: dsFetch,
        },
      });
    } catch (e) {
      dsErr = e;
    }
    expect(dsErr).toBeInstanceOf(DocusignApiError);
    const dse = dsErr as InstanceType<typeof DocusignApiError>;
    expect(dse.status).toBe(400);
    expect(dse.detail).toBe('{"error":"invalid_grant","error_description":"expired"}');
    expectNoCanary(dse.detail ?? '');

    // Drive token exchange failure → safe Google API error JSON in the body.
    const drFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 }),
    ) as unknown as typeof fetch;
    let drErr: unknown;
    try {
      await exchangeCode({
        code: 'bad',
        redirectUri: 'https://x.test/cb',
        deps: {
          env: {
            GOOGLE_OAUTH_CLIENT_ID: 'cid',
            GOOGLE_OAUTH_CLIENT_SECRET: 'sec',
          } as NodeJS.ProcessEnv,
          fetchImpl: drFetch,
        },
      });
    } catch (e) {
      drErr = e;
    }
    expect(drErr).toBeInstanceOf(DriveApiError);
    const dre = drErr as InstanceType<typeof DriveApiError>;
    expect(dre.status).toBe(401);
    expect(dre.detail).toBe('{"error":"invalid_grant"}');
  });

  it('(b) the document-fetch error has NO detail even when the failing body is 5MB of bytes', async () => {
    const { fetchDocusignCombinedDocument, DocusignApiError } = await import(
      '../integrations/oauth/docusign.js'
    );

    // A failing response whose BODY is the 5 MB document — the doc-fetch path
    // must NOT read it. Status + message only, detail stays undefined.
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
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DocusignApiError);
    const err = caught as InstanceType<typeof DocusignApiError>;
    expect(err.status).toBe(502);
    // The document-fetch path is detail-FREE (and body-free) by construction.
    expect(err.detail).toBeUndefined();
    expect('body' in err).toBe(false);
    expectNoCanary(JSON.stringify({ ...err, message: err.message, stack: err.stack }));
  });
});
