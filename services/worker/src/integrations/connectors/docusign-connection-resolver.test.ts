import { describe, expect, it, vi } from 'vitest';

import {
  resolveEffectiveDocusignConnection,
  DocusignConnectionResolutionError,
  type DocusignConnectionResolverDeps,
} from './docusign-connection-resolver.js';

const PARENT_ORG = '11111111-1111-4111-8111-111111111111';
const SUB_ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';

const OWN_ROW = {
  id: 'own-int',
  org_id: SUB_ORG,
  account_id: 'acct-sub',
  base_uri: 'https://na1.docusign.net',
  token_secret_name: 'projects/p/secrets/sub-refresh',
  inherited_from_org_id: null as string | null,
};

const PARENT_ROW = {
  id: 'parent-int',
  org_id: PARENT_ORG,
  account_id: 'acct-parent',
  base_uri: 'https://na2.docusign.net',
  token_secret_name: 'projects/p/secrets/parent-refresh',
  inherited_from_org_id: null as string | null,
};

const MARKER_ROW = {
  id: 'marker-int',
  org_id: SUB_ORG,
  inherited_from_org_id: PARENT_ORG,
};

function makeDeps(
  overrides: Partial<DocusignConnectionResolverDeps> = {},
): DocusignConnectionResolverDeps {
  return {
    fetchOwnConnection: vi.fn().mockResolvedValue(null),
    fetchInheritanceMarker: vi.fn().mockResolvedValue(null),
    fetchParentOrgId: vi.fn().mockResolvedValue(null),
    fetchParentOwnConnection: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const REQUEST = {
  orgId: SUB_ORG,
  accountId: 'acct-sub',
  integrationId: 'own-int',
};

describe('resolveEffectiveDocusignConnection', () => {
  it('returns the org own connection without consulting inheritance', async () => {
    const deps = makeDeps({ fetchOwnConnection: vi.fn().mockResolvedValue(OWN_ROW) });

    const result = await resolveEffectiveDocusignConnection({ ...REQUEST, deps });

    expect(result).toEqual({
      source: 'own',
      ownerOrgId: SUB_ORG,
      requestedOrgId: SUB_ORG,
      integrationId: 'own-int',
      accountId: 'acct-sub',
      baseUri: 'https://na1.docusign.net',
      tokenSecretName: 'projects/p/secrets/sub-refresh',
    });
    expect(deps.fetchOwnConnection).toHaveBeenCalledWith({
      orgId: SUB_ORG,
      accountId: 'acct-sub',
      integrationId: 'own-int',
    });
    // Own connection short-circuits — never touches inheritance lookups.
    expect(deps.fetchInheritanceMarker).not.toHaveBeenCalled();
    expect(deps.fetchParentOrgId).not.toHaveBeenCalled();
    expect(deps.fetchParentOwnConnection).not.toHaveBeenCalled();
  });

  it('resolves to the parent connection when the sub-org holds a valid inheritance marker', async () => {
    const deps = makeDeps({
      fetchInheritanceMarker: vi.fn().mockResolvedValue(MARKER_ROW),
      fetchParentOrgId: vi.fn().mockResolvedValue(PARENT_ORG),
      fetchParentOwnConnection: vi.fn().mockResolvedValue(PARENT_ROW),
    });

    const result = await resolveEffectiveDocusignConnection({ ...REQUEST, deps });

    expect(result).toEqual({
      source: 'inherited',
      ownerOrgId: PARENT_ORG,
      requestedOrgId: SUB_ORG,
      integrationId: 'parent-int',
      accountId: 'acct-parent',
      baseUri: 'https://na2.docusign.net',
      tokenSecretName: 'projects/p/secrets/parent-refresh',
    });
    expect(deps.fetchParentOwnConnection).toHaveBeenCalledWith(PARENT_ORG, 'acct-sub');
  });

  it('throws not_found when there is neither an own connection nor a marker', async () => {
    const deps = makeDeps();

    await expect(resolveEffectiveDocusignConnection({ ...REQUEST, deps })).rejects.toMatchObject({
      code: 'docusign_integration_not_found',
    });
  });

  it('rejects a marker whose claimed parent does not match the actual parent (cross-tenant guard)', async () => {
    const deps = makeDeps({
      fetchInheritanceMarker: vi.fn().mockResolvedValue({ ...MARKER_ROW, inherited_from_org_id: OTHER_ORG }),
      fetchParentOrgId: vi.fn().mockResolvedValue(PARENT_ORG),
      fetchParentOwnConnection: vi.fn().mockResolvedValue(PARENT_ROW),
    });

    await expect(resolveEffectiveDocusignConnection({ ...REQUEST, deps })).rejects.toMatchObject({
      code: 'docusign_inherited_parent_mismatch',
    });
    // Must not fetch parent credentials once the guard fails.
    expect(deps.fetchParentOwnConnection).not.toHaveBeenCalled();
  });

  it('rejects an orphaned marker on an org that has no parent', async () => {
    const deps = makeDeps({
      fetchInheritanceMarker: vi.fn().mockResolvedValue(MARKER_ROW),
      fetchParentOrgId: vi.fn().mockResolvedValue(null),
    });

    await expect(resolveEffectiveDocusignConnection({ ...REQUEST, deps })).rejects.toMatchObject({
      code: 'docusign_inherited_parent_mismatch',
    });
  });

  it('throws parent_not_connected when the parent has no own DocuSign connection', async () => {
    const deps = makeDeps({
      fetchInheritanceMarker: vi.fn().mockResolvedValue(MARKER_ROW),
      fetchParentOrgId: vi.fn().mockResolvedValue(PARENT_ORG),
      fetchParentOwnConnection: vi.fn().mockResolvedValue(null),
    });

    await expect(resolveEffectiveDocusignConnection({ ...REQUEST, deps })).rejects.toMatchObject({
      code: 'docusign_inherited_parent_not_connected',
    });
  });

  it('refuses to chain inheritance when the parent connection is itself inherited', async () => {
    const deps = makeDeps({
      fetchInheritanceMarker: vi.fn().mockResolvedValue(MARKER_ROW),
      fetchParentOrgId: vi.fn().mockResolvedValue(PARENT_ORG),
      fetchParentOwnConnection: vi
        .fn()
        .mockResolvedValue({ ...PARENT_ROW, inherited_from_org_id: OTHER_ORG }),
    });

    await expect(resolveEffectiveDocusignConnection({ ...REQUEST, deps })).rejects.toMatchObject({
      code: 'docusign_inherited_parent_not_own',
    });
  });

  it('passes the payload accountId to fetchParentOwnConnection so a parent with multiple accounts selects the correct one', async () => {
    const PARENT_ACCOUNT_A = 'acct-parent-A';
    const PARENT_ACCOUNT_B = 'acct-parent-B';

    const parentRowA = {
      id: 'parent-int-A',
      org_id: PARENT_ORG,
      account_id: PARENT_ACCOUNT_A,
      base_uri: 'https://na1.docusign.net',
      token_secret_name: 'projects/p/secrets/parent-A-refresh',
      inherited_from_org_id: null as string | null,
    };
    const parentRowB = {
      id: 'parent-int-B',
      org_id: PARENT_ORG,
      account_id: PARENT_ACCOUNT_B,
      base_uri: 'https://na2.docusign.net',
      token_secret_name: 'projects/p/secrets/parent-B-refresh',
      inherited_from_org_id: null as string | null,
    };

    // Simulate a DB-level filtered lookup: only returns the row matching accountId.
    const fetchParentOwnConnection = vi.fn().mockImplementation(
      (_parentOrgId: string, accountId: string) =>
        Promise.resolve(accountId === PARENT_ACCOUNT_A ? parentRowA : accountId === PARENT_ACCOUNT_B ? parentRowB : null),
    );

    const depsA = makeDeps({
      fetchInheritanceMarker: vi.fn().mockResolvedValue(MARKER_ROW),
      fetchParentOrgId: vi.fn().mockResolvedValue(PARENT_ORG),
      fetchParentOwnConnection,
    });

    // Request carrying account A should resolve to parent row A.
    const resultA = await resolveEffectiveDocusignConnection({
      orgId: SUB_ORG,
      accountId: PARENT_ACCOUNT_A,
      integrationId: 'some-int',
      deps: depsA,
    });
    expect(resultA.accountId).toBe(PARENT_ACCOUNT_A);
    expect(resultA.integrationId).toBe('parent-int-A');
    expect(fetchParentOwnConnection).toHaveBeenCalledWith(PARENT_ORG, PARENT_ACCOUNT_A);

    // Request carrying account B should resolve to parent row B.
    const resultB = await resolveEffectiveDocusignConnection({
      orgId: SUB_ORG,
      accountId: PARENT_ACCOUNT_B,
      integrationId: 'some-int',
      deps: depsA,
    });
    expect(resultB.accountId).toBe(PARENT_ACCOUNT_B);
    expect(resultB.integrationId).toBe('parent-int-B');
    expect(fetchParentOwnConnection).toHaveBeenCalledWith(PARENT_ORG, PARENT_ACCOUNT_B);
  });

  it('exposes the error type for instanceof checks', async () => {
    const deps = makeDeps();
    const err = await resolveEffectiveDocusignConnection({ ...REQUEST, deps }).catch((e) => e);
    expect(err).toBeInstanceOf(DocusignConnectionResolutionError);
  });
});
