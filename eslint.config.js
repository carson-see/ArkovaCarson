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
      // ARCH-5/DEBT-3: Prevent circular dependencies
      'import/no-cycle': ['error', { maxDepth: 4 }],
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
