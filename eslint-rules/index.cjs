/**
 * eslint-plugin-arkova — Local ESLint plugin for Arkova test quality rules.
 *
 * Rules:
 *   arkova/no-unscoped-service-test  (error) — Mock Supabase tests must assert org/user scoping
 *   arkova/require-error-code-assertion (warn) — Error tests must assert specific error codes
 *   arkova/no-mock-echo              (warn)  — Tests must not just echo mock return values
 *   arkova/missing-org-filter        (warn)  — Supabase queries on multi-tenant tables need a scope filter
 *   arkova/no-connector-bytes-to-sink (error, connector files) — raw connector document bytes must not reach a logger/Sentry/Error/last_error/temp file/Postgres (§1.6A / SCRUM-2492)
 */

const noUnscopedServiceTest = require('./no-unscoped-service-test.cjs');
const requireErrorCodeAssertion = require('./require-error-code-assertion.cjs');
const noMockEcho = require('./no-mock-echo.cjs');
const tenantIsolation = require('./tenant-isolation.cjs');
const noConnectorBytesToSink = require('./no-connector-bytes-to-sink.cjs');

module.exports = {
  rules: {
    'no-unscoped-service-test': noUnscopedServiceTest,
    'require-error-code-assertion': requireErrorCodeAssertion,
    'no-mock-echo': noMockEcho,
    // SCRUM-1208 — tenant isolation enforcement on Supabase queries.
    'missing-org-filter': tenantIsolation,
    // SCRUM-2492 — §1.6A connector-byte handling: no raw document bytes to any sink.
    'no-connector-bytes-to-sink': noConnectorBytesToSink,
  },
};
