# tests/eslint-rules/agents.md

Tests for custom ESLint rules (`eslint-plugin-arkova`).

## Files
- **`arkova-rules.test.ts`** — tests for 3 custom test-quality rules: `no-unscoped-service-test`, `require-error-code-assertion`, `no-mock-echo`. Uses ESLint 10 `RuleTester` with TypeScript parser.

## Conventions
- `RuleTester.run()` calls `describe()`/`it()` internally; do not nest inside `it()`.
- Rule implementations live in `eslint-rules/*.cjs` at repo root.
- Run via the main Vitest config.
