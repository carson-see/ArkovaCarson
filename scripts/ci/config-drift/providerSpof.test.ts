import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkProviderSpof,
  parseCodeDefaultProvider,
  parseDeployedProvider,
  type ProviderSpofInputs,
} from './providerSpof.js';

// S1 hardening (config-drift README item #6 / CHAIN-RESIL). The worker's
// BITCOIN_UTXO_PROVIDER code default (config.ts) is 'mempool'; prod is intended
// to run 'getblock' (asserted), set explicitly by deploy-worker.yml. If that env
// line is dropped, the worker silently falls back to 'mempool' — the mempool↔GetBlock
// SPOF (R-4 / PM-L-DRIFT / the 2026-05-30 prod audit finding).
describe('checkProviderSpof (pure)', () => {
  const base: ProviderSpofInputs = {
    assertedProvider: 'getblock',
    codeDefaultProvider: 'mempool',
    deployedProvider: 'getblock',
  };

  it('no finding when deploy sets the asserted provider AND the code default matches', () => {
    expect(
      checkProviderSpof({
        assertedProvider: 'getblock',
        codeDefaultProvider: 'getblock',
        deployedProvider: 'getblock',
      }),
    ).toEqual([]);
  });

  it('WARNS (latent SPOF) when the deploy is correct but the code default diverges from asserted', () => {
    const f = checkProviderSpof(base); // deployed getblock masks code-default mempool
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'warn', code: 'code-default-divergence' });
  });

  it('ERRORS (active SPOF) when the deploy OMITS the override and the code default != asserted', () => {
    const f = checkProviderSpof({ ...base, deployedProvider: null });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'error', code: 'deploy-omits-override' });
  });

  it('SAFE (no finding) when the deploy omits the override but the code default already equals asserted', () => {
    // dropping the env line fails SAFE — code default IS the asserted value
    expect(
      checkProviderSpof({
        assertedProvider: 'getblock',
        codeDefaultProvider: 'getblock',
        deployedProvider: null,
      }),
    ).toEqual([]);
  });

  it('ERRORS when the deploy sets a provider different from asserted', () => {
    const f = checkProviderSpof({ ...base, deployedProvider: 'mempool' });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'error', code: 'deploy-mismatch' });
  });
});

describe('parsers (fail closed)', () => {
  it('parses the .default(...) provider out of config.ts source', () => {
    const src = `  bitcoinUtxoProvider: z.enum(['rpc', 'mempool', 'getblock']).default('mempool'),`;
    expect(parseCodeDefaultProvider(src)).toBe('mempool');
  });

  it('throws when config.ts has no parseable provider default (cannot confirm => fail closed)', () => {
    expect(() => parseCodeDefaultProvider('no provider default here')).toThrow();
  });

  it('parses BITCOIN_UTXO_PROVIDER out of the deploy-worker.yml --set-env-vars line', () => {
    const yml = `--set-env-vars "^||^NODE_ENV=production||BITCOIN_UTXO_PROVIDER=getblock||BITCOIN_FEE_STRATEGY=mempool"`;
    expect(parseDeployedProvider(yml)).toBe('getblock');
  });

  it('returns null when the deploy omits BITCOIN_UTXO_PROVIDER', () => {
    expect(parseDeployedProvider('--set-env-vars "^||^NODE_ENV=production||USE_MOCKS=false"')).toBeNull();
  });
});

// Smoke test against the REAL source files — documents the live latent SPOF
// (config.ts default 'mempool' vs prod-intended 'getblock'). If the code default is
// later aligned to 'getblock' (the recommended fail-safe fix), update these expectations.
describe('provider-SPOF on the real tree (current-state smoke)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  it('config.ts still defaults BITCOIN_UTXO_PROVIDER to mempool (latent SPOF is live)', () => {
    const src = readFileSync(resolve(repoRoot, 'services/worker/src/config.ts'), 'utf8');
    expect(parseCodeDefaultProvider(src)).toBe('mempool');
  });

  it('deploy-worker.yml sets BITCOIN_UTXO_PROVIDER=getblock (the override masks the SPOF)', () => {
    const yml = readFileSync(resolve(repoRoot, '.github/workflows/deploy-worker.yml'), 'utf8');
    expect(parseDeployedProvider(yml)).toBe('getblock');
  });
});
