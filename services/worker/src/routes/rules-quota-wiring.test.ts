/** CTO-ratified repository-truth regression for SCRUM-2703 rule quotas. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const adminSource = readFileSync(new URL('./admin.ts', import.meta.url), 'utf8');

describe('rule quota wiring', () => {
  it('mounts authoritative rules_total capacity after trusted JWT-to-org resolution', () => {
    expect(adminSource).toMatch(/getCallerOrgIdResult/);
    expect(adminSource).toMatch(/const ruleCapacityQuota = requireOrgQuota\(\{[\s\S]*kind: ['"]rules_total['"][\s\S]*mode: ['"]capacity['"][\s\S]*getOrgId: \(req\) => req\.orgId \?\? null/);
    expect(adminSource).toMatch(/adminRouter\.post\(\s*['"]\/rules['"],\s*requireRuleCreateOrg,\s*ruleCapacityQuota,/);
  });

  it('does not misreport the providerless rule-draft module as a mounted quota surface', () => {
    expect(adminSource).not.toMatch(/adminRouter\.post\(\s*['"]\/rules\/draft['"]/);
    expect(adminSource).not.toContain('makeHandleDraftRule');
    expect(adminSource).not.toMatch(/kind:\s*['"]rule_drafts['"]/);
  });
});
