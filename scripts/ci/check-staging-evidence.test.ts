import { describe, expect, it } from 'vitest';
import {
  check,
  extractDeclaredTier,
  hasEvidenceSection,
  isStagingToolingOnly,
  missingFields,
  requiredTierFor,
  TIER_SPECS,
} from './check-staging-evidence.js';

const T3_BODY = `
## Summary
Queue rewrite.

## Staging Soak Evidence
- Tier: T3
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00012-abc
- Soak start: 2026-05-04 14:00 UTC
- Soak end: 2026-05-06 14:00 UTC
- E2E result: 312/312 green
- Migration applied: 0288_priority_anchor_credits.sql
- Rollback rehearsed: yes — applied + rolled back + re-applied
- Trigger A fires: 4 (10k threshold reached at T+04:32, T+10:11, T+22:04, T+38:51)
- Trigger B fires: 2 (clock fired at T+09:14 and T+34:01)
- Daily flush observation: fired 2026-05-05 08:00 UTC, drained 4,217 anchors across 18 orgs
- Per-org isolation check: zero cross-org claims observed in 48h
`;

describe('check-staging-evidence', () => {
  describe('requiredTierFor', () => {
    it('returns T1 for plain frontend file', () => {
      expect(requiredTierFor(['src/components/Foo.tsx']).tier).toBe('T1');
    });

    it('returns T2 when migration is touched', () => {
      expect(requiredTierFor(['supabase/migrations/0288_x.sql']).tier).toBe('T2');
    });

    it('returns T3 when chain hot path is touched', () => {
      expect(requiredTierFor(['services/worker/src/chain/client.ts']).tier).toBe('T3');
    });

    it('returns T3 when batch-anchor.ts is touched', () => {
      expect(
        requiredTierFor(['services/worker/src/jobs/batch-anchor.ts']).tier,
      ).toBe('T3');
    });

    it('returns T3 when scheduled.ts is touched', () => {
      expect(
        requiredTierFor(['services/worker/src/routes/scheduled.ts']).tier,
      ).toBe('T3');
    });

    it('returns T3 when billing logic is touched', () => {
      expect(
        requiredTierFor(['services/worker/src/billing/paymentGuard.ts']).tier,
      ).toBe('T3');
    });

    it('picks highest tier across multiple matched files', () => {
      const result = requiredTierFor([
        'src/components/Foo.tsx',
        'services/worker/src/chain/client.ts',
        'supabase/migrations/0288_x.sql',
      ]);
      expect(result.tier).toBe('T3');
    });

    it('returns T2 for v1 API surface', () => {
      expect(
        requiredTierFor(['services/worker/src/api/v1/anchor.ts']).tier,
      ).toBe('T2');
    });
  });

  describe('extractDeclaredTier', () => {
    it('finds T3 declaration', () => {
      expect(extractDeclaredTier(T3_BODY)).toBe('T3');
    });

    it('returns null when no declaration', () => {
      expect(extractDeclaredTier('## Summary\nnothing here')).toBeNull();
    });

    it('finds T1 with no list-prefix', () => {
      expect(extractDeclaredTier('Tier: T1\n')).toBe('T1');
    });

    it('rejects malformed tier (T4)', () => {
      expect(extractDeclaredTier('Tier: T4')).toBeNull();
    });
  });

  describe('hasEvidenceSection', () => {
    it('matches the canonical heading', () => {
      expect(hasEvidenceSection(T3_BODY)).toBe(true);
    });

    it('rejects body without the heading', () => {
      expect(hasEvidenceSection('## Summary\nnothing')).toBe(false);
    });
  });

  describe('missingFields', () => {
    it('returns empty for a complete T3 body', () => {
      expect(missingFields(T3_BODY, 'T3')).toEqual([]);
    });

    it('lists all T1 fields when body has none', () => {
      expect(missingFields('', 'T1').length).toBe(TIER_SPECS.T1.requiredFields.length);
    });

    it('catches partial T3 (missing trigger fires)', () => {
      const partial = T3_BODY
        .replace(/Trigger A fires:.*\n/, '')
        .replace(/Trigger B fires:.*\n/, '');
      const missing = missingFields(partial, 'T3');
      expect(missing).toContain('Trigger A fires:');
      expect(missing).toContain('Trigger B fires:');
    });
  });

  describe('isStagingToolingOnly', () => {
    it('passes when all files are in the allowlist', () => {
      expect(
        isStagingToolingOnly([
          'scripts/staging/seed.ts',
          'scripts/ci/check-staging-evidence.ts',
          'CLAUDE.md',
          'docs/staging/README.md',
          '.github/workflows/staging-evidence.yml',
          'scripts/gcp-setup/cloud-scheduler.sh',
        ]).pass,
      ).toBe(true);
    });

    it('fails when any file is outside the allowlist', () => {
      expect(
        isStagingToolingOnly([
          'scripts/staging/seed.ts',
          'services/worker/src/chain/client.ts',
        ]).pass,
      ).toBe(false);
    });
  });

  describe('check (integration)', () => {
    it('passes when override label is set', () => {
      const r = check({ body: '', files: ['services/worker/src/chain/client.ts'], overridden: true });
      expect(r.ok).toBe(true);
    });

    it('passes for staging-tooling-only PR with no body', () => {
      const r = check({
        body: '',
        files: ['scripts/staging/seed.ts', 'docs/staging/README.md'],
        overridden: false,
      });
      expect(r.ok).toBe(true);
    });

    it('fails when tier missing on prod-affecting PR', () => {
      const r = check({
        body: '## Summary\nfix bug',
        files: ['services/worker/src/chain/client.ts'],
        overridden: false,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/missing a tier declaration/i);
    });

    it('fails when declared tier is below required', () => {
      const body = `## Staging Soak Evidence\n- Tier: T1\n- Staging branch: x\n- Worker revision: y\n- Soak start: a\n- Soak end: b\n- E2E result: green\n`;
      const r = check({
        body,
        files: ['services/worker/src/chain/client.ts'],
        overridden: false,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below required tier T3/);
    });

    it('passes a complete T3 PR', () => {
      const r = check({
        body: T3_BODY,
        files: ['services/worker/src/jobs/batch-anchor.ts'],
        overridden: false,
      });
      expect(r.ok).toBe(true);
    });

    it('fails T3 PR with evidence section but missing required fields', () => {
      const incomplete = `## Staging Soak Evidence\n- Tier: T3\n`;
      const r = check({
        body: incomplete,
        files: ['services/worker/src/jobs/batch-anchor.ts'],
        overridden: false,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/missing required fields/i);
    });
  });
});
