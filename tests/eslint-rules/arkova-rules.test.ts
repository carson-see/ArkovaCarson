/**
 * Tests for custom ESLint rules (eslint-plugin-arkova)
 *
 * Verifies that the 3 test quality rules correctly flag anti-patterns
 * and pass on well-written tests.
 *
 * NOTE: ESLint 10's RuleTester.run() internally calls describe()/it(),
 * so each run() must be at the describe level — not nested inside it().
 */

import { describe } from 'vitest';
import { RuleTester } from 'eslint';
import tsParser from 'typescript-eslint';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser.parser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const noUnscopedServiceTest = require('../../eslint-rules/no-unscoped-service-test.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const requireErrorCodeAssertion = require('../../eslint-rules/require-error-code-assertion.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noMockEcho = require('../../eslint-rules/no-mock-echo.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tenantIsolation = require('../../eslint-rules/tenant-isolation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noConnectorBytesToSink = require('../../eslint-rules/no-connector-bytes-to-sink.cjs');

describe('arkova/no-unscoped-service-test', () => {
  ruleTester.run('no-unscoped-service-test', noUnscopedServiceTest, {
    valid: [
      {
        filename: 'useHook.test.ts',
        code: `
          vi.mock('@/lib/supabase', () => ({
            supabase: { from: mockFrom },
          }));
          const mockFrom = vi.fn();
          it('fetches scoped data', () => {
            expect(mockEq).toHaveBeenCalledWith('user_id', 'test-user');
          });
        `,
      },
      {
        filename: 'useHook.test.ts',
        code: `
          vi.mock('@/lib/supabase', () => ({
            supabase: { from: mockFrom },
          }));
          const mockFrom = vi.fn();
          it('proves the fallback table query does not run', () => {
            expect(mockFrom).not.toHaveBeenCalled();
          });
        `,
      },
      {
        filename: 'useHook.test.ts',
        code: `
          vi.mock('@/lib/supabase', () => ({
            supabase: { from: mockFrom },
          }));
          const mockFrom = vi.fn();
          it('uses the singleton treasury cache table', () => {
            expect(mockFrom).toHaveBeenCalledWith('treasury_cache');
          });
        `,
      },
      {
        filename: 'utils.test.ts',
        code: `
          it('adds numbers', () => {
            expect(add(1, 2)).toBe(3);
          });
        `,
      },
      {
        filename: 'useHook.ts', // Not a test file
        code: `
          vi.mock('@/lib/supabase', () => ({
            supabase: { from: mockFrom },
          }));
        `,
      },
    ],
    invalid: [
      {
        filename: 'useHook.test.ts',
        code: `
          vi.mock('@/lib/supabase', () => ({
            supabase: { from: mockFrom },
          }));
          const mockFrom = vi.fn();
          it('fetches data', () => {
            mockFrom.mockReturnValue({ select: vi.fn() });
            expect(result).toBeDefined();
          });
        `,
        errors: [{ messageId: 'unscopedService' }],
      },
    ],
  });
});

describe('arkova/require-error-code-assertion', () => {
  ruleTester.run('require-error-code-assertion', requireErrorCodeAssertion, {
    valid: [
      {
        filename: 'api.test.ts',
        code: `
          it('returns 403 on forbidden error', () => {
            expect(result.status).toBe(403);
          });
        `,
      },
      {
        filename: 'utils.test.ts',
        code: `
          it('transforms data correctly', () => {
            expect(transform(input)).toEqual(expected);
          });
        `,
      },
      {
        filename: 'api.test.ts',
        code: `
          it('rejects expired signed URLs', () => {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toBe('expired');
          });
        `,
      },
      {
        filename: 'api.test.ts',
        code: `
          it('rejects malformed null payloads', () => {
            expect(parse(input)).toBeNull();
          });
          it('accepts a valid ok response', () => {
            expect(result.ok).toBe(true);
          });
        `,
      },
    ],
    invalid: [
      {
        filename: 'api.test.ts',
        code: `
          it('returns null on API error', () => {
            const result = await fetch('/api');
            expect(result.ok).toBe(false);
            expect(data).toBeNull();
          });
        `,
        errors: [{ messageId: 'missingErrorCode' }],
      },
    ],
  });
});

describe('arkova/missing-org-filter', () => {
  ruleTester.run('tenant-isolation', tenantIsolation, {
    valid: [
      {
        code: `
          supabase.from('attestations').select('*').eq('attester_org_id', orgId);
        `,
      },
      {
        code: `
          supabase.from('attestations').select('*').eq('attester_user_id', userId);
        `,
      },
      {
        code: `
          supabase.from('subscriptions').select('id').eq('user_id', userId);
        `,
      },
      {
        code: `
          supabase.from('org_members').insert({ org_id: orgId, user_id: userId, role: 'owner' });
        `,
      },
      {
        code: `
          supabase.from('attestations').insert([
            { attester_org_id: orgId, title: 'Document A' },
            { attester_org_id: orgId, title: 'Document B' },
          ]);
        `,
      },
      {
        code: `
          supabase.from('attestations').select('*').match({ attester_org_id: orgId });
        `,
      },
      {
        code: `
          supabase.from('attestations').select('id', { count: 'exact', head: true }).match(orgId ? { attester_org_id: orgId } : { attester_user_id: userId });
        `,
      },
    ],
    invalid: [
      {
        code: `
          supabase.from('attestations').select('*');
        `,
        errors: [{ messageId: 'missingOrgFilter' }],
      },
      {
        code: `
          supabase.from('org_members').insert({ role: 'owner' });
        `,
        errors: [{ messageId: 'missingOrgFilter' }],
      },
      {
        code: `
          supabase.from('attestations').insert([
            { attester_org_id: orgId, title: 'Document A' },
            { title: 'Document B' },
          ]);
        `,
        errors: [{ messageId: 'missingOrgFilter' }],
      },
    ],
  });
});

describe('arkova/no-mock-echo', () => {
  ruleTester.run('no-mock-echo', noMockEcho, {
    valid: [
      {
        filename: 'useHook.test.ts',
        code: `
          const mockData = { first: 'John', last: 'Doe' };
          mockRpc.mockResolvedValue({ data: mockData });
          it('computes full name', () => {
            expect(result.fullName).toBe('John Doe');
            expect(result.initials).toBe('JD');
          });
        `,
      },
      {
        filename: 'useHook.test.ts',
        code: `
          const mockData = { value: 42 };
          mockFn.mockResolvedValue({ data: mockData });
          it('processes data', () => {
            expect(result.value).toBe(42);
            expect(result.doubled).toBe(84);
            expect(result.label).toBe('answer');
          });
        `,
      },
    ],
    invalid: [
      {
        filename: 'useHook.test.ts',
        code: `
          const mockData = { balance: 45, plan: 'Pro' };
          mockRpc.mockResolvedValue({ data: mockData });
          it('fetches credits', () => {
            expect(result.balance).toBe(45);
            expect(result.plan).toBe('Pro');
          });
        `,
        errors: [{ messageId: 'mockEcho' }],
      },
    ],
  });
});

describe('arkova/missing-org-filter', () => {
  ruleTester.run('missing-org-filter', tenantIsolation, {
    valid: [
      {
        filename: 'worker.ts',
        code: "await db.from('audit_events').select('created_at').is('org_id', null).limit(20);",
      },
      {
        filename: 'worker.ts',
        code: "await db.from('audit_events').insert({ event_type: 'smoke_test.completed', event_category: 'SYSTEM', org_id: null });",
      },
      {
        filename: 'worker.ts',
        code: "await db.from('audit_events').insert([{ event_type: 'a', org_id: 'org-1' }, { event_type: 'b', org_id: null }]);",
      },
    ],
    invalid: [
      {
        filename: 'worker.ts',
        code: "await db.from('audit_events').select('created_at').eq('event_type', 'smoke_test.completed').limit(20);",
        errors: [{ messageId: 'missingOrgFilter' }],
      },
      {
        filename: 'worker.ts',
        code: "await db.from('audit_events').insert({ event_type: 'smoke_test.completed', event_category: 'SYSTEM' });",
        errors: [{ messageId: 'missingOrgFilter' }],
      },
    ],
  });
});

// SCRUM-2492 — §1.6A connector-byte handling. Raw document bytes must never
// reach a logger, Sentry, an Error, last_error, a temp file, or Postgres.
// Cases map to the architect/security/QA-converged spec: positive (P1-P10),
// negative (N1-N7), and edge cases.
describe('arkova/no-connector-bytes-to-sink', () => {
  ruleTester.run('no-connector-bytes-to-sink', noConnectorBytesToSink, {
    valid: [
      // N1 — `.byteLength` numeric terminal (the canonical safe metadata write).
      {
        filename: 'docusign.ts',
        code: "logger.info({ byteLength: documentBytes.byteLength }, 'fetched');",
      },
      // N2 — `.length` numeric terminal.
      {
        filename: 'docusign.ts',
        code: "logger.info({ size: buffer.length }, 'fetched');",
      },
      // N3 — the fingerprint hex string from createHash(...).digest('hex').
      {
        filename: 'docusign.ts',
        code: "const fingerprint = createHash('sha256').update(documentBytes).digest('hex'); logger.info({ fingerprint }, 'hashed');",
      },
      // N4 — the canonical enqueueSignedDocument sink persists only byte_length.
      {
        filename: 'docusign-envelope-completed.ts',
        code: "await db.from('integration_events').insert({ org_id: orgId, details: { byte_length: documentBytes.byteLength, content_type: contentType } });",
      },
      // N5 — PKI/timestamp reader throws carry only the HTTP status, not bytes.
      {
        filename: 'crlManager.ts',
        code: "const raw = Buffer.from(await response.arrayBuffer()); if (!response.ok) throw new Error(`CRL fetch returned HTTP ${response.status}`);",
      },
      // N6 — byte-free connector error (status + message only).
      {
        filename: 'docusign.ts',
        code: "throw new DocusignApiError('DocuSign completed document fetch failed', res.status);",
      },
      // N7 — fingerprint passed to Sentry context (not raw bytes).
      {
        filename: 'docusign.ts',
        code: "Sentry.setContext('document', { fingerprint, byteLength: documentBytes.byteLength });",
      },
      // Edge — `.toString('hex')` is a safe textual digest, not raw bytes.
      {
        filename: 'docusign.ts',
        code: "logger.info({ digest: documentBytes.toString('hex') }, 'digest');",
      },
      // Edge — `.toString('base64')` is also a safe encoding.
      {
        filename: 'docusign.ts',
        code: "logger.debug({ b64: buffer.toString('base64') });",
      },
      // Edge — dynamically-typed value with no byte-ish name is NOT flagged.
      {
        filename: 'docusign.ts',
        code: "logger.info({ result }, 'done');",
      },
      // Edge — non-connector metadata object reaching a logger.
      {
        filename: 'docusign.ts',
        code: "logger.warn({ envelopeId, accountId, status }, 'envelope processed');",
      },
      // Edge — a digest var named `sha256` is not raw bytes.
      {
        filename: 'docusign.ts',
        code: "throw new Error(`anchor mismatch: ${sha256}`);",
      },
      // Edge — Postgres write of plain metadata (no bytes).
      {
        filename: 'docusign.ts',
        code: "await db.from('integration_events').update({ status: 'success', details: { envelope_id: envelopeId } });",
      },
    ],
    invalid: [
      // P1 — Buffer/identifier `documentBytes` into logger.error.
      {
        filename: 'docusign.ts',
        code: "logger.error({ documentBytes }, 'fetch failed');",
        errors: [{ messageId: 'bytesToSink', data: { sink: 'logger' } }],
      },
      // P2 — `*.bytes` member into a logger object key.
      {
        filename: 'docusign.ts',
        code: "logger.info({ payload: document.bytes }, 'fetched');",
        errors: [{ messageId: 'bytesToSink' }],
      },
      // P3 — Buffer.from(await res.arrayBuffer()) directly into a logger.
      {
        filename: 'docusign.ts',
        code: "logger.warn(Buffer.from(await res.arrayBuffer()), 'raw');",
        errors: [{ messageId: 'bytesToSink' }],
      },
      // P4 — bytes into a new Error message via template literal.
      {
        filename: 'docusign.ts',
        code: "throw new Error(`fetch failed for ${documentBytes}`);",
        errors: [{ messageId: 'bytesToSink', data: { sink: 'Error' } }],
      },
      // P5 — bytes into a custom connector error constructor.
      {
        filename: 'docusign.ts',
        code: "throw new DocusignApiError('fetch failed', res.status, documentBytes);",
        errors: [{ messageId: 'bytesToSink' }],
      },
      // P6 — bytes into `last_error:` inside a Postgres `.update({...})`.
      // The DB-write sink (outer, visited first) owns the report; the dedicated
      // `last_error` Property visitor catches the same value in non-DB objects
      // (e.g. a plain object handed to a helper). Range-dedupe → exactly one.
      {
        filename: 'jobQueue.ts',
        code: "await db.from('job_queue').update({ status: 'failed', last_error: documentBytes });",
        errors: [{ messageId: 'bytesToSink', data: { sink: 'Postgres write' } }],
      },
      // P6b — standalone `last_error:` object (not a DB call) is still caught.
      {
        filename: 'jobQueue.ts',
        code: "const patch = { status: 'failed', last_error: documentBytes }; return patch;",
        errors: [{ messageId: 'bytesToSink', data: { sink: 'last_error' } }],
      },
      // P7 — bytes into failJob(...).
      {
        filename: 'docusign-envelope-completed.ts',
        code: "await failJob(jobId, documentBytes, attempts, maxAttempts);",
        errors: [{ messageId: 'bytesToSink', data: { sink: 'last_error (failJob)' } }],
      },
      // P8 — bytes written to a temp file.
      {
        filename: 'docusign.ts',
        code: "await fs.writeFile('/tmp/doc.pdf', documentBytes);",
        errors: [{ messageId: 'bytesToSink', data: { sink: 'fs write' } }],
      },
      // P9 — bytes into a Postgres .insert object value.
      {
        filename: 'docusign-envelope-completed.ts',
        code: "await db.from('integration_events').insert({ org_id: orgId, details: { raw: documentBytes } });",
        errors: [{ messageId: 'bytesToSink', data: { sink: 'Postgres write' } }],
      },
      // P10 — Sentry.captureException with bytes in extra.
      {
        filename: 'docusign.ts',
        code: "Sentry.captureException(err, { extra: { documentBytes } });",
        errors: [{ messageId: 'bytesToSink', data: { sink: 'Sentry' } }],
      },
      // Edge — JSON.stringify(bytes) inside new Error(...). The inner
      // JSON.stringify is the sink that touches raw bytes (the Error only ever
      // sees the resulting string); range-dedupe → exactly one report.
      {
        filename: 'docusign.ts',
        code: "throw new Error(JSON.stringify(documentBytes));",
        errors: [{ messageId: 'bytesToSink', data: { sink: 'JSON.stringify' } }],
      },
      // Edge — raw `.toString()` (no encoding) re-exposes bytes as text.
      {
        filename: 'docusign.ts',
        code: "logger.error({ text: documentBytes.toString() }, 'failed');",
        errors: [{ messageId: 'bytesToSink' }],
      },
      // Edge — raw `.toString('utf8')` likewise.
      {
        filename: 'docusign.ts',
        code: "logger.error({ text: buffer.toString('utf8') });",
        errors: [{ messageId: 'bytesToSink' }],
      },
      // Edge — typed-array literal into a logger.
      {
        filename: 'docusign.ts',
        code: "logger.info({ data: new Uint8Array(raw) }, 'bytes');",
        errors: [{ messageId: 'bytesToSink' }],
      },
      // Edge — deeply nested object property still reaches the logger.
      {
        filename: 'docusign.ts',
        code: "logger.error({ ctx: { document: { payload: documentBytes } } }, 'failed');",
        errors: [{ messageId: 'bytesToSink' }],
      },
      // Edge — single-hop alias of the bytes value (same scope).
      {
        filename: 'docusign.ts',
        code: "const copy = documentBytes; logger.error({ copy }, 'failed');",
        errors: [{ messageId: 'bytesToSink' }],
      },
      // Edge — child logger (logger.child({...}).warn(bytes)).
      {
        filename: 'docusign.ts',
        code: "logger.child({ rpc: 'docusign' }).warn({ documentBytes }, 'failed');",
        errors: [{ messageId: 'bytesToSink' }],
      },
    ],
  });
});
