import { describe, expect, it } from 'vitest';
import { validateProbeTarget, validateFixtureIds, assertLockProbeHealthy } from './admin-rpc-0428-lock-probe.js';

describe('admin profile lock-probe admission and evidence', () => {
  it('refuses production, missing, and mismatched database targets', () => {
    expect(() => validateProbeTarget('vzwyaatejekddvltxyye', { PGHOST: 'db.vzwyaatejekddvltxyye.supabase.co' })).toThrow();
    expect(() => validateProbeTarget('ixekmrkkhqyqtycerihq', {})).toThrow();
    expect(() => validateProbeTarget('ixekmrkkhqyqtycerihq', { PGHOST: 'db.otherproject.supabase.co' })).toThrow();
  });
  it('refuses hidden connection redirects', () => {
    for (const patch of [{ PGHOSTADDR: '127.0.0.2' }, { PGSERVICE: 'production' }, { PGDATABASE: 'postgres://prod/database' }]) {
      expect(() => validateProbeTarget('local-0428', { PGHOST: '127.0.0.1', PGPORT: '55428', ...patch })).toThrow();
    }
  });
  it('accepts matching session connections and an explicitly local fixture', () => {
    expect(() => validateProbeTarget('ixekmrkkhqyqtycerihq', { PGHOST: 'db.ixekmrkkhqyqtycerihq.supabase.co', PGPORT: '5432' })).not.toThrow();
    expect(() => validateProbeTarget('ixekmrkkhqyqtycerihq', { PGHOST: 'aws-0-us-east-2.pooler.supabase.com', PGUSER: 'postgres.ixekmrkkhqyqtycerihq', PGPORT: '5432' })).not.toThrow();
    expect(() => validateProbeTarget('local-0428', { PGHOST: '127.0.0.1', PGPORT: '55428' })).not.toThrow();
  });
  it('refuses the transaction pooler for persistent sessions', () => {
    expect(() => validateProbeTarget('ixekmrkkhqyqtycerihq', { PGHOST: 'aws-0-us-east-2.pooler.supabase.com', PGUSER: 'postgres.ixekmrkkhqyqtycerihq', PGPORT: '6543' })).toThrow();
  });
  it('requires three independent UUID rows', () => {
    expect(() => validateFixtureIds(['0428a11d-0000-4000-8000-000000000002', '0428a11d-0000-4000-8000-000000000003', '0428a11d-0000-4000-8000-000000000002'])).toThrow();
    expect(() => validateFixtureIds(['bad', 'another', 'third'])).toThrow();
  });
  const healthy = { rpc: 'admin_change_user_role', barrierObserved: false, innocentBlockedByRpc: false, innocentServerMs: 12, innocentRows: 1, rpcCompleted: true, holderConfirmed: true, rpcLockConfirmed: true };
  it('rejects a barrier even when an innocent write eventually finishes quickly', () => {
    expect(() => assertLockProbeHealthy({ ...healthy, barrierObserved: true, innocentServerMs: 40 })).toThrow(/barrier/i);
  });
  it('rejects row-less, unfinished and unobserved experiments', () => {
    for (const patch of [{ innocentRows: 0 }, { rpcCompleted: false }, { holderConfirmed: false }, { rpcLockConfirmed: false }]) {
      expect(() => assertLockProbeHealthy({ ...healthy, ...patch })).toThrow();
    }
  });
  it('keeps the 3-second ceiling on database execution time', () => {
    expect(() => assertLockProbeHealthy({ ...healthy, innocentServerMs: 3001 })).toThrow();
    expect(() => assertLockProbeHealthy({ ...healthy, innocentServerMs: Number.NaN })).toThrow();
    expect(() => assertLockProbeHealthy(healthy)).not.toThrow();
  });
});
