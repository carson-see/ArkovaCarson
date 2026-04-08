/**
 * ESLint Rule: require-error-code-assertion
 *
 * Flags test blocks (it/test) that check for error responses
 * (ok === false, error !== null, .error, status 4xx/5xx)
 * but never assert the specific error code, status, or message.
 *
 * Just checking "it failed" is insufficient — tests must verify
 * the code fails with the RIGHT error.
 *
 * Severity: warn
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Tests that check for errors must also assert the specific error code, status, or message',
      category: 'Testing',
    },
    messages: {
      missingErrorCode:
        'This test checks for an error condition (ok === false, error !== null, toBeNull on error path) ' +
        'but never asserts the specific error code, HTTP status, or error message. ' +
        'Add an assertion like: expect(result.status).toBe(403) or ' +
        'expect(error.code).toBe(\'PGRST301\') or expect(error.message).toContain(\'...\').',
    },
    schema: [],
  },

  create(context) {
    const filename = context.getFilename();
    if (!filename.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) return {};

    // We analyze each it/test block separately
    const testBlocks = [];
    let currentTestBlock = null;

    return {
      // Enter an it() or test() block
      CallExpression(node) {
        const callee = node.callee;
        const isTestBlock =
          (callee.type === 'Identifier' && (callee.name === 'it' || callee.name === 'test')) ||
          (callee.type === 'MemberExpression' &&
           callee.object.type === 'Identifier' &&
           (callee.object.name === 'it' || callee.object.name === 'test'));

        if (isTestBlock && node.arguments.length >= 2) {
          const testName =
            node.arguments[0].type === 'Literal'
              ? String(node.arguments[0].value)
              : node.arguments[0].type === 'TemplateLiteral'
                ? 'template'
                : '';

          // Only flag tests whose name suggests they test error paths
          const nameLC = testName.toLowerCase();
          const isErrorTest =
            nameLC.includes('error') ||
            nameLC.includes('fail') ||
            nameLC.includes('denied') ||
            nameLC.includes('reject') ||
            nameLC.includes('invalid') ||
            nameLC.includes('unauthorized') ||
            nameLC.includes('forbidden') ||
            nameLC.includes('not found') ||
            nameLC.includes('404') ||
            nameLC.includes('403') ||
            nameLC.includes('401') ||
            nameLC.includes('500');

          if (isErrorTest) {
            currentTestBlock = {
              node,
              hasErrorCheck: false,
              hasSpecificAssertion: false,
            };
            testBlocks.push(currentTestBlock);
          }
        }
      },

      // Look for error-checking assertions within the current scope
      MemberExpression(node) {
        if (!currentTestBlock) return;

        const prop = node.property;
        if (prop.type !== 'Identifier') return;

        // Detect access to error-related properties
        const errorProps = ['error', 'ok', 'status'];
        if (errorProps.includes(prop.name)) {
          currentTestBlock.hasErrorCheck = true;
        }

        // Detect specific error assertions: .code, .message, .status, .statusCode, .statusText
        const specificProps = ['code', 'message', 'statusCode', 'statusText', 'detail'];
        if (specificProps.includes(prop.name)) {
          // Check if this is inside an expect chain
          let parent = node.parent;
          let depth = 0;
          while (parent && depth < 8) {
            if (
              parent.type === 'CallExpression' &&
              parent.callee.type === 'MemberExpression' &&
              parent.callee.property.type === 'Identifier' &&
              (parent.callee.property.name === 'toBe' ||
               parent.callee.property.name === 'toEqual' ||
               parent.callee.property.name === 'toContain' ||
               parent.callee.property.name === 'toMatch' ||
               parent.callee.property.name === 'toStrictEqual' ||
               parent.callee.property.name === 'toBeDefined' ||
               parent.callee.property.name === 'toHaveBeenCalledWith')
            ) {
              currentTestBlock.hasSpecificAssertion = true;
              break;
            }
            // Also check if the parent is an expect() call
            if (
              parent.type === 'CallExpression' &&
              parent.callee.type === 'Identifier' &&
              parent.callee.name === 'expect'
            ) {
              currentTestBlock.hasSpecificAssertion = true;
              break;
            }
            parent = parent.parent;
            depth++;
          }
        }
      },

      // Detect toBe(403), toBe(404), etc. — numeric status code assertions
      Literal(node) {
        if (!currentTestBlock) return;
        if (typeof node.value !== 'number') return;

        // HTTP status codes
        if (node.value >= 400 && node.value < 600) {
          let parent = node.parent;
          let depth = 0;
          while (parent && depth < 6) {
            if (
              parent.type === 'CallExpression' &&
              parent.callee.type === 'MemberExpression' &&
              parent.callee.property.type === 'Identifier' &&
              parent.callee.property.name === 'toBe'
            ) {
              currentTestBlock.hasSpecificAssertion = true;
              break;
            }
            parent = parent.parent;
            depth++;
          }
        }
      },

      // Detect toContain('specific error text') — string error message assertions
      'CallExpression[callee.property.name="toContain"]'(node) {
        if (!currentTestBlock) return;
        if (
          node.arguments.length > 0 &&
          node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string' &&
          node.arguments[0].value.length > 3
        ) {
          currentTestBlock.hasSpecificAssertion = true;
        }
      },

      // Detect expect(x.error).toBe('some string') — asserting error content
      'CallExpression[callee.property.name="toBe"]'(node) {
        if (!currentTestBlock) return;
        if (
          node.arguments.length > 0 &&
          node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string' &&
          node.arguments[0].value.length > 3
        ) {
          // Walk up to find the expect() call and check if it accesses error-related properties
          let parent = node.callee.object; // the expect(...) call
          if (parent && parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'expect') {
            const expectArg = parent.arguments[0];
            if (expectArg && isErrorPropertyAccess(expectArg)) {
              currentTestBlock.hasSpecificAssertion = true;
            }
          }
        }
      },

      // Detect expect.objectContaining with error fields
      'CallExpression[callee.property.name="objectContaining"]'(node) {
        if (!currentTestBlock) return;
        if (node.arguments.length > 0 && node.arguments[0].type === 'ObjectExpression') {
          for (const prop of node.arguments[0].properties) {
            if (
              prop.type === 'Property' &&
              prop.key.type === 'Identifier' &&
              (prop.key.name === 'code' ||
               prop.key.name === 'message' ||
               prop.key.name === 'status' ||
               prop.key.name === 'statusCode')
            ) {
              currentTestBlock.hasSpecificAssertion = true;
            }
          }
        }
      },

      'Program:exit'() {
        for (const block of testBlocks) {
          if (block.hasErrorCheck && !block.hasSpecificAssertion) {
            context.report({
              node: block.node,
              messageId: 'missingErrorCode',
            });
          }
        }
      },
    };
  },
};

/**
 * Check if an AST node represents accessing an error-related property.
 * e.g., result.current.error, response.error, err.message, x.code
 */
function isErrorPropertyAccess(node) {
  const errorProps = ['error', 'message', 'code', 'status', 'statusCode', 'detail'];
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    if (errorProps.includes(node.property.name)) return true;
    // Check nested: result.current.error
    return isErrorPropertyAccess(node.object);
  }
  // Optional chaining: result.current?.error
  if (node.type === 'ChainExpression') {
    return isErrorPropertyAccess(node.expression);
  }
  return false;
}
