import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import { fixupPluginRules } from '@eslint/compat';
import arkovaPlugin from '../../eslint-rules/index.cjs';

export default tseslint.config(
  {
    ignores: ['dist'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: {
      'import': fixupPluginRules(importPlugin),
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
    settings: {
      'import/resolver': {
        typescript: true,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Preserve pre-upgrade behavior: these were not errors in typescript-eslint v6
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      // ARCH-5/DEBT-3: Prevent circular dependencies
      'import/no-cycle': ['error', { maxDepth: 4 }],
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
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
