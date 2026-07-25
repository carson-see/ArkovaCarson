/** Structural regressions for SCRUM-2703/2705 route placement. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('per-org quota route wiring', () => {
  it('meters only executable single anchor writes after idempotent deduplication', () => {
    const router = source('./router.ts');
    const submit = source('./anchor-submit.ts');

    expect(router).toContain("router.use('/anchor', requireScope('anchor:write'), anchorSubmitRouter)");
    expect(submit).toMatch(/export const AnchorSubmitSchema/);
    expect(submit).toMatch(/async function consumeAnchorCreateQuota\([\s\S]*kind: ['"]anchors_created['"][\s\S]*getOrgId: \(quotaReq\) => quotaReq\.apiKey\?\.orgId \?\? null[\s\S]*getDelta: \(\) => delta/);
    expect(submit).toMatch(/if \(existing\) \{[\s\S]*return;[\s\S]*await consumeAnchorCreateQuota\(req, res, 1\)/);
    expect(submit).toMatch(/router\.post\(['"]\/['"], handleAnchorSubmit\)/);
    expect(submit).toMatch(/router\.post\(['"]\/submit['"], handleAnchorSubmit\)/);
  });

  it('meters bulk cardinality from the deduplicated executable set after dry-run exits', () => {
    const bulk = source('./anchor-bulk.ts');

    expect(bulk).toMatch(/async function consumeAnchorCreateQuota\([\s\S]*kind: ['"]anchors_created['"][\s\S]*getDelta: \(\) => delta/);
    expect(bulk).toMatch(/const queueable = body\.anchors[\s\S]*if \(body\.dry_run\) \{[\s\S]*return;[\s\S]*await consumeAnchorCreateQuota\(req, res, queueable\.length\)/);
    expect(bulk).toMatch(/router\.post\(['"]\/['"], async/);
  });

  it('checks connector capacity after API-key and org-admin guards on registration only', () => {
    const webhooks = source('./webhooks.ts');

    expect(webhooks).toMatch(/const connectorCapacityQuota = requireOrgQuota\(\{[\s\S]*kind: ['"]connectors_total['"][\s\S]*mode: ['"]capacity['"]/);
    expect(webhooks).toMatch(/router\.post\(\s*['"]\/['"],\s*requireWebhookApiKey,\s*requireWebhookOrgAdmin,\s*connectorCapacityQuota,/);
    expect(webhooks).not.toMatch(/router\.(?:get|patch|delete)\([^\n]*connectorCapacityQuota/);
  });
});

describe('verified x402 payer limiter wiring', () => {
  it('places the payer limiter between payment validation and the AI limiter on Nessie only', () => {
    const router = source('./router.ts');

    expect(router).toContain(
      "router.use('/nessie/query', x402PaymentGate('/api/v1/nessie/query'), x402PayerRateLimit, aiRateLimiter, nessieQueryRouter)",
    );
    expect(router.match(/, x402PayerRateLimit,/g)).toHaveLength(1);
  });

  it('exposes canonical org and payer quota headers to browser consumers', () => {
    const router = source('./router.ts');

    for (const header of [
      'X-Org-Quota-Anchors-Limit',
      'X-Org-Quota-Rule-Drafts-Limit',
      'X-Org-Quota-Rules-Limit',
      'X-Org-Quota-Connectors-Limit',
      'X-X402-RateLimit-Limit',
    ]) {
      expect(router).toContain(header);
    }
  });
});
