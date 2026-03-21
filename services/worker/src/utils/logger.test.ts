/**
 * DH-11: Structured RPC Logging Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pino before importing logger
vi.mock('pino', () => {
  const child = vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }));

  const mockPino = vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child,
  }));

  return { default: mockPino };
});

vi.mock('../config.js', () => ({
  config: { logLevel: 'info', nodeEnv: 'test' },
}));

vi.mock('./correlationId.js', () => ({
  getCorrelationId: vi.fn(() => 'test-corr-id'),
}));

import { createRpcLogger, logger } from './logger.js';

describe('DH-11: createRpcLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a child logger with rpc name', () => {
    const rpcLog = createRpcLogger('processAnchor', { anchorId: 'a1' });
    expect(rpcLog).toBeDefined();
    expect(logger.child).toHaveBeenCalledWith({
      rpc: 'processAnchor',
      anchorId: 'a1',
    });
  });

  it('start() logs info message', () => {
    const rpcLog = createRpcLogger('processAnchor');
    rpcLog.start();

    const child = (logger.child as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(child.info).toHaveBeenCalledWith('RPC call started');
  });

  it('success() logs with duration', () => {
    const rpcLog = createRpcLogger('processAnchor');
    rpcLog.start();

    vi.advanceTimersByTime(150);

    rpcLog.success({ result: 'ok' });

    const child = (logger.child as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(child.info).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 150, result: 'ok' }),
      'RPC call succeeded',
    );
  });

  it('error() logs with duration and error', () => {
    const rpcLog = createRpcLogger('processAnchor');
    rpcLog.start();

    vi.advanceTimersByTime(75);

    const err = new Error('boom');
    rpcLog.error(err);

    const child = (logger.child as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(child.error).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 75, err, errorMessage: 'boom' }),
      'RPC call failed',
    );
  });
});
