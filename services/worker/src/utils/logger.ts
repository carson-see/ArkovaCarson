/**
 * Structured Logger
 *
 * Uses pino for JSON structured logging with correlation ID support.
 */

import pino, { type Logger as PinoLogger } from 'pino';
import { config } from '../config.js';
import { getCorrelationId } from './correlationId.js';

// pino v8 CJS/ESM interop with NodeNext: runtime `pino` may be
// `{ default: fn }` while types say it's a namespace. Use `any` bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoFn = ((pino as any).default ?? pino) as (opts: pino.LoggerOptions) => pino.Logger;

export const logger = pinoFn({
  level: config.logLevel,
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
    error: (error: unknown) =>
      child.error(
        { durationMs: Date.now() - startTime, error },
        'RPC call failed',
      ),
  };
}
