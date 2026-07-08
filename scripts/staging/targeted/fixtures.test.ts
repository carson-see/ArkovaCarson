import { describe, expect, it } from 'vitest';

import {
  buildSecuredUnbatchedAnchor,
  buildDlqFixtureRow,
  buildOrgAndAdminProfile,
  FIXTURE_TAG,
  isSyntheticFixture,
  type FixtureExecutor,
} from './fixtures';

describe('fixtures: SECURED-but-unbatched anchor (NO_BATCH_PROOF branch, #1439)', () => {
  it('produces a SECURED anchor with a chain tx but no proof row', () => {
    const row = buildSecuredUnbatchedAnchor({ orgId: 'org-1', userId: 'user-1' });
    // SECURED so the record EXISTS (not 404 RECORD_NOT_FOUND) ...
    expect(row.status).toBe('SECURED');
    // ... has an on-chain receipt ...
    expect(row.chain_tx_id).toBeTruthy();
    // ... but the driver must NOT also seed an anchor_proofs row, so the proof
    // endpoint takes the "no batch proof" branch.
    expect(row).not.toHaveProperty('proof_path');
    expect(row).not.toHaveProperty('merkle_root');
  });

  it('uses a 64-hex fingerprint and a clearly-synthetic public_id', () => {
    const row = buildSecuredUnbatchedAnchor({ orgId: 'org-1', userId: 'user-1' });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.public_id).toMatch(new RegExp(`^${FIXTURE_TAG}`));
    expect(isSyntheticFixture(row.public_id)).toBe(true);
  });

  it('threads through the supplied org/user for tenant isolation', () => {
    const row = buildSecuredUnbatchedAnchor({ orgId: 'org-42', userId: 'user-9' });
    expect(row.org_id).toBe('org-42');
    expect(row.user_id).toBe('user-9');
  });

  it('generates a unique public_id per call', () => {
    const a = buildSecuredUnbatchedAnchor({ orgId: 'o', userId: 'u' });
    const b = buildSecuredUnbatchedAnchor({ orgId: 'o', userId: 'u' });
    expect(a.public_id).not.toBe(b.public_id);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('fixtures: DLQ row (webhooks self-service dlq/resolve branch, #1443)', () => {
  it('produces an unresolved dead-letter row scoped to the org', () => {
    const row = buildDlqFixtureRow({ orgId: 'org-1', endpointId: 'ep-1' });
    expect(row.org_id).toBe('org-1');
    expect(row.endpoint_id).toBe('ep-1');
    expect(row.resolved).toBe(false);
    expect(row.resolved_at).toBeNull();
    // localhost URL cannot resolve outside the host — SSRF-safe synthetic.
    expect(row.endpoint_url).toMatch(/^http:\/\/localhost/);
    expect(row.payload).toBeTypeOf('object');
  });

  it('marks the event_id as a synthetic fixture', () => {
    const row = buildDlqFixtureRow({ orgId: 'o', endpointId: 'e' });
    expect(isSyntheticFixture(row.event_id)).toBe(true);
  });
});

describe('fixtures: org + ORG_ADMIN profile', () => {
  it('produces an org + admin profile pair with a synthetic reserved-TLD email', () => {
    const { org, profile } = buildOrgAndAdminProfile();
    expect(profile.org_id).toBe(org.id);
    expect(profile.role).toBe('ORG_ADMIN');
    expect(profile.email).toMatch(/@staging\.invalid\.test$/);
    expect(isSyntheticFixture(org.name)).toBe(true);
  });
});

describe('fixtures: executor contract', () => {
  it('applies rows through an injected executor (no real DB in unit test)', async () => {
    const calls: Array<{ table: string; count: number }> = [];
    const exec: FixtureExecutor = async (table, rows) => {
      calls.push({ table, count: rows.length });
      return rows.map((_, i) => ({ id: `${table}-${i}` }));
    };
    const inserted = await exec('anchors', [
      buildSecuredUnbatchedAnchor({ orgId: 'o', userId: 'u' }),
    ]);
    expect(calls).toEqual([{ table: 'anchors', count: 1 }]);
    expect(inserted[0].id).toBe('anchors-0');
  });
});
