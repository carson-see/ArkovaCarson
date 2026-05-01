# API Key Scope Vocabulary

> Status: Canonical | Story: SCRUM-1581

The canonical API key scope vocabulary lives in `services/worker/src/api/apiScopes.ts`.

That module feeds:

- worker key creation validation,
- worker agent delegation validation,
- worker route scope checks,
- frontend scope labels and badges,
- the frontend create-key picker,
- the SQL CHECK constraint in `supabase/migrations/0283_api_key_scope_vocabulary.sql`.

## API v2 Scopes

These scopes are visible in the create-key picker for new API keys.

| Scope | Purpose |
|---|---|
| `read:search` | Search organizations, records, fingerprints, and documents. |
| `read:records` | Verify fingerprints and inspect records, fingerprints, documents, and anchors. |
| `read:orgs` | List and inspect organization context. |
| `write:anchors` | Reserved v2 anchor-write permission. |
| `admin:rules` | Reserved v2 rules-admin permission. |

Default new key scope: `read:search`.

## Accepted Legacy Scopes

These remain accepted for backward compatibility. They are displayable but not offered as new-key picker choices.

| Scope | Purpose |
|---|---|
| `verify` | Legacy v1 verify/read permission. Also satisfies `anchor:read`, `oracle:read`, and `attestations:read` for compatibility. |
| `verify:batch` | Legacy v1 batch verification permission. |
| `usage:read` | Legacy usage endpoint permission. |
| `keys:manage` | Legacy key-management permission. |

Short aliases such as `batch` and `usage` are not canonical API key scopes and should not be newly stored.

Historical agent delegation aliases `attest` and `oracle` are also non-canonical. Migration `0283_api_key_scope_vocabulary.sql` normalizes existing agent rows from `attest` to `attestations:write` and from `oracle` to `oracle:read`; new agent registrations validate against the API key vocabulary.

## Accepted Compliance And Management Scopes

These are accepted by the worker and database and can be displayed in the UI, but are not offered in the public create-key picker until the product flow explicitly supports them.

| Scope | Purpose |
|---|---|
| `compliance:read` | Read compliance surfaces. |
| `compliance:write` | Write compliance surfaces. |
| `oracle:read` | Read Oracle verification surfaces. |
| `oracle:write` | Write Oracle surfaces. |
| `anchor:read` | Read anchor metadata. |
| `anchor:write` | Submit or mutate anchors. |
| `attestations:read` | Read attestations. |
| `attestations:write` | Create or modify attestations. |
| `webhooks:manage` | Manage webhook endpoints. |
| `agents:manage` | Manage agent registrations. |
| `keys:read` | Read key metadata. |

## Change Checklist

When adding, renaming, or removing a scope:

1. Update `services/worker/src/api/apiScopes.ts`.
2. Update frontend labels and badge classes in `src/lib/apiScopes.ts` and `src/lib/copy.ts`.
3. Add a new SQL migration replacing `api_keys_scopes_known_values`.
4. Update this page and relevant API docs.
5. Run worker scope tests and the API contract drift guard.
