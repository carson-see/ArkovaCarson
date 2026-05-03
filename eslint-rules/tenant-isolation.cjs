/**
 * ESLint Rule: tenant-isolation/missing-org-filter
 *
 * Catches Supabase queries against multi-tenant tables that lack a tenant
 * scoping filter. The audit that prompted this rule found three bugs in
 * production:
 *
 *   - services/worker/src/api/v1/webhooks/docusign.ts:41-50
 *     Cross-org integration lookup (accountId alone was not tenant-unique).
 *   - services/worker/src/api/v1/webhooks/ats.ts:137-157
 *     Webhook handler wrote to multi-tenant tables with no org scoping.
 *   - services/worker/src/api/v2/search.ts:64-91
 *     searchOrgs enumerated across tenants.
 *
 * Detection:
 *   1. Match any CallExpression shaped like `X.from('<table>')` where the
 *      literal table name is in MULTI_TENANT_TABLES.
 *   2. Walk forward through the method chain (the CallExpression is the
 *      `object` of the next MemberExpression, whose parent is another
 *      CallExpression, and so on).
 *   3. A read link passes if it is `.eq('org_id', ...)`,
 *      `.eq('organization_id', ...)`, `.is('org_id', null)`, or
 *      `.is('organization_id', null)`. The `.is(..., null)` form is reserved
 *      for explicit system-level rows.
 *   4. A write link passes if `.insert(...)` / `.upsert(...)` includes a
 *      top-level org_id/organization_id key on every literal row object,
 *      including `org_id: null` for explicit system events.
 *   5. Otherwise report at the `.from(...)` call site.
 *
 * False-positive notes:
 *   - `organizations` itself is NOT in the list — reads by `public_id`
 *     are a legitimate cross-tenant pattern for verification.
 *   - The rule only flags statically-resolvable literal table names.
 *     Dynamic strings (`.from(tableName)`) are skipped.
 *   - The rule only inspects the immediate method chain — scoping via a
 *     later RLS policy or a follow-up `.eq()` in a helper is NOT seen
 *     and will be flagged. This is intentional: tenant isolation should
 *     be visible at the query site.
 *
 * Severity: warn (report-only; tracked via SCRUM-1208).
 */

const MULTI_TENANT_TABLES = new Set([
  'org_integrations',
  'integration_events',
  'org_kyb',
  'org_members',
  'org_memberships',
  'subscriptions',
  'org_monthly_allocation',
  'kyb_webhook_nonces',
  'docusign_webhook_nonces',
  'audit_events',
  'organization_rule_events',
  'organization_rule_executions',
  'attestations',
  'public_records',
  'org_tier_entitlements',
  'organization_rules',
  'api_keys',
  'org_api_keys',
]);

const ORG_ID_COLUMNS = new Set(['org_id', 'organization_id']);

function isOrgColumnArg(arg) {
  return arg?.type === 'Literal' && typeof arg.value === 'string' && ORG_ID_COLUMNS.has(arg.value);
}

function objectExpressionHasOrgKey(node) {
  if (!node || node.type !== 'ObjectExpression') return false;

  return node.properties.some((property) => {
    if (property.type !== 'Property') return false;
    const key = property.key;
    if (key.type === 'Identifier') return ORG_ID_COLUMNS.has(key.name);
    if (key.type === 'Literal' && typeof key.value === 'string') return ORG_ID_COLUMNS.has(key.value);
    return false;
  });
}

function writeCallHasOrgScope(node) {
  const rowsArg = node.arguments[0];
  if (objectExpressionHasOrgKey(rowsArg)) return true;
  if (!rowsArg || rowsArg.type !== 'ArrayExpression') return false;
  if (rowsArg.elements.length === 0) return false;
  return rowsArg.elements.every((element) => objectExpressionHasOrgKey(element));
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Supabase queries against multi-tenant tables must include .eq("org_id", ...) or .eq("organization_id", ...) in the method chain.',
      category: 'Security',
    },
    messages: {
      missingOrgFilter:
        "tenant-isolation: query against multi-tenant table '{{table}}' missing .eq('org_id', ...). See SCRUM-1208.",
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        // Match: <anything>.from('<literal>')
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'from') return;
        if (node.arguments.length === 0) return;

        const tableArg = node.arguments[0];
        if (tableArg.type !== 'Literal' || typeof tableArg.value !== 'string') return;

        const table = tableArg.value;
        if (!MULTI_TENANT_TABLES.has(table)) return;

        // Walk the chain forward. Starting node is the `.from('...')` CallExpression.
        // Chain link shape: CallExpression.parent === MemberExpression,
        // whose parent === CallExpression (the next chained call).
        let current = node;
        let hasOrgFilter = false;

        // Safety bound — a chain of 30 calls would already be absurd.
        for (let i = 0; i < 30; i += 1) {
          const parentMember = current.parent;
          if (!parentMember || parentMember.type !== 'MemberExpression') break;
          if (parentMember.object !== current) break;

          const nextCall = parentMember.parent;
          if (!nextCall || nextCall.type !== 'CallExpression') break;
          if (nextCall.callee !== parentMember) break;

          const method = parentMember.property;
          if (method.type === 'Identifier') {
            if ((method.name === 'eq' || method.name === 'is') && nextCall.arguments.length >= 1) {
              if (isOrgColumnArg(nextCall.arguments[0])) {
                hasOrgFilter = true;
                break;
              }
            }

            if ((method.name === 'insert' || method.name === 'upsert') && writeCallHasOrgScope(nextCall)) {
              hasOrgFilter = true;
              break;
            }
          }

          current = nextCall;
        }

        if (!hasOrgFilter) {
          context.report({
            node,
            messageId: 'missingOrgFilter',
            data: { table },
          });
        }
      },
    };
  },
};
