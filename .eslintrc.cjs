module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs', 'eslint-rules'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh', 'import'],
  settings: {
    'import/resolver': {
      typescript: true,
    },
  },
  rules: {
    'react-refresh/only-export-components': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // ARCH-5/DEBT-3: Prevent circular dependencies
    'import/no-cycle': ['error', { maxDepth: 4 }],
  },
  overrides: [
    {
      // Arkova test quality rules — only apply to test files
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
      plugins: ['arkova'],
      rules: {
        // Flags test files that mock Supabase but never assert org/user scoping
        // Set to 'warn' initially — 23 existing violations to fix, then escalate to 'error'
        'arkova/no-unscoped-service-test': 'warn',
        // Flags tests that check ok === false without asserting the specific error code
        'arkova/require-error-code-assertion': 'warn',
        // Detects tests that just compare result.data to the exact mock return value
        'arkova/no-mock-echo': 'warn',
      },
    },
  ],
};
