/**
 * Structured Logger
 *
 * Uses pino for JSON structured logging.
 */

import pino, { Logger as PinoLogger } from 'pino';
import { config } from '../config.js';

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
});

export type Logger = PinoLogger;
