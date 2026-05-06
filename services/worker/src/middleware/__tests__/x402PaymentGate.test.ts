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
    arkovaUsdcAddress: '0x00000000000000000000000000000000deadbeef' as string | undefined,
    x402Network: 'eip155:84532',
    baseRpcUrl: undefined as string | undefined,
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
  mockConfig.x402FacilitatorUrl = 'https://x402.org/facilitator';
  mockConfig.arkovaUsdcAddress = '0x00000000000000000000000000000000deadbeef';
  mockConfig.x402Network = 'eip155:84532';
  mockConfig.baseRpcUrl = undefined;
  mockConfig.nodeEnv = 'test';
  mockInsert.mockResolvedValue({ error: null });
  mockSelect.mockResolvedValue({ data: null }); // No existing payment
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ result: null }),
  });
  // Clear module cache to reset in-memory tx cache
  vi.resetModules();
  // No BASE_RPC_URL in tests by default (x402 validation fails closed)
  delete process.env.BASE_RPC_URL;
});

async function verifyGate() {
  const { x402PaymentGate } = await import('../x402PaymentGate.js');
  return x402PaymentGate('/api/v1/verify');
}

function encodePayment(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      txHash: '0xvalid_tx_hash_1234567890',
      network: 'eip155:84532',
      payerAddress: '0xPayer',
      ...overrides,
    }),
  ).toString('base64');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reqWith(fields: Record<string, unknown>): any {
  return fields;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resWith(statusCode = 200): any {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), statusCode };
}

describe('x402PaymentGate', () => {
  it('passes through when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const middleware = await verifyGate();

    const req = reqWith({ headers: {}, apiKey: undefined });
    const res = resWith();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes through when API key is present', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const middleware = await verifyGate();

    const req = reqWith({ headers: {}, apiKey: { keyId: 'test-key' } });
    const res = resWith();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 402 when no payment header and no API key', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const middleware = await verifyGate();

    const req = reqWith({ headers: {}, apiKey: undefined });
    const res = resWith();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        x402Version: 1,
        accepts: expect.arrayContaining([
          expect.objectContaining({
            asset: 'USDC',
            payTo: '0x00000000000000000000000000000000deadbeef',
          }),
        ]),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when Base RPC is not configured', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const middleware = await verifyGate();

    const req = reqWith({ headers: { 'x-payment': encodePayment() }, apiKey: undefined, id: 'req-123' });
    const res = resWith();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'payment_validation_unavailable',
        reason: 'rpc_not_configured',
      }),
    );
  });

  it('fails closed with 503 when Base RPC validation is unavailable', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockConfig.baseRpcUrl = 'https://base-rpc.test';
    mockFetch.mockRejectedValueOnce(new Error('rpc down'));

    const middleware = await verifyGate();

    const req = reqWith({ headers: { 'x-payment': encodePayment() }, apiKey: undefined, id: 'req-123' });
    const res = resWith();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'payment_validation_unavailable',
        reason: 'validation_error',
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('proceeds to handler when valid payment header and on-chain proof are present', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockConfig.baseRpcUrl = 'https://base-rpc.test';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        result: {
          status: '0x1',
          logs: [{
            address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x0000000000000000000000000000000000000000000000000000000000000000',
              '0x00000000000000000000000000000000000000000000000000000000deadbeef',
            ],
            data: `0x${(2_000).toString(16).padStart(64, '0')}`,
          }],
        },
      }),
    });

    const middleware = await verifyGate();

    const req = reqWith({ headers: { 'x-payment': encodePayment() }, apiKey: undefined, id: 'req-123' });
    const res = resWith();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // RISK-3: Payment NOT recorded yet (post-execution)
    // Call res.json to trigger recording
    res.json({ result: 'ok' });
    // Give async recording a tick
    await vi.advanceTimersByTimeAsync(10);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tx_hash: '0xvalid_tx_hash_1234567890',
        network: 'eip155:84532',
        amount_usd: 0.002,
        payer_address: '0xPayer',
        payee_address: '0x00000000000000000000000000000000deadbeef',
        token: 'USDC',
        verification_request_id: 'req-123',
      }),
    );
  });

  it('returns 401 instead of 402 when an invalid API key reaches the payment gate', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const middleware = await verifyGate();

    const req = reqWith({ headers: { authorization: 'Bearer ak_test_invalid' }, apiKey: undefined });
    const res = resWith();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_api_key' }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when x402 is enabled but no payee address is configured', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockConfig.arkovaUsdcAddress = undefined;

    const middleware = await verifyGate();

    const req = reqWith({ headers: {}, apiKey: undefined });
    const res = resWith();
    const next = vi.fn();

    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'authentication_required' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects replayed tx_hash with 409 Conflict (RISK-4)', async () => {
    mockRpc.mockResolvedValue({ data: true });
    // Simulate existing payment in DB
    mockSelect.mockResolvedValue({ data: { id: 'existing-payment' } });

    const middleware = await verifyGate();

    const req = reqWith({
      headers: { 'x-payment': encodePayment({ txHash: '0xreplayed_tx_hash_existing' }) },
      apiKey: undefined,
    });
    const res = resWith();
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

    const middleware = await verifyGate();

    const req = reqWith({
      headers: { 'x-payment': encodePayment({ txHash: '0xexpired_tx_hash_12345678', timestamp: Date.now() - 6 * 60 * 1000 }) },
      apiKey: undefined,
    });
    const res = resWith();
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

    const middleware = await verifyGate();

    const req = reqWith({ headers: { 'x-payment': encodePayment({ txHash: '0x' }) }, apiKey: undefined });
    const res = resWith();
    const next = vi.fn();

    await middleware(req, res, next);
    // Invalid txHash → no payment parsed → 402
    expect(res.status).toHaveBeenCalledWith(402);
  });
});

describe('X402_PRICING', () => {
  it('has prices for all documented launch-scope x402 endpoints', async () => {
    const { X402_PRICING } = await import('../x402PaymentGate.js');
    expect(X402_PRICING).toMatchObject({
      '/api/v1/verify': 0.002,
      '/api/v1/verify/entity': 0.005,
      '/api/v1/compliance/check': 0.01,
      '/api/v1/regulatory/lookup': 0.002,
      '/api/v1/cle': 0.005,
      '/api/v1/nessie/query': 0.01,
    });
  });
});
