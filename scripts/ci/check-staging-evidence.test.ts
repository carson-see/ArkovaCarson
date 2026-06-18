import { describe, expect, it } from 'vitest';
import {
  check,
  extractDeclaredTier,
  hasEvidenceSection,
  hasResidualRiskException,
  isFrontendOnlyChange,
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
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-123---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-04 13:55 UTC
- Preflight result: environment_type=clean_mirror
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
      expect(TIER_SPECS.T0.soakHours).toBe(0);
      expect(TIER_SPECS.T1.soakHours).toBe(2);
      expect(TIER_SPECS.T2.soakHours).toBe(12);
      expect(TIER_SPECS.T3.soakHours).toBe(48);
    });
  });

  describe('requiredTierFor', () => {
    it('returns T0 for docs-only changes', () => {
      expect(requiredTierFor(['docs/staging/README.md']).tier).toBe('T0');
    });

    it('returns T0 for unit-test-only changes', () => {
      expect(requiredTierFor(['services/worker/src/api/v1/anchor.test.ts']).tier).toBe('T0');
    });

    it('returns T1 for plain frontend file', () => {
      expect(requiredTierFor(['src/components/Foo.tsx']).tier).toBe('T1');
    });

    it('returns T0 for the S0-E4 release-pipeline CI tooling scripts', () => {
      expect(
        requiredTierFor([
          'scripts/ci/check-ledger-numeric-integrity.ts',
          'scripts/ci/check-agents-md-migration-collision.ts',
          'scripts/ci/compute-merge-authority.ts',
          'scripts/ci/snapshots/ledger-numeric-exemptions.json',
        ]).tier,
      ).toBe('T0');
    });

    it('returns T0 for worker load-test tooling scripts', () => {
      expect(
        requiredTierFor([
          'services/worker/scripts/load-test/10k-dau.js',
          'services/worker/scripts/load-test/lib/docusign-synth.js',
          'services/worker/scripts/load-test/lib/k6-docusign.test.ts',
          'services/worker/scripts/load-test/README.md',
        ]).tier,
      ).toBe('T0');
    });

    it('returns T3 when migration is touched', () => {
      expect(requiredTierFor(['supabase/migrations/0288_x.sql']).tier).toBe('T3');
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

    it('keeps auth, public contracts, AI, queues, anchoring, billing, and security out of T1', () => {
      expect(requiredTierFor(['services/worker/src/auth/session.ts']).tier).toBe('T2');
      expect(requiredTierFor(['docs/api/openapi.yaml']).tier).toBe('T2');
      expect(requiredTierFor(['services/worker/src/ai/riskScoring.ts']).tier).toBe('T2');
      expect(requiredTierFor(['services/worker/src/jobs/sendEmail.ts']).tier).toBe('T2');
      expect(requiredTierFor(['src/components/anchor/AnchorStatus.tsx']).tier).toBe('T2');
      expect(requiredTierFor(['src/components/billing/BillingPlan.tsx']).tier).toBe('T2');
      expect(requiredTierFor(['services/worker/src/security/audit.ts']).tier).toBe('T3');
    });

    it('treats worker deploy config as T2 production runtime surface', () => {
      expect(requiredTierFor(['.github/workflows/deploy-worker.yml']).tier).toBe('T2');
      expect(requiredTierFor(['services/worker/cloudbuild.yaml']).tier).toBe('T2');
    });

    it('excludes staging-tooling files from tier calculation', () => {
      expect(
        requiredTierFor(['services/worker/src/webhooks/agents.md']).tier,
      ).toBe('T0');
      expect(
        requiredTierFor(['services/worker/src/billing/agents.md']).tier,
      ).toBe('T0');
      expect(
        requiredTierFor([
          'services/worker/src/tests/webhook-delivery-roundtrip.test.ts',
          'services/worker/src/webhooks/agents.md',
        ]).tier,
      ).toBe('T0');
    });

    it('excludes test/spec files from tier calculation', () => {
      expect(
        requiredTierFor(['services/worker/src/api/queue-resolution.test.ts']).tier,
      ).toBe('T0');
      expect(
        requiredTierFor(['services/worker/src/api/v1/credentials-ctdl.test.ts']).tier,
      ).toBe('T0');
      expect(
        requiredTierFor(['services/worker/src/chain/broadcast.spec.ts']).tier,
      ).toBe('T0');
      // production file still triggers T2
      expect(
        requiredTierFor(['services/worker/src/api/queue-resolution.ts']).tier,
      ).toBe('T2');
      // mix of test + production uses production tier
      expect(
        requiredTierFor([
          'services/worker/src/api/queue-resolution.test.ts',
          'services/worker/src/api/queue-resolution.ts',
        ]).tier,
      ).toBe('T2');
    });
  });

  describe('extractDeclaredTier', () => {
    it('finds T3 declaration', () => {
      expect(extractDeclaredTier(T3_BODY)).toBe('T3');
    });

    it('finds T0 declaration', () => {
      expect(extractDeclaredTier('Tier: T0\n')).toBe('T0');
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
- [x] PR head SHA: 1234567890abcdef1234567890abcdef12345678
- [x] Staging tag URL or N/A explanation: https://pr-999---arkova-worker-staging.example.run.app
- [x] Health/smoke result: health ok, smoke green
- [x] Soak start: 2026-05-09 14:00 UTC
- [x] Soak end: 2026-05-09 16:00 UTC
- [x] CI/E2E green: green
- [x] Rollback plan: revert PR
- [x] Risk rationale: low-risk frontend copy change
- [x] Human approver: Carson
`;
      expect(missingFields(body, 'T1')).toEqual([]);
    });

    it('recognizes fields prefixed with unchecked checkbox [ ]', () => {
      const body = `## Staging Soak Evidence
- [ ] Tier: T1
- [ ] PR head SHA: 1234567890abcdef1234567890abcdef12345678
- [ ] Staging tag URL or N/A explanation: https://pr-999---arkova-worker-staging.example.run.app
- [ ] Health/smoke result: health ok, smoke green
- [ ] Soak start: 2026-05-09 14:00 UTC
- [ ] Soak end: 2026-05-09 16:00 UTC
- [ ] CI/E2E green: green
- [ ] Rollback plan: revert PR
- [ ] Risk rationale: low-risk frontend copy change
- [ ] Human approver: Carson
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
    const t2Files = ['services/worker/src/api/v1/example.ts'];

    const completeT2Body = (start: string, end: string) => `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: ${start}
- Soak end: ${end}
- E2E result: 50/50 green
- Migration applied: 0300_example.sql
- Rollback rehearsed: yes
- Staging deploy log id: 142
`;

    const completeT1Body = (start: string, end: string) => `## Staging Soak Evidence
- Tier: T1
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Staging tag URL or N/A explanation: https://pr-999---arkova-worker-staging.example.run.app
- Health/smoke result: health ok, targeted smoke green
- Soak start: ${start}
- Soak end: ${end}
- CI/E2E green: TypeCheck, Tests, E2E Tests green on current head
- Rollback plan: revert this PR and redeploy previous worker image
- Risk rationale: low-risk copy-only frontend change, no API/auth/billing/queue/anchoring/security surface
- Human approver: Carson
`;

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
        'T1 expedited evidence at exactly 2 hours',
        completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 16:00 UTC'),
        t1Files,
      ],
    ])('passes %s', (_label, body, files) => {
      expect(check({
        body,
        files,
        headSha: '1234567890abcdef1234567890abcdef12345678',
      }).ok).toBe(true);
    });

    it.each([
      [
        'T1 expedited evidence with no soak window',
        `## Staging Soak Evidence
- Tier: T1
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Staging tag URL or N/A explanation: https://pr-999---arkova-worker-staging.example.run.app
- Health/smoke result: health ok, targeted smoke green
- CI/E2E green: TypeCheck, Tests, E2E Tests green on current head
- Rollback plan: revert this PR and redeploy previous worker image
- Risk rationale: low-risk copy-only frontend change, no API/auth/billing/queue/anchoring/security surface
- Human approver: Carson
`,
        t1Files,
        /missing required fields.*Soak start:.*Soak end:/,
      ],
      [
        'T1 shorter than 2 hours',
        completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 15:59 UTC'),
        t1Files,
        /below the 2h minimum/,
      ],
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
          'scripts/ci/staging-honesty-preflight.ts',
          'scripts/ci/staging-honesty-preflight.test.ts',
          '.github/workflows/ci.yml',
          'CLAUDE.md',
          'docs/staging/README.md',
          'docs/ops/gemini-model-upgrade.md',
          'services/worker/scripts/load-test/docusign-volume.js',
          'services/worker/scripts/load-test/lib/docusign-synth.test.ts',
          'tests/k6/verify-api-load.js',
          'tests/load/webhook-delivery.test.ts',
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

    it('rejects eslint-config lookalike filenames', () => {
      expect(
        isStagingToolingOnly([
          'services/worker/src/noteslint.config.js',
        ]).pass,
      ).toBe(false);
    });

    it('passes for nested package lockfiles (Dependabot sub-package bumps)', () => {
      expect(
        isStagingToolingOnly([
          'packages/embed/package-lock.json',
        ]).pass,
      ).toBe(true);
      expect(
        isStagingToolingOnly([
          'services/worker/package-lock.json',
        ]).pass,
      ).toBe(true);
    });

    it('passes for E2E test specs (test infrastructure, not deployed code)', () => {
      expect(
        isStagingToolingOnly(['e2e/billing.spec.ts']).pass,
      ).toBe(true);
      expect(
        isStagingToolingOnly(['e2e/nested/deep/test.spec.ts']).pass,
      ).toBe(true);
    });

    it('passes for services/edge/package.json (Cloudflare edge worker, not Cloud Run)', () => {
      expect(
        isStagingToolingOnly(['services/edge/package.json']).pass,
      ).toBe(true);
    });

    it('fails for services/worker/package.json (prod dependency bump requires soak)', () => {
      expect(
        isStagingToolingOnly(['services/worker/package.json']).pass,
      ).toBe(false);
    });

    it('fails for worker deploy config because it affects production runtime', () => {
      expect(
        isStagingToolingOnly(['.github/workflows/deploy-worker.yml']).pass,
      ).toBe(false);
      expect(
        isStagingToolingOnly(['services/worker/cloudbuild.yaml']).pass,
      ).toBe(false);
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
    it('passes for T0 staging-tooling PR with no body', () => {
      const r = check({
        body: '',
        files: ['scripts/staging/seed.ts', 'docs/staging/README.md'],
      });
      expect(r.ok).toBe(true);
    });

    it('passes for T0 docs/tests/CI-only PR with no staging evidence', () => {
      const r = check({
        body: '',
        files: ['docs/staging/README.md', '.github/workflows/staging-evidence.yml'],
      });
      expect(r.ok).toBe(true);
      expect(r.notes.join(' ')).toMatch(/T0/i);
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

    describe('release-candidate manifest coverage', () => {
      const headSha = '1234567890abcdef1234567890abcdef12345678';
      const baseSha = 'abcdef1234567890abcdef1234567890abcdef12';
      const rcPath = 'docs/staging/rc-manifests/rc-2026-06-08-queue-drain.json';
      const rcBody = `## Staging Soak Evidence
- Tier: T3
- RC manifest path: ${rcPath}
`;

      const manifest = (overrides: Record<string, unknown> = {}) => ({
        schema_version: 1,
        rc_id: 'RC-2026-06-08-QUEUE-DRAIN',
        created_at: '2026-06-08T19:00:00Z',
        created_by: 'release-bot@arkova.io',
        release_owner: 'Carson',
        approval_status: 'approved',
        approval_actor: 'Carson',
        approval_time: '2026-06-08T19:05:00Z',
        train_launch_sha: 'ffffffffffffffffffffffffffffffffffffffff',
        target_main_sha: baseSha,
        included_prs: [
          {
            number: 1047,
            head_sha: headSha,
            base_sha: baseSha,
            risk_tier: 'T3',
            owner: 'release',
            ci_summary: 'required checks green',
            rollback_note: 'revert PR and re-apply prior migration state',
            migration_files: ['supabase/migrations/0332_free_tier_cap.sql'],
          },
        ],
        environment: {
          evidence_scope: 'merge-grade isolated staging',
          staging_api_base: 'https://pr-1047---arkova-worker-staging.example.run.app',
          staging_url: 'https://pr-1047---arkova-worker-staging.example.run.app',
          cloud_run_service: 'arkova-worker-staging',
          revision: 'arkova-worker-staging-00104-abc',
          deploy_tag: 'pr-1047',
          image_digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          supabase_project_ref: 'ujtlwnoqfhtitcmsnrpq',
          deploy_log_id: '1047',
          preflight_result: 'environment_type=clean_mirror',
        },
        soak: {
          start: '2026-06-08T00:00:00Z',
          end: '2026-06-10T00:00:00Z',
          duration_hours: 48,
          harness_version: 'scripts/staging/load-harness.ts@ffffffff',
          result: 'green',
          evidence_links: ['https://github.com/carson-see/ArkovaCarson/actions/runs/123'],
          expires_at: '2026-06-12T00:00:00Z',
        },
        migration_plan: {
          order: ['0332_free_tier_cap.sql'],
          rollback_proof: 'rollback block rehearsed and health stayed green',
          reapply_proof: 'migration re-applied and ledger verified',
          stop_conditions: ['SHA mismatch', 'rollback failure'],
        },
        ...overrides,
      });

      const runWithManifest = (rc: unknown, body = rcBody) => check({
        body,
        files: ['supabase/migrations/0332_free_tier_cap.sql'],
        headSha,
        baseSha,
        nowMs: Date.parse('2026-06-10T01:00:00Z'),
        rcManifestLoader: (path) => {
          expect(path).toBe(rcPath);
          return JSON.stringify(rc);
        },
      });

      it('passes when a valid RC manifest covers the exact PR head/base and tier', () => {
        const r = runWithManifest(manifest());
        expect(r.ok).toBe(true);
        expect(r.notes.join(' ')).toMatch(/RC manifest/i);
      });

      it('fails when the RC manifest path is outside the approved local directory', () => {
        const r = runWithManifest(manifest(), `## Staging Soak Evidence
- Tier: T3
- RC manifest path: https://example.com/rc.json
`);
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/local JSON file/i);
      });

      it('fails when the RC manifest path attempts directory traversal', () => {
        const r = runWithManifest(manifest(), `## Staging Soak Evidence
- Tier: T3
- RC manifest path: docs/staging/rc-manifests/../rc-evil.json
`);
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/local JSON file/i);
      });

      it('fails when the RC manifest does not cover the current PR head', () => {
        const r = runWithManifest(manifest({
          included_prs: [{
            head_sha: '9999999990abcdef1234567890abcdef12345678',
            base_sha: baseSha,
            risk_tier: 'T3',
            rollback_note: 'rollback ready',
          }],
        }));
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/current PR head/i);
      });

      it('fails when the RC manifest base SHA is stale', () => {
        const r = runWithManifest(manifest({
          included_prs: [{
            head_sha: headSha,
            base_sha: '9999999990abcdef1234567890abcdef12345678',
            risk_tier: 'T3',
            rollback_note: 'rollback ready',
          }],
        }));
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/base SHA/i);
      });

      it('fails when the current PR entry lacks audit fields and migration file coverage', () => {
        const r = runWithManifest(manifest({
          included_prs: [{
            number: 1047,
            head_sha: headSha,
            base_sha: baseSha,
            risk_tier: 'T3',
            rollback_note: 'rollback ready',
          }],
        }));
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/owner|ci_summary|migration_files/i);
      });

      it('fails when RC preflight is dirty', () => {
        const r = runWithManifest(manifest({
          environment: {
            evidence_scope: 'merge-grade isolated staging',
            staging_api_base: 'https://pr-1047---arkova-worker-staging.example.run.app',
            revision: 'arkova-worker-staging-00104-abc',
            deploy_tag: 'pr-1047',
            image_digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            supabase_project_ref: 'ujtlwnoqfhtitcmsnrpq',
            deploy_log_id: '1047',
            preflight_result: 'environment_type=soak_artifact',
          },
        }));
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/clean_mirror/i);
      });

      it('fails when RC evidence is expired', () => {
        const r = runWithManifest(manifest({
          soak: {
            start: '2026-06-08T00:00:00Z',
            end: '2026-06-10T00:00:00Z',
            duration_hours: 48,
            harness_version: 'scripts/staging/load-harness.ts@ffffffff',
            result: 'green',
            evidence_links: ['https://github.com/carson-see/ArkovaCarson/actions/runs/123'],
            expires_at: '2026-06-10T00:30:00Z',
          },
        }));
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/expired/i);
      });

      it('fails migration PR coverage without rollback and reapply proof', () => {
        const r = runWithManifest(manifest({
          migration_plan: {
            order: ['0332_free_tier_cap.sql'],
          },
        }));
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/rollback_proof|reapply_proof/i);
      });
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
- [x] PR head SHA: 1234567890abcdef1234567890abcdef12345678
- [x] Staging tag URL or N/A explanation: not applicable - docs-only worker image was not built
- [x] Health/smoke result: current-head smoke green
- [x] Soak start: 2026-05-09 14:00 UTC
- [x] Soak end: 2026-05-09 16:00 UTC
- [x] CI/E2E green: green
- [x] Rollback plan: revert PR
- [x] Risk rationale: frontend copy-only change, no restricted surfaces
- [x] Human approver: Carson
`;
      const r = check({
        body,
        files: ['src/components/Foo.tsx'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
      });
      expect(r.ok).toBe(true);
    });

    it('fails T1 expedited evidence copied from an older PR head', () => {
      const body = `## Staging Soak Evidence
- Tier: T1
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Staging tag URL or N/A explanation: https://pr-999---arkova-worker-staging.example.run.app
- Health/smoke result: health ok, smoke green
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-09 16:00 UTC
- CI/E2E green: green
- Rollback plan: revert PR
- Risk rationale: low-risk frontend copy change
- Human approver: Carson
`;
      const r = check({
        body,
        files: ['src/components/Foo.tsx'],
        headSha: '9999999990abcdef1234567890abcdef12345678',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/PR head SHA/i);
    });

    it('fails T1 expedited evidence when auditable fields are empty', () => {
      const body = `## Staging Soak Evidence
- Tier: T1
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Staging tag URL or N/A explanation:
- Health/smoke result: health ok
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-09 16:00 UTC
- CI/E2E green: green
- Rollback plan: revert PR
- Risk rationale: low-risk frontend copy change
- Human approver: Carson
`;
      const r = check({
        body,
        files: ['src/components/Foo.tsx'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Staging tag URL or N\/A explanation/i);
    });

    it('fails public API contract work that tries to use the expedited T1 path', () => {
      const body = `## Staging Soak Evidence
- Tier: T1
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Staging tag URL or N/A explanation: https://pr-999---arkova-worker-staging.example.run.app
- Health/smoke result: health ok, smoke green
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-09 16:00 UTC
- CI/E2E green: green
- Rollback plan: revert PR
- Risk rationale: API docs only
- Human approver: Carson
`;
      const r = check({
        body,
        files: ['docs/api/openapi.yaml'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below required tier T2/);
    });

    it('fails completed T2 evidence when the shared-staging preflight is not clean', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=soak_artifact; duplicate migration names found
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/clean_mirror/i);
    });

    it('fails completed T2 evidence copied from an older PR head', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '9999999990abcdef1234567890abcdef12345678',
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/PR head SHA/i);
    });

    it('fails completed T2 evidence copied from an older base SHA', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: '9999991234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Base SHA/i);
    });

    it('preserves completed T2 evidence when base drift is T0 CI-only and approved', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Base drift impact: T0 CI-only drift in .github/workflows/ci.yml; no runtime/schema/migration/staging/soak/deploy impact. Approved by: Carson 2026-06-09.
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: '9999991234567890abcdef1234567890abcdef12',
        baseDriftFiles: ['.github/workflows/ci.yml'],
      });
      expect(r.ok).toBe(true);
    });

    it('fails completed T2 evidence when base drift touches runtime code even with an impact note', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Base drift impact: T0 CI-only drift; no runtime/schema/migration/staging/soak/deploy impact. Approved by: Carson 2026-06-09.
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: '9999991234567890abcdef1234567890abcdef12',
        baseDriftFiles: ['services/worker/src/api/v1/docusign.ts'],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/base SHA drift|T2 surface/i);
    });

    it('fails completed T2 evidence when T0 base drift lacks an approved impact note', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: '9999991234567890abcdef1234567890abcdef12',
        baseDriftFiles: ['.github/workflows/ci.yml'],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Base drift impact/i);
    });

    it('fails completed T2 evidence when base drift approval is a placeholder', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Base drift impact: T0 CI-only drift in .github/workflows/ci.yml; no runtime/schema/migration/staging/soak/deploy impact. Approved by: TBD.
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: '9999991234567890abcdef1234567890abcdef12',
        baseDriftFiles: ['.github/workflows/ci.yml'],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Base drift impact/i);
    });

    it('fails completed T2 evidence with an unsupported evidence scope', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: shared staging smoke
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Evidence scope/i);
    });

    it('SCRUM-1208: HANDOFF.md and .gitignore are now in the T0 allowlist (PR #733 follow-up)', () => {
      // Codex review on PR #733 flagged these as missing from the allowlist
      // even though the PR's own diff included them. Without them, the PR
      // that removed the deleted staging-soak-skip override could not require
      // its own runtime evidence. This keeps the T0 meta-PR pattern honest for
      // CI/agent config + state docs.
      const r = check({
        body: '',
        files: ['HANDOFF.md', '.gitignore', '.claude/settings.json', '.claude/hooks/check-staging-evidence-pre-merge.sh'],
      });
      expect(r.ok).toBe(true);
      expect(r.notes.join(' ')).toMatch(/T0 CI-only/i);
    });

    it('passes T2 with non-clean preflight when a structured residual-risk exception is present', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00190-diz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-924---arkova-worker-staging-kvojbeutfa-uc.a.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-27 15:32 UTC
- Preflight result: environment_type=soak_artifact (residual-risk exception approved)
- Soak start: 2026-05-27 15:52 UTC
- Soak end: 2026-05-28 03:52 UTC
- E2E result: cron mode 720/720 (0% error rate)
- Migration applied: 0316 + 0317
- Rollback rehearsed: YES
- Staging deploy log id: 114

### Residual-risk note (preflight non-clean_mirror)
- Contamination type: soak_artifact
- Affected rows: 15 timestamp-versioned migration ledger rows from prior PR soaks
- Impact on this PR: none — PR #924 migrations (0316, 0317) are net-new additive DDL
- Reason not cleaned: 7 other PRs hold active staging leases; cleaning would invalidate their evidence
- Approved by: Carson (2026-05-27)
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(true);
      expect(r.notes.join(' ')).toMatch(/residual-risk/i);
    });

    it('still fails non-clean preflight without a residual-risk section', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=soak_artifact
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/clean_mirror/i);
    });

    it('fails residual-risk section missing required sub-fields', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=soak_artifact (residual-risk exception approved)
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: n/a
- Staging deploy log id: 142

### Residual-risk note (preflight non-clean_mirror)
- Contamination type: soak_artifact
- Approved by: Carson (2026-05-09)
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/residual-risk.*missing/i);
    });
  });

  describe('hasResidualRiskException', () => {
    it('returns true for a complete residual-risk section', () => {
      const body = `### Residual-risk note (preflight non-clean_mirror)
- Contamination type: soak_artifact
- Affected rows: 15 timestamp-versioned migration ledger rows
- Impact on this PR: none — net-new additive DDL
- Reason not cleaned: 7 other PRs hold active staging leases
- Approved by: Carson (2026-05-27)
`;
      expect(hasResidualRiskException(body)).toEqual({ valid: true, missing: [] });
    });

    it('returns false when the section header is missing', () => {
      const body = `Some other content without the header`;
      const result = hasResidualRiskException(body);
      expect(result.valid).toBe(false);
    });

    it('returns missing fields when sub-fields are absent', () => {
      const body = `### Residual-risk note (preflight non-clean_mirror)
- Contamination type: soak_artifact
`;
      const result = hasResidualRiskException(body);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('Affected rows:');
      expect(result.missing).toContain('Impact on this PR:');
      expect(result.missing).toContain('Reason not cleaned:');
      expect(result.missing).toContain('Approved by:');
    });

    // Gap 2: a self-written `Approved by:` with no value (or a placeholder)
    // must NOT satisfy the exception. Before the fix the sub-field check was
    // label-presence only, so a blank approver waived both the clean_mirror
    // preflight and the soak-duration minimum on dirty staging.
    it('returns invalid when Approved by has a label but no value', () => {
      const body = `### Residual-risk note (preflight non-clean_mirror)
- Contamination type: soak_artifact
- Affected rows: 15 ledger rows
- Impact on this PR: none — net-new additive DDL
- Reason not cleaned: other PRs hold active staging leases
- Approved by:
`;
      const result = hasResidualRiskException(body);
      expect(result.valid).toBe(false);
      expect(result.missing.join(' ')).toMatch(/Approved by/i);
    });

    it.each(['pending', 'TBD', 'tbd', 'TODO', 'n/a', 'N/A', 'none', 'tba'])(
      'returns invalid when Approved by is the placeholder %s',
      (placeholder) => {
        const body = `### Residual-risk note (preflight non-clean_mirror)
- Contamination type: soak_artifact
- Affected rows: 15 ledger rows
- Impact on this PR: none
- Reason not cleaned: other PRs hold active staging leases
- Approved by: ${placeholder}
`;
        const result = hasResidualRiskException(body);
        expect(result.valid).toBe(false);
        expect(result.missing.join(' ')).toMatch(/Approved by/i);
      },
    );

    it('still returns valid for an email approver', () => {
      const body = `### Residual-risk note (preflight non-clean_mirror)
- Contamination type: soak_artifact
- Affected rows: 15 ledger rows
- Impact on this PR: none
- Reason not cleaned: other PRs hold active staging leases
- Approved by: carson@arkova.io
`;
      expect(hasResidualRiskException(body)).toEqual({ valid: true, missing: [] });
    });
  });

  // Gap 1: at T2/T3 the deploy-evidence fields (Worker revision, Cloud Run
  // service/tag URL, Image digest, Staging deploy log id, …) were never
  // value-checked — only their labels were required. A PR could go green with
  // every artifact left as "PENDING". These exercise the symmetric, stricter
  // analog of the T1 auditable-value checks for T2 and T3.
  describe('T2/T3 deploy-evidence value validation (defense-in-depth)', () => {
    const headSha = '1234567890abcdef1234567890abcdef12345678';
    const baseSha = 'abcdef1234567890abcdef1234567890abcdef12';

    it('Gap 1: T2 fails when deploy-evidence fields are PENDING placeholders', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: PENDING
- PR head SHA: ${headSha}
- Base SHA: ${baseSha}
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: PENDING
- Image digest: PENDING
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: yes
- Staging deploy log id: PENDING
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha,
        baseSha,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Worker revision/i);
      expect(r.errors.join(' ')).toMatch(/placeholder/i);
    });

    it('Gap 1: T3 fails when deploy-evidence fields are PENDING placeholders', () => {
      const body = `## Staging Soak Evidence
- Tier: T3
- Staging branch: arkova-staging
- Worker revision: PENDING
- PR head SHA: ${headSha}
- Base SHA: ${baseSha}
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: PENDING
- Image digest: PENDING
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-04 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-04 14:00 UTC
- Soak end: 2026-05-06 14:00 UTC
- E2E result: 312/312 green
- Migration applied: 0288_x.sql
- Rollback rehearsed: yes
- Staging deploy log id: PENDING
- Trigger A fires: PENDING
- Trigger B fires: PENDING
- Daily flush observation: PENDING
- Per-org isolation check: PENDING
`;
      const r = check({
        body,
        files: ['supabase/migrations/0288_x.sql'],
        headSha,
        baseSha,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/placeholder/i);
    });

    it('Gap 1: T2 with real deploy values and a metric-only E2E result still passes', () => {
      // Guards against over-strict enforcement: a real passing E2E result is
      // sometimes reported as a ratio with no "green"/"pass" keyword.
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: ${headSha}
- Base SHA: ${baseSha}
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: cron mode 720/720 (0% error rate)
- Migration applied: none
- Rollback rehearsed: yes
- Staging deploy log id: 142
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha,
        baseSha,
      });
      expect(r.ok).toBe(true);
    });

    it('Gap 1+2: dirty-staging T2 with PENDING artifacts and a self-blank Approved by stays red', () => {
      // The combined exploit: dirty preflight + short soak + all-PENDING deploy
      // evidence, "waived" by a self-authored residual-risk note whose
      // Approved by carries no real approver. Both gaps must fail it.
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: PENDING
- PR head SHA: ${headSha}
- Base SHA: ${baseSha}
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: PENDING
- Image digest: PENDING
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=soak_artifact
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-09 18:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: yes
- Staging deploy log id: PENDING

### Residual-risk note (preflight non-clean_mirror)
- Contamination type: soak_artifact
- Affected rows: some
- Impact on this PR: none
- Reason not cleaned: lazy
- Approved by:
`;
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha,
        baseSha,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/placeholder/i);
      expect(r.errors.join(' ')).toMatch(/clean_mirror|residual-risk/i);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Frontend-T2 evidence mode (decision (a)).
  //
  // A PR can be required-tier T2 purely by touching a sensitive *frontend*
  // contract surface (src/components/{anchor,api,auth,billing,public,
  // verification,verify}/). Such a PR ships no worker code, no migration, and
  // no SDK/contract change — so it CANNOT produce the worker artifacts the
  // standard T2 block demands (Worker revision, Image digest, Cloud Run URL,
  // Staging deploy log id). The frontend-T2 mode lets that narrow case satisfy
  // T2 with frontend-appropriate evidence (Vercel deployment URL + E2E on the
  // affected view + a residual-risk note attesting no worker artifacts exist).
  //
  // CRITICAL backward-compat guard: this path activates ONLY when every changed
  // file is purely frontend (src/** and not a worker/migration/SDK/contract
  // path). Any worker- or migration-touching T2 PR keeps the unchanged
  // worker-artifact requirements.
  // ───────────────────────────────────────────────────────────────────────
  describe('frontend-T2 evidence mode', () => {
    const headSha = '1234567890abcdef1234567890abcdef12345678';

    // The real #1023 fileset: sensitive frontend dirs (anchor, verification)
    // → required tier T2, but every path is src/**.
    const frontendOnlyT2Files = [
      'src/components/anchor/AssetDetailView.tsx',
      'src/components/verification/PublicVerification.tsx',
      'src/components/credentials/CpeMetadataSection.tsx',
      'src/hooks/useHasCredentialImportEntitlement.ts',
    ];

    const frontendT2Body = (overrides: Partial<{
      tier: string;
      vercel: string;
      e2e: string;
      ciGreen: string;
      head: string;
      rollback: string;
      note: string;
    }> = {}) => {
      const {
        tier = 'T2',
        vercel = 'https://arkova-26-git-feat-cpe.vercel.app',
        e2e = 'credential-detail + public-verification E2E 18/18 green on head',
        ciGreen = 'Tests, E2E Tests, TypeCheck & Lint all green on current head',
        head = headSha,
        rollback = 'revert PR — additive display-only components, no data/schema/worker state',
        note = `
### Residual-risk note
- No worker artifacts: frontend-only PR — no Cloud Run deploy, no worker revision, no image digest, no staging deploy-log id (no server code, no migration changed)
- Surfaces touched: credential detail view + public verification view (src/components/{anchor,verification,credentials})
- Approved by: Carson`,
      } = overrides;
      return `## Staging Soak Evidence
- Tier: ${tier}
- PR head SHA: ${head}
- Vercel deployment URL: ${vercel}
- E2E result: ${e2e}
- CI/E2E green: ${ciGreen}
- Rollback plan: ${rollback}
${note}
`;
    };

    describe('isFrontendOnlyChange', () => {
      it('is true for an all-src/** fileset', () => {
        expect(isFrontendOnlyChange(frontendOnlyT2Files)).toBe(true);
      });

      it('is true for a single frontend component', () => {
        expect(isFrontendOnlyChange(['src/components/anchor/AssetDetailView.tsx'])).toBe(true);
      });

      it('is false when a worker file is present', () => {
        expect(isFrontendOnlyChange([
          'src/components/anchor/AssetDetailView.tsx',
          'services/worker/src/api/v1/anchor.ts',
        ])).toBe(false);
      });

      it('is false when a migration is present', () => {
        expect(isFrontendOnlyChange([
          'src/components/verification/PublicVerification.tsx',
          'supabase/migrations/0331_x.sql',
        ])).toBe(false);
      });

      it('is false when an SDK/package file is present', () => {
        expect(isFrontendOnlyChange([
          'src/components/api/ApiKeys.tsx',
          'packages/typescript/src/index.ts',
        ])).toBe(false);
      });

      it('is false when a public API contract doc is present', () => {
        expect(isFrontendOnlyChange([
          'src/components/api/ApiKeys.tsx',
          'docs/api/openapi.yaml',
        ])).toBe(false);
      });

      it('is false for an empty fileset (nothing to attest as frontend-only)', () => {
        expect(isFrontendOnlyChange([])).toBe(false);
      });

      it('is false for a non-src frontend-ish path (e.g. a root config)', () => {
        expect(isFrontendOnlyChange(['vite.config.ts'])).toBe(false);
      });
    });

    // ── Scenario 1 (required): frontend-only T2 + frontend evidence → PASS ──
    it('Scenario 1: frontend-only T2 with frontend evidence PASSES', () => {
      const r = check({
        body: frontendT2Body(),
        files: frontendOnlyT2Files,
        headSha,
      });
      expect(r.ok).toBe(true);
      expect(r.notes.join(' ')).toMatch(/frontend-T2/i);
    });

    it('Scenario 1b: frontend-only T2 PASSES without any worker-artifact fields present at all', () => {
      // Proves we are not silently requiring the worker fields for this path.
      // Assert that the worker-artifact *list-item field lines* are absent. We
      // check for the `- <Label>` form the standard T2 block uses (rather than a
      // bare substring) because the residual-risk prose legitimately names the
      // artifacts it attests are absent. Plain string matching — no regex — so
      // there is no backtracking/ReDoS surface.
      const body = frontendT2Body();
      expect(body).not.toContain('- Worker revision:');
      expect(body).not.toContain('- Image digest:');
      expect(body).not.toContain('- Cloud Run service/tag URL:');
      expect(body).not.toContain('- Staging deploy log id:');
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(true);
    });

    // ── Scenario 2 (required): worker-touching T2 still FAILS without artifacts ──
    it('Scenario 2: worker-touching T2 with ONLY frontend evidence still FAILS (worker artifacts unchanged)', () => {
      const r = check({
        body: frontendT2Body(),
        // Same body, but the fileset now includes a worker file → NOT frontend-only.
        files: ['src/components/anchor/AssetDetailView.tsx', 'services/worker/src/api/v1/docusign.ts'],
        headSha,
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      // It must demand the standard worker-artifact fields it lacks.
      expect(r.errors.join(' ')).toMatch(/Worker revision:|Image digest:|Cloud Run|Staging deploy log id:/i);
    });

    it('Scenario 2b: a real worker T2 PR with a complete worker-artifact block still PASSES (no regression to the standard path)', () => {
      const completeWorkerT2 = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: ${headSha}
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Staging project ref: ujtlwnoqfhtitcmsnrpq
- Cloud Run service/tag URL: https://pr-999---arkova-worker-staging.example.run.app
- Image digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- Evidence scope: merge-grade shared staging
- Preflight timestamp: 2026-05-09 13:55 UTC
- Preflight result: environment_type=clean_mirror
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-10 02:00 UTC
- E2E result: 50/50 green
- Migration applied: none
- Rollback rehearsed: yes
- Staging deploy log id: 142
`;
      const r = check({
        body: completeWorkerT2,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha,
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(true);
    });

    // ── Scenario 3 (required): frontend-only T2 WITHOUT frontend evidence → FAIL ──
    it('Scenario 3: frontend-only T2 missing the Vercel deployment URL FAILS', () => {
      const body = frontendT2Body().replace(/- Vercel deployment URL:.*\n/, '');
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Vercel deployment URL:/i);
    });

    it('Scenario 3b: frontend-only T2 with a non-URL Vercel field FAILS', () => {
      const body = frontendT2Body({ vercel: 'deployed somewhere' });
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Vercel deployment URL/i);
    });

    it('Scenario 3c: frontend-only T2 with an empty E2E result FAILS', () => {
      const body = frontendT2Body({ e2e: '' });
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/E2E result/i);
    });

    it('Scenario 3d: frontend-only T2 with a PENDING E2E result FAILS (placeholder rejected)', () => {
      const body = frontendT2Body({ e2e: 'PENDING' });
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/placeholder/i);
    });

    it('Scenario 3e: frontend-only T2 with NO residual-risk note FAILS', () => {
      const body = frontendT2Body({ note: '' });
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/residual-risk/i);
    });

    it('Scenario 3f: frontend-only T2 whose residual-risk note has a blank Approved by FAILS', () => {
      const body = frontendT2Body({
        note: `
### Residual-risk note
- No worker artifacts: frontend-only — no Cloud Run deploy
- Surfaces touched: credential detail view
- Approved by:`,
      });
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Approved by|residual-risk/i);
    });

    it('Scenario 3g: frontend-only T2 with a stale (mismatched) PR head SHA FAILS (exact-head integrity preserved)', () => {
      const body = frontendT2Body();
      const r = check({
        body,
        files: frontendOnlyT2Files,
        headSha: '9999999990abcdef1234567890abcdef12345678',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/PR head SHA/i);
    });

    it('Scenario 3h: frontend-only T2 missing the CI/E2E-green field FAILS', () => {
      const body = frontendT2Body().replace(/- CI\/E2E green:.*\n/, '');
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/CI\/E2E green:/i);
    });

    // Regression (PR #1051 MEDIUM finding): the label is PRESENT but its value
    // is EMPTY (`- CI/E2E green:` with nothing after the colon). missingFields
    // is satisfied (label present), and validatePassingEvidenceField
    // short-circuits to PASS on an empty value — so before the fix a frontend-T2
    // body could attest *nothing* for CI/E2E-green, weaker than the T1 path
    // which runs validateNonEmptyEvidenceField over every required field. The
    // frontend-T2 path must reject an empty value, mirroring T1.
    it('Scenario 3i: frontend-only T2 with an EMPTY CI/E2E-green value FAILS', () => {
      const body = frontendT2Body({ ciGreen: '' });
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/CI\/E2E green:/i);
    });

    // Under-declaration must still fail: a T2-required frontend-only PR that
    // declares T1 is blocked exactly as before (the frontend path does NOT
    // weaken classification — it only changes which evidence T2 accepts).
    it('does not let a frontend-only T2-required PR sneak through as a declared T1', () => {
      const body = `## Staging Soak Evidence
- Tier: T1
- PR head SHA: ${headSha}
- Staging tag URL or N/A explanation: N/A — frontend-only
- Health/smoke result: green
- CI/E2E green: green
- Rollback plan: revert PR
- Risk rationale: frontend-only
- Human approver: Carson
`;
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below required tier T2/i);
    });

    // A T3-required frontend surface (admin/treasury) must NOT get the
    // frontend-T2 shortcut — that path is treasury-administration and stays
    // full T3.
    it('does not extend the frontend path to a T3 frontend surface (admin/treasury)', () => {
      const body = frontendT2Body();
      const r = check({
        body,
        files: ['src/components/admin/treasury/TreasuryPanel.tsx'],
        headSha,
      });
      expect(r.ok).toBe(false);
      // Declared T2 < required T3 → blocked; never reaches frontend-T2 acceptance.
      expect(r.errors.join(' ')).toMatch(/below required tier T3/i);
    });
  });
});
