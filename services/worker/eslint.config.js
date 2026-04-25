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
);
