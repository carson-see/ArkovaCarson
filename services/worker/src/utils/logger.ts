/**
 * Structured Logger
 *
 * Uses pino for JSON structured logging with correlation ID support.
 *
 * SCRUM-2492 (§1.6A): connector-fetched document bytes must NEVER reach the
 * logs. A defensive `formatters.log` hook recursively strips any binary value
 * (`Buffer`, any `TypedArray`/`DataView`, `ArrayBuffer`, or the serialized
 * `{ type: 'Buffer', data: [...] }` shape) to a redaction token, regardless of
 * the key it appears under. This is a TYPE-based guard (not key-name based) so
 * it catches bytes even on an unexpected/renamed field. A `redact` path list
 * additionally covers the known byte-bearing field names. The `err`/`error`
 * serializer runs the same sanitizer over the serialized error so a
 * byte-bearing field on an Error can never be emitted.
 */

import pino, { type Logger as PinoLogger } from 'pino';
import { config } from '../config.js';
import { getCorrelationId } from './correlationId.js';

// pino v8 CJS/ESM interop with NodeNext: runtime `pino` may be
// `{ default: fn }` while types say it's a namespace. Use `any` bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoFn = ((pino as any).default ?? pino) as (opts: pino.LoggerOptions) => pino.Logger;

// stdSerializers also needs CJS/ESM bridge
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoSerializers = ((pino as any).stdSerializers ?? (pino as any).default?.stdSerializers) as typeof pino.stdSerializers | undefined;

// ─── SCRUM-2492: binary-value redaction (type-based, key-agnostic) ─────────

/** Token written in place of any binary value reaching the logger. */
export const REDACTED_BYTES_TOKEN = '[REDACTED_BYTES]';

// Bound the recursive walk so a pathological/cyclic object can't hang logging.
const MAX_REDACT_DEPTH = 8;

/** A binary value that must never be logged: Buffer / TypedArray / DataView / ArrayBuffer. */
function isBinaryValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return ArrayBuffer.isView(value as never) || value instanceof ArrayBuffer;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  // ArrayBuffer.isView covers every TypedArray (Uint8Array, …) plus DataView.
  if (ArrayBuffer.isView(value as ArrayBufferView)) return true;
  if (value instanceof ArrayBuffer) return true;
  return false;
}

/**
 * The JSON-serialized form of a Buffer: `{ type: 'Buffer', data: [number,…] }`.
 * pino serializes via `JSON.stringify`, which turns a Buffer into this shape
 * unless we intercept it first — but a caller may also hand us an already-
 * serialized object literal, so detect it explicitly.
 */
function isSerializedBufferShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.type === 'Buffer' && Array.isArray(obj.data);
}

/**
 * Recursively replace any binary value (by type, regardless of key) with a
 * redaction token. Returns a sanitized clone; never mutates the input. Arrays
 * and plain objects are walked; binary/serialized-buffer values are tokenized.
 */
export function redactBinaryValues<T>(value: T, depth = 0): T {
  if (isBinaryValue(value) || isSerializedBufferShape(value)) {
    return REDACTED_BYTES_TOKEN as unknown as T;
  }
  if (depth >= MAX_REDACT_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactBinaryValues(item, depth + 1)) as unknown as T;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = redactBinaryValues(source[key], depth + 1);
  }
  return out as unknown as T;
}

/** Sanitize a serialized error object so it can never carry a byte-bearing field. */
function redactErrorSerializer(err: unknown): unknown {
  const serialized = pinoSerializers?.err ? pinoSerializers.err(err as Error) : err;
  return redactBinaryValues(serialized);
}

// Known byte-bearing field names — covered by `redact` as a belt-and-braces
// complement to the type-based formatter (e.g. if a value is a getter or a
// non-enumerable that the formatter walk misses).
const BYTE_FIELD_REDACT_PATHS = [
  'documentBytes',
  'document_bytes',
  'bytes',
  'fileBytes',
  'file_bytes',
  'rawBytes',
  'raw_bytes',
  'buffer',
  'fileContent',
  'file_content',
  'documentBuffer',
  'combinedDocument',
  '*.documentBytes',
  '*.document_bytes',
  '*.bytes',
  '*.buffer',
];

export const logger = pinoFn({
  level: config.logLevel,
  // Ensure Error objects are properly serialized (pino only auto-serializes `err`
  // key) AND that the serialized error carries no binary field (SCRUM-2492).
  ...(pinoSerializers ? {
    serializers: {
      error: redactErrorSerializer,
      err: redactErrorSerializer,
    },
  } : {}),
  // SCRUM-2492: type-based binary redaction over every logged object. Runs on
  // the merged log object (the `{ ... }` first arg to logger.x) regardless of
  // key, so document bytes on any field become a token before serialization.
  formatters: {
    log(object: Record<string, unknown>) {
      return redactBinaryValues(object);
    },
  },
  // Belt-and-braces redaction of the known byte-bearing field names. `remove`
  // drops the key entirely rather than printing `[Redacted]`.
  redact: {
    paths: BYTE_FIELD_REDACT_PATHS,
    remove: true,
  },
  transport:
    config.nodeEnv === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        }
      : undefined,
  mixin() {
    const correlationId = getCorrelationId();
    return correlationId ? { correlationId } : {};
  },
});

export type Logger = PinoLogger;

// ─── DH-11: Structured RPC Logging Helpers ─────────────────────────────

/**
 * Create a child logger scoped to an RPC call.
 * Automatically includes rpc name, timing, and correlation context.
 */
export function createRpcLogger(rpcName: string, context?: Record<string, unknown>) {
  const child = logger.child({ rpc: rpcName, ...context });
  const startTime = Date.now();

  return {
    start: () => child.info('RPC call started'),
    success: (result?: Record<string, unknown>) =>
      child.info({ durationMs: Date.now() - startTime, ...result }, 'RPC call succeeded'),
    error: (error: unknown) => {
      // Extract error details for proper serialization (pino serializes Error as {})
      const errorInfo = error instanceof Error
        ? { err: error, errorMessage: error.message, errorStack: error.stack }
        : { error };
      child.error(
        { durationMs: Date.now() - startTime, ...errorInfo },
        'RPC call failed',
      );
    },
  };
}
// deploy trigger 1774363575
