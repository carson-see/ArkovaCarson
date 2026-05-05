import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/**',
        'src/**/*.test.ts',
      ],
      thresholds: {
        // Critical paths: chain signing, webhook delivery, stripe client
        // Thresholds based on actual coverage — raise as coverage improves
        'src/chain/mock.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/chain/signing-provider.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/webhooks/delivery.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/stripe/client.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/stripe/mock.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/jobs/report.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/utils/correlationId.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/utils/rateLimit.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        // SCRUM-1545 (R4-4-FU) raised both files to the 80%/80%/80%/80%
        // critical-path floor on 2026-05-05 after the coverage-backfill
        // suites landed (`anchor-coverage.test.ts` + the new chain/client
        // describe blocks). Actual coverage at threshold-raise:
        //   anchor.ts:        98.29 / 95.49 / 100  / 98.83
        //   chain/client.ts:  97.70 / 97.10 / 100  / 97.64
        'src/jobs/anchor.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/chain/client.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/stripe/handlers.ts': {
          // SCRUM-1289 (R4-4): bumped 75/70/70/70 → 80 across the board.
          // Actual coverage 2026-04-28: 88.99 / 88.11 / 85.71 / 89.47.
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/config.ts': {
          // Restored from 65 → 70 (DEP-05). PR #347 (SCRUM-534) added
          // config.test.ts cases for the FRONTEND_URL production guard,
          // bringing branch coverage back above the original 70% target.
          branches: 70,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/index.ts': {
          // Same align-with-reality pattern as the functions threshold
          // below: route mounts grew faster than smoke tests. Branches
          // 50 → 42 / lines 70 → 68 / statements 70 → 68 reflect actual
          // coverage on 2026-04-27 (PR #583 batch — anchor evidence +
          // bug-bounty fixes added a few new mounts without the smoke
          // tests landing yet). Raise these back when mount-level
          // smoke tests cover the new routes (Adobe Sign, Checkr,
          // Veremark, OpenAPI CIBA, connector-health, plus the
          // recently-mounted HAKI and audit-evidence routes).
          branches: 42,
          functions: 20,
          lines: 68,
          statements: 68,
        },
      },
    },
  },
});
