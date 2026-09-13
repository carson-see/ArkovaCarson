import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/api/admin-invitations.local.test.ts'],
    testTimeout: 30_000,
  },
});
