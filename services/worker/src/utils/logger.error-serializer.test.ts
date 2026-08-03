/**
 * Logger error-serializer contract (SCRUM-3050 — silent-failure hardening).
 *
 * These tests build a REAL pino instance from the worker's exported logger
 * options and write to an in-memory destination, so they assert the actual
 * emitted JSON line rather than a mock. That matters: the defect they pin was
 * invisible to `logger.test.ts`, which mocks pino wholesale.
 *
 * The defect (observed in prod 2026-08-01): `logger.error({ error: err }, msg)`
 * emitted `"error": {}` — message AND stack gone — because the SCRUM-2492
 * binary-redaction `formatters.log` hook runs BEFORE the `error`/`err`
 * serializers and rebuilt every logged object with `Object.keys()`. `message`
 * and `stack` are NON-ENUMERABLE own properties of `Error`, so the clone was an
 * empty plain object and the serializer never saw an Error at all. Every
 * `logger.error`/`logger.warn` in the worker was affected; root-causing the 70h
 * anchoring outage needed database archaeology because of it.
 *
 * The SCRUM-2492 §1.6A guarantee (document bytes never reach the logs) must
 * survive the fix — hence the binary-redaction cases below run through the same
 * real-pino path.
 */

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';

// Only the config is mocked — pino itself is REAL here, which is the entire
// point of this file.
vi.mock('../config.js', () => ({
  config: { logLevel: 'info', nodeEnv: 'test' },
}));

import { buildLoggerOptions, REDACTED_BYTES_TOKEN } from './logger.js';

/** Build a real pino logger writing JSON lines into an array. */
function captureLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const destination = {
    write(chunk: string) {
      chunks.push(chunk);
    },
  };
  // pino v8 CJS/ESM interop under NodeNext — same bridge logger.ts uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pinoFn = ((pino as any).default ?? pino) as (
    opts: pino.LoggerOptions,
    dest: unknown,
  ) => pino.Logger;
  const logger = pinoFn(buildLoggerOptions({ level: 'trace', pretty: false }), destination);
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('logger error serialization (silent-failure hardening)', () => {
  it('retains message AND stack for an Error under the `error` key', () => {
    const { logger, lines } = captureLogger();

    logger.error({ error: new Error('boom') }, 'something failed');

    const [line] = lines();
    const serialized = line.error as Record<string, unknown>;
    expect(serialized).toBeTypeOf('object');
    expect(serialized.message).toBe('boom');
    expect(typeof serialized.stack).toBe('string');
    expect(serialized.stack as string).toContain('logger.error-serializer.test');
    expect(serialized.type).toBe('Error');
  });

  it('retains message AND stack for an Error under the `err` key', () => {
    const { logger, lines } = captureLogger();

    logger.error({ err: new TypeError('bad type') }, 'something failed');

    const [line] = lines();
    const serialized = line.err as Record<string, unknown>;
    expect(serialized.message).toBe('bad type');
    expect(serialized.type).toBe('TypeError');
    expect((serialized.stack as string).length).toBeGreaterThan(0);
  });

  it('retains message AND stack when an Error is the first argument', () => {
    const { logger, lines } = captureLogger();

    logger.error(new Error('positional boom'));

    const [line] = lines();
    const serialized = line.err as Record<string, unknown>;
    expect(serialized.message).toBe('positional boom');
    expect((serialized.stack as string).length).toBeGreaterThan(0);
  });

  it('retains message AND stack for an Error nested under an arbitrary key', () => {
    const { logger, lines } = captureLogger();

    logger.warn({ context: { cause: new Error('nested boom') } }, 'nested failure');

    const [line] = lines();
    const context = line.context as Record<string, Record<string, unknown>>;
    expect(context.cause.message).toBe('nested boom');
    expect((context.cause.stack as string).length).toBeGreaterThan(0);
  });

  it('preserves PostgREST-style plain-object error fields instead of fabricating an empty stack', () => {
    const { logger, lines } = captureLogger();

    // The exact shape that made the 70h anchoring outage unreadable: a
    // PostgREST error object. Previously emitted as
    // {type:"Object", message:"Bad Request", stack:""} — code/details/hint,
    // the only actionable fields, were dropped and a fake empty stack added.
    logger.error(
      {
        error: {
          message: 'Bad Request',
          code: 'PGRST102',
          details: 'query string too large',
          hint: null,
        },
      },
      'query failed',
    );

    const [line] = lines();
    const serialized = line.error as Record<string, unknown>;
    expect(serialized.message).toBe('Bad Request');
    expect(serialized.code).toBe('PGRST102');
    expect(serialized.details).toBe('query string too large');
    expect(serialized.stack).toBeUndefined();
  });

  it('still redacts document bytes carried on an Error (SCRUM-2492 / §1.6A)', () => {
    const { logger, lines } = captureLogger();

    const err = Object.assign(new Error('fetch failed'), {
      documentBytes: Buffer.from('super secret document contents'),
    });
    logger.error({ error: err }, 'connector fetch failed');

    const [line] = lines();
    const serialized = line.error as Record<string, unknown>;
    expect(serialized.message).toBe('fetch failed');
    expect(JSON.stringify(line)).not.toContain('super secret document contents');
    // `documentBytes` is on the byte-field redact path list, so it is removed
    // outright; any surviving representation must be the redaction token.
    if (serialized.documentBytes !== undefined) {
      expect(serialized.documentBytes).toBe(REDACTED_BYTES_TOKEN);
    }
  });

  it('still redacts binary values on an unexpected key of an Error (type-based guard)', () => {
    const { logger, lines } = captureLogger();

    const err = Object.assign(new Error('fetch failed'), {
      // Deliberately NOT one of the known byte-field names — the type-based
      // guard must catch it anyway.
      payloadChunk: new Uint8Array([1, 2, 3, 4]),
    });
    logger.error({ error: err }, 'connector fetch failed');

    const [line] = lines();
    const serialized = line.error as Record<string, unknown>;
    expect(serialized.message).toBe('fetch failed');
    expect(serialized.payloadChunk).toBe(REDACTED_BYTES_TOKEN);
  });

  it('still redacts binary values on a plain logged object', () => {
    const { logger, lines } = captureLogger();

    logger.info({ blob: Buffer.from('doc bytes'), n: 1 }, 'ok');

    const [line] = lines();
    expect(line.blob).toBe(REDACTED_BYTES_TOKEN);
    expect(line.n).toBe(1);
  });

  it('does not throw on a self-referential Error', () => {
    const { logger, lines } = captureLogger();

    const err = new Error('cyclic') as Error & { self?: unknown };
    err.self = err;

    expect(() => logger.error({ error: err }, 'cyclic failure')).not.toThrow();
    const [line] = lines();
    expect((line.error as Record<string, unknown>).message).toBe('cyclic');
  });
});
