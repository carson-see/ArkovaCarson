/**
 * Structured Logger
 *
 * Uses pino for JSON structured logging with correlation ID support.
 */

import pino, { Logger as PinoLogger } from 'pino';
import { config } from '../config.js';
import { getCorrelationId } from './correlationId.js';

const pinoInstance = pino as unknown as typeof pino.default;

export const logger = pinoInstance({
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
