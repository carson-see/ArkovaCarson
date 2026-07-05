/**
 * DocuSign sub-org connection resolution (SCRUM-2045 [DS-SUBORG-01]).
 *
 * A sub-organization can either hold its OWN DocuSign connection or INHERIT its
 * direct parent's connection via an inheritance-marker row in `org_integrations`
 * (`inherited_from_org_id` set, no own credentials). This module resolves which
 * org's credentials a DocuSign envelope job should actually use, while keeping
 * the event attributed to the requesting sub-org.
 *
 * Pure + dependency-injected: it performs no DB/IO itself. The caller supplies
 * the three lookups, which makes every branch — including the cross-tenant guard
 * and the no-chaining rule — unit-testable without a database. The DB-level
 * trigger added in migration 0328 enforces the same parent-linkage invariant at
 * write time; the read-time guard here is defense-in-depth against parent
 * reassignment after the marker was created.
 */

export type DocusignConnectionSource = 'own' | 'inherited';

/**
 * DS-04 (SCRUM-2364): queue scope for a resolved DocuSign connection.
 *
 * - `'org'`  — the envelope is connected under ORG POLICY: either an
 *   org_integrations row the org owns, or a parent org's inherited connection.
 *   Materialized artifacts route to the org queue.
 * - `'member'` — a personal per-member connection (member_integrations row).
 *   The completed envelope routes to that member's PERSONAL queue and both the
 *   token lookup and queue materialization are scoped to `ownerUserId`.
 *
 * Precedence mirrors the webhook `findIntegration` + the resolver's own-first
 * lookup: an org_integrations match ALWAYS wins over a member_integrations one,
 * so "connected under org policy" is authoritative and a member envelope only
 * falls through to the personal queue when no org connection claims it.
 */
export type DocusignQueueScope = 'org' | 'member';

export interface DocusignConnectionRow {
  id: string;
  org_id: string;
  account_id: string | null;
  base_uri: string | null;
  token_secret_name: string | null;
  inherited_from_org_id: string | null;
  /**
   * DS-04: the owning user for a member_integrations (personal) connection.
   * NULL for org_integrations rows. Set ⇒ the connection is member-scoped.
   */
  owner_user_id?: string | null;
}

export interface DocusignInheritanceMarkerRow {
  id: string;
  org_id: string;
  inherited_from_org_id: string | null;
}

export interface DocusignEffectiveConnection {
  source: DocusignConnectionSource;
  /** Org that actually owns the credentials (parent org when inherited). */
  ownerOrgId: string;
  /** Org the inbound event is attributed to (always the requesting org). */
  requestedOrgId: string;
  integrationId: string;
  accountId: string | null;
  baseUri: string | null;
  tokenSecretName: string | null;
  /**
   * DS-04: queue routing scope. `'member'` for a personal member connection,
   * `'org'` for an org-owned or parent-inherited (org-policy) connection.
   */
  scope: DocusignQueueScope;
  /**
   * DS-04: the member who owns a personal connection. Set only when
   * `scope === 'member'`; NULL for org/inherited connections. Downstream
   * materialization keys the personal queue on this id.
   */
  ownerUserId: string | null;
}

export interface DocusignConnectionResolverDeps {
  fetchOwnConnection: (args: {
    orgId: string;
    accountId: string;
    integrationId: string;
  }) => Promise<DocusignConnectionRow | null>;
  fetchInheritanceMarker: (orgId: string) => Promise<DocusignInheritanceMarkerRow | null>;
  fetchParentOrgId: (orgId: string) => Promise<string | null>;
  fetchParentOwnConnection: (args: {
    parentOrgId: string;
    accountId: string;
  }) => Promise<DocusignConnectionRow | null>;
}

export type DocusignConnectionResolutionErrorCode =
  | 'docusign_integration_not_found'
  | 'docusign_inherited_parent_mismatch'
  | 'docusign_inherited_parent_not_connected'
  | 'docusign_inherited_parent_not_own';

export class DocusignConnectionResolutionError extends Error {
  readonly code: DocusignConnectionResolutionErrorCode;

  constructor(code: DocusignConnectionResolutionErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'DocusignConnectionResolutionError';
    this.code = code;
  }
}

export interface ResolveEffectiveDocusignConnectionArgs {
  orgId: string;
  accountId: string;
  integrationId: string;
  deps: DocusignConnectionResolverDeps;
}

export async function resolveEffectiveDocusignConnection(
  args: ResolveEffectiveDocusignConnectionArgs,
): Promise<DocusignEffectiveConnection> {
  const { orgId, accountId, integrationId, deps } = args;

  const own = await deps.fetchOwnConnection({ orgId, accountId, integrationId });
  if (own) {
    // DS-04: a member_integrations row carries owner_user_id ⇒ personal queue.
    // An org_integrations row leaves it null ⇒ org queue (org policy).
    const ownerUserId = own.owner_user_id ?? null;
    return {
      source: 'own',
      ownerOrgId: orgId,
      requestedOrgId: orgId,
      integrationId: own.id,
      accountId: own.account_id,
      baseUri: own.base_uri,
      tokenSecretName: own.token_secret_name,
      scope: ownerUserId ? 'member' : 'org',
      ownerUserId,
    };
  }

  const marker = await deps.fetchInheritanceMarker(orgId);
  if (!marker) {
    throw new DocusignConnectionResolutionError('docusign_integration_not_found');
  }

  // Cross-tenant guard (mirrors allocate_credits_to_sub_org): the marker's
  // claimed parent must equal the org's actual parent. Catches an orphaned org
  // and a marker left stale by a parent reassignment.
  const actualParentOrgId = await deps.fetchParentOrgId(orgId);
  if (!actualParentOrgId || actualParentOrgId !== marker.inherited_from_org_id) {
    throw new DocusignConnectionResolutionError('docusign_inherited_parent_mismatch');
  }

  const parent = await deps.fetchParentOwnConnection({ parentOrgId: actualParentOrgId, accountId });
  if (!parent) {
    throw new DocusignConnectionResolutionError('docusign_inherited_parent_not_connected');
  }
  // No chaining: the parent must hold its own credentials, not itself inherit.
  if (parent.inherited_from_org_id !== null) {
    throw new DocusignConnectionResolutionError('docusign_inherited_parent_not_own');
  }

  // Inheritance is org policy by definition — the child org consumes the
  // parent org's connection. A member (personal) connection is never inherited,
  // so this branch is always org-scoped.
  return {
    source: 'inherited',
    ownerOrgId: actualParentOrgId,
    requestedOrgId: orgId,
    integrationId: parent.id,
    accountId: parent.account_id,
    baseUri: parent.base_uri,
    tokenSecretName: parent.token_secret_name,
    scope: 'org',
    ownerUserId: null,
  };
}
