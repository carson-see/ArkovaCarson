import { defineConfig } from 'vitest/config';

/**
 * Minimal Vitest harness for the edge worker (Story D, PR-1).
 *
 * The functions under test (`shapeAnchorRow`, `nessieTextFallback`,
 * `handleVerifyCredential`, etc.) are pure-ish: they take a config object
 * and call `fetch`/`ai.run`, both of which are mocked per-test. No
 * Miniflare / workerd runtime is needed for these unit tests — plain Node
 * is sufficient and far faster. If a future suite needs the real Workers
 * runtime, add `@cloudflare/vitest-pool-workers` in a separate config.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
