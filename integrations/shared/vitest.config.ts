import { defineConfig } from 'vitest/config';

// This package is a bare, dependency-free source directory (no package.json —
// see src/agents.md). Vitest and its deps resolve from the repo-root install,
// the same way sdks/langchain-ts does. Run with `npx vitest run` from here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
