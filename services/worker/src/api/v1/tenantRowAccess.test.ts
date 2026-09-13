import { describe, it, expect } from 'vitest';
import { callerMayReadRow } from './tenantRowAccess.js';

const ORG_A = '10000000-1000-4000-8000-0000000000aa';
const ORG_B = '10000000-1000-4000-8000-0000000000bb';
const USER_1 = '10000000-1000-4000-8000-000000000001';
const USER_2 = '10000000-1000-4000-8000-000000000002';

describe('callerMayReadRow (SCRUM-4984 fail-closed tenant access)', () => {
  it('allows a row in the caller org', () => {
    expect(callerMayReadRow({ org_id: ORG_A, user_id: USER_2 }, { userId: USER_1, orgId: ORG_A })).toBe(true);
  });

  it('allows a row the caller owns even with no org on either side', () => {
    expect(callerMayReadRow({ org_id: null, user_id: USER_1 }, { userId: USER_1, orgId: null })).toBe(true);
  });

  it('denies a row from another org', () => {
    expect(callerMayReadRow({ org_id: ORG_B, user_id: USER_2 }, { userId: USER_1, orgId: ORG_A })).toBe(false);
  });

  it('denies when the caller has no org and does not own the row (the former fail-open case)', () => {
    expect(callerMayReadRow({ org_id: ORG_B, user_id: USER_2 }, { userId: USER_1, orgId: null })).toBe(false);
  });

  it('denies when the row has no org and no owner (orphan row)', () => {
    expect(callerMayReadRow({ org_id: null, user_id: null }, { userId: USER_1, orgId: ORG_A })).toBe(false);
  });

  it('denies when org_id was never selected (undefined) and the caller is not the owner', () => {
    expect(callerMayReadRow({}, { userId: USER_1, orgId: ORG_A })).toBe(false);
  });
});
