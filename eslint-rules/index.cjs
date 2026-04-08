/**
 * eslint-plugin-arkova — Local ESLint plugin for Arkova test quality rules.
 *
 * Rules:
 *   arkova/no-unscoped-service-test  (error) — Mock Supabase tests must assert org/user scoping
 *   arkova/require-error-code-assertion (warn) — Error tests must assert specific error codes
 *   arkova/no-mock-echo              (warn)  — Tests must not just echo mock return values
 */

const noUnscopedServiceTest = require('./no-unscoped-service-test.cjs');
const requireErrorCodeAssertion = require('./require-error-code-assertion.cjs');
const noMockEcho = require('./no-mock-echo.cjs');

module.exports = {
  rules: {
    'no-unscoped-service-test': noUnscopedServiceTest,
    'require-error-code-assertion': requireErrorCodeAssertion,
    'no-mock-echo': noMockEcho,
  },
};
