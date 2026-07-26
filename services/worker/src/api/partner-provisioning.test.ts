/**
 * Tests for the partner-account provisioning state machine (SCRUM-2990).
 *
 * Minimal request -> approve -> provision skeleton with:
 *   - org-scoped RBAC at request AND approval/provision time;
 *   - separation of duties (the requester may not approve their own request);
 *   - a stable UUID id used as the audit target_id for the whole lifecycle;
 *   - an audit event emitted for every transition;
 *   - a cancel-from-approved leg (no stuck 'approved');
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
  cancelApprovedRequest,
  provisionPartnerAccount,
  PartnerProvisioningError,
  type ProvisioningActor,
} from './partner-provisioning.js';

const AT = '2026-07-20T12:00:00Z';

// Real UUIDs — sponsorOrgId must be a UUID (feeds audit org_id + FK).
const SPONSOR_ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const ARKOVA_ORG = '33333333-3333-4333-8333-333333333333';
const PARTNER_ORG = '44444444-4444-4444-8444-444444444444';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requester: ProvisioningActor = { userId: 'user-req', orgId: SPONSOR_ORG, role: 'org_admin' };
const approver: ProvisioningActor = { userId: 'user-appr', orgId: SPONSOR_ORG, role: 'owner' };
const platformAdmin: ProvisioningActor = { userId: 'user-plat', orgId: ARKOVA_ORG, role: 'platform_admin' };
const outsider: ProvisioningActor = { userId: 'user-out', orgId: OTHER_ORG, role: 'org_admin' };

function makeRequest(partnerName = 'HakiChain') {
  return requestPartnerAccount(
    { partnerName, partnerContactEmail: 'ops@hakichain.example', sponsorOrgId: SPONSOR_ORG },
    requester,
    AT,
  );
}

describe('requestPartnerAccount (SCRUM-2990)', () => {
  it('creates a REQUESTED record with a stable UUID id + audit event', () => {
    const { record, audit } = makeRequest();
    expect(record.status).toBe('requested');
    expect(record.id).toMatch(UUID_RE);
    expect(record.partnerName).toBe('HakiChain');
    expect(record.requestedBy).toBe('user-req');
    expect(record.sponsorOrgId).toBe(SPONSOR_ORG);
    expect(audit.event_type).toBe('partner.account.requested');
    expect(audit.event_category).toBe('ORG');
    expect(audit.org_id).toBe(SPONSOR_ORG);
    // target_id is the stable UUID id, never the mutable partner name.
    expect(audit.target_id).toBe(record.id);
  });

  it('rejects a non-UUID sponsorOrgId (audit org_id + FK contract)', () => {
    expect(() =>
      requestPartnerAccount(
        { partnerName: 'X', partnerContactEmail: 'ops@x.example', sponsorOrgId: 'org-sponsor' },
        { userId: 'u', orgId: 'org-sponsor', role: 'platform_admin' },
        AT,
      ),
    ).toThrow(PartnerProvisioningError);
  });

  it('rejects a blank partner name / invalid email', () => {
    expect(() =>
      requestPartnerAccount(
        { partnerName: '  ', partnerContactEmail: 'ops@x.example', sponsorOrgId: SPONSOR_ORG },
        requester,
        AT,
      ),
    ).toThrow(PartnerProvisioningError);
    expect(() =>
      requestPartnerAccount(
        { partnerName: 'X', partnerContactEmail: 'not-an-email', sponsorOrgId: SPONSOR_ORG },
        requester,
        AT,
      ),
    ).toThrow(PartnerProvisioningError);
  });

  it('a long (≤200-char) partner name is fine — target_id stays the UUID (no 120 cap breach)', () => {
    const longName = 'A'.repeat(200);
    const { record, audit } = makeRequest(longName);
    expect(record.partnerName).toBe(longName);
    expect(audit.target_id).toBe(record.id);
    expect(audit.target_id!.length).toBeLessThanOrEqual(120);
  });

  it('request-time RBAC: an outsider may NOT request for a sponsor org they are not in', () => {
    expect(() =>
      requestPartnerAccount(
        { partnerName: 'X', partnerContactEmail: 'ops@x.example', sponsorOrgId: SPONSOR_ORG },
        outsider,
        AT,
      ),
    ).toThrow(/not authorized to request/i);
  });

  it('request-time RBAC: a platform admin may request for any sponsor org', () => {
    const { record } = requestPartnerAccount(
      { partnerName: 'X', partnerContactEmail: 'ops@x.example', sponsorOrgId: SPONSOR_ORG },
      platformAdmin,
      AT,
    );
    expect(record.status).toBe('requested');
  });
});

describe('approvePartnerRequest RBAC + separation of duties', () => {
  it('an owner of the sponsor org may approve; audit target_id is the stable id', () => {
    const { record } = makeRequest();
    const { record: approved, audit } = approvePartnerRequest(record, approver, AT);
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('user-appr');
    expect(approved.id).toBe(record.id);
    expect(audit.event_type).toBe('partner.account.approved');
    expect(audit.target_id).toBe(record.id);
  });

  it('a platform admin may approve', () => {
    const { record } = makeRequest();
    expect(approvePartnerRequest(record, platformAdmin, AT).record.status).toBe('approved');
  });

  it('the requester may NOT approve their own request (separation of duties)', () => {
    const { record } = makeRequest();
    expect(() => approvePartnerRequest(record, requester, AT)).toThrow(/separation of duties|own request/i);
  });

  it('the requester may NOT reject their own request either (SoD covers the reject leg)', () => {
    const { record } = makeRequest();
    expect(() => rejectPartnerRequest(record, requester, 'changed my mind', AT)).toThrow(
      /separation of duties|own request/i,
    );
  });

  it('an outsider (wrong org, not platform admin) may NOT approve', () => {
    const { record } = makeRequest();
    expect(() => approvePartnerRequest(record, outsider, AT)).toThrow(/not authorized|RBAC/i);
  });

  it('a member without owner/admin role may NOT approve', () => {
    const { record } = makeRequest();
    const member: ProvisioningActor = { userId: 'm', orgId: SPONSOR_ORG, role: 'member' };
    expect(() => approvePartnerRequest(record, member, AT)).toThrow(/not authorized|RBAC/i);
  });
});

describe('provisionPartnerAccount', () => {
  it('provisions only an APPROVED request; target_id stays the stable id, org id in details', () => {
    const { record } = makeRequest();
    const { record: approved } = approvePartnerRequest(record, approver, AT);
    const { record: provisioned, audit } = provisionPartnerAccount(
      approved,
      platformAdmin,
      { partnerOrgId: PARTNER_ORG },
      AT,
    );
    expect(provisioned.status).toBe('provisioned');
    expect(provisioned.partnerOrgId).toBe(PARTNER_ORG);
    expect(audit.event_type).toBe('partner.account.provisioned');
    expect(audit.target_id).toBe(record.id);
    expect(audit.details).toContain(PARTNER_ORG);
  });

  it('refuses to provision a request that is not APPROVED (illegal transition)', () => {
    const { record } = makeRequest();
    expect(() =>
      provisionPartnerAccount(record, platformAdmin, { partnerOrgId: PARTNER_ORG }, AT),
    ).toThrow(/illegal transition|not approved/i);
  });

  it('rejects a non-UUID partnerOrgId at provision (review P1)', () => {
    const { record } = makeRequest();
    const { record: approved } = approvePartnerRequest(record, approver, AT);
    expect(() =>
      provisionPartnerAccount(approved, platformAdmin, { partnerOrgId: 'org-haki-new' }, AT),
    ).toThrow(/must be a UUID/i);
  });

  it('a rejected request cannot be approved or provisioned', () => {
    const { record } = makeRequest();
    const { record: rejected, audit } = rejectPartnerRequest(record, approver, 'incomplete KYB', AT);
    expect(rejected.status).toBe('rejected');
    expect(audit.event_type).toBe('partner.account.rejected');
    expect(() => approvePartnerRequest(rejected, approver, AT)).toThrow(/illegal transition/i);
    expect(() =>
      provisionPartnerAccount(rejected, platformAdmin, { partnerOrgId: PARTNER_ORG }, AT),
    ).toThrow(/illegal transition|not approved/i);
  });
});

describe('cancelApprovedRequest (missing-lifecycle leg)', () => {
  it('cancels an approved request (approved -> rejected) with attribution', () => {
    const { record } = makeRequest();
    const { record: approved } = approvePartnerRequest(record, approver, AT);
    const { record: cancelled, audit } = cancelApprovedRequest(approved, approver, 'partner backed out', AT);
    expect(cancelled.status).toBe('rejected');
    expect(cancelled.rejectedBy).toBe('user-appr');
    expect(cancelled.rejectionReason).toContain('cancelled after approval');
    expect(audit.event_type).toBe('partner.account.cancelled');
  });

  it('cannot cancel a request that is not approved', () => {
    const { record } = makeRequest(); // 'requested'
    expect(() => cancelApprovedRequest(record, approver, 'x', AT)).toThrow(/illegal transition/i);
  });

  it('requires approval authority to cancel', () => {
    const { record } = makeRequest();
    const { record: approved } = approvePartnerRequest(record, approver, AT);
    expect(() => cancelApprovedRequest(approved, outsider, 'x', AT)).toThrow(/not authorized|RBAC/i);
  });
});

describe('actor shape validation (review P1 backstop)', () => {
  it('rejects a malformed actor (non-UUID orgId) at a transition', () => {
    const { record } = makeRequest();
    const badActor = { userId: 'x', orgId: 'not-a-uuid', role: 'owner' } as ProvisioningActor;
    expect(() => approvePartnerRequest(record, badActor, AT)).toThrow(/invalid actor/i);
  });

  it('rejects an actor with an unrecognized role', () => {
    const { record } = makeRequest();
    const badActor = { userId: 'x', orgId: SPONSOR_ORG, role: 'superuser' } as unknown as ProvisioningActor;
    expect(() => approvePartnerRequest(record, badActor, AT)).toThrow(/invalid actor/i);
  });
});

describe('audit details bounding', () => {
  it('truncates an over-long rejection reason to the audit cap (no write failure)', () => {
    const { record } = makeRequest();
    const huge = 'z'.repeat(20_000);
    const { record: rejected, audit } = rejectPartnerRequest(record, approver, huge, AT);
    expect(audit.details!.length).toBeLessThanOrEqual(10_000);
    expect(rejected.rejectionReason!.length).toBeLessThanOrEqual(10_000);
  });
});
