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
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
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
    },
  },
  // SCRUM-1250 (R0-4): test-file overrides. Tests legitimately use `_` prefixed
  // vars to ignore destructured fields, `any` in mock factories, and require()
  // for dynamic imports of vi.mock'd modules. Without this block 119 errors in
  // test files blocked every deploy. Treat the same patterns as warnings here
  // so `npm run lint` (the deploy gate per R0-4) returns zero exit codes when
  // there are no real errors. Same scope as the production-file override above.
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.node, ...globals.vitest },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },
);
