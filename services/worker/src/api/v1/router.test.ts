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

  it('does not register middleware-only verify scope on all anchor traffic before writes', () => {
    const routerSource = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');

    expect(routerSource).toMatch(/req\.method !== ['"]GET['"]/);
    expect(routerSource).not.toMatch(
      /router\.use\(\s*['"]\/anchor['"]\s*,\s*requireScope\(['"]verify['"]\)\s*,\s*anchorExtractionManifestRouter\s*\)/,
    );
  });

  it('mounts webhook self-service before the broad API-key webhook router so diagnostics are not double rate-limited', () => {
    const routerSource = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');

    expect(routerSource.indexOf("router.use('/webhooks/self-service'")).toBeLessThan(
      routerSource.indexOf("router.use('/webhooks', batchRateLimiter, webhooksRouter)"),
    );
  });
});
