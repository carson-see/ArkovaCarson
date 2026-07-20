/**
 * Tests for the partner-account provisioning state machine (SCRUM-2990).
 *
 * Minimal request -> approve -> provision skeleton with:
 *   - org-scoped RBAC (only a platform admin or the sponsoring org's owner/admin
 *     may approve/reject/provision);
 *   - separation of duties (the requester may not approve their own request);
 *   - an audit event emitted for every transition;
 *   - NO SCIM / SAML (out of scope — explicit).
 *
 * Pure + injection-based: no DB, no clock. The API layer persists the returned
 * record + audit event; this module owns the legality of every transition.
 * The Aug-9 HakiChain demo org will be created THROUGH this flow.
 */

import { describe, it, expect } from 'vitest';
import {
  requestPartnerAccount,
  approvePartnerRequest,
  rejectPartnerRequest,
  provisionPartnerAccount,
  PartnerProvisioningError,
  type ProvisioningActor,
} from './partner-provisioning.js';

const AT = '2026-07-20T12:00:00Z';

const requester: ProvisioningActor = {
  userId: 'user-req',
  orgId: 'org-sponsor',
  role: 'org_admin',
};
const approver: ProvisioningActor = {
  userId: 'user-appr',
  orgId: 'org-sponsor',
  role: 'owner',
};
const platformAdmin: ProvisioningActor = {
  userId: 'user-plat',
  orgId: 'org-arkova',
  role: 'platform_admin',
};
const outsider: ProvisioningActor = {
  userId: 'user-out',
  orgId: 'org-other',
  role: 'org_admin',
};

function makeRequest() {
  return requestPartnerAccount(
    {
      partnerName: 'HakiChain',
      partnerContactEmail: 'ops@hakichain.example',
      sponsorOrgId: 'org-sponsor',
    },
    requester,
    AT,
  );
}

describe('requestPartnerAccount (SCRUM-2990)', () => {
  it('creates a REQUESTED record + audit event', () => {
    const { record, audit } = makeRequest();
    expect(record.status).toBe('requested');
    expect(record.partnerName).toBe('HakiChain');
    expect(record.requestedBy).toBe('user-req');
    expect(record.sponsorOrgId).toBe('org-sponsor');
    expect(audit.event_type).toBe('partner.account.requested');
    expect(audit.event_category).toBe('ORG');
    expect(audit.org_id).toBe('org-sponsor');
  });

  it('rejects a blank partner name / invalid email', () => {
    expect(() =>
      requestPartnerAccount(
        { partnerName: '  ', partnerContactEmail: 'ops@x.example', sponsorOrgId: 'o' },
        requester,
        AT,
      ),
    ).toThrow(PartnerProvisioningError);
    expect(() =>
      requestPartnerAccount(
        { partnerName: 'X', partnerContactEmail: 'not-an-email', sponsorOrgId: 'o' },
        requester,
        AT,
      ),
    ).toThrow(PartnerProvisioningError);
  });
});

describe('approvePartnerRequest RBAC + separation of duties', () => {
  it('an owner of the sponsor org may approve', () => {
    const { record } = makeRequest();
    const { record: approved, audit } = approvePartnerRequest(record, approver, AT);
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('user-appr');
    expect(audit.event_type).toBe('partner.account.approved');
  });

  it('a platform admin may approve', () => {
    const { record } = makeRequest();
    expect(approvePartnerRequest(record, platformAdmin, AT).record.status).toBe('approved');
  });

  it('the requester may NOT approve their own request (separation of duties)', () => {
    const { record } = makeRequest();
    expect(() => approvePartnerRequest(record, requester, AT)).toThrow(/separation of duties|own request/i);
  });

  it('an outsider (wrong org, not platform admin) may NOT approve', () => {
    const { record } = makeRequest();
    expect(() => approvePartnerRequest(record, outsider, AT)).toThrow(/not authorized|RBAC/i);
  });

  it('a member without owner/admin role may NOT approve', () => {
    const { record } = makeRequest();
    const member: ProvisioningActor = { userId: 'm', orgId: 'org-sponsor', role: 'member' };
    expect(() => approvePartnerRequest(record, member, AT)).toThrow(/not authorized|RBAC/i);
  });
});

describe('provisionPartnerAccount', () => {
  it('provisions only an APPROVED request, minting a partner org id', () => {
    const { record } = makeRequest();
    const { record: approved } = approvePartnerRequest(record, approver, AT);
    const { record: provisioned, audit } = provisionPartnerAccount(
      approved,
      platformAdmin,
      { partnerOrgId: 'org-haki-new' },
      AT,
    );
    expect(provisioned.status).toBe('provisioned');
    expect(provisioned.partnerOrgId).toBe('org-haki-new');
    expect(audit.event_type).toBe('partner.account.provisioned');
    expect(audit.target_id).toBe('org-haki-new');
  });

  it('refuses to provision a request that is not APPROVED (illegal transition)', () => {
    const { record } = makeRequest(); // still 'requested'
    expect(() =>
      provisionPartnerAccount(record, platformAdmin, { partnerOrgId: 'x' }, AT),
    ).toThrow(/illegal transition|not approved/i);
  });

  it('a rejected request cannot be approved or provisioned', () => {
    const { record } = makeRequest();
    const { record: rejected, audit } = rejectPartnerRequest(record, approver, 'incomplete KYB', AT);
    expect(rejected.status).toBe('rejected');
    expect(audit.event_type).toBe('partner.account.rejected');
    expect(() => approvePartnerRequest(rejected, approver, AT)).toThrow(/illegal transition/i);
    expect(() =>
      provisionPartnerAccount(rejected, platformAdmin, { partnerOrgId: 'x' }, AT),
    ).toThrow(/illegal transition|not approved/i);
  });
});
