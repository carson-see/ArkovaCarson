/**
 * Tests for the DPA clause 4.6 coverage detector.
 *
 * The detector exists because a hand-built census of anchor-inserting routes
 * was wrong in both directions. These tests pin the two properties that make it
 * better than the census: it does not flag reads, and it does not miss writes.
 */

import { describe, it, expect } from 'vitest';
import {
  findAnchorInserts,
  callsFieldPolicyGuard,
  scan,
} from './check-anchor-field-policy-coverage.js';

describe('findAnchorInserts', () => {
  it('finds a chained insert', () => {
    expect(findAnchorInserts(`await db.from('anchors').insert({ a: 1 })`)).toHaveLength(1);
  });

  it('finds a multi-line insert', () => {
    const src = `
      const { data } = await db
        .from('anchors')
        .insert(payload)
        .select('id')
        .single();
    `;
    expect(findAnchorInserts(src)).toHaveLength(1);
  });

  it('finds an upsert', () => {
    expect(findAnchorInserts(`db.from('anchors').upsert(row)`)).toHaveLength(1);
  });

  it('finds an insert through an aliased client (dbAny)', () => {
    expect(findAnchorInserts(`dbAny.from('anchors').insert(p)`)).toHaveLength(1);
  });

  it('accepts double quotes', () => {
    expect(findAnchorInserts(`db.from("anchors").insert(p)`)).toHaveLength(1);
  });

  // The false-positive class. The worker has ~164 of these; the census that
  // preceded this detector named four such files as gaps.
  it('does NOT flag a select', () => {
    expect(findAnchorInserts(`db.from('anchors').select('id').eq('org_id', o)`)).toHaveLength(0);
  });

  it('does NOT flag a select in a file that inserts into a DIFFERENT table', () => {
    const src = `
      await db.from('anchors').select('public_id').eq('id', id).maybeSingle();
      await db.from('audit_events').insert({ kind: 'read' });
    `;
    expect(findAnchorInserts(src)).toHaveLength(0);
  });

  it('does NOT flag an update or delete', () => {
    expect(findAnchorInserts(`db.from('anchors').update({ x: 1 })`)).toHaveLength(0);
    expect(findAnchorInserts(`db.from('anchors').delete().eq('id', id)`)).toHaveLength(0);
  });

  it('does NOT flag a commented-out insert', () => {
    expect(findAnchorInserts(`// await db.from('anchors').insert(p)`)).toHaveLength(0);
    expect(findAnchorInserts(`/* db.from('anchors').insert(p) */`)).toHaveLength(0);
  });

  it('does NOT flag an insert into a table whose name merely contains "anchors"', () => {
    expect(findAnchorInserts(`db.from('anchor_recipients').insert(p)`)).toHaveLength(0);
    expect(findAnchorInserts(`db.from('anchors_archive').insert(p)`)).toHaveLength(0);
  });

  it('reports each insert site in a file with several', () => {
    const src = `
      db.from('anchors').insert(a);
      db.from('anchors').select('id');
      db.from('anchors').insert(b);
    `;
    expect(findAnchorInserts(src)).toHaveLength(2);
  });
});

describe('callsFieldPolicyGuard', () => {
  it('detects a call', () => {
    expect(callsFieldPolicyGuard(`if (!(await enforceOrgFieldPolicy({ orgId }))) return;`)).toBe(true);
  });

  it('does NOT accept a mention in a comment as a call', () => {
    expect(callsFieldPolicyGuard(`// TODO: wire up enforceOrgFieldPolicy(...) here`)).toBe(false);
    expect(callsFieldPolicyGuard(`/** see enforceOrgFieldPolicy() */`)).toBe(false);
  });

  it('does NOT accept a bare import with no call', () => {
    expect(
      callsFieldPolicyGuard(`import { enforceOrgFieldPolicy } from '../../utils/orgFieldPolicy.js';`),
    ).toBe(false);
  });
});

describe('scan (against the real tree)', () => {
  it('reports no uncovered anchor-creating request handler', () => {
    // If this fails, a route under services/worker/src/api/ creates anchors
    // without enforcing the org field policy. Wire the guard in — do not
    // add the file to an exemption list, there isn't one.
    expect(scan()).toEqual([]);
  });
});
