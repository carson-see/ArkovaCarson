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
- Staging deploy log id: 142 (from public.staging_deploy_log via scripts/staging/deploy.sh)
- Trigger A fires: 4 (10k threshold reached at T+04:32, T+10:11, T+22:04, T+38:51)
- Trigger B fires: 2 (clock fired at T+09:14 and T+34:01)
- Daily flush observation: fired 2026-05-05 08:00 UTC, drained 4,217 anchors across 18 orgs
- Per-org isolation check: zero cross-org claims observed in 48h
`;

describe('check-staging-evidence', () => {
  describe('TIER_SPECS', () => {
    it('pins the current minimum soak windows', () => {
      expect(TIER_SPECS.T1.soakHours).toBe(2);
      expect(TIER_SPECS.T2.soakHours).toBe(12);
      expect(TIER_SPECS.T3.soakHours).toBe(48);
    });
  });

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

    // SCRUM-1803: every T2/T3 deploy must reference its staging_deploy_log row,
    // proving the lease-enforced wrapper was used. A free-typed evidence
    // block without that id wouldn't catch raw-gcloud bypasses.
    it('SCRUM-1803: T2 fails when Staging deploy log id is missing', () => {
      const t2Body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
`;
      const missing = missingFields(t2Body, 'T2');
      expect(missing).toContain('Staging deploy log id:');
    });

    it('SCRUM-1803: T3 fails when Staging deploy log id is missing', () => {
      const partial = T3_BODY.replace(/Staging deploy log id:.*\n/, '');
      const missing = missingFields(partial, 'T3');
      expect(missing).toContain('Staging deploy log id:');
    });
  });

  describe('minimum soak duration enforcement', () => {
    const completeT2Body = (start: string, end: string) => `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- Soak start: ${start}
- Soak end: ${end}
- E2E result: 50/50 green
- Migration applied: 0300_example.sql
- Rollback rehearsed: yes
- Staging deploy log id: 142
`;

    const completeT1Body = (start: string, end: string) => `## Staging Soak Evidence
- Tier: T1
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- Soak start: ${start}
- Soak end: ${end}
- E2E result: green
`;

    it('fails a T2 PR when the soak is shorter than 12 hours', () => {
      const r = check({
        body: completeT2Body('2026-05-09 14:00 UTC', '2026-05-09 18:00 UTC'),
        files: ['supabase/migrations/0300_example.sql'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below the 12h minimum/);
    });

    it('fails a prod-affecting PR when soak timestamps are not parseable', () => {
      const r = check({
        body: completeT2Body('N/A', 'N/A'),
        files: ['supabase/migrations/0300_example.sql'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/could not parse/i);
    });

    it('passes a complete T2 PR when the soak lasts at least 12 hours', () => {
      const r = check({
        body: completeT2Body('2026-05-09 14:00 UTC', '2026-05-10 02:00 UTC'),
        files: ['supabase/migrations/0300_example.sql'],
      });

      expect(r.ok).toBe(true);
    });

    it('accepts ISO 8601 timestamps for a complete T2 PR', () => {
      const r = check({
        body: completeT2Body('2026-05-09T14:00:00Z', '2026-05-10T02:00:00Z'),
        files: ['supabase/migrations/0300_example.sql'],
      });

      expect(r.ok).toBe(true);
    });

    it('passes a T1 PR when the soak is exactly 2 hours', () => {
      const r = check({
        body: completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 16:00 UTC'),
        files: ['src/components/Foo.tsx'],
      });

      expect(r.ok).toBe(true);
    });

    it('passes a T1 PR when the soak is one minute above 2 hours', () => {
      const r = check({
        body: completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 16:01 UTC'),
        files: ['src/components/Foo.tsx'],
      });

      expect(r.ok).toBe(true);
    });

    it('accepts ISO 8601 timestamps for a complete T1 PR', () => {
      const r = check({
        body: completeT1Body('2026-05-09T14:00:00Z', '2026-05-09T16:00:00Z'),
        files: ['src/components/Foo.tsx'],
      });

      expect(r.ok).toBe(true);
    });

    it('fails a T2 PR when the soak is one minute below 12 hours', () => {
      const r = check({
        body: completeT2Body('2026-05-09 14:00 UTC', '2026-05-10 01:59 UTC'),
        files: ['supabase/migrations/0300_example.sql'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below the 12h minimum/);
    });

    it('passes a T2 PR when the soak is one minute above 12 hours', () => {
      const r = check({
        body: completeT2Body('2026-05-09 14:00 UTC', '2026-05-10 02:01 UTC'),
        files: ['supabase/migrations/0300_example.sql'],
      });

      expect(r.ok).toBe(true);
    });

    it('fails a T1 PR when the soak is shorter than 2 hours', () => {
      const r = check({
        body: completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 15:00 UTC'),
        files: ['src/components/Foo.tsx'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below the 2h minimum/);
    });

    it('fails a T1 PR when the soak is one minute below 2 hours', () => {
      const r = check({
        body: completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 15:59 UTC'),
        files: ['src/components/Foo.tsx'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below the 2h minimum/);
    });

    it('fails a T2 PR when soak end equals soak start', () => {
      const r = check({
        body: completeT2Body('2026-05-09 14:00 UTC', '2026-05-09 14:00 UTC'),
        files: ['supabase/migrations/0300_example.sql'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Soak end must be after Soak start/);
    });

    it('fails a T2 PR when soak end is before soak start', () => {
      const r = check({
        body: completeT2Body('2026-05-09 14:00 UTC', '2026-05-09 13:59 UTC'),
        files: ['supabase/migrations/0300_example.sql'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Soak end must be after Soak start/);
    });

    it('fails a T1 PR when soak end equals soak start', () => {
      const r = check({
        body: completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 14:00 UTC'),
        files: ['src/components/Foo.tsx'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Soak end must be after Soak start/);
    });

    it('fails a T1 PR when soak end is before soak start', () => {
      const r = check({
        body: completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 13:59 UTC'),
        files: ['src/components/Foo.tsx'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Soak end must be after Soak start/);
    });
  });

  describe('isStagingToolingOnly', () => {
    it('passes when all files are in the allowlist', () => {
      expect(
        isStagingToolingOnly([
          'scripts/staging/seed.ts',
          'scripts/ci/check-staging-evidence.ts',
          '.github/workflows/ci.yml',
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
    it('passes for staging-tooling-only PR with no body', () => {
      const r = check({
        body: '',
        files: ['scripts/staging/seed.ts', 'docs/staging/README.md'],
      });
      expect(r.ok).toBe(true);
    });

    it('fails when tier missing on prod-affecting PR', () => {
      const r = check({
        body: '## Summary\nfix bug',
        files: ['services/worker/src/chain/client.ts'],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/missing a tier declaration/i);
    });

    it('fails when declared tier is below required', () => {
      const body = `## Staging Soak Evidence\n- Tier: T1\n- Staging branch: x\n- Worker revision: y\n- Soak start: a\n- Soak end: b\n- E2E result: green\n`;
      const r = check({
        body,
        files: ['services/worker/src/chain/client.ts'],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below required tier T3/);
    });

    it('passes a complete T3 PR', () => {
      const r = check({
        body: T3_BODY,
        files: ['services/worker/src/jobs/batch-anchor.ts'],
      });
      expect(r.ok).toBe(true);
    });

    it('fails T3 PR with evidence section but missing required fields', () => {
      const incomplete = `## Staging Soak Evidence\n- Tier: T3\n`;
      const r = check({
        body: incomplete,
        files: ['services/worker/src/jobs/batch-anchor.ts'],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/missing required fields/i);
    });

    it('SCRUM-1208: HANDOFF.md and .gitignore are now in the staging-tooling allowlist (PR #733 follow-up)', () => {
      // Codex review on PR #733 flagged these as missing from the allowlist
      // even though the PR's own diff included them. Without them, the PR
      // that REMOVED the staging-soak-skip override couldn't itself self-skip,
      // forcing a circular evidence requirement. Adding them here keeps the
      // self-skip honest for the meta-PR pattern (CI/agent config + state docs).
      const r = check({
        body: '',
        files: ['HANDOFF.md', '.gitignore', '.claude/settings.json', '.claude/hooks/check-staging-evidence-pre-merge.sh'],
      });
      expect(r.ok).toBe(true);
      expect(r.notes.join(' ')).toMatch(/staging-tooling-only/i);
    });
  });
});
