import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, mockDb, mockCreateUtxoProvider, mockLogger } = vi.hoisted(() => {
  const provider = {
    name: 'stub-getblock',
    getRawTransaction: vi.fn(),
    getBlockHeaderHex: vi.fn(),
    getTxOutProof: vi.fn(),
  };
  return {
    mockConfig: {
      useMocks: false,
      enableProdNetworkAnchoring: true,
      bitcoinUtxoProvider: 'getblock' as const,
      bitcoinRpcUrl: 'https://btc.getblock.test/token',
      bitcoinRpcAuth: undefined as string | undefined,
      mempoolApiUrl: undefined as string | undefined,
      bitcoinNetwork: 'signet' as string,
    },
    mockDb: { from: vi.fn() },
    mockCreateUtxoProvider: vi.fn(() => provider),
    mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../utils/db.js', () => ({ db: mockDb }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../chain/utxo-provider.js', () => ({ createUtxoProvider: mockCreateUtxoProvider }));

/** Mirrors the `populateConfirmationProofsForSecuredAnchors` scan chain, ending in an empty result. */
function emptyScanQuery() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = {};
  q.select = vi.fn(() => q);
  q.not = vi.fn(() => q);
  q.is = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.limit = vi.fn(() => ({ data: [], error: null }));
  return q;
}

describe('runConfirmationProofBackfill (cron wiring)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('./confirmation-proof-backfill.js');
    mod._resetProviderCacheForTest();
    mockConfig.useMocks = false;
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockDb.from.mockImplementation(() => emptyScanQuery());
  });

  it('no-ops in mock mode and never builds a real provider', async () => {
    mockConfig.useMocks = true;
    const { runConfirmationProofBackfill } = await import('./confirmation-proof-backfill.js');

    const result = await runConfirmationProofBackfill();

    expect(result.skipped).toBe(true);
    expect(result.anchorsUpdated).toBe(0);
    expect(result.scanned).toBe(0);
    expect(mockCreateUtxoProvider).not.toHaveBeenCalled();
    expect(mockDb.from).not.toHaveBeenCalled();
  });

  it('no-ops when ENABLE_PROD_NETWORK_ANCHORING is off (no real inclusion-proof source)', async () => {
    mockConfig.enableProdNetworkAnchoring = false;
    const { runConfirmationProofBackfill } = await import('./confirmation-proof-backfill.js');

    const result = await runConfirmationProofBackfill();

    expect(result.skipped).toBe(true);
    expect(mockCreateUtxoProvider).not.toHaveBeenCalled();
    expect(mockDb.from).not.toHaveBeenCalled();
  });

  it('builds the configured provider and delegates the SECURED-anchor scan when enabled', async () => {
    const { runConfirmationProofBackfill } = await import('./confirmation-proof-backfill.js');

    const result = await runConfirmationProofBackfill();

    expect(result.skipped).toBe(false);
    // Provider built from config — mirrors the createChainClient wiring.
    expect(mockCreateUtxoProvider).toHaveBeenCalledWith({
      type: 'getblock',
      rpcUrl: 'https://btc.getblock.test/token',
      rpcAuth: undefined,
      mempoolApiUrl: undefined,
      network: 'signet',
    });
    // Delegated into the populate scan (queried anchor_proofs).
    expect(mockDb.from).toHaveBeenCalledWith('anchor_proofs');
    expect(result.scanned).toBe(0); // empty scan in this test
  });

  it('takes the mainnet path (deeper confirmations) when network is mainnet', async () => {
    mockConfig.bitcoinNetwork = 'mainnet';
    const { runConfirmationProofBackfill } = await import('./confirmation-proof-backfill.js');

    const result = await runConfirmationProofBackfill();

    expect(result.skipped).toBe(false);
    expect(mockCreateUtxoProvider).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'mainnet' }),
    );
  });
});
