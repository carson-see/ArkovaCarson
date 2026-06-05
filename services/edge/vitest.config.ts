import { defineConfig } from 'vitest/config';

/**
 * Edge worker unit-test harness (SCRUM-2226).
 *
 * Node environment, not @cloudflare/vitest-pool-workers: the units under
 * test here are PURE mappers/helpers (e.g. `shapeAnchorRow`) and Node 20+
 * platform helpers (WebCrypto, fetch) — none reach for a Workers-runtime
 * binding (KV, Durable Objects, Workers AI, `env`). If/when a test needs a
 * real Workers binding, isolate that suite into the workers pool rather than
 * pulling the whole harness onto miniflare.
 *
 * Edge source ships as `.ts` with `moduleResolution: bundler`. Tests import
 * the `.ts` source directly (Vitest resolves it); there is no build step.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
