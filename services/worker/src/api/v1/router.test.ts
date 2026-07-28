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

  it('rate-limits webhook self-service by authenticated user instead of shared API-key batch IP bucket', () => {
    const routerSource = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');

    expect(routerSource).toMatch(/const webhooksSelfServiceRateLimiter = rateLimit\(\{[\s\S]*scope: ['"]webhooks-self-service['"]/);
    expect(routerSource).toMatch(/keyGenerator: \(req\) => req\.authUserId \?\? req\.ip \?\? ['"]unknown['"]/);
    expect(routerSource).toContain(
      "router.use('/webhooks/self-service', requireAuth, webhooksSelfServiceRateLimiter, webhooksSelfServiceRouter)",
    );
  });

  // Endpoint-reachability audit: signaturesRouter was mounted three times at
  // '/sign', '/signatures', '/verify-signature' — its own internal route
  // strings already carry those segments, so Express required them TWICE
  // (`POST /api/v1/sign/sign`), 404ing every documented AdES endpoint. Fixed
  // by mounting the router once at '/', matching the signatureComplianceRouter
  // / keyInventoryRouter precedent immediately below it.
  it('mounts signaturesRouter once at the API root, not at /sign, /signatures, or /verify-signature sub-paths', () => {
    const routerSource = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');

    expect(routerSource).not.toMatch(/router\.use\(\s*['"]\/sign['"]\s*,[\s\S]{0,80}signaturesRouter\s*\)/);
    expect(routerSource).not.toMatch(/router\.use\(\s*['"]\/signatures['"]\s*,[\s\S]{0,80}signaturesRouter\s*\)/);
    expect(routerSource).not.toMatch(/router\.use\(\s*['"]\/verify-signature['"]\s*,[\s\S]{0,80}signaturesRouter\s*\)/);
    expect(routerSource).toMatch(/router\.use\(\s*['"]\/['"]\s*,\s*adesSignatureGate\(\),\s*requireSignatureAuth,\s*signaturesRouter\s*\)/);
  });

  it('gates /sign and /signatures* behind requireSignatureAuth but lets /verify-signature and unrelated paths through unauthenticated', () => {
    const routerSource = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
    const fnStart = routerSource.indexOf('function requireSignatureAuth');
    const fnBody = routerSource.slice(fnStart, routerSource.indexOf('router.use(\'/\', adesSignatureGate(), requireSignatureAuth, signaturesRouter)'));

    expect(fnStart).toBeGreaterThan(-1);
    expect(fnBody).toContain("p === '/sign'");
    expect(fnBody).toContain("p.startsWith('/signatures/')");
    expect(fnBody).toContain('requireAuth(req, res, next)');
  });
});
