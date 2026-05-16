import { describe, expect, it } from 'vitest';
import {
  check,
  extractDeclaredTier,
  hasEvidenceSection,
  isStagingToolingOnly,
  missingFields,
  requiredTierFor,
  soakDurationErrors,
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

    it('returns T3 when anchorExpirySweep.ts is touched', () => {
      expect(
        requiredTierFor(['services/worker/src/jobs/anchorExpirySweep.ts']).tier,
      ).toBe('T3');
    });

    it('returns T3 when attestationAnchor.ts is touched', () => {
      expect(
        requiredTierFor(['services/worker/src/jobs/attestationAnchor.ts']).tier,
      ).toBe('T3');
    });

    it('returns T3 when grace-expiry-sweep.ts is touched', () => {
      expect(
        requiredTierFor(['services/worker/src/jobs/grace-expiry-sweep.ts']).tier,
      ).toBe('T3');
    });

    it('returns T3 when revocation.ts is touched', () => {
      expect(
        requiredTierFor(['services/worker/src/jobs/revocation.ts']).tier,
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

    it('finds tier with checked checkbox prefix', () => {
      expect(extractDeclaredTier('- [x] Tier: T2\n')).toBe('T2');
    });

    it('finds tier with unchecked checkbox prefix', () => {
      expect(extractDeclaredTier('- [ ] Tier: T1\n')).toBe('T1');
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

    it('recognizes fields prefixed with markdown checkbox [x]', () => {
      const body = `## Staging Soak Evidence
- [x] Tier: T1
- [x] Staging branch: arkova-staging
- [x] Worker revision: arkova-worker-staging-00099-xyz
- [x] Soak start: 2026-05-09 14:00 UTC
- [x] Soak end: 2026-05-09 16:00 UTC
- [x] E2E result: green
`;
      expect(missingFields(body, 'T1')).toEqual([]);
    });

    it('recognizes fields prefixed with unchecked checkbox [ ]', () => {
      const body = `## Staging Soak Evidence
- [ ] Tier: T1
- [ ] Staging branch: arkova-staging
- [ ] Worker revision: arkova-worker-staging-00099-xyz
- [ ] Soak start: 2026-05-09 14:00 UTC
- [ ] Soak end: 2026-05-09 16:00 UTC
- [ ] E2E result: green
`;
      expect(missingFields(body, 'T1')).toEqual([]);
    });
  });

  describe('extractEvidenceFieldValue (via soakDurationErrors)', () => {
    it('does not capture the next line when field value is empty', () => {
      const body = `## Staging Soak Evidence
- Tier: T1
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- Soak start:
- Soak end: 2026-05-09 16:00 UTC
- E2E result: green
`;
      const errors = soakDurationErrors(body, 'T1');
      // Before fix: \s* ate the newline, captured next line as value →
      // "Soak end must be after Soak start" (wrong). After fix: empty
      // value → unparseable timestamp (correct).
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/Soak start could not parse/);
      expect(errors[0]).not.toMatch(/after Soak start/);
    });

    it('does not bleed next-line content into empty field with checkbox prefix', () => {
      const body = `## Staging Soak Evidence
- [x] Tier: T1
- [x] Staging branch: arkova-staging
- [x] Worker revision: arkova-worker-staging-00099-xyz
- [x] Soak start:
- [x] Soak end: 2026-05-09 16:00 UTC
- [x] E2E result: green
`;
      const errors = soakDurationErrors(body, 'T1');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/Soak start could not parse/);
      expect(errors[0]).not.toMatch(/after Soak start/);
    });
  });

  describe('minimum soak duration enforcement', () => {
    const t1Files = ['src/components/Foo.tsx'];
    const t2Files = ['supabase/migrations/0300_example.sql'];

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

    const expectEvidencePasses = (body: string, files: string[]) => {
      expect(check({ body, files }).ok).toBe(true);
    };

    const expectEvidenceFails = (body: string, files: string[], pattern: RegExp) => {
      const r = check({ body, files });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(pattern);
    };

    it.each([
      [
        'complete T2 at exactly 12 hours',
        completeT2Body('2026-05-09 14:00 UTC', '2026-05-10 02:00 UTC'),
        t2Files,
      ],
      [
        'T2 ISO 8601 timestamps',
        completeT2Body('2026-05-09T14:00:00Z', '2026-05-10T02:00:00Z'),
        t2Files,
      ],
      [
        'T2 one minute above 12 hours',
        completeT2Body('2026-05-09 14:00 UTC', '2026-05-10 02:01 UTC'),
        t2Files,
      ],
      [
        'T1 at exactly 2 hours',
        completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 16:00 UTC'),
        t1Files,
      ],
      [
        'T1 ISO 8601 timestamps',
        completeT1Body('2026-05-09T14:00:00Z', '2026-05-09T16:00:00Z'),
        t1Files,
      ],
      [
        'T1 one minute above 2 hours',
        completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 16:01 UTC'),
        t1Files,
      ],
    ])('passes %s', (_label, body, files) => {
      expectEvidencePasses(body, files);
    });

    it.each([
      [
        'T2 shorter than 12 hours',
        completeT2Body('2026-05-09 14:00 UTC', '2026-05-09 18:00 UTC'),
        t2Files,
        /below the 12h minimum/,
      ],
      [
        'T2 one minute below 12 hours',
        completeT2Body('2026-05-09 14:00 UTC', '2026-05-10 01:59 UTC'),
        t2Files,
        /below the 12h minimum/,
      ],
      [
        'T1 shorter than 2 hours',
        completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 15:00 UTC'),
        t1Files,
        /below the 2h minimum/,
      ],
      [
        'T1 one minute below 2 hours',
        completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 15:59 UTC'),
        t1Files,
        /below the 2h minimum/,
      ],
      [
        'non-parseable prod-affecting timestamps',
        completeT2Body('N/A', 'N/A'),
        t2Files,
        /could not parse/i,
      ],
      [
        'T2 end equal to start',
        completeT2Body('2026-05-09 14:00 UTC', '2026-05-09 14:00 UTC'),
        t2Files,
        /Soak end must be after Soak start/,
      ],
      [
        'T2 end before start',
        completeT2Body('2026-05-09 14:00 UTC', '2026-05-09 13:59 UTC'),
        t2Files,
        /Soak end must be after Soak start/,
      ],
      [
        'T1 end equal to start',
        completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 14:00 UTC'),
        t1Files,
        /Soak end must be after Soak start/,
      ],
      [
        'T1 end before start',
        completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 13:59 UTC'),
        t1Files,
        /Soak end must be after Soak start/,
      ],
    ])('fails %s', (_label, body, files, pattern) => {
      expectEvidenceFails(body, files, pattern);
    });
  });

  describe('isStagingToolingOnly', () => {
    it('passes when all files are in the allowlist', () => {
      expect(
        isStagingToolingOnly([
          'scripts/staging/seed.ts',
          'scripts/ci/check-staging-evidence.ts',
          'scripts/ci/check-staging-gcloud-policy.ts',
          '.github/workflows/ci.yml',
          'CLAUDE.md',
          'docs/staging/README.md',
          'docs/ops/gemini-model-upgrade.md',
          '.github/workflows/staging-evidence.yml',
          'scripts/gcp-setup/cloud-scheduler.sh',
        ]).pass,
      ).toBe(true);
    });

    it('passes for eslint config and rule files', () => {
      expect(
        isStagingToolingOnly([
          'eslint-rules/tenant-isolation.cjs',
          'services/worker/eslint.config.js',
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

    it('passes a complete T1 PR with checkbox-prefixed fields', () => {
      const body = `## Staging Soak Evidence
- [x] Tier: T1
- [x] Staging branch: arkova-staging
- [x] Worker revision: arkova-worker-staging-00099-xyz
- [x] Soak start: 2026-05-09 14:00 UTC
- [x] Soak end: 2026-05-09 16:00 UTC
- [x] E2E result: green
`;
      const r = check({
        body,
        files: ['src/components/Foo.tsx'],
      });
      expect(r.ok).toBe(true);
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
