/**
 * Unit tests for x402 Payment Gate Middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockRpc, mockInsert, mockLogger, mockConfig } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockInsert = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockConfig = {
    x402FacilitatorUrl: 'https://x402.org/facilitator',
    arkovaUsdcAddress: '0xTestPayee',
    x402Network: 'eip155:84532',
    nodeEnv: 'test',
  };
  return { mockRpc, mockInsert, mockLogger, mockConfig };
});

vi.mock('../../utils/db.js', () => ({
  db: {
    rpc: mockRpc,
    from: vi.fn(() => ({
      insert: mockInsert,
    })),
  },
}));

vi.mock('../../config.js', () => ({
  config: mockConfig,
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
});

describe('x402PaymentGate', () => {
  it('passes through when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { x402PaymentGate } = await import('../x402PaymentGate.js');
    const middleware = x402PaymentGate('/api/v1/verify');

    const req = { headers: {}, apiKey: undefined } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes through when API key is present', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const { x402PaymentGate } = await import('../x402PaymentGate.js');
    const middleware = x402PaymentGate('/api/v1/verify');

    const req = { headers: {}, apiKey: { keyId: 'test-key' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 402 when no payment header and no API key', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const { x402PaymentGate } = await import('../x402PaymentGate.js');
    const middleware = x402PaymentGate('/api/v1/verify');

    const req = { headers: {}, apiKey: undefined } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        x402Version: 1,
        accepts: expect.arrayContaining([
          expect.objectContaining({
            asset: 'USDC',
            payTo: '0xTestPayee',
          }),
        ]),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('records payment and proceeds when X-PAYMENT header present', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const { x402PaymentGate } = await import('../x402PaymentGate.js');
    const middleware = x402PaymentGate('/api/v1/verify');

    const paymentPayload = Buffer.from(
      JSON.stringify({
        txHash: '0xabc123',
        network: 'eip155:84532',
        payerAddress: '0xPayer',
      }),
    ).toString('base64');

    const req = {
      headers: { 'x-payment': paymentPayload },
      apiKey: undefined,
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tx_hash: '0xabc123',
        payer_address: '0xPayer',
        token: 'USDC',
      }),
    );
  });
});
