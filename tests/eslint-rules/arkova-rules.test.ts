/**
 * Tests for custom ESLint rules (eslint-plugin-arkova)
 *
 * Verifies that the 3 test quality rules correctly flag anti-patterns
 * and pass on well-written tests.
 */

import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import tsParser from 'typescript-eslint';

// ESLint v9 RuleTester uses flat config format
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser.parser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const noUnscopedServiceTest = require('../../eslint-rules/no-unscoped-service-test.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const requireErrorCodeAssertion = require('../../eslint-rules/require-error-code-assertion.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noMockEcho = require('../../eslint-rules/no-mock-echo.cjs');

describe('arkova/no-unscoped-service-test', () => {
  it('flags test file that mocks supabase.from() without scoping assertion', () => {
    expect(() => {
      ruleTester.run('no-unscoped-service-test', noUnscopedServiceTest, {
        valid: [],
        invalid: [
          {
            filename: 'useHook.test.ts',
            code: `
              vi.mock('@/lib/supabase', () => ({
                supabase: { from: mockFrom },
              }));
              const mockFrom = vi.fn();
              it('fetches data', () => {
                mockFrom.mockReturnValue({ select: vi.fn() });
                expect(result).toBeDefined();
              });
            `,
            errors: [{ messageId: 'unscopedService' }],
          },
        ],
      });
    }).not.toThrow();
  });

  it('passes when test asserts user_id scoping', () => {
    expect(() => {
      ruleTester.run('no-unscoped-service-test', noUnscopedServiceTest, {
        valid: [
          {
            filename: 'useHook.test.ts',
            code: `
              vi.mock('@/lib/supabase', () => ({
                supabase: { from: mockFrom },
              }));
              const mockFrom = vi.fn();
              it('fetches scoped data', () => {
                expect(mockEq).toHaveBeenCalledWith('user_id', 'test-user');
              });
            `,
          },
        ],
        invalid: [],
      });
    }).not.toThrow();
  });

  it('passes when test does not mock supabase at all', () => {
    expect(() => {
      ruleTester.run('no-unscoped-service-test', noUnscopedServiceTest, {
        valid: [
          {
            filename: 'utils.test.ts',
            code: `
              it('adds numbers', () => {
                expect(add(1, 2)).toBe(3);
              });
            `,
          },
        ],
        invalid: [],
      });
    }).not.toThrow();
  });

  it('passes for non-test files', () => {
    expect(() => {
      ruleTester.run('no-unscoped-service-test', noUnscopedServiceTest, {
        valid: [
          {
            filename: 'useHook.ts', // Not a test file
            code: `
              vi.mock('@/lib/supabase', () => ({
                supabase: { from: mockFrom },
              }));
            `,
          },
        ],
        invalid: [],
      });
    }).not.toThrow();
  });
});

describe('arkova/require-error-code-assertion', () => {
  it('flags error test that only checks result is null', () => {
    expect(() => {
      ruleTester.run('require-error-code-assertion', requireErrorCodeAssertion, {
        valid: [],
        invalid: [
          {
            filename: 'api.test.ts',
            code: `
              it('returns null on API error', () => {
                const result = await fetch('/api');
                expect(result.ok).toBe(false);
                expect(data).toBeNull();
              });
            `,
            errors: [{ messageId: 'missingErrorCode' }],
          },
        ],
      });
    }).not.toThrow();
  });

  it('passes when error test asserts status code', () => {
    expect(() => {
      ruleTester.run('require-error-code-assertion', requireErrorCodeAssertion, {
        valid: [
          {
            filename: 'api.test.ts',
            code: `
              it('returns 403 on forbidden error', () => {
                expect(result.status).toBe(403);
              });
            `,
          },
        ],
        invalid: [],
      });
    }).not.toThrow();
  });

  it('passes for non-error tests', () => {
    expect(() => {
      ruleTester.run('require-error-code-assertion', requireErrorCodeAssertion, {
        valid: [
          {
            filename: 'utils.test.ts',
            code: `
              it('transforms data correctly', () => {
                expect(transform(input)).toEqual(expected);
              });
            `,
          },
        ],
        invalid: [],
      });
    }).not.toThrow();
  });
});

describe('arkova/no-mock-echo', () => {
  it('flags test that echoes mock values in assertions', () => {
    expect(() => {
      ruleTester.run('no-mock-echo', noMockEcho, {
        valid: [],
        invalid: [
          {
            filename: 'useHook.test.ts',
            code: `
              const mockData = { balance: 45, plan: 'Pro' };
              mockRpc.mockResolvedValue({ data: mockData });
              it('fetches credits', () => {
                expect(result.balance).toBe(45);
                expect(result.plan).toBe('Pro');
              });
            `,
            errors: [{ messageId: 'mockEcho' }],
          },
        ],
      });
    }).not.toThrow();
  });

  it('passes when test asserts transformed/computed values', () => {
    expect(() => {
      ruleTester.run('no-mock-echo', noMockEcho, {
        valid: [
          {
            filename: 'useHook.test.ts',
            code: `
              const mockData = { first: 'John', last: 'Doe' };
              mockRpc.mockResolvedValue({ data: mockData });
              it('computes full name', () => {
                expect(result.fullName).toBe('John Doe');
                expect(result.initials).toBe('JD');
              });
            `,
          },
        ],
        invalid: [],
      });
    }).not.toThrow();
  });

  it('passes when fewer than 50% assertions are echoes', () => {
    expect(() => {
      ruleTester.run('no-mock-echo', noMockEcho, {
        valid: [
          {
            filename: 'useHook.test.ts',
            code: `
              const mockData = { value: 42 };
              mockFn.mockResolvedValue({ data: mockData });
              it('processes data', () => {
                expect(result.value).toBe(42);
                expect(result.doubled).toBe(84);
                expect(result.label).toBe('answer');
              });
            `,
          },
        ],
        invalid: [],
      });
    }).not.toThrow();
  });
});
