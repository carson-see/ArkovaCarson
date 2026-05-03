import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('api v1 router attestation batch routes', () => {
  it('does not register middleware-only attestation batch routes', () => {
    const routerSource = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
    const attestationsSource = readFileSync(new URL('./attestations.ts', import.meta.url), 'utf8');

    expect(routerSource).not.toMatch(/router\.post\(\s*['"]\/attestations\/batch-create['"]\s*,\s*batchRateLimiter\s*\)/);
    expect(routerSource).not.toMatch(/router\.post\(\s*['"]\/attestations\/batch-verify['"]\s*,\s*requireScope\([^)]*\)\s*,\s*batchRateLimiter\s*\)/);
    expect(attestationsSource).toMatch(/router\.post\(\s*['"]\/batch-create['"]\s*,\s*attestationBatchRateLimiter\s*,/);
    expect(attestationsSource).toMatch(/router\.post\(\s*['"]\/batch-verify['"]\s*,\s*requireScope\(['"]verify:batch['"]\)\s*,\s*attestationBatchRateLimiter\s*,/);
  });
});
