/**
 * docusign-bilateral-2026-08 (CTO Decision Record, R9) — unit tests for the
 * guard-probe's pure decision logic (`assessGuardResult`) and its Supabase
 * call shape (`attemptForgedMetadataWrite`, against a minimal mock client —
 * this probe targets PR #2472, unmerged, so there is no real guard trigger to
 * exercise here; these tests pin the PROBE's own logic, not the guard).
 */
import { describe, it, expect, vi } from 'vitest';

import { GUARD_PROBE_SENTINEL, assessGuardResult, attemptForgedMetadataWrite } from './docusign-guard-probe.js';

describe('assessGuardResult', () => {
  it('PASS: the UPDATE itself was rejected (strongest enforcement)', () => {
    const result = assessGuardResult({ updateError: { message: 'permission denied' }, persistedMetadata: null });
    expect(result.pass).toBe(true);
    expect(result.findings[0]).toContain('strongest possible enforcement');
  });

  it('PASS: the UPDATE succeeded but all three forged keys were stripped', () => {
    const result = assessGuardResult({
      updateError: null,
      persistedMetadata: { note: 'guard probe run' },
    });
    expect(result.pass).toBe(true);
  });

  it('FAIL: the forged account_id sentinel persisted', () => {
    const result = assessGuardResult({
      updateError: null,
      persistedMetadata: { account_id: GUARD_PROBE_SENTINEL },
    });
    expect(result.pass).toBe(false);
    expect(result.findings.some((f) => f.includes('account_id'))).toBe(true);
  });

  it('FAIL: connector_source="docusign" persisted', () => {
    const result = assessGuardResult({
      updateError: null,
      persistedMetadata: { connector_source: 'docusign' },
    });
    expect(result.pass).toBe(false);
  });

  it('FAIL: _signers persisted', () => {
    const result = assessGuardResult({
      updateError: null,
      persistedMetadata: { _signers: [{ recipient_id_guid: 'x', status: 'completed' }] },
    });
    expect(result.pass).toBe(false);
  });

  it('inconclusive (not a pass): no row read back at all', () => {
    const result = assessGuardResult({ updateError: null, persistedMetadata: null });
    expect(result.pass).toBe(false);
    expect(result.findings[0]).toContain('inconclusive');
  });

  it('an empty _signers array does NOT count as a leak', () => {
    const result = assessGuardResult({
      updateError: null,
      persistedMetadata: { _signers: [] },
    });
    expect(result.pass).toBe(true);
  });
});

describe('attemptForgedMetadataWrite', () => {
  function makeClient({ updateError = null, selectData = null, selectError = null } = {}) {
    const eqAfterUpdate = vi.fn().mockResolvedValue({ error: updateError });
    const update = vi.fn().mockReturnValue({ eq: eqAfterUpdate });

    const maybeSingle = vi.fn().mockResolvedValue({ data: selectData, error: selectError });
    const eqAfterSelect = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq: eqAfterSelect });

    const from = vi.fn().mockReturnValue({ update, select });
    return { from, update, select, eqAfterUpdate, eqAfterSelect, maybeSingle };
  }

  it('issues an UPDATE with the forged keys, then a fresh SELECT (never trusts the UPDATE response)', async () => {
    const client = makeClient({ selectData: { metadata: { note: 'guard probe run' } } });

    const result = await attemptForgedMetadataWrite(client as never, 'anchor-123');

    expect(client.from).toHaveBeenCalledWith('anchors');
    const updateArg = client.update.mock.calls[0][0];
    expect(updateArg.metadata.connector_source).toBe('docusign');
    expect(updateArg.metadata.account_id).toBe(GUARD_PROBE_SENTINEL);
    expect(Array.isArray(updateArg.metadata._signers)).toBe(true);
    expect(client.eqAfterUpdate).toHaveBeenCalledWith('id', 'anchor-123');

    expect(client.select).toHaveBeenCalledWith('metadata');
    expect(client.eqAfterSelect).toHaveBeenCalledWith('id', 'anchor-123');
    expect(result.persistedMetadata).toEqual({ note: 'guard probe run' });
  });

  it('surfaces the UPDATE error without throwing (assessGuardResult decides what it means)', async () => {
    const client = makeClient({
      updateError: { message: 'RLS policy violation' },
      selectData: { metadata: {} },
    });
    const result = await attemptForgedMetadataWrite(client as never, 'anchor-123');
    expect(result.updateError).toEqual({ message: 'RLS policy violation' });
  });

  it('throws if the read-back SELECT itself errors (cannot assess without a read-back)', async () => {
    const client = makeClient({ selectError: { message: 'connection reset' } });
    await expect(attemptForgedMetadataWrite(client as never, 'anchor-123')).rejects.toThrow('connection reset');
  });

  it('never reads a service-role-shaped env var (SUPABASE_SERVICE_ROLE_KEY or similar) — the prose ABOUT avoiding service_role is fine, an actual env-var read is not', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./docusign-guard-probe.js', import.meta.url), 'utf8'),
    );
    // Matches `process.env.SUPABASE_SERVICE_ROLE_KEY` / `requireEnv('SUPABASE_SERVICE_ROLE_KEY')`
    // / any other SCREAMING_SNAKE_CASE token containing SERVICE_ROLE — the
    // shape an actual credential read would take. Plain prose mentioning
    // "service_role" or "service-role" (lowercase/hyphenated, as in this
    // file's own comments explaining what it deliberately does NOT do) does
    // not match this pattern.
    expect(source).not.toMatch(/[A-Z0-9_]*SERVICE_ROLE[A-Z0-9_]*/);
  });
});
