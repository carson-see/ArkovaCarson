import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/staging/targeted/uat04-uat22-auth-invite-driver.local-smoke.ts'],
    passWithNoTests: false,
  },
});
