import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8');
}

const routerSource = readRepoFile('services/worker/src/api/v1/router.ts');
const configSource = readRepoFile('services/worker/src/config.ts');
const flagRegistrySource = readRepoFile('services/worker/src/middleware/flagRegistry.ts');
const x402GateSource = readRepoFile('services/worker/src/middleware/x402PaymentGate.ts');
const x402Docs = readRepoFile('docs/reference/X402_API_ARCHITECTURE.md');

const launchScope = [
  '/api/v1/verify',
  '/api/v1/verify/entity',
  '/api/v1/compliance/check',
  '/api/v1/regulatory/lookup',
  '/api/v1/cle',
  '/api/v1/nessie/query',
] as const;

describe('x402 launch-scope contract', () => {
  it('wires every launch-scope paid endpoint through x402PaymentGate', () => {
    for (const endpoint of launchScope) {
      expect(routerSource, endpoint).toContain(`x402PaymentGate('${endpoint}')`);
      expect(x402GateSource, endpoint).toContain(`'${endpoint}':`);
      expect(x402Docs, endpoint).toContain(endpoint);
    }
  });

  it('keeps runtime config and kill-switch prerequisites explicit', () => {
    for (const envName of [
      'X402_FACILITATOR_URL',
      'ARKOVA_USDC_ADDRESS',
      'X402_NETWORK',
    ]) {
      expect(configSource).toContain(envName);
      expect(x402Docs).toContain(envName);
    }

    expect(configSource).toContain('BASE_RPC_URL');
    expect(configSource).toContain('baseRpcUrl: z.string().url().optional()');
    expect(configSource).toContain('baseRpcUrl: process.env.BASE_RPC_URL');
    expect(x402GateSource).toContain('BASE_RPC_URL');
    expect(x402GateSource).toContain('config.baseRpcUrl');
    expect(x402Docs).toContain('BASE_RPC_URL');
    expect(flagRegistrySource).toContain('ENABLE_X402_PAYMENTS');
    expect(x402Docs).toContain('ENABLE_X402_PAYMENTS');
  });

  it('keeps API/MCP launch read surfaces out of the x402 payment scope', () => {
    expect(routerSource).not.toContain("x402PaymentGate('/api/v2");
    expect(x402Docs).toContain('API/MCP read-only launch surfaces use scoped API keys, not x402');
  });
});
