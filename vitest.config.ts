import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    // tests/eslint-rules/* exercises the custom eslint-plugin-arkova via
    // ESLint's RuleTester with flat-config (v9) API. ESLint v9 is introduced
    // in DEP-05 (PR #348); until that lands, running it against v8 throws
    // "Cannot find module '../rules'". Re-enable when DEP-05 merges.
    exclude: ['tests/rls/**', 'tests/load/**', 'tests/eslint-rules/**'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/types/**',
        'src/test/**',
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/components/ui/**',
        'src/vite-env.d.ts',
      ],
      thresholds: {
        // Critical paths: fingerprinting + validation + proof packages
        'src/lib/fileHasher.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/lib/validators.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/lib/proofPackage.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
