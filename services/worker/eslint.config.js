import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import arkovaPlugin from '../../eslint-rules/index.cjs';

export default tseslint.config(
  {
    ignores: ['dist'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'scripts/**/*.test.ts', 'scripts/**/*.spec.ts'],
    plugins: {
      arkova: arkovaPlugin,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Preserve pre-upgrade behavior: these were not errors in typescript-eslint v6
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      // SCRUM-1208 — tenant isolation on multi-tenant Supabase tables.
      'arkova/missing-org-filter': 'warn',
      // eslint 10 promoted these to errors in recommended; keep as warnings
      // to preserve pre-upgrade behavior. Follow-up story to fix and promote.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  // Worker cron jobs in src/jobs/ run under the service-role client and operate
  // cross-tenant by design (pipeline ingestion, anchor lifecycle, rules engine).
  // The tenant-isolation rule is valuable for API handlers and webhooks where
  // per-request user context exists, but false-positives on every job query.
  {
    files: ['src/jobs/**/*.ts'],
    rules: {
      'arkova/missing-org-filter': 'off',
    },
  },
  // SCRUM-1250 (R0-4): test-file overrides. Tests legitimately use `_` prefixed
  // vars to ignore destructured fields, `any` in mock factories, and require()
  // for dynamic imports of vi.mock'd modules. Without this block 119 errors in
  // test files blocked every deploy. Treat the same patterns as warnings here
  // so `npm run lint` (the deploy gate per R0-4) returns zero exit codes when
  // there are no real errors. Same scope as the production-file override above.
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'scripts/**/*.test.ts', 'scripts/**/*.spec.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.node, ...globals.vitest },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
);
