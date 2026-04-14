/**
 * ESLint Rule: no-unscoped-service-test
 *
 * Flags test files that mock supabase.from() and set up a mock chain
 * that returns data, but never assert that queries are scoped by
 * user_id or org_id.
 *
 * Without scoping assertions, a test passes even if production code
 * drops .eq('user_id', ...) — a silent RLS bypass.
 *
 * Only fires when:
 * 1. The test mocks the supabase module
 * 2. The mock includes a `.from()` method (data table query, not just auth)
 * 3. The test never asserts scoping with user_id/org_id
 *
 * Severity: error
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Test files that mock supabase.from() must assert org/user scoping (.eq called with user_id or org_id)',
      category: 'Testing',
    },
    messages: {
      unscopedService:
        'This test mocks supabase.from() but never asserts that queries are scoped by user_id or org_id. ' +
        'Add an assertion like: expect(mockEq).toHaveBeenCalledWith(\'user_id\', ...) or ' +
        'expect(mockFrom).toHaveBeenCalledWith(...) followed by scoping verification. ' +
        'Without this, the test passes even if production code drops the RLS scoping filter.',
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!filename.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) return {};

    let hasMockSupabase = false;
    let hasMockFrom = false;
    let hasScopingAssertion = false;

    // Scoping field names we look for
    const scopingFields = ['user_id', 'org_id', 'owner_id', 'created_by'];

    return {
      CallExpression(node) {
        // Detect vi.mock('...supabase...')
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.name === 'vi' &&
          node.callee.property.name === 'mock' &&
          node.arguments.length > 0 &&
          node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string' &&
          node.arguments[0].value.includes('supabase')
        ) {
          hasMockSupabase = true;
        }

        // Detect expect(mockXxx).toHaveBeenCalledWith('user_id', ...) or ('org_id', ...)
        if (
          node.callee.type === 'MemberExpression' &&
          (node.callee.property.name === 'toHaveBeenCalledWith' ||
           node.callee.property.name === 'toBeCalledWith')
        ) {
          for (const arg of node.arguments) {
            if (
              arg.type === 'Literal' &&
              typeof arg.value === 'string' &&
              scopingFields.includes(arg.value)
            ) {
              hasScopingAssertion = true;
            }
          }
        }
      },

      // Detect mockFrom usage or `from:` property in mock factory
      // Pattern 1: const mockFrom = vi.fn()  (variable name contains 'from')
      // Pattern 2: supabase: { from: mockFrom } in vi.mock factory
      VariableDeclarator(node) {
        if (
          node.id.type === 'Identifier' &&
          node.id.name.toLowerCase().includes('from')
        ) {
          hasMockFrom = true;
        }
      },

      // Detect `from:` or `from(` in mock setup objects
      Property(node) {
        if (
          node.key.type === 'Identifier' &&
          node.key.name === 'from'
        ) {
          hasMockFrom = true;
        }
      },

      // Detect mockFrom.mockReturnValue / mockFrom.mockImplementation
      'CallExpression[callee.property.name=/^mock/]'(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name.toLowerCase().includes('from')
        ) {
          hasMockFrom = true;
        }
      },

      // Check string literals for scoping fields in assertion context
      Literal(node) {
        if (
          typeof node.value === 'string' &&
          scopingFields.includes(node.value)
        ) {
          let parent = node.parent;
          let depth = 0;
          while (parent && depth < 6) {
            if (
              parent.type === 'CallExpression' &&
              parent.callee.type === 'MemberExpression' &&
              typeof parent.callee.property.name === 'string' &&
              parent.callee.property.name.startsWith('toHaveBeen')
            ) {
              hasScopingAssertion = true;
              break;
            }
            parent = parent.parent;
            depth++;
          }
        }
      },

      'Program:exit'(node) {
        // Only flag when BOTH: supabase is mocked AND .from() is part of the mock
        if (hasMockSupabase && hasMockFrom && !hasScopingAssertion) {
          context.report({
            node,
            messageId: 'unscopedService',
          });
        }
      },
    };
  },
};
