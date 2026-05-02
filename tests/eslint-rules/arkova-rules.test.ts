/**
 * Tests for custom ESLint rules (eslint-plugin-arkova)
 *
 * Verifies that the 3 test quality rules correctly flag anti-patterns
 * and pass on well-written tests.
 *
 * NOTE: ESLint 10's RuleTester.run() internally calls describe()/it(),
 * so each run() must be at the describe level — not nested inside it().
 */

import { describe } from 'vitest';
import { RuleTester } from 'eslint';
import tsParser from 'typescript-eslint';

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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tenantIsolation = require('../../eslint-rules/tenant-isolation.cjs');

describe('arkova/no-unscoped-service-test', () => {
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
      {
        filename: 'useHook.test.ts',
        code: `
          vi.mock('@/lib/supabase', () => ({
            supabase: { from: mockFrom },
          }));
          const mockFrom = vi.fn();
          it('proves the fallback table query does not run', () => {
            expect(mockFrom).not.toHaveBeenCalled();
          });
        `,
      },
      {
        filename: 'useHook.test.ts',
        code: `
          vi.mock('@/lib/supabase', () => ({
            supabase: { from: mockFrom },
          }));
          const mockFrom = vi.fn();
          it('uses the singleton treasury cache table', () => {
            expect(mockFrom).toHaveBeenCalledWith('treasury_cache');
          });
        `,
      },
      {
        filename: 'utils.test.ts',
        code: `
          it('adds numbers', () => {
            expect(add(1, 2)).toBe(3);
          });
        `,
      },
      {
        filename: 'useHook.ts', // Not a test file
        code: `
          vi.mock('@/lib/supabase', () => ({
            supabase: { from: mockFrom },
          }));
        `,
      },
    ],
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
});

describe('arkova/require-error-code-assertion', () => {
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
      {
        filename: 'utils.test.ts',
        code: `
          it('transforms data correctly', () => {
            expect(transform(input)).toEqual(expected);
          });
        `,
      },
      {
        filename: 'api.test.ts',
        code: `
          it('rejects expired signed URLs', () => {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toBe('expired');
          });
        `,
      },
      {
        filename: 'api.test.ts',
        code: `
          it('rejects malformed null payloads', () => {
            expect(parse(input)).toBeNull();
          });
          it('accepts a valid ok response', () => {
            expect(result.ok).toBe(true);
          });
        `,
      },
    ],
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
});

describe('arkova/missing-org-filter', () => {
  ruleTester.run('tenant-isolation', tenantIsolation, {
    valid: [
      {
        code: `
          supabase.from('attestations').select('*').eq('attester_org_id', orgId);
        `,
      },
      {
        code: `
          supabase.from('attestations').select('*').eq('attester_user_id', userId);
        `,
      },
      {
        code: `
          supabase.from('subscriptions').select('id').eq('user_id', userId);
        `,
      },
      {
        code: `
          supabase.from('org_members').insert({ org_id: orgId, user_id: userId, role: 'owner' });
        `,
      },
      {
        code: `
          supabase.from('attestations').select('*').match({ attester_org_id: orgId });
        `,
      },
    ],
    invalid: [
      {
        code: `
          supabase.from('attestations').select('*');
        `,
        errors: [{ messageId: 'missingOrgFilter' }],
      },
      {
        code: `
          supabase.from('org_members').insert({ role: 'owner' });
        `,
        errors: [{ messageId: 'missingOrgFilter' }],
      },
    ],
  });
});

describe('arkova/no-mock-echo', () => {
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
});
