import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  S33_LANE1_OFFLINE_EVIDENCE_FILES,
  check,
  extractDeclaredTier,
  findS33RuntimeImporters,
  findS33Lane1RuntimeImporters,
  hasEvidenceSection,
  hasResidualRiskException,
  isDeployWorkerUsesOnlyBump,
  isFrontendOnlyChange,
  isOfflinePackageOnlyChange,
  isS33Lane1RootLintScriptOnly,
  isStagingToolingOnly,
  missingFields,
  requiredTierFor,
  SHARED_PROD_RUNTIME_RULES,
  soakDurationErrors,
  TIER_SPECS,
} from './check-staging-evidence.js';

// Unified diff (the body git emits after the `@@` hunk header) limited to an
// `actions/<name>@vN` (or `@<sha>`) bump in .github/workflows/deploy-worker.yml.
const USES_ONLY_DEPLOY_WORKER_DIFF = `@@ -41,7 +41,7 @@ jobs:
       - name: Checkout
-        uses: actions/checkout@v6
+        uses: actions/checkout@v7
       - name: Setup Node
         uses: actions/setup-node@v4
`;

// The deploy preflight runs worker tests that verify immutable Git ancestry.
// Adding an explicit full-history checkout changes CI mechanics only; it does
// not alter the built image, runtime env, scaling, secrets, or deployed code.
const fullHistoryDeployWorkerDiff = `@@ -28,6 +28,9 @@ jobs:
     steps:
       - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
+        with:
+          fetch-depth: 0
+          persist-credentials: false

       - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
`;

const shallowHistoryDeployWorkerDiff = `@@ -28,8 +28,8 @@ jobs:
       - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
         with:
-          fetch-depth: 0
+          fetch-depth: 1
`;

const nonCheckoutFullHistoryDiff = `@@ -32,6 +32,8 @@ jobs:
       - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
         with:
+          fetch-depth: 0
+          persist-credentials: false
           node-version: 20
`;

const credentialPersistenceWeakeningDiff = `@@ -28,8 +28,8 @@ jobs:
       - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
         with:
           fetch-depth: 0
-          persist-credentials: false
+          persist-credentials: true
`;

// A real runtime-config change in deploy-worker.yml: bumps --min-instances. This
// MUST keep classifying T2 — it is exactly the prod-runtime surface the gate guards.
const RUNTIME_CONFIG_DEPLOY_WORKER_DIFF = `@@ -78,7 +78,7 @@ jobs:
           --region=us-central1 \\
-          --min-instances=1 \\
+          --min-instances=2 \\
           --max-instances=10 \\
`;

// A mixed diff: a uses: bump AND a real env-var change in the same file. Fail
// closed — the presence of any non-uses runtime line keeps the whole file T2.
const MIXED_DEPLOY_WORKER_DIFF = `@@ -41,7 +41,7 @@ jobs:
       - name: Checkout
-        uses: actions/checkout@v6
+        uses: actions/checkout@v7
@@ -90,7 +90,7 @@ jobs:
           --set-env-vars \\
-          ENABLE_AI_EXTRACTION=true \\
+          ENABLE_AI_EXTRACTION=false \\
`;

const S33_LANE1_ROOT_LINT_DIFF = `@@ -16,6 +16,7 @@
     "typecheck": "tsc --noEmit",
     "lint": "eslint src/",
     "lint:copy": "tsx scripts/check-copy-terms.ts",
+    "lint:batch-drain-evidence": "eslint --no-ignore scripts/staging/batch-drain-harness-lib.ts scripts/staging/batch-drain-harness-lib.test.ts scripts/staging/batch-drain-observation.ts scripts/staging/batch-drain-observation.test.ts scripts/staging/batch-drain-crash-control.ts scripts/staging/batch-drain-crash-control.test.ts scripts/staging/batch-drain-crash-adapter.ts scripts/staging/batch-drain-crash-adapter.test.ts scripts/staging/batch-drain-strict-json.ts scripts/staging/batch-drain-strict-json.test.ts scripts/staging/batch-drain-time.ts scripts/staging/batch-drain-time.test.ts scripts/staging/batch-drain-live-evidence.ts scripts/staging/batch-drain-live-evidence.test.ts scripts/staging/batch-drain-evidence-sources.test.ts scripts/staging/batch-drain-admission-adapter.ts scripts/staging/batch-drain-admission-adapter.test.ts",
     "gen:types": "supabase gen types typescript --local > src/types/database.types.ts",
`;

const S33_LANE1_FILES = [
  'scripts/staging/batch-drain-admission-adapter.ts',
  'scripts/staging/batch-drain-crash-adapter.ts',
  'scripts/staging/batch-drain-crash-control.ts',
  'scripts/staging/batch-drain-harness-lib.ts',
  'scripts/staging/batch-drain-live-evidence.ts',
  'scripts/staging/batch-drain-observation.ts',
  'scripts/staging/batch-drain-strict-json.ts',
  'scripts/staging/batch-drain-time.ts',
  'package.json',
  '.github/workflows/ci.yml',
];

const S33_LANE1_EXACT_MODULES = [
  'scripts/staging/batch-drain-admission-adapter.ts',
  'scripts/staging/batch-drain-crash-adapter.ts',
  'scripts/staging/batch-drain-crash-control.ts',
  'scripts/staging/batch-drain-harness-lib.ts',
  'scripts/staging/batch-drain-live-evidence.ts',
  'scripts/staging/batch-drain-observation.ts',
  'scripts/staging/batch-drain-strict-json.ts',
  'scripts/staging/batch-drain-time.ts',
];

const T3_BODY = `
## Summary
Queue rewrite.

## Staging Soak Evidence
- Tier: T3
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00012-abc
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
      expect(TIER_SPECS.T1.soakHours).toBe(0);
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

    it('returns T0 for the SCRUM-2977 anti-hollow-soak guard set + its report-only ci.yml wiring', () => {
      // The full changed-file set of PR #1623: a pure CI guard module + CLI +
      // tests, its agents.md, and a report-only ci.yml job. No runtime /
      // migration / API / frontend surface → T0.
      expect(
        requiredTierFor([
          'scripts/ci/anti-hollow-soak/guards.ts',
          'scripts/ci/anti-hollow-soak/guards.test.ts',
          'scripts/ci/anti-hollow-soak/agents.md',
          'scripts/ci/check-staging-evidence.ts',
          'scripts/ci/check-staging-evidence.test.ts',
          '.github/workflows/ci.yml',
        ]).tier,
      ).toBe('T0');
    });

    it('returns T0 for the SCRUM-2897 evidence-identity gate + its report-only ci.yml wiring', () => {
      // The full changed-file set of PR #1625: a pure CI identity-check module +
      // tests, its agents.md, and a report-only ci.yml job. No runtime /
      // migration / API / frontend surface → T0.
      expect(
        requiredTierFor([
          'scripts/ci/check-evidence-identity.ts',
          'scripts/ci/check-evidence-identity.test.ts',
          'scripts/ci/agents.md',
          'scripts/ci/check-staging-evidence.ts',
          'scripts/ci/check-staging-evidence.test.ts',
          '.github/workflows/ci.yml',
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

    it('returns T0 for the CI-only Supabase-start helper script', () => {
      // scripts/ci-supabase-start.sh runs ONLY in CI to boot the local Supabase
      // stack for the types/tests/e2e jobs; it never ships to prod runtime.
      expect(requiredTierFor(['scripts/ci-supabase-start.sh']).tier).toBe('T0');
    });

    it('returns T0 for the SCRUM-3026 mint-fresh-event re-trigger helper + its test', () => {
      // scripts/ci/mint-fresh-event.sh only ever mints a tree-identical empty
      // commit / bumps a PR-body field via `gh`; it runs as an operator/agent
      // CLI and never ships to prod runtime.
      expect(requiredTierFor(['scripts/ci/mint-fresh-event.sh']).tier).toBe('T0');
      expect(requiredTierFor(['scripts/ci/mint-fresh-event.test.sh']).tier).toBe('T0');
    });

    it('does not grandfather a mint-fresh-event lookalike outside the exact filename', () => {
      // Fail-closed check: the allowlist regex is anchored to the exact
      // filename, not a scripts/ci/ prefix carve-out.
      expect(
        requiredTierFor(['scripts/ci/mint-fresh-event-v2.sh']).tier,
      ).toBe('T1');
      expect(
        requiredTierFor(['scripts/ci/lib/mint-fresh-event.sh']).tier,
      ).toBe('T0'); // scripts/ci/lib/ is already an allowlisted directory
    });

    // --- G1 (PI-0.5): KPI-3 rehearsal + clean-room .mjs tooling classify T0 ---
    it('returns T0 for the KPI-3 rehearsal tooling bundle', () => {
      expect(
        requiredTierFor([
          'scripts/kpi3/rehearse-explorer-verify.mjs',
          'scripts/kpi3/lib/fetch-block.mjs',
          'scripts/kpi3/README.md',
          'scripts/kpi3/fixtures/anchor-proof.json',
        ]).tier,
      ).toBe('T0');
    });

    it('returns T0 for clean-room .mjs verification tools in their dedicated trees', () => {
      expect(requiredTierFor(['scripts/clean-room/verify-proof.mjs']).tier).toBe('T0');
      expect(requiredTierFor(['scripts/kpi3/verify-anchor-standalone.mjs']).tier).toBe('T0');
    });

    it('G1 gate-integrity: .mjs under scripts/ OUTSIDE the dedicated trees is NOT T0', () => {
      // Review finding (PR #1613): a blanket scripts/**.mjs carve-out would
      // silently T0 future prod-shaped ops scripts. Pin the floor: an .mjs at
      // the scripts/ root or in a non-allowlisted subdir keeps the T1 default.
      expect(requiredTierFor(['scripts/verify-anchor-standalone.mjs']).tier).toBe('T1');
      expect(requiredTierFor(['scripts/prod/apply-migration.mjs']).tier).toBe('T1');
      // An .mjs rename/sibling of the prod-reachable S33 acceptance companion
      // keeps its T2 PATH_RULE (extension-generalized by this PR).
      expect(
        requiredTierFor(['scripts/ci/s33-wave1-github-evidence.mjs']).tier,
      ).toBe('T2');
      // Outside the anchored ^scripts/ prefix nothing changes either.
      expect(requiredTierFor(['services/worker/scripts/ops.mjs']).tier).toBe('T1');
    });

    it('returns T0 for a doc-only bundle spanning docs/, README, HANDOFF, and memory notes', () => {
      // G1 (PI-0.5): doc-only bundles classify T0 — no staging evidence block.
      expect(
        requiredTierFor([
          'docs/operating-model/session-operating-model.md',
          'docs/staging/rc-manifests/rc-2026-07-21-example.json',
          'README.md',
          'HANDOFF.md',
          'memory/feedback_example.md',
          'services/worker/agents.md',
        ]).tier,
      ).toBe('T0');
    });

    // --- G1 HARD AC: the tweak must NOT loosen the real gate. A migration /
    // worker / API / chain / billing path still forces its full tier, whether it
    // rides ALONE or bundled with the new T0 KPI-3 / clean-room files. ---
    it('G1 gate-integrity: migration still forces T3 alongside new T0 tooling', () => {
      // Migration alone.
      expect(requiredTierFor(['supabase/migrations/0360_x.sql']).tier).toBe('T3');
      // Migration bundled with a KPI-3 rehearsal + a clean-room .mjs tool: the
      // migration's T3 PATH_RULE wins; the T0 files do not drag the tier down.
      const bundled = requiredTierFor([
        'scripts/kpi3/rehearse-explorer-verify.mjs',
        'scripts/clean-room/verify-proof.mjs',
        'supabase/migrations/0360_x.sql',
      ]);
      expect(bundled.tier).toBe('T3');
      expect(bundled.reason).toContain('supabase/migrations/0360_x.sql');
    });

    it('G1 gate-integrity: worker/chain/API paths keep their tier alongside new T0 tooling', () => {
      // Chain hot path → T3.
      expect(
        requiredTierFor([
          'scripts/kpi3/rehearse-explorer-verify.mjs',
          'services/worker/src/chain/client.ts',
        ]).tier,
      ).toBe('T3');
      // Public API surface → T2.
      expect(
        requiredTierFor([
          'scripts/clean-room/verify-proof.mjs',
          'services/worker/src/api/v1/anchor.ts',
        ]).tier,
      ).toBe('T2');
      // Generic worker behavior → T2.
      expect(
        requiredTierFor([
          'scripts/kpi3/verify-anchor-standalone.mjs',
          'services/worker/src/index.ts',
        ]).tier,
      ).toBe('T2');
    });

    it('G1 scope guard: a runtime .mjs OUTSIDE scripts/ is NOT swept into T0', () => {
      // The clean-room carve-out is scoped to scripts/**; a .mjs shipped in a
      // deployed package still earns its tier via the SDK/package PATH_RULE.
      expect(requiredTierFor(['sdks/typescript/dist/index.mjs']).tier).toBe('T2');
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

    it('returns T0 for a peripheral integrations lockfile bump', () => {
      expect(
        requiredTierFor(['integrations/zapier/package-lock.json']).tier,
      ).toBe('T0');
    });

    it('returns T0 for a peripheral packages/* manifest + lockfile bump', () => {
      expect(
        requiredTierFor([
          'packages/embed/package.json',
          'packages/embed/package-lock.json',
        ]).tier,
      ).toBe('T0');
    });

    it('returns T0 for a peripheral integrations/* manifest + lockfile bump', () => {
      expect(
        requiredTierFor([
          'integrations/zapier/package.json',
          'integrations/zapier/package-lock.json',
        ]).tier,
      ).toBe('T0');
    });

    it('keeps services/* package.json above T0 (guards runtime deps)', () => {
      expect(
        requiredTierFor(['services/worker/package.json']).tier,
      ).not.toBe('T0');
    });

    it('keeps the root package.json above T0 (guards runtime deps)', () => {
      expect(requiredTierFor(['package.json']).tier).not.toBe('T0');
    });

    // ── PI-0 S2 verifier track / PROOF-08 (SCRUM-2341): zero-prod-runtime
    // reclassification. @arkova/verifier + @arkova/verifier-cli are standalone
    // MIT packages not imported by the worker or frontend; the proof fixtures
    // loader is imported only by tests. All three classify T0. ──
    it('returns T0 for the @arkova/verifier package (standalone lib, no prod runtime)', () => {
      // Exact #1349 changed-file set.
      expect(
        requiredTierFor([
          'packages/verifier/agents.md',
          'packages/verifier/package-lock.json',
          'packages/verifier/package.json',
          'packages/verifier/src/independent-node.test.ts',
          'packages/verifier/src/independent-node.ts',
          'packages/verifier/src/index.ts',
          'packages/verifier/tsconfig.json',
          'packages/verifier/vitest.config.ts',
        ]).tier,
      ).toBe('T0');
    });

    it('returns T0 for the @arkova/verifier-cli package set (#1353, standalone CLI + CI)', () => {
      // Exact #1353 changed-file set (verifier-cli + a re-touch of verifier + ci.yml).
      expect(
        requiredTierFor([
          '.github/workflows/ci.yml',
          'packages/verifier-cli/.gitignore',
          'packages/verifier-cli/LICENSE',
          'packages/verifier-cli/README.md',
          'packages/verifier-cli/agents.md',
          'packages/verifier-cli/eslint.config.js',
          'packages/verifier-cli/fixtures/README.md',
          'packages/verifier-cli/fixtures/generate-fixtures.mjs',
          'packages/verifier-cli/fixtures/published-keys.json',
          'packages/verifier-cli/fixtures/signed-bundle.json',
          'packages/verifier-cli/fixtures/synthetic-vectors.json',
          'packages/verifier-cli/package-lock.json',
          'packages/verifier-cli/package.json',
          'packages/verifier-cli/src/cli.ts',
          'packages/verifier-cli/src/index.ts',
          'packages/verifier-cli/src/lib/independent-endpoint.ts',
          'packages/verifier-cli/src/lib/report.ts',
          'packages/verifier-cli/src/lib/signature.ts',
          'packages/verifier-cli/src/types.ts',
          'packages/verifier-cli/src/vendor/canonical-json.ts',
          'packages/verifier-cli/src/vendor/merkle-verify.ts',
          'packages/verifier-cli/src/vendor/merkle.ts',
          'packages/verifier-cli/src/verify.ts',
          'packages/verifier-cli/test/cli.test.ts',
          'packages/verifier-cli/test/conformance.test.ts',
          'packages/verifier-cli/test/helpers.ts',
          'packages/verifier-cli/test/independent-endpoint.test.ts',
          'packages/verifier-cli/test/signature.test.ts',
          'packages/verifier-cli/test/sync-recompute.test.ts',
          'packages/verifier-cli/tsconfig.json',
          'packages/verifier-cli/vitest.config.ts',
          'packages/verifier/agents.md',
          'packages/verifier/package-lock.json',
          'packages/verifier/package.json',
          'packages/verifier/src/independent-node.test.ts',
          'packages/verifier/src/independent-node.ts',
          'packages/verifier/src/index.ts',
          'packages/verifier/tsconfig.json',
          'packages/verifier/vitest.config.ts',
        ]).tier,
      ).toBe('T0');
    });

    it('returns T0 for the proof test-fixtures set (#1357, test-only loader, no prod importer)', () => {
      // Exact #1357 changed-file set.
      expect(
        requiredTierFor([
          'services/worker/src/proof/agents.md',
          'services/worker/src/proof/fixtures/README.md',
          'services/worker/src/proof/fixtures/index.ts',
          'services/worker/src/proof/fixtures/proof-fixtures.json',
          'services/worker/src/proof/fixtures/proof-fixtures.test.ts',
          'services/worker/src/utils/merkle-verify.test.ts',
        ]).tier,
      ).toBe('T0');
    });

    it('does NOT over-broaden: a real worker-runtime file stays above T0 (control)', () => {
      // The allowlist is scoped to packages/verifier*, packages/verifier-cli,
      // and services/worker/src/proof/fixtures/ only — a genuine worker-runtime
      // file must keep its production tier (no regression).
      expect(
        requiredTierFor(['services/worker/src/api/v1/verify-proof.ts']).tier,
      ).not.toBe('T0');
      // Sibling non-fixtures files under services/worker/src/proof/ stay T2.
      expect(
        requiredTierFor(['services/worker/src/proof/signed-bundle.ts']).tier,
      ).not.toBe('T0');
    });

    it('classifies only the exact CTO-ratified S3.3 offline support files as T0', () => {
      expect(requiredTierFor([
        '.sonarcloud.properties',
        'docs/lane3/s33-batch-acceptance-protocol.md',
        'scripts/ci/check-staging-evidence.test.ts',
        'scripts/ci/check-staging-evidence.ts',
        'services/worker/src/ai/eval/agents.md',
        'services/worker/src/ai/eval/golden-dataset-s33-types.test.ts',
        'services/worker/src/ai/eval/golden-dataset-s33-types.ts',
        'services/worker/src/ai/eval/heldout-leakage.test.ts',
        'services/worker/src/ai/eval/heldout-leakage.ts',
        'services/worker/src/ai/eval/s33-acceptance-ledger.ts',
        'services/worker/src/ai/eval/s33-batch-acceptance.test.ts',
        'services/worker/src/ai/eval/s33-batch-acceptance.ts',
        'services/worker/src/ai/eval/s33-wave1-dual-dag.test.ts',
        'services/worker/src/ai/eval/s33-wave1-dual-dag.ts',
        'services/worker/src/ai/eval/s33-wave1-github-evidence.ts',
        'services/worker/src/ai/eval/s33-wave1-prerequisite-runner.test.ts',
        'services/worker/src/ai/eval/s33-wave1-prerequisite-runner.ts',
        'services/worker/src/ai/eval/s33-wave1-producer-verifier.test.ts',
        'services/worker/src/ai/eval/s33-wave1-producer-verifier.ts',
        'services/worker/src/ai/eval/s33-wave1-producer-parser.ts',
        'services/worker/src/ai/eval/s33-wave1-workflow-reports.test.ts',
        'services/worker/src/ai/eval/s33-wave1-workflow-reports.ts',
      ], { s33RuntimeImporterProvider: () => [] }).tier).toBe('T0');

      expect(requiredTierFor([
        'services/worker/src/ai/eval/s33-eval-runner.ts',
      ], { s33RuntimeImporterProvider: () => [] }).tier).toBe('T2');
    });

    // This test calls the REAL (unmocked) findS33RuntimeImporters(), which
    // does a synchronous BFS over services/worker/src's actual import graph
    // starting at src/index.ts — real readFileSync + regex parse per
    // reachable file, by design (it's asserting the ACTUAL runtime graph,
    // not a stubbed one). Locally this takes ~1s cold / ~0.4s warm, but it
    // timed out in CI (observed on PR #1727, scripts/ci/check-staging-
    // evidence.test.ts:608) against vitest's 5000ms default test timeout.
    // Root cause is CI resource contention, not a logic bug or infinite
    // loop: this "test" job also runs the full Supabase Docker Compose
    // stack (Postgres/PostgREST/GoTrue/Realtime/Kong) concurrently on the
    // same 2-vCPU ubuntu-22.04 runner, and vitest's default thread pool
    // schedules many other test files in parallel — the same class of
    // slow-runner headroom already called out for the E2E worker health
    // check above ("slow runners can push past the old 60s ceiling").
    // Bumping to a generous 20s (this test file's other real-graph test at
    // line ~698 gets the same treatment) rather than mocking the graph walk
    // here, because these two tests are specifically the ones asserting the
    // REAL graph is empty/correct — mocking would remove the thing under
    // test.
    it('classifies the real full #1545 candidate as T0 using the actual runtime graph', () => {
      const candidate = [
        '.gitleaks.toml',
        '.github/s33-wave1-acceptance-authorities.json',
        '.github/workflows/s33-wave1-acceptance.yml',
        '.github/workflows/s33-wave1-prerequisites.yml',
        '.sonarcloud.properties',
        'docs/lane3/agents.md',
        'docs/lane3/s33-batch-acceptance-protocol.md',
        'scripts/ci/agents.md',
        'scripts/ci/check-staging-evidence.test.ts',
        'scripts/ci/check-staging-evidence.ts',
        'scripts/ci/s33-wave1-github-evidence.test.ts',
        'scripts/ci/s33-wave1-github-evidence.ts',
        'services/worker/src/ai/eval/agents.md',
        'services/worker/src/ai/eval/golden-dataset-s33-types.test.ts',
        'services/worker/src/ai/eval/golden-dataset-s33-types.ts',
        'services/worker/src/ai/eval/heldout-leakage.test.ts',
        'services/worker/src/ai/eval/heldout-leakage.ts',
        'services/worker/src/ai/eval/s33-acceptance-ledger.ts',
        'services/worker/src/ai/eval/s33-batch-acceptance.test.ts',
        'services/worker/src/ai/eval/s33-batch-acceptance.ts',
        'services/worker/src/ai/eval/s33-wave1-dual-dag.test.ts',
        'services/worker/src/ai/eval/s33-wave1-dual-dag.ts',
        'services/worker/src/ai/eval/s33-wave1-github-evidence.ts',
        'services/worker/src/ai/eval/s33-wave1-prerequisite-runner.test.ts',
        'services/worker/src/ai/eval/s33-wave1-prerequisite-runner.ts',
        'services/worker/src/ai/eval/s33-wave1-producer-verifier.test.ts',
        'services/worker/src/ai/eval/s33-wave1-producer-verifier.ts',
        'services/worker/src/ai/eval/s33-wave1-producer-parser.ts',
        'services/worker/src/ai/eval/s33-wave1-workflow-reports.test.ts',
        'services/worker/src/ai/eval/s33-wave1-workflow-reports.ts',
      ];
      expect(candidate).toHaveLength(30);
      const realRuntimeImporters = findS33RuntimeImporters();
      expect(realRuntimeImporters).toEqual([]);
      expect(requiredTierFor(candidate, {
        s33RuntimeImporterProvider: () => realRuntimeImporters,
      }).tier).toBe('T0');
    }, 20_000);

    it('classifies the exact Wave-2 trusted-main acceptance boundary as offline T0', () => {
      const candidate = [
        '.mergify.yml',
        '.github/workflows/s33-wave2-batch-acceptance.yml',
        'scripts/ci/agents.md',
        'scripts/ci/check-staging-evidence.test.ts',
        'scripts/ci/check-staging-evidence.ts',
        'scripts/ci/s33-wave2-batch-acceptance.test.ts',
        'scripts/ci/s33-wave2-batch-acceptance.ts',
        'scripts/ci/s33-wave2-github-transport.test.ts',
        'scripts/ci/s33-wave2-github-transport.ts',
        'scripts/ci/s33-wave2-workflow-contract.test.ts',
        'services/worker/src/ai/eval/agents.md',
        'services/worker/src/ai/eval/heldout-leakage.ts',
        'services/worker/src/ai/eval/s33-batch-acceptance.ts',
        'services/worker/src/ai/eval/s33-wave1-producer-parser.ts',
        'services/worker/src/ai/eval/s33-wave2-batch-acceptance.test.ts',
        'services/worker/src/ai/eval/s33-wave2-batch-acceptance.ts',
        'services/worker/src/ai/eval/s33-wave2-acceptance-envelope.test.ts',
        'services/worker/src/ai/eval/s33-wave2-acceptance-envelope.ts',
        'services/worker/src/ai/eval/s33-wave2-corpus-registry.test.ts',
        'services/worker/src/ai/eval/s33-wave2-corpus-registry.ts',
      ];
      expect(requiredTierFor(candidate, { s33RuntimeImporterProvider: () => [] }).tier).toBe('T0');
    });

    it('classifies only the exact Wave-3 detached-signing tooling as offline T0', () => {
      const candidate = [
        'docs/lane3/s33-wave3-v71-offline-gates.json',
        'scripts/ci/s33-wave3-detached-signing-v2.test.ts',
        'scripts/ci/s33-wave3-detached-signing-v2.ts',
        'services/worker/src/ai/eval/s33-wave3-detached-signing-v2.test.ts',
        'services/worker/src/ai/eval/s33-wave3-detached-signing-v2.ts',
      ];
      expect(requiredTierFor(candidate, { s33RuntimeImporterProvider: () => [] }).tier).toBe('T0');
      expect(requiredTierFor(candidate, {
        s33RuntimeImporterProvider: () => ['services/worker/src/index.ts'],
      }).tier).toBe('T2');
      expect(requiredTierFor([
        'services/worker/src/ai/eval/s33-wave3-detached-signing-v3.ts',
      ], { s33RuntimeImporterProvider: () => [] }).tier).toBe('T2');
    });

    // Second real (unmocked) findS33RuntimeImporters() call in this file —
    // see the timeout-budget comment on the "#1545 candidate" test above.
    it('classifies only the exact inert Wave-3 deterministic evaluator as offline T0', () => {
      const candidate = [
        'docs/lane3/s33-wave3-v71-offline-gates.json',
        'services/worker/src/ai/eval/s33-wave3-deterministic-eval-gates.test.ts',
        'services/worker/src/ai/eval/s33-wave3-deterministic-eval-gates.ts',
      ];
      const realRuntimeImporters = findS33RuntimeImporters();
      expect(realRuntimeImporters).toEqual([]);
      expect(requiredTierFor(candidate, {
        s33RuntimeImporterProvider: () => realRuntimeImporters,
      }).tier).toBe('T0');
      expect(requiredTierFor(candidate, {
        s33RuntimeImporterProvider: () => ['services/worker/src/index.ts'],
      }).tier).toBe('T2');
      expect(requiredTierFor([
        'services/worker/src/ai/eval/s33-wave3-deterministic-eval-gates-v2.ts',
      ], { s33RuntimeImporterProvider: () => [] }).tier).toBe('T2');
    }, 20_000);

    it('allows only the exact inert Wave-2 corpus filename shape and fails closed on runtime reachability', () => {
      const corpus = 'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-heldout.ts';
      expect(requiredTierFor([corpus], { s33RuntimeImporterProvider: () => [] }).tier).toBe('T0');
      expect(requiredTierFor([corpus], {
        s33RuntimeImporterProvider: () => ['services/worker/src/index.ts'],
      }).tier).toBe('T2');
      expect(requiredTierFor([
        'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15.ts',
      ], { s33RuntimeImporterProvider: () => [] }).tier).toBe('T2');
    });

    it('keeps the dual-DAG implementation T0 only while the runtime graph is readable and unreachable', () => {
      const dualDag = ['services/worker/src/ai/eval/s33-wave1-dual-dag.ts'];

      expect(requiredTierFor(dualDag, {
        s33RuntimeImporterProvider: () => [],
      }).tier).toBe('T0');
      expect(requiredTierFor(dualDag, {
        s33RuntimeImporterProvider: () => ['services/worker/src/index.ts'],
      }).tier).toBe('T2');
      expect(requiredTierFor(dualDag, {
        s33RuntimeImporterProvider: () => {
          throw new Error('runtime graph unreadable');
        },
      }).tier).toBe('T2');
    });

    it('classifies the exact Wave-1 producer corpus files as T0 only while unimported by runtime', () => {
      expect(requiredTierFor([
        'docs/lane4/s33-corpus-datasheet.md',
        'docs/lane4/s33-wave1-batch-manifest.json',
        'docs/lane4/s33-wave1-entry-datasheet.json',
        'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
        'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
        'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
      ], { s33RuntimeImporterProvider: () => [] }).tier).toBe('T0');
    });

    it('fails the S3.3 T0 carve-out closed when any production source imports it', () => {
      expect(requiredTierFor([
        'services/worker/src/ai/eval/s33-batch-acceptance.ts',
      ], {
        s33RuntimeImporterProvider: () => ['services/worker/src/routes/cron.ts'],
      }).tier).toBe('T2');
    });
  });

  describe('findS33RuntimeImporters', () => {
    const withRuntimeFixture = (
      files: Readonly<Record<string, string>>,
      assertion: (root: string) => void,
    ): void => {
      const root = mkdtempSync(join(tmpdir(), 's33-import-guard-'));
      try {
        for (const [path, content] of Object.entries(files)) {
          const absolute = join(root, path);
          mkdirSync(join(absolute, '..'), { recursive: true });
          writeFileSync(absolute, content);
        }
        assertion(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    it('walks the runtime-entrypoint module graph and ignores unreachable/test imports', () => {
      withRuntimeFixture({
        'services/worker/src/index.ts': "import './routes/cron.js';\n",
        'services/worker/src/routes/cron.ts': "export * from '../ai/eval/s33-batch-acceptance.js';\n",
        'services/worker/src/routes/unreachable.ts': "import '../ai/eval/s33-batch-acceptance.js';\n",
        'services/worker/src/routes/cron.test.ts': "import '../ai/eval/s33-batch-acceptance.js';\n",
        'services/worker/src/ai/eval/s33-batch-acceptance.ts': 'export const offline = true;\n',
      }, (root) => {
        expect(findS33RuntimeImporters(root)).toEqual(['services/worker/src/routes/cron.ts']);
      });
    });

    it.each([
      ['services/worker/src/ai/eval/heldout-leakage.ts', './ai/eval/heldout-leakage.js'],
      ['services/worker/src/ai/eval/s33-wave1-github-evidence.ts', './ai/eval/s33-wave1-github-evidence.js'],
      ['services/worker/src/ai/eval/s33-wave1-prerequisite-runner.ts', './ai/eval/s33-wave1-prerequisite-runner.js'],
      ['services/worker/src/ai/eval/s33-wave1-producer-parser.ts', './ai/eval/s33-wave1-producer-parser.js'],
      ['scripts/ci/s33-wave1-github-evidence.ts', '../../../scripts/ci/s33-wave1-github-evidence.js'],
      ['.github/s33-wave1-acceptance-authorities.json', '../../../.github/s33-wave1-acceptance-authorities.json'],
    ])('forces T2 when runtime imports newly carved offline file %s', (offlinePath, specifier) => {
      withRuntimeFixture({
        'services/worker/src/index.ts': `import ${JSON.stringify(specifier)};\n`,
        [offlinePath]: offlinePath.endsWith('.json') ? '{}\n' : 'export const offline = true;\n',
      }, (root) => {
        expect(findS33RuntimeImporters(root)).toEqual(['services/worker/src/index.ts']);
        expect(requiredTierFor([offlinePath], {
          s33RuntimeImporterProvider: () => findS33RuntimeImporters(root),
        }).tier).toBe('T2');
      });
    });

    it('recognises literal dynamic import, require, and createRequire edges', () => {
      for (const body of [
        "void import('./ai/eval/s33-batch-acceptance.js');\n",
        "require('./ai/eval/s33-batch-acceptance.js');\n",
        "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nreq('./ai/eval/s33-batch-acceptance.js');\n",
        "const { createRequire: makeRequire } = require('node:module');\nconst req = makeRequire(import.meta.url);\nreq('./ai/eval/s33-batch-acceptance.js');\n",
        "const moduleApi = require('node:module');\nconst req = moduleApi.createRequire(import.meta.url);\nreq('./ai/eval/s33-batch-acceptance.js');\n",
      ]) {
        withRuntimeFixture({
          'services/worker/src/index.ts': body,
          'services/worker/src/ai/eval/s33-batch-acceptance.ts': 'export const offline = true;\n',
        }, (root) => {
          expect(findS33RuntimeImporters(root)).toEqual(['services/worker/src/index.ts']);
        });
      }
    });

    it.each([
      ["const part = 's33-batch-acceptance.js'; void import('./ai/eval/' + part);\n", 'dynamic import'],
      ["const part = 's33-batch-acceptance.js'; require('./ai/eval/' + part);\n", 'require/createRequire'],
      [
        "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconst part = 's33-batch-acceptance.js';\nreq('./ai/eval/' + part);\n",
        'require/createRequire',
      ],
      [
        "const { createRequire } = require('node:module');\nconst req = createRequire(import.meta.url);\nconst part = 's33-batch-acceptance.js';\nreq('./ai/eval/' + part);\n",
        'require/createRequire',
      ],
    ])('fails closed on a reachable constructed module load', (body, loadKind) => {
      withRuntimeFixture({
        'services/worker/src/index.ts': body,
      }, (root) => {
        const importers = findS33RuntimeImporters(root);
        expect(importers).toEqual([
          `<unsafe services/worker/src/index.ts: ${loadKind}>`,
        ]);
        for (const companionPath of [
          'scripts/ci/s33-wave1-github-evidence.ts',
          '.github/s33-wave1-acceptance-authorities.json',
        ]) {
          expect(requiredTierFor([companionPath], {
            s33RuntimeImporterProvider: () => importers,
          }).tier).toBe('T2');
        }
      });
    });

    it('fails closed to T2 when a reachable runtime module cannot be resolved', () => {
      withRuntimeFixture({
        'services/worker/src/index.ts': "import './routes/missing-runtime.js';\n",
      }, (root) => {
        const importers = findS33RuntimeImporters(root);
        expect(importers).toHaveLength(1);
        expect(importers[0]).toMatch(/^<unreadable services\/worker runtime module graph:/u);
        for (const offlinePath of [
          'services/worker/src/ai/eval/s33-wave1-prerequisite-runner.ts',
          'scripts/ci/s33-wave1-github-evidence.ts',
          '.github/s33-wave1-acceptance-authorities.json',
        ]) {
          expect(requiredTierFor([offlinePath], {
            s33RuntimeImporterProvider: () => importers,
          }).tier).toBe('T2');
        }
      });
    });
  });

  // ── deploy-worker.yml `uses:`-only Dependabot bump exemption ──
  // A Dependabot GitHub-Actions bump that only edits a `uses: actions/<x>@vN`
  // line in deploy-worker.yml touches zero prod runtime config (min-instances,
  // env, secrets, image). It should classify CI-tooling (T0), not T2. A real
  // runtime-config edit, or any mixed diff, must stay T2 (fail-closed).
  describe('isDeployWorkerUsesOnlyBump', () => {
    it('returns true for a diff that only bumps a uses: action version', () => {
      expect(isDeployWorkerUsesOnlyBump(USES_ONLY_DEPLOY_WORKER_DIFF)).toBe(true);
    });

    it('returns true for an additive full-history checkout fix', () => {
      expect(isDeployWorkerUsesOnlyBump(fullHistoryDeployWorkerDiff)).toBe(true);
    });

    it('returns false when checkout is weakened back to shallow history', () => {
      expect(isDeployWorkerUsesOnlyBump(shallowHistoryDeployWorkerDiff)).toBe(false);
    });

    it('returns false when checkout-only inputs are added to another action', () => {
      expect(isDeployWorkerUsesOnlyBump(nonCheckoutFullHistoryDiff)).toBe(false);
    });

    it('returns false when checkout credential isolation is weakened', () => {
      expect(isDeployWorkerUsesOnlyBump(credentialPersistenceWeakeningDiff)).toBe(false);
    });

    it('returns false for a runtime-config (--min-instances) change', () => {
      expect(isDeployWorkerUsesOnlyBump(RUNTIME_CONFIG_DEPLOY_WORKER_DIFF)).toBe(false);
    });

    it('returns false for a mixed uses-bump + env-var change (fail-closed)', () => {
      expect(isDeployWorkerUsesOnlyBump(MIXED_DEPLOY_WORKER_DIFF)).toBe(false);
    });

    it('returns false for an empty / unobtainable diff (fail-closed)', () => {
      expect(isDeployWorkerUsesOnlyBump('')).toBe(false);
      expect(isDeployWorkerUsesOnlyBump(null)).toBe(false);
    });
  });

  describe('requiredTierFor with deploy-worker.yml diff content', () => {
    const file = '.github/workflows/deploy-worker.yml';
    const diffProvider = (diff: string | null) => (f: string) => (f === file ? diff : null);

    it('classifies a uses:-only deploy-worker.yml bump as T0 (CI tooling)', () => {
      expect(
        requiredTierFor([file], { diffProvider: diffProvider(USES_ONLY_DEPLOY_WORKER_DIFF) }).tier,
      ).toBe('T0');
    });

    it('classifies an additive fetch-depth: 0 checkout fix as T0 (CI tooling)', () => {
      expect(
        requiredTierFor([file], { diffProvider: diffProvider(fullHistoryDeployWorkerDiff) }).tier,
      ).toBe('T0');
    });

    it('keeps a --min-instances deploy-worker.yml change at T2', () => {
      expect(
        requiredTierFor([file], { diffProvider: diffProvider(RUNTIME_CONFIG_DEPLOY_WORKER_DIFF) }).tier,
      ).toBe('T2');
    });

    it('keeps a mixed (uses bump + env change) deploy-worker.yml diff at T2 (fail-closed)', () => {
      expect(
        requiredTierFor([file], { diffProvider: diffProvider(MIXED_DEPLOY_WORKER_DIFF) }).tier,
      ).toBe('T2');
    });

    it('keeps deploy-worker.yml at T2 when no diff provider is supplied (fail-closed)', () => {
      expect(requiredTierFor([file]).tier).toBe('T2');
    });

    it('keeps deploy-worker.yml at T2 when the diff cannot be obtained (fail-closed)', () => {
      expect(
        requiredTierFor([file], { diffProvider: diffProvider(null) }).tier,
      ).toBe('T2');
    });

    it('does not exempt other workflow runtime files via the deploy-worker carve-out', () => {
      // cloudbuild.yaml is a separate T2 rule; the uses:-only carve-out is scoped
      // to deploy-worker.yml only.
      expect(
        requiredTierFor(['services/worker/cloudbuild.yaml'], {
          diffProvider: () => USES_ONLY_DEPLOY_WORKER_DIFF,
        }).tier,
      ).toBe('T2');
    });
  });

  describe('S3.3 Lane 1 offline-evidence T0 carve-out', () => {
    const cleanImportScan = { complete: true, importers: [] as string[] };
    const diffProvider = (file: string) => (
      file === 'package.json' ? S33_LANE1_ROOT_LINT_DIFF : null
    );

    it('accepts only the exact root lint-script addition', () => {
      expect(isS33Lane1RootLintScriptOnly(S33_LANE1_ROOT_LINT_DIFF)).toBe(true);
      expect(isS33Lane1RootLintScriptOnly(`${S33_LANE1_ROOT_LINT_DIFF}+    "start": "node server.js",\n`)).toBe(false);
      expect(isS33Lane1RootLintScriptOnly(null)).toBe(false);
    });

    it('pins the stricter import-scan carve-out to the authoritative eight modules', () => {
      expect([...S33_LANE1_OFFLINE_EVIDENCE_FILES].sort()).toEqual(S33_LANE1_EXACT_MODULES);
    });

    it('classifies the exact offline file set as T0 after a complete clean runtime-import scan', () => {
      expect(requiredTierFor(S33_LANE1_FILES, {
        diffProvider,
        s33Lane1ImportScan: cleanImportScan,
      })).toEqual({ tier: 'T0', reason: 'docs/tests/CI/tooling-only' });
    });

    it('fails closed to T2 when the runtime-import scan is absent or incomplete', () => {
      expect(requiredTierFor(S33_LANE1_FILES, { diffProvider }).tier).toBe('T2');
      expect(requiredTierFor(S33_LANE1_FILES, {
        diffProvider,
        s33Lane1ImportScan: { complete: false, importers: [] },
      }).tier).toBe('T2');
    });

    it('fails closed to T2 when any production runtime imports staging tooling', () => {
      const importers = findS33Lane1RuntimeImporters([
        {
          path: 'services/worker/src/jobs/runtime-consumer.ts',
          content: "import { verify } from '../../../../scripts/staging/batch-drain-live-evidence.js';\n",
        },
        {
          path: 'src/lib/runtime-consumer.ts',
          content: "export * from '../../scripts/staging';\n",
        },
        {
          path: 'packages/embed/src/runtime-consumer.ts',
          content: "const verifier = await import('../../../scripts/staging');\n",
        },
        {
          path: 'services/worker/src/jobs/runtime-consumer.test.ts',
          content: "import '../../../../scripts/staging/batch-drain-live-evidence.js';\n",
        },
      ]);
      expect(importers).toEqual([
        'packages/embed/src/runtime-consumer.ts',
        'services/worker/src/jobs/runtime-consumer.ts',
        'src/lib/runtime-consumer.ts',
      ]);
      expect(requiredTierFor(S33_LANE1_FILES, {
        diffProvider,
        s33Lane1ImportScan: { complete: true, importers },
      }).tier).toBe('T2');
    });

    it('does not exempt a mixed root-manifest change', () => {
      const mixedDiff = `${S33_LANE1_ROOT_LINT_DIFF}+    "start": "node server.js",\n`;
      expect(requiredTierFor(S33_LANE1_FILES, {
        diffProvider: (file) => (file === 'package.json' ? mixedDiff : null),
        s33Lane1ImportScan: cleanImportScan,
      }).tier).toBe('T1');
    });

    it('passes the evidence gate with no soak block only for the exact clean T0 case', () => {
      const r = check({
        body: '## Staging Soak Evidence\n- Tier: T0\n',
        files: S33_LANE1_FILES,
        diffProvider,
        s33Lane1ImportScan: cleanImportScan,
      });
      expect(r.ok).toBe(true);
      expect(r.notes.join(' ')).toMatch(/T0 CI-only/i);
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

    it('finds tier with plain Tier: line', () => {
      expect(extractDeclaredTier('Tier: T2\n')).toBe('T2');
    });

    it('finds tier wrapped in markdown bold (**Tier:** T2)', () => {
      expect(extractDeclaredTier('**Tier:** T2\n')).toBe('T2');
    });

    it('finds tier with list marker + markdown bold (- **Tier:** T2)', () => {
      expect(extractDeclaredTier('- **Tier:** T2\n')).toBe('T2');
    });

    it('finds tier with list marker + underscore emphasis (* _Tier_: T3)', () => {
      expect(extractDeclaredTier('* _Tier_: T3\n')).toBe('T3');
    });

    it('returns null for a bold-decorated line with no tier declared', () => {
      expect(extractDeclaredTier('- **Severity:** high\n')).toBeNull();
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
      expect(missingFields('', 'T1')).toHaveLength(TIER_SPECS.T1.requiredFields.length);
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
        'T1 exact-head evidence with optional soak timestamps',
        completeT1Body('2026-05-09 14:00 UTC', '2026-05-09 16:00 UTC'),
        t1Files,
      ],
      [
        'T1 exact-head evidence with no soak window',
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
          'scripts/ci/mint-fresh-event.sh',
          'scripts/ci/mint-fresh-event.test.sh',
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

    // SonarCloud analyzer config is the same class as the eslint config above:
    // read only by the static analyzer, never imported, never bundled, never
    // deployed. A soak cannot exercise it because it has no runtime surface.
    it('passes for SonarCloud analyzer config', () => {
      expect(
        isStagingToolingOnly([
          '.sonarcloud.properties',
          'sonar-project.properties',
        ]).pass,
      ).toBe(true);
    });

    it('rejects sonar-config lookalike filenames', () => {
      expect(isStagingToolingOnly(['src/lib/sonar-project.properties']).pass).toBe(false);
      expect(isStagingToolingOnly(['services/worker/.sonarcloud.properties']).pass).toBe(false);
      expect(isStagingToolingOnly(['sonar-project.properties.ts']).pass).toBe(false);
    });

    // Same class as check-staging-gcloud-policy / check-handoff-claims /
    // check-ledger-numeric-integrity above: a CI-only gate script that reads a
    // remote API and never ships to prod runtime.
    it('passes for the SonarCloud quality-gate CI script', () => {
      expect(
        isStagingToolingOnly([
          'scripts/ci/check-sonar-quality-gate.ts',
          'scripts/ci/check-sonar-quality-gate.test.ts',
        ]).pass,
      ).toBe(true);
    });

    // The sonar carve-outs must never rescue a PR that also touches runtime.
    it('does not let sonar config downgrade a worker or migration PR', () => {
      expect(requiredTierFor(['.sonarcloud.properties', 'services/worker/src/chain/client.ts']).tier).toBe('T3');
      expect(requiredTierFor(['.sonarcloud.properties', 'supabase/migrations/0999_x.sql']).tier).toBe('T3');
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

    it('passes for integrations/* lockfiles (Dependabot peripheral bumps)', () => {
      expect(
        isStagingToolingOnly([
          'integrations/zapier/package-lock.json',
        ]).pass,
      ).toBe(true);
    });

    it('passes for peripheral packages/* and integrations/* manifest bumps', () => {
      expect(
        isStagingToolingOnly([
          'packages/embed/package.json',
          'packages/embed/package-lock.json',
        ]).pass,
      ).toBe(true);
      expect(
        isStagingToolingOnly([
          'integrations/zapier/package.json',
          'integrations/zapier/package-lock.json',
        ]).pass,
      ).toBe(true);
    });

    it('fails for root package.json (guards runtime deps)', () => {
      expect(
        isStagingToolingOnly(['package.json']).pass,
      ).toBe(false);
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

    it('preserves the under-declared tier error when the evidence section is also missing', () => {
      const r = check({
        body: '## Summary\nTier: T0\nNo staging evidence block.',
        files: ['services/worker/src/api/v1/example.ts'],
      });

      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below required tier T2/i);
      expect(r.errors.join(' ')).toMatch(/missing a .*Staging Soak Evidence.* section/i);
    });

    it('passes a complete T3 PR', () => {
      const r = check({
        body: T3_BODY,
        files: ['services/worker/src/jobs/batch-anchor.ts'],
      });
      expect(r.ok).toBe(true);
    });

    it('passes a Dependabot uses:-only deploy-worker.yml bump as T0 (no evidence needed)', () => {
      const r = check({
        body: '## Summary\nBump actions/checkout v6 → v7 (Dependabot).',
        files: ['.github/workflows/deploy-worker.yml'],
        diffProvider: () => USES_ONLY_DEPLOY_WORKER_DIFF,
      });
      expect(r.ok).toBe(true);
      expect(r.notes.join(' ')).toMatch(/T0/i);
    });

    it('still fails a real deploy-worker.yml runtime-config change without T2 evidence', () => {
      const r = check({
        body: '## Summary\nBump --min-instances 1 → 2.',
        files: ['.github/workflows/deploy-worker.yml'],
        diffProvider: () => RUNTIME_CONFIG_DEPLOY_WORKER_DIFF,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/tier declaration|T2/i);
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

    describe('deferred_consolidated_soak mode (CTO ruling 2026-07-28, SCRUM-2980)', () => {
      const headSha = '2222222222222222222222222222222222222222';
      const baseSha = 'ae2209fd771ff088d8f3ef12070f4028cbd421a7';
      const rcPath = 'docs/staging/rc-manifests/rc-2026-08-launch-72h.json';
      const rcBody = `## Staging Soak Evidence
- Tier: T3
- RC manifest path: ${rcPath}
`;

      // Deliberately minimal: no environment/soak/migration_plan blocks at
      // all — proving deferred mode does not require them (that's the point;
      // there is no real evidence yet).
      const deferredManifest = (overrides: Record<string, unknown> = {}) => ({
        schema_version: 1,
        rc_id: 'RC-2026-08-launch-72h',
        created_at: '2026-07-28T14:57:46Z',
        created_by: 'RM agent',
        release_owner: 'Carson',
        approval_status: 'pending',
        approval_actor: '',
        approval_time: '',
        soak_mode: 'deferred_consolidated_soak',
        train_launch_sha: baseSha,
        target_main_sha: baseSha,
        allowed_base_shas: [baseSha],
        covered_main_shas: [baseSha],
        included_prs: [
          {
            number: 1615,
            head_sha: headSha,
            base_sha: baseSha,
            risk_tier: 'T3',
            owner: 'L1',
            ci_summary: 'required checks green',
            rollback_note: 'revert PR and re-apply prior migration state',
            migration_files: ['supabase/migrations/0359_materializer.sql'],
          },
        ],
        ...overrides,
      });

      const runDeferred = (
        rc: unknown,
        opts: { body?: string; files?: string[]; deployWorkerPaused?: boolean } = {},
      ) => check({
        body: opts.body ?? rcBody,
        files: opts.files ?? ['supabase/migrations/0359_materializer.sql'],
        headSha,
        baseSha,
        deployWorkerPaused: opts.deployWorkerPaused,
        rcManifestLoader: (path) => {
          expect(path).toBe(rcPath);
          return JSON.stringify(rc);
        },
      });

      it('passes a manifest-listed PR when the deploy gate is positively confirmed engaged', () => {
        const r = runDeferred(deferredManifest(), { deployWorkerPaused: true });
        expect(r.ok).toBe(true);
        // Must never render as "evidence present" — the note has to say
        // DEFERRED / NOT satisfied in plain language.
        const notes = r.notes.join(' ');
        expect(notes).toMatch(/DEFERRED/);
        expect(notes).toMatch(/NOT satisfied/i);
      });

      it('fails closed when the deploy gate is NOT confirmed engaged (undefined)', () => {
        const r = runDeferred(deferredManifest(), { deployWorkerPaused: undefined });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/DEPLOY_WORKER_PAUSED/);
      });

      it('fails closed when the deploy gate is explicitly false', () => {
        const r = runDeferred(deferredManifest(), { deployWorkerPaused: false });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/DEPLOY_WORKER_PAUSED/);
      });

      it('fails closed for a PR NOT listed in included_prs[], even with the gate paused', () => {
        const r = runDeferred(deferredManifest({
          included_prs: [{
            number: 9999,
            head_sha: '9999999999999999999999999999999999999999',
            base_sha: baseSha,
            risk_tier: 'T3',
            owner: 'other',
            ci_summary: 'green',
            rollback_note: 'revert',
            migration_files: ['supabase/migrations/0359_materializer.sql'],
          }],
        }), { deployWorkerPaused: true });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/current PR head/i);
      });

      it('rejects approval_status="approved" while soak_mode is deferred — that combination is a contradiction', () => {
        const r = runDeferred(deferredManifest({ approval_status: 'approved' }), { deployWorkerPaused: true });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/pending/i);
      });

      it('rejects an unrecognized soak_mode value rather than silently falling through', () => {
        const r = runDeferred(deferredManifest({ soak_mode: 'skip_everything' }), { deployWorkerPaused: true });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/not a recognized value/i);
      });

      it('does not require environment/soak/migration_plan blocks (the whole point of deferred mode)', () => {
        // deferredManifest() already omits all three; this asserts the
        // *reason* it passes is not "they happened to be present."
        const r = runDeferred(deferredManifest(), { deployWorkerPaused: true });
        expect(r.ok).toBe(true);
      });

      it('a manifest with soak_mode absent uses the EXACT existing (non-deferred) behavior — still fails on a non-"approved" approval_status', () => {
        // Sanity check that omitting soak_mode entirely reverts to today's
        // pre-existing rule (approval_status must be exactly "approved"),
        // proving the new mode does not weaken the default path. Uses
        // "rejected" rather than "pending" as the bad value here because
        // "pending" independently trips the PRE-EXISTING (unrelated to this
        // change) isFilledValue() incomplete-placeholder rejection on this
        // same field — asserted separately below — which would make this
        // particular assertion ambiguous about which code path produced it.
        const r = runDeferred(deferredManifest({ soak_mode: undefined, approval_status: 'rejected' }), { deployWorkerPaused: true });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/approval_status must be approved/i);
      });

      it('a manifest with soak_mode absent and approval_status="pending" fails via the PRE-EXISTING placeholder rule (unchanged by this PR)', () => {
        // This is the exact behavior that motivated deferred mode's own
        // approval_status check to bypass requireRcString() — the normal
        // path's requireRcString() already rejects the bare word "pending"
        // as an incomplete-placeholder value before it ever reaches the
        // "!== approved" comparison. That is 100% pre-existing behavior
        // (see requireRcString/isFilledValue/INCOMPLETE_VALUE_PATTERNS,
        // none of which this PR touches) — this test pins it so a future
        // change to either code path can't silently alter it.
        const r = runDeferred(deferredManifest({ soak_mode: undefined }), { deployWorkerPaused: true });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/approval_status.*must be a real value/i);
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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

    it('passes a complete T1 PR without T2/T3 changed-behavior/load fields', () => {
      const body = `## Staging Soak Evidence
- Tier: T1
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Staging tag URL or N/A explanation: not applicable - docs-only worker image was not built
- Health/smoke result: current-head smoke green
- Soak start: 2026-05-09 14:00 UTC
- Soak end: 2026-05-09 16:00 UTC
- CI/E2E green: green
- Rollback plan: revert PR
- Risk rationale: frontend copy-only change, no restricted surfaces
- Human approver: Carson
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
      // No baseDriftFiles override + unresolvable fake SHAs ⇒ changedFilesBetween
      // returns null ⇒ fail closed (cannot classify base drift → re-soak).
      const r = check({
        body,
        files: ['services/worker/src/api/v1/docusign.ts'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: '9999991234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Could not inspect changed files|Base SHA/i);
    });

    it('preserves completed T2 evidence when base drift is T0 CI-only and approved', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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

    it('fails completed T2 evidence when same-surface T0 base drift lacks an approved impact note', () => {
      // Base drift touches the PR's OWN file (`agents.md`), so it intersects the
      // soak surface. The drift set is T0-only (agents.md), so the strictly-narrower
      // attestation fallback applies — but with no `Base drift impact:` note the
      // fallback is unmet and the gate must fail.
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
        files: ['services/worker/src/api/v1/docusign.ts', 'services/worker/src/api/agents.md'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: '9999991234567890abcdef1234567890abcdef12',
        baseDriftFiles: ['services/worker/src/api/agents.md'],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Base drift impact|Base SHA .* differs/i);
    });

    it('fails completed T2 evidence when same-surface base drift approval is a placeholder', () => {
      // Same-surface T0 drift (PR's own agents.md), attestation present but the
      // approver is a placeholder → fallback unmet → fail.
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: 1234567890abcdef1234567890abcdef12345678
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
- Base SHA: abcdef1234567890abcdef1234567890abcdef12
- Base drift impact: T0 CI-only drift in services/worker/src/api/agents.md; no runtime/schema/migration/staging/soak/deploy impact. Approved by: TBD.
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
        files: ['services/worker/src/api/v1/docusign.ts', 'services/worker/src/api/agents.md'],
        headSha: '1234567890abcdef1234567890abcdef12345678',
        baseSha: '9999991234567890abcdef1234567890abcdef12',
        baseDriftFiles: ['services/worker/src/api/agents.md'],
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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

    // ── Path-aware base-drift gate (ci/path-aware-drift-gate) ──
    // Replaces the SHA-exact / T0-only base-drift wall with a surface-intersection
    // test: intervening main movement invalidates a completed soak ONLY when it
    // touches THIS PR's soak surface (its own changed files ∪ the shared
    // prod-runtime surface). Disjoint drift preserves evidence with no attestation.
    describe('path-aware base drift (surface intersection)', () => {
      const HEAD = '1234567890abcdef1234567890abcdef12345678';
      const EVIDENCE_BASE = 'abcdef1234567890abcdef1234567890abcdef12';
      const CURRENT_BASE = '9999991234567890abcdef1234567890abcdef12';

      // Merge-grade T2 evidence whose recorded Base SHA is EVIDENCE_BASE. The
      // current base (CURRENT_BASE, passed to check()) differs, so the drift path
      // is exercised. No `Base drift impact:` note — disjoint drift must not need
      // one; same-surface drift must fail even in its absence.
      const t2Body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: ${HEAD}
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
- Base SHA: ${EVIDENCE_BASE}
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

      const driftCheck = (files: string[], baseDriftFiles: string[]) =>
        check({ body: t2Body, files, headSha: HEAD, baseSha: CURRENT_BASE, baseDriftFiles });

      it('SHARED_PROD_RUNTIME_RULES is the T2+ subset of the tier detector', () => {
        // Every shared-surface rule is a real PATH_RULE at T2 or T3 — derived from
        // the single source of truth so the surface can never drift from the detector.
        expect(SHARED_PROD_RUNTIME_RULES.length).toBeGreaterThan(0);
        expect(SHARED_PROD_RUNTIME_RULES.every((r) => r.minTier === 'T2' || r.minTier === 'T3')).toBe(true);
        // Frontend (T1) is intentionally excluded from the shared surface.
        expect(SHARED_PROD_RUNTIME_RULES.some((r) => r.pattern.test('src/components/Foo.tsx'))).toBe(false);
        // A representative sample of the shared surface is present.
        expect(SHARED_PROD_RUNTIME_RULES.some((r) => r.pattern.test('supabase/migrations/0350_x.sql'))).toBe(true);
        expect(SHARED_PROD_RUNTIME_RULES.some((r) => r.pattern.test('services/worker/src/chain/client.ts'))).toBe(true);
      });

      // (a) Orthogonal intervening diff → PASS (evidence preserved, no attestation).
      it('(a) preserves evidence when intervening drift is orthogonal to the PR surface', () => {
        // PR touches the worker API; main independently moved an unrelated docs file
        // and an unrelated frontend component. Neither is the PR's own file nor a
        // shared prod-runtime surface → disjoint → evidence preserved.
        const r = driftCheck(
          ['services/worker/src/api/v1/docusign.ts'],
          ['docs/architecture/overview.md', 'src/components/Header.tsx'],
        );
        expect(r.ok).toBe(true);
      });

      // (b) Same-file intervening diff → FAIL (hard re-soak, no override).
      it('(b) fails when intervening drift edits one of the PR\'s own soaked files', () => {
        const r = driftCheck(
          ['services/worker/src/api/v1/docusign.ts'],
          ['services/worker/src/api/v1/docusign.ts'],
        );
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/touches this PR's soak surface/i);
        expect(r.errors.join(' ')).toContain('services/worker/src/api/v1/docusign.ts');
      });

      // (c) Shared-runtime intervening diff → FAIL for each substrate the design names.
      it.each([
        ['shared migration surface', ['supabase/migrations/0351_add_index.sql'], /soak surface.*T3/is],
        ['shared chain surface', ['services/worker/src/chain/client.ts'], /soak surface/i],
        ['shared queue surface', ['services/worker/src/queues/batch-drain.ts'], /soak surface/i],
      ])('(c) fails when intervening drift touches the %s', (_label, driftFiles, errorPattern) => {
        const r = driftCheck(['services/worker/src/api/v1/docusign.ts'], driftFiles);
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(errorPattern);
      });

      it('(c) fails when intervening drift touches the cron schedule surface', () => {
        const r = driftCheck(
          ['services/worker/src/api/v1/docusign.ts'],
          ['services/worker/src/routes/scheduled.ts'],
        );
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/soak surface/i);
      });

      // (d) T0/docs intervening diff (disjoint) → PASS.
      it('(d) preserves evidence when intervening drift is docs/CI-only and disjoint', () => {
        const r = driftCheck(
          ['services/worker/src/api/v1/docusign.ts'],
          ['README.md', '.github/workflows/ci.yml', 'scripts/ci/some-tool.test.ts'],
        );
        expect(r.ok).toBe(true);
      });

      it('preserves evidence when the mixed drift set is entirely disjoint from the surface', () => {
        // Even a large intervening diff passes as long as nothing intersects the
        // PR's own files or the shared prod-runtime surface.
        const r = driftCheck(
          ['services/worker/src/api/v1/docusign.ts'],
          ['docs/x.md', 'src/pages/About.tsx', 'e2e/smoke.spec.ts', 'HANDOFF.md'],
        );
        expect(r.ok).toBe(true);
      });

      it('fails when ANY drift file intersects even if the rest are disjoint', () => {
        const r = driftCheck(
          ['services/worker/src/api/v1/docusign.ts'],
          ['docs/x.md', 'supabase/migrations/0352_y.sql', 'README.md'],
        );
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toContain('supabase/migrations/0352_y.sql');
      });

      it('T0-drift on the PR\'s own file passes via the narrower attestation fallback', () => {
        // The PR also owns a T0 file (agents.md). Main touched that exact file →
        // intersects the surface, but the drift set is T0-only, so an approved
        // `Base drift impact:` note preserves evidence.
        const attestBody = t2Body.replace(
          `- Base SHA: ${EVIDENCE_BASE}\n`,
          `- Base SHA: ${EVIDENCE_BASE}\n- Base drift impact: T0 CI-only drift in services/worker/src/api/agents.md; no runtime/schema/migration/staging/soak/deploy impact. Approved by: Carson 2026-07-07.\n`,
        );
        const r = check({
          body: attestBody,
          files: ['services/worker/src/api/v1/docusign.ts', 'services/worker/src/api/agents.md'],
          headSha: HEAD,
          baseSha: CURRENT_BASE,
          baseDriftFiles: ['services/worker/src/api/agents.md'],
        });
        expect(r.ok).toBe(true);
      });

      it('fails closed when the drift-file list cannot be resolved', () => {
        // No baseDriftFiles override + fake SHAs unresolvable by git → null → re-soak.
        const r = check({
          body: t2Body,
          files: ['services/worker/src/api/v1/docusign.ts'],
          headSha: HEAD,
          baseSha: CURRENT_BASE,
        });
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/Could not inspect changed files/i);
      });
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
    const mergeGradeT2Body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-00099-xyz
- PR head SHA: ${headSha}
- Changed behavior: DocuSign rate-limit retry preserves the Retry-After backoff slot
- Targeted evidence: staging POST /api/v1/docusign/envelopes replay hit 429 then retried after Retry-After and completed
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
- Base SHA: ${baseSha}
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

    it('Gap 1: T2 fails when deploy-evidence fields are PENDING placeholders', () => {
      const body = `## Staging Soak Evidence
- Tier: T2
- Staging branch: arkova-staging
- Worker revision: PENDING
- PR head SHA: ${headSha}
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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

    it('rejects NOT STARTED evidence values even when the field label is present', () => {
      const body = mergeGradeT2Body.replace(/E2E result:.*\n/, 'E2E result: NOT STARTED\n');
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/E2E result:.*NOT STARTED/i);
    });

    it('rejects planned or future-dated evidence before it can start the soak clock', () => {
      const body = mergeGradeT2Body
        .replace(/Preflight timestamp:.*\n/, 'Preflight timestamp: 2099-05-09 13:55 UTC\n')
        .replace(/Soak start:.*\n/, 'Soak start: 2099-05-09 14:00 UTC\n')
        .replace(/Soak end:.*\n/, 'Soak end: 2099-05-10 02:00 UTC\n');
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/future/i);
    });

    it('rejects T2/T3 deploy evidence without a real image digest', () => {
      const body = mergeGradeT2Body.replace(
        /Image digest:.*\n/,
        'Image digest: us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:pr-999\n',
      );
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Image digest:.*sha256/i);
    });

    it('rejects T2/T3 deploy evidence without a target Cloud Run URL', () => {
      const body = mergeGradeT2Body.replace(
        /Cloud Run service\/tag URL:.*\n/,
        'Cloud Run service/tag URL: arkova-worker-staging-00099-xyz\n',
      );
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Cloud Run service\/tag URL:.*URL/i);
    });

    it('rejects dirty preflight output that also says clean_mirror', () => {
      const body = mergeGradeT2Body.replace(
        /Preflight result:.*\n/,
        'Preflight result: environment_type=clean_mirror; duplicate migration names found; dirty staging project\n',
      );
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/clean_mirror/i);
    });

    it('rejects generic /health as the changed-behavior coverage', () => {
      const body = mergeGradeT2Body.replace(
        /Targeted evidence:.*\n/,
        'Targeted evidence: Playwright asserted GET /health returned 200 healthy\n',
      );
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Targeted evidence:.*changed behavior|\/health/i);
    });

    it('does not treat healthcheck as a substring inside a larger token', () => {
      const body = mergeGradeT2Body.replace(
        /Targeted evidence:.*\n/,
        'Targeted evidence: prehealthcheck scenario exercised the changed behavior under the targeted driver\n',
      );
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(true);
    });

    it('rejects missing heavy-user load/concurrency evidence', () => {
      const body = mergeGradeT2Body.replace(/- Load\/concurrency evidence:.*\n/, '');
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Load\/concurrency evidence:.*heavy-user|load|concurrency/i);
    });

    it('rejects N/A as load/concurrency evidence for a soak', () => {
      const body = mergeGradeT2Body.replace(
        /Load\/concurrency evidence:.*\n/,
        'Load/concurrency evidence: N/A\n',
      );
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Load\/concurrency evidence:.*real heavy-user/i);
    });

    it('rejects generic /health as load/concurrency evidence', () => {
      const body = mergeGradeT2Body.replace(
        /Load\/concurrency evidence:.*\n/,
        'Load/concurrency evidence: GET /health returned 200 under one request\n',
      );
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Load\/concurrency evidence:.*generic.*\/health/i);
    });

    it('rejects weak request-only text as load/concurrency evidence', () => {
      const body = mergeGradeT2Body.replace(
        /Load\/concurrency evidence:.*\n/,
        'Load/concurrency evidence: replayed the changed request successfully\n',
      );
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Load\/concurrency evidence:.*load\/concurrency proof/i);
    });

    it('allows completed evidence that mentions a planned/future scenario', () => {
      const body = mergeGradeT2Body.replace(
        /E2E result:.*\n/,
        'E2E result: 50/50 green for planned fallback and future-effective retry scenarios\n',
      );
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(true);
    });

    it('rejects evidence that does not name the changed behavior', () => {
      const body = mergeGradeT2Body.replace(/Changed behavior:.*\n/, '');
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Changed behavior:/i);
    });

    it('does not let a residual-risk note waive the standard T2 12h floor', () => {
      const body = `${mergeGradeT2Body.replace(/Soak end:.*\n/, 'Soak end: 2026-05-09 18:00 UTC\n')}
### Residual-risk note (preflight non-clean_mirror)
- Contamination type: soak_artifact
- Affected rows: 15 timestamp-versioned migration ledger rows
- Impact on this PR: none — evidence target is isolated from the contaminated rows
- Reason not cleaned: active staging leases would be invalidated
- Approved by: Carson (2026-05-09)
`;
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/12h minimum/i);
    });

    it('requires an explicit async-cycle floor for RM-approved targeted T2 evidence below 12h', () => {
      const body = `${mergeGradeT2Body.replace(/Soak end:.*\n/, 'Soak end: 2026-05-09 18:00 UTC\n')}- RM-approved targeted evidence: Carson approved targeted DocuSign Retry-After evidence for this T2-long path
`;
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Async-cycle floor:/i);
    });

    it('allows RM-approved targeted T2 evidence when it names the async-cycle floor', () => {
      const body = `${mergeGradeT2Body.replace(/Soak end:.*\n/, 'Soak end: 2026-05-09 18:00 UTC\n')}- RM-approved targeted evidence: Carson approved targeted DocuSign Retry-After evidence for this T2-long path
- Async-cycle floor: Retry-After backoff cycle observed through one complete retry slot
`;
      const r = check({ body, files: ['services/worker/src/api/v1/docusign.ts'], headSha, baseSha });
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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
  // Frontend-T2 targeted evidence mode.
  //
  // A declared-T2 PR can be frontend-only even when it is T1 by path (copy/UI
  // contract) or T2 by sensitive frontend path. Such a PR ships no worker code,
  // no migration, and no SDK/contract change — so it CANNOT produce the worker
  // artifacts the standard T2 block demands. The frontend-T2 mode lets that
  // narrow case satisfy T2 with RM-approved targeted UI evidence plus
  // async-cycle/load proof.
  //
  // CRITICAL backward-compat guard: this path activates ONLY when every changed
  // file is frontend/UAT/test/support-only and not a worker/migration/SDK/
  // contract path. Any worker- or migration-touching T2 PR keeps the unchanged
  // worker-artifact requirements.
  // ───────────────────────────────────────────────────────────────────────
  describe('frontend-T2 targeted evidence mode', () => {
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
      e2e: string;
      ciGreen: string;
      head: string;
      rollback: string;
      approval: string;
      floor: string;
      changed: string;
      targeted: string;
      load: string;
    }> = {}) => {
      const {
        tier = 'T2',
        e2e = 'credential-detail + public-verification E2E 18/18 green on head',
        ciGreen = 'Tests, E2E Tests, TypeCheck & Lint all green on current head',
        head = headSha,
        rollback = 'revert PR — additive display-only components, no data/schema/worker state',
        approval = 'Carson/RM approved targeted frontend-only T2 evidence for this UI contract path',
        floor = 'Async UI validation cycle: copy/route contract assertions plus Playwright affected-view pass under 8 parallel workers',
        changed = 'verification page copy and UI contract for the credential evidence panel',
        targeted = 'Playwright verification-copy.spec.ts exercised the changed verification copy and UI contract',
        load = 'Playwright ran the affected verification UI checks under 8 parallel workers with p95 assertion latency recorded',
      } = overrides;
      return `## Staging Soak Evidence
- Tier: ${tier}
- PR head SHA: ${head}
- RM-approved targeted evidence: ${approval}
- Async-cycle floor: ${floor}
- Changed behavior: ${changed}
- Targeted evidence: ${targeted}
- Load/concurrency evidence: ${load}
- E2E result: ${e2e}
- CI/E2E green: ${ciGreen}
- Rollback plan: ${rollback}
`;
    };

    describe('isFrontendOnlyChange', () => {
      it('is true for an all-src/** fileset', () => {
        expect(isFrontendOnlyChange(frontendOnlyT2Files)).toBe(true);
      });

      it('is true for a single frontend component', () => {
        expect(isFrontendOnlyChange(['src/components/anchor/AssetDetailView.tsx'])).toBe(true);
      });

      // A frontend feature legitimately ships vendored runtime assets
      // (public/vendor) + its Playwright E2E (e2e/) alongside the src/ change.
      // None of those can produce a worker/migration/SDK artifact, so the PR
      // stays frontend-T2 eligible. (The #1262 §1.6 fail-closed OCR shape.)
      it('is true for a src/ + public/vendor + e2e/ fileset (vendored assets + E2E are non-deploying)', () => {
        expect(isFrontendOnlyChange([
          'src/components/anchor/SecureDocumentDialog.tsx',
          'public/vendor/tesseract/core/tesseract-core-lstm.wasm.js',
          'e2e/extraction-csp-fail-closed.spec.ts',
        ])).toBe(true);
      });

      it('is true for a public/-plus-src fileset', () => {
        expect(isFrontendOnlyChange([
          'src/lib/ocrWorker.ts',
          'public/vendor/tesseract/worker.min.js',
        ])).toBe(true);
      });

      it('is true for an e2e/-plus-src fileset', () => {
        expect(isFrontendOnlyChange([
          'src/lib/aiExtraction.ts',
          'e2e/extraction-csp-fail-closed.spec.ts',
        ])).toBe(true);
      });

      it('is true for a src/ + docs UAT/support fileset', () => {
        expect(isFrontendOnlyChange([
          'src/lib/copy.ts',
          'docs/uat/pr-1438/UAT_REPORT.md',
          'tests/support/frontend-copy-fixtures.ts',
        ])).toBe(true);
      });

      it('is false when a CI script is present (scripts/ci is not frontend)', () => {
        expect(isFrontendOnlyChange([
          'src/components/anchor/SecureDocumentDialog.tsx',
          'public/vendor/tesseract/worker.min.js',
          'scripts/ci/check-csp-runtime-deps.ts',
        ])).toBe(false);
      });

      it('is true for the WEBEXT NER browser-runtime support file shape', () => {
        expect(isFrontendOnlyChange([
          '.gitignore',
          'docs/reference/WEBEXT01_FIX_RESULTS.md',
          'docs/reference/webext01-fix-evidence/evidence-results.json',
          'package.json',
          'public/vendor/transformers.bundle.min.js',
          'public/vendor/transformers.web.min.js',
          'scripts/agents.md',
          'scripts/ci/agents.md',
          'scripts/ci/check-csp-runtime-deps.test.ts',
          'scripts/ci/check-csp-runtime-deps.ts',
          'scripts/ner-runtime.lock.json',
          'scripts/vendor-ner-runtime.test.ts',
          'scripts/vendor-ner-runtime.ts',
          'scripts/vendor-transformers-version.test.ts',
          'src/lib/agents.md',
          'src/lib/nerPiiDetector.test.ts',
          'src/lib/nerPiiDetector.ts',
        ])).toBe(true);
      });

      it('keeps unrelated scripts/ci changes out of the frontend-T2 path', () => {
        expect(isFrontendOnlyChange([
          'src/components/anchor/SecureDocumentDialog.tsx',
          'scripts/ci/check-csp-runtime-deps.ts',
        ])).toBe(false);
      });

      it('is false when a GitHub Actions workflow is present', () => {
        expect(isFrontendOnlyChange([
          'src/components/anchor/SecureDocumentDialog.tsx',
          'e2e/extraction-csp-fail-closed.spec.ts',
          '.github/workflows/ci.yml',
        ])).toBe(false);
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

    // ── Scenario 1 (required): frontend-only T2 + targeted evidence → PASS ──
    it('Scenario 1: frontend-only T2 with RM-approved targeted evidence PASSES', () => {
      const r = check({
        body: frontendT2Body(),
        files: frontendOnlyT2Files,
        headSha,
      });
      expect(r.ok).toBe(true);
      expect(r.notes.join(' ')).toMatch(/frontend-T2/i);
    });

    it('Scenario 1b: frontend-only T2 PASSES without any backend artifact/preflight fields present at all', () => {
      // Proves we are not silently requiring the worker fields for this path.
      // Assert that the worker-artifact *list-item field lines* are absent. We
      // check for the `- <Label>` form the standard T2 block uses. Plain string
      // matching — no regex — so there is no backtracking/ReDoS surface.
      const body = frontendT2Body();
      expect(body).not.toContain('- Worker revision:');
      expect(body).not.toContain('- Image digest:');
      expect(body).not.toContain('- Cloud Run service/tag URL:');
      expect(body).not.toContain('- Staging deploy log id:');
      expect(body).not.toContain('- Staging project ref:');
      expect(body).not.toContain('- Preflight timestamp:');
      expect(body).not.toContain('- Preflight result:');
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(true);
    });

    it('Scenario 1c: #1438-like frontend verification copy targeted evidence PASSES', () => {
      const files = [
        'src/lib/copy.ts',
        'src/pages/PublicAttestationVerifyPage.tsx',
        'e2e/verification-copy.spec.ts',
        'docs/uat/pr-1438/UAT_REPORT.md',
      ];
      expect(requiredTierFor(files).tier).toBe('T1');

      const r = check({
        body: frontendT2Body({
          changed: 'frontend verification copy and no-raw-enum UI contract on the public verification page',
          targeted: 'verification-copy.spec.ts and UAT report exercised the changed public verification copy, no generic /health coverage',
          load: 'Playwright affected-view suite ran with 8 parallel workers; p95 UI assertion latency and retry-free pass recorded for the copy contract',
          e2e: 'verification-copy.spec.ts 12/12 passed on current head',
        }),
        files,
        headSha,
      });
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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

    // ── Scenario 3 (required): frontend-only T2 WITHOUT targeted evidence → FAIL ──
    it('Scenario 3: frontend-only T2 missing RM approval FAILS', () => {
      const body = frontendT2Body().replace(/- RM-approved targeted evidence:.*\n/, '');
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/RM-approved targeted evidence:/i);
    });

    it('Scenario 3b: frontend-only T2 without Carson/RM approval naming FAILS', () => {
      const body = frontendT2Body({ approval: 'frontend lead approved this targeted evidence' });
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/release manager approval/i);
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

    it('Scenario 3e: frontend-only T2 with PENDING targeted evidence FAILS', () => {
      const body = frontendT2Body({ targeted: 'PENDING' });
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/placeholder/i);
    });

    it('Scenario 3f: frontend-only T2 missing the async-cycle floor FAILS', () => {
      const body = frontendT2Body().replace(/- Async-cycle floor:.*\n/, '');
      const r = check({ body, files: frontendOnlyT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Async-cycle floor:/i);
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
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
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

  // ───────────────────────────────────────────────────────────────────────
  // Architecturally-unsoakable evidence mode (offline CLI/SDK/tooling pkgs).
  //
  // A PR can be required-tier T2 purely by touching an OFFLINE package/SDK
  // surface (the `packages/(?:arkova-py|embed|mcp-server|typescript|langchain)`
  // / `sdks/` half of the SDK PATH_RULE). Those packages ship no worker code,
  // no migration, and are not the served Cloud Run HTTP contract — they are
  // distributed as standalone libraries/CLIs and run offline (pytest / vitest /
  // parity). Such a PR can NEVER produce the worker-soak artifacts (Worker
  // revision, Image digest, Cloud Run URL, Staging deploy-log id, clean_mirror
  // preflight) the standard T2 block demands — an impossible catch-22 that
  // blocked #1411 (verifier-cli + arkova-py).
  //
  // The unsoakable path lets that narrow case satisfy T2 with TEST/PARITY
  // evidence (vitest/pytest/parity green at head) + an N/A-with-justification
  // staging tag + an `### Unsoakable-surface note` attesting no worker runtime
  // exists to soak.
  //
  // CRITICAL fail-closed guard: this path activates ONLY when every changed
  // file is an offline package/SDK path (packages/** or sdks/**) AND none is a
  // worker/migration/served-contract surface. Any worker-, migration-, or
  // API-contract-doc-touching T2 PR keeps the unchanged worker-artifact
  // requirements.
  // ───────────────────────────────────────────────────────────────────────
  describe('architecturally-unsoakable evidence mode', () => {
    const headSha = '1234567890abcdef1234567890abcdef12345678';

    // The real #1411 fileset: an offline Python client SDK + its tests.
    const offlinePackageT2Files = [
      'packages/arkova-py/src/arkova/client.py',
      'packages/arkova-py/src/arkova/models.py',
      'packages/arkova-py/tests/test_client.py',
      'packages/arkova-py/pyproject.toml',
    ];

    const unsoakableBody = (overrides: Partial<{
      tier: string;
      head: string;
      testEvidence: string;
      ciGreen: string;
      stagingTag: string;
      note: string;
    }> = {}) => {
      const {
        tier = 'T2',
        head = headSha,
        testEvidence = 'pytest 42/42 green + parity suite green on current head',
        ciGreen = 'Tests, TypeCheck & Lint all green on current head',
        stagingTag = 'N/A — offline Python SDK: no worker runtime, no migration, no served contract to soak',
        note = `
### Unsoakable-surface note
- No worker runtime: offline SDK package — no Cloud Run deploy, no worker revision, no image digest, no staging deploy-log id, no migration (nothing a soak could exercise)
- Surfaces touched: packages/arkova-py (standalone Python client library, run offline by consumers)
- Approved by: Carson`,
      } = overrides;
      return `## Staging Soak Evidence
- Tier: ${tier}
- PR head SHA: ${head}
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
- Test evidence: ${testEvidence}
- CI green: ${ciGreen}
- Staging tag URL or N/A explanation: ${stagingTag}
${note}
`;
    };

    describe('isOfflinePackageOnlyChange', () => {
      it('is true for an all-offline-package fileset (#1411 arkova-py)', () => {
        expect(isOfflinePackageOnlyChange(offlinePackageT2Files)).toBe(true);
      });

      it('is true for a single offline SDK source file', () => {
        expect(isOfflinePackageOnlyChange(['packages/arkova-py/src/arkova/client.py'])).toBe(true);
      });

      it('is true for the sdks/ offline client tree', () => {
        expect(isOfflinePackageOnlyChange([
          'sdks/typescript/src/index.ts',
          'sdks/langchain/src/tool.ts',
        ])).toBe(true);
      });

      it('is true for the verifier-cli offline CLI package', () => {
        expect(isOfflinePackageOnlyChange([
          'packages/verifier-cli/src/index.ts',
          'packages/verifier/src/verify.ts',
        ])).toBe(true);
      });

      it('is false when a worker file is present', () => {
        expect(isOfflinePackageOnlyChange([
          'packages/arkova-py/src/arkova/client.py',
          'services/worker/src/api/v1/verify.ts',
        ])).toBe(false);
      });

      it('is false when a migration is present', () => {
        expect(isOfflinePackageOnlyChange([
          'packages/typescript/src/index.ts',
          'supabase/migrations/0354_x.sql',
        ])).toBe(false);
      });

      it('is false when a served API contract doc is present (docs/api describes the soakable worker contract)', () => {
        expect(isOfflinePackageOnlyChange([
          'packages/arkova-py/src/arkova/client.py',
          'docs/api/openapi.yaml',
        ])).toBe(false);
      });

      it('is false when the API_GUIDE contract doc is present', () => {
        expect(isOfflinePackageOnlyChange([
          'packages/embed/src/widget.ts',
          'docs/guides/API_GUIDE.md',
        ])).toBe(false);
      });

      it('is false when a frontend file is present (not an offline package)', () => {
        expect(isOfflinePackageOnlyChange([
          'packages/typescript/src/index.ts',
          'src/components/api/ApiKeys.tsx',
        ])).toBe(false);
      });

      it('is false for an empty fileset (nothing to attest as offline-package-only)', () => {
        expect(isOfflinePackageOnlyChange([])).toBe(false);
      });
    });

    // ── Scenario 1 (required): offline-package T2 + test evidence → PASS ──
    it('Scenario 1: #1411 offline-package T2 with test/parity evidence PASSES', () => {
      const r = check({
        body: unsoakableBody(),
        files: offlinePackageT2Files,
        headSha,
      });
      expect(r.ok).toBe(true);
      expect(r.notes.join(' ')).toMatch(/unsoakable/i);
    });

    it('Scenario 1b: offline-package T2 PASSES with NO worker-artifact fields present at all', () => {
      const body = unsoakableBody();
      expect(body).not.toContain('- Worker revision:');
      expect(body).not.toContain('- Image digest:');
      expect(body).not.toContain('- Cloud Run service/tag URL:');
      expect(body).not.toContain('- Staging deploy log id:');
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(true);
    });

    // ── Scenario 2 (required): worker-touching T2 still FAILS without artifacts ──
    it('Scenario 2: worker-touching T2 with ONLY unsoakable evidence still FAILS (worker artifacts unchanged)', () => {
      const r = check({
        body: unsoakableBody(),
        // Same body, but the fileset now includes a worker file → NOT offline-only.
        files: ['packages/arkova-py/src/arkova/client.py', 'services/worker/src/api/v1/verify.ts'],
        headSha,
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Worker revision:|Image digest:|Cloud Run|Staging deploy log id:/i);
    });

    it('Scenario 2b: a migration-bearing PR alongside an offline package still demands a full T3 soak', () => {
      const r = check({
        body: unsoakableBody({ tier: 'T3' }),
        files: ['packages/arkova-py/src/arkova/client.py', 'supabase/migrations/0354_x.sql'],
        headSha,
        baseSha: 'abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(r.ok).toBe(false);
      // Migration → T3; the offline-package escape hatch must not apply.
      expect(r.errors.join(' ')).toMatch(/Worker revision:|Trigger A fires:|missing required fields for T3/i);
    });

    // ── Scenario 3 (required): offline-package T2 WITHOUT test evidence → FAIL ──
    it('Scenario 3: offline-package T2 missing the Test evidence field FAILS', () => {
      const body = unsoakableBody().replace(/- Test evidence:.*\n/, '');
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Test evidence:/i);
    });

    it('Scenario 3b: offline-package T2 with an EMPTY Test evidence value FAILS', () => {
      const body = unsoakableBody({ testEvidence: '' });
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Test evidence:/i);
    });

    it('Scenario 3c: offline-package T2 with a PENDING Test evidence value FAILS (placeholder rejected)', () => {
      const body = unsoakableBody({ testEvidence: 'PENDING' });
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/placeholder/i);
    });

    it('Scenario 3d: offline-package T2 whose Test evidence does not state a passing result FAILS', () => {
      const body = unsoakableBody({ testEvidence: 'ran the suite locally' });
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Test evidence/i);
    });

    it('Scenario 3e: offline-package T2 with an empty CI green value FAILS', () => {
      const body = unsoakableBody({ ciGreen: '' });
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/CI green:/i);
    });

    it('Scenario 3f: offline-package T2 with NO unsoakable-surface note FAILS', () => {
      const body = unsoakableBody({ note: '' });
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/unsoakable-surface note|no worker runtime/i);
    });

    it('Scenario 3g: offline-package T2 whose note has a blank Approved by FAILS', () => {
      const body = unsoakableBody({
        note: `
### Unsoakable-surface note
- No worker runtime: offline SDK — nothing to soak
- Surfaces touched: packages/arkova-py
- Approved by:`,
      });
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Approved by|unsoakable-surface note/i);
    });

    it('Scenario 3h: offline-package T2 with a stale (mismatched) PR head SHA FAILS (exact-head integrity preserved)', () => {
      const body = unsoakableBody();
      const r = check({
        body,
        files: offlinePackageT2Files,
        headSha: '9999999990abcdef1234567890abcdef12345678',
      });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/PR head SHA/i);
    });

    it('Scenario 3i: offline-package T2 with a bare staging tag (no N/A justification, no URL) FAILS', () => {
      const body = unsoakableBody({ stagingTag: 'skipped' });
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Staging tag URL or N\/A explanation/i);
    });

    // Under-declaration must still fail: an offline-package T2-required PR that
    // declares T1 is blocked exactly as before (the unsoakable path does NOT
    // weaken classification — it only changes which evidence T2 accepts).
    it('does not let an offline-package T2-required PR sneak through as a declared T1', () => {
      const body = `## Staging Soak Evidence
- Tier: T1
- PR head SHA: ${headSha}
- Changed behavior: fixture changed behavior under test
- Targeted evidence: targeted fixture evidence exercised the changed behavior path
- Load/concurrency evidence: tests/load fixture exercised the changed behavior under high-concurrency users
- Test evidence: pytest green
- CI green: green
- Staging tag URL or N/A explanation: N/A — offline SDK
`;
      const r = check({ body, files: offlinePackageT2Files, headSha });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/below required tier T2/i);
    });

    // A pure-frontend PR must NOT reach the offline-package path: it keeps the
    // frontend-targeted T2 evidence mode. Guards against the two alt-evidence paths
    // bleeding into each other.
    it('a frontend-only T2 PR is NOT treated as offline-package (stays frontend-targeted T2)', () => {
      expect(isOfflinePackageOnlyChange(['src/components/anchor/AssetDetailView.tsx'])).toBe(false);
    });
  });
});
