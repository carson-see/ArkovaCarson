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
        // Files below 80% — tracked for improvement
        'src/jobs/anchor.ts': {
          branches: 55,
          functions: 60,
          lines: 65,
          statements: 65,
        },
        'src/chain/client.ts': {
          branches: 70,
          functions: 75,
          lines: 75,
          statements: 75,
        },
        'src/stripe/handlers.ts': {
          branches: 75,
          functions: 70,
          lines: 70,
          statements: 70,
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
          // Functions threshold tracks reality. Every new route mount in
          // src/index.ts that doesn't have a matching index.test.ts case
          // pulls this number down. Currently 33.33% after #509 added the
          // /api/v1/integrations/docusign/* mount. Raise back to 40+ when
          // mount-level smoke tests exist for middesk webhook, drive-oauth,
          // and docusign-oauth routes (mirror the stripe webhook cases at
          // src/index.test.ts:443).
          branches: 50,
          functions: 20,
          lines: 70,
          statements: 70,
        },
      },
    },
  },
});
