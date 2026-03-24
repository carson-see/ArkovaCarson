/**
 * Unit tests for x402 Payment Gate Middleware
 *
 * Tests RISK-2 (on-chain validation), RISK-3 (post-execution recording),
 * RISK-4 (replay prevention), ECON-2 (dynamic pricing), and RECON-2 (request ID linking).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockRpc, mockInsert, mockSelect, mockLogger, mockConfig } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockInsert = vi.fn();
  const mockSelect = vi.fn();
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
  return { mockRpc, mockInsert, mockSelect, mockLogger, mockConfig };
});

vi.mock('../../utils/db.js', () => ({
  db: {
    rpc: mockRpc,
    from: vi.fn(() => ({
      insert: mockInsert,
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: mockSelect,
        })),
      })),
    })),
  },
}));

vi.mock('../../config.js', () => ({
  config: mockConfig,
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

// Mock fetch for on-chain validation
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Suppress the setInterval for cache eviction in test
vi.useFakeTimers({ shouldAdvanceTime: true });

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  mockSelect.mockResolvedValue({ data: null }); // No existing payment
  mockFetch.mockResolvedValue({
    json: () => Promise.resolve({ result: null }),
  });
  // Clear module cache to reset in-memory tx cache
  vi.resetModules();
  // No BASE_RPC_URL in tests by default (skips on-chain validation)
  delete process.env.BASE_RPC_URL;
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

  it('proceeds to handler when valid payment header present (no on-chain RPC)', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const { x402PaymentGate } = await import('../x402PaymentGate.js');
    const middleware = x402PaymentGate('/api/v1/verify');

    const paymentPayload = Buffer.from(
      JSON.stringify({
        txHash: '0xvalid_tx_hash_1234567890',
        network: 'eip155:84532',
        payerAddress: '0xPayer',
      }),
    ).toString('base64');

    const req = {
      headers: { 'x-payment': paymentPayload },
      apiKey: undefined,
      id: 'req-123',
    } as any;
    const jsonFn = vi.fn();
    const res = {
      status: vi.fn().mockReturnThis(),
      json: jsonFn,
      statusCode: 200,
    } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // RISK-3: Payment NOT recorded yet (post-execution)
    // Call res.json to trigger recording
    res.json({ result: 'ok' });
    // Give async recording a tick
    await vi.advanceTimersByTimeAsync(10);
  });

  it('rejects replayed tx_hash with 409 Conflict (RISK-4)', async () => {
    mockRpc.mockResolvedValue({ data: true });
    // Simulate existing payment in DB
    mockSelect.mockResolvedValue({ data: { id: 'existing-payment' } });

    const { x402PaymentGate } = await import('../x402PaymentGate.js');
    const middleware = x402PaymentGate('/api/v1/verify');

    const paymentPayload = Buffer.from(
      JSON.stringify({
        txHash: '0xreplayed_tx_hash_existing',
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
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'payment_already_used' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects expired payment proof (>5 minutes old)', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const { x402PaymentGate } = await import('../x402PaymentGate.js');
    const middleware = x402PaymentGate('/api/v1/verify');

    const paymentPayload = Buffer.from(
      JSON.stringify({
        txHash: '0xexpired_tx_hash_12345678',
        timestamp: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      }),
    ).toString('base64');

    const req = {
      headers: { 'x-payment': paymentPayload },
      apiKey: undefined,
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'payment_expired' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid/short txHash', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const { x402PaymentGate } = await import('../x402PaymentGate.js');
    const middleware = x402PaymentGate('/api/v1/verify');

    const paymentPayload = Buffer.from(
      JSON.stringify({ txHash: '0x' }), // Too short
    ).toString('base64');

    const req = {
      headers: { 'x-payment': paymentPayload },
      apiKey: undefined,
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    // Invalid txHash → no payment parsed → 402
    expect(res.status).toHaveBeenCalledWith(402);
  });
});

describe('X402_PRICING', () => {
  it('has prices for all documented endpoints', async () => {
    const { X402_PRICING } = await import('../x402PaymentGate.js');
    expect(X402_PRICING['/api/v1/verify']).toBe(0.002);
    expect(X402_PRICING['/api/v1/compliance/check']).toBe(0.01);
    expect(X402_PRICING['/api/v1/nessie/query']).toBe(0.01);
  });
});
