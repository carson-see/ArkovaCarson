import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import { fixupPluginRules } from '@eslint/compat';
import arkovaPlugin from './eslint-rules/index.cjs';

export default tseslint.config(
  {
    ignores: ['dist', 'eslint-rules', 'arkova-marketing', 'services', 'supabase', 'e2e', 'machines', 'sdks', 'edge-workers', 'scripts', 'docs', '*.config.*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'import': fixupPluginRules(importPlugin),
      arkova: arkovaPlugin,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    settings: {
      'import/resolver': {
        typescript: true,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'import/no-cycle': ['error', { maxDepth: 4 }],
      // SCRUM-1208 — tenant isolation on multi-tenant Supabase tables.
      'arkova/missing-org-filter': 'warn',
      // eslint-plugin-react-hooks v7 ships React Compiler rules in its
      // recommended preset. The codebase pre-dates the compiler and has
      // violations that need per-file refactoring. Downgrade to warn so
      // they surface without blocking CI; a dedicated migration story
      // will re-enable them as errors after the cleanup lands.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/incompatible-library': 'warn',
    },
  },
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    plugins: {
      arkova: arkovaPlugin,
    },
    rules: {
      'arkova/no-unscoped-service-test': 'warn',
      'arkova/require-error-code-assertion': 'warn',
      'arkova/no-mock-echo': 'warn',
    },
  },
);
// Note: the worker has its own eslint.config.js (services/worker/eslint.config.js)
// that separately enables arkova/missing-org-filter — ESLint v9 flat config
// uses the nearest config upward from each file, so a worker block here
// would never fire.
