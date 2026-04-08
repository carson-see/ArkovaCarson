/**
 * ESLint Rule: no-mock-echo
 *
 * Detects tests that just compare result.data to the exact value
 * the mock was told to return. These "echo tests" prove the mock
 * framework works, not the code under test.
 *
 * Pattern detected:
 *   const mockData = { balance: 45 };
 *   mockRpc.mockResolvedValue({ data: mockData });
 *   // later...
 *   expect(result.current.credits?.balance).toBe(45);
 *   // ^^^ This just echoes the mock value
 *
 * The rule tracks:
 *   1. Literal values assigned to mock data objects/variables
 *   2. Those same literal values appearing in expect().toBe() assertions
 *
 * If >50% of toBe/toEqual assertions in a test block echo mock values,
 * the test is flagged.
 *
 * Severity: warn
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Tests should not just assert that result.data equals the mock return value — that only proves the mock works',
      category: 'Testing',
    },
    messages: {
      mockEcho:
        'This test appears to echo mock values back in assertions ({{echoCount}}/{{totalCount}} assertions ' +
        'use values defined in the mock setup). Tests should assert transformation, business logic, ' +
        'or side effects — not that the mock framework passes data through. ' +
        'Consider: Does this test break if the production logic changes?',
    },
    schema: [],
  },

  create(context) {
    const filename = context.getFilename();
    if (!filename.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) return {};

    // Phase 1: Collect all literal values used in mock setup
    // Phase 2: Check if those same values appear in assertions

    // Track literal values from mock setup (mockResolvedValue, mockReturnValue, etc.)
    const mockLiterals = new Set();
    let inMockSetup = false;

    // Track test blocks and their assertion stats
    const testBlocks = [];
    let currentTestNode = null;
    let currentEchoCount = 0;
    let currentTotalAssertions = 0;

    // Mock setup method names
    const mockSetupMethods = [
      'mockResolvedValue',
      'mockResolvedValueOnce',
      'mockReturnValue',
      'mockReturnValueOnce',
      'mockImplementation',
    ];

    return {
      // Detect mock setup calls: mockXxx.mockResolvedValue({...})
      'CallExpression[callee.property.name]'(node) {
        const methodName = node.callee.property.name;

        if (mockSetupMethods.includes(methodName)) {
          // Collect all literal values inside the arguments
          collectLiterals(node.arguments, mockLiterals);
        }
      },

      // Also collect literals from top-level const declarations that look like mock data
      VariableDeclarator(node) {
        if (!node.id || node.id.type !== 'Identifier') return;
        const name = node.id.name.toLowerCase();

        // Variables named mock*, fake*, stub*, fixture*
        if (
          name.startsWith('mock') ||
          name.startsWith('fake') ||
          name.startsWith('stub') ||
          name.startsWith('fixture')
        ) {
          if (node.init) {
            collectLiterals([node.init], mockLiterals);
          }
        }
      },

      // Track it/test blocks
      CallExpression(node) {
        const callee = node.callee;
        const isTestBlock =
          (callee.type === 'Identifier' && (callee.name === 'it' || callee.name === 'test')) ||
          (callee.type === 'MemberExpression' &&
           callee.object.type === 'Identifier' &&
           (callee.object.name === 'it' || callee.object.name === 'test'));

        if (isTestBlock && node.arguments.length >= 2) {
          // Save previous test block
          if (currentTestNode) {
            testBlocks.push({
              node: currentTestNode,
              echoCount: currentEchoCount,
              totalAssertions: currentTotalAssertions,
            });
          }
          currentTestNode = node;
          currentEchoCount = 0;
          currentTotalAssertions = 0;
        }
      },

      // Check assertions: expect(x).toBe(literal) or expect(x).toEqual(literal)
      'CallExpression:exit'(node) {
        if (!currentTestNode) return;
        if (node.callee.type !== 'MemberExpression') return;

        const method = node.callee.property;
        if (!method || method.type !== 'Identifier') return;

        // Only check toBe and toEqual with literal args
        if (method.name !== 'toBe' && method.name !== 'toEqual') return;

        if (node.arguments.length === 0) return;
        const assertedValue = node.arguments[0];

        // Skip non-value assertions (toBe(true), toBe(false), toBe(null), toBe(undefined))
        if (assertedValue.type === 'Literal') {
          if (
            assertedValue.value === true ||
            assertedValue.value === false ||
            assertedValue.value === null ||
            assertedValue.value === 0 ||
            assertedValue.value === 1 ||
            assertedValue.value === ''
          ) {
            return; // Trivial values are not echo — they're structural assertions
          }

          currentTotalAssertions++;

          if (mockLiterals.has(assertedValue.value)) {
            currentEchoCount++;
          }
        }

        // Handle toEqual with object literals — check individual properties
        if (method.name === 'toEqual' && assertedValue.type === 'ObjectExpression') {
          let objEchoCount = 0;
          let objTotalProps = 0;

          for (const prop of assertedValue.properties) {
            if (prop.type !== 'Property') continue;
            if (!prop.value || prop.value.type !== 'Literal') continue;
            if (
              prop.value.value === true ||
              prop.value.value === false ||
              prop.value.value === null
            ) {
              continue;
            }

            objTotalProps++;
            if (mockLiterals.has(prop.value.value)) {
              objEchoCount++;
            }
          }

          if (objTotalProps > 0) {
            currentTotalAssertions += objTotalProps;
            currentEchoCount += objEchoCount;
          }
        }
      },

      'Program:exit'() {
        // Save last test block
        if (currentTestNode) {
          testBlocks.push({
            node: currentTestNode,
            echoCount: currentEchoCount,
            totalAssertions: currentTotalAssertions,
          });
        }

        for (const block of testBlocks) {
          // Only flag if there are meaningful assertions and >50% are echoes
          if (
            block.totalAssertions >= 2 &&
            block.echoCount / block.totalAssertions > 0.5
          ) {
            context.report({
              node: block.node,
              messageId: 'mockEcho',
              data: {
                echoCount: String(block.echoCount),
                totalCount: String(block.totalAssertions),
              },
            });
          }
        }
      },
    };
  },
};

/**
 * Recursively collect all literal values from AST nodes.
 * Skips booleans, null, and empty strings (too common to be meaningful).
 */
function collectLiterals(nodes, set) {
  for (const node of nodes) {
    if (!node) continue;

    if (node.type === 'Literal') {
      if (
        node.value !== null &&
        node.value !== true &&
        node.value !== false &&
        node.value !== '' &&
        node.value !== 0 &&
        node.value !== 1
      ) {
        set.add(node.value);
      }
    } else if (node.type === 'ObjectExpression') {
      for (const prop of node.properties) {
        if (prop.type === 'Property' && prop.value) {
          collectLiterals([prop.value], set);
        }
        if (prop.type === 'SpreadElement' && prop.argument) {
          collectLiterals([prop.argument], set);
        }
      }
    } else if (node.type === 'ArrayExpression') {
      collectLiterals(node.elements.filter(Boolean), set);
    } else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      // Walk into the function body for mockImplementation(() => ({ data: ... }))
      if (node.body.type === 'ObjectExpression') {
        collectLiterals([node.body], set);
      } else if (node.body.type === 'BlockStatement') {
        // Skip complex function bodies
      }
    } else if (node.type === 'CallExpression') {
      // Promise.resolve({ data: ... })
      collectLiterals(node.arguments, set);
    }
  }
}
