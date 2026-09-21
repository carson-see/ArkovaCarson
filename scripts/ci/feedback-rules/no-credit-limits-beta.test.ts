/**
 * Tests for the feedback_no_credit_limits_beta detector.
 *
 * P0002 is Postgres `no_data_found`. 0093 abused it for a quota refusal, which
 * is why the detector matches it — but a genuine not-found error is the code's
 * ordinary meaning and is not quota enforcement. 0470/0482 raise
 * `'user_not_found' USING ERRCODE = 'P0002'` and were flagged (PR #3019, #3036).
 */
import { describe, it, expect } from 'vitest';
import { findViolationsInSql } from './no-credit-limits-beta.js';

const F = 'supabase/migrations/9999_x.sql';

describe('no-credit-limits-beta: findViolationsInSql', () => {
  it('flags the 0093 shape: Quota exceeded with P0002', () => {
    const sql = `RAISE EXCEPTION 'Quota exceeded: % remaining', q USING ERRCODE = 'P0002';`;
    expect(findViolationsInSql(sql, F)).toHaveLength(1);
  });

  it('flags P0002 on a differently worded limit refusal', () => {
    const sql = `RAISE EXCEPTION 'monthly allowance used up' USING ERRCODE = 'P0002';`;
    expect(findViolationsInSql(sql, F)).toHaveLength(1);
  });

  it('flags a bare ERRCODE P0002 with no message on the line', () => {
    expect(findViolationsInSql(`  USING ERRCODE = 'P0002';`, F)).toHaveLength(1);
  });

  it('does not flag P0002 used for a genuine not-found error', () => {
    const sql = `    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';`;
    expect(findViolationsInSql(sql, F)).toEqual([]);
  });

  it('does not flag the same not-found statement inside a rollback comment', () => {
    const sql = `--       RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';`;
    expect(findViolationsInSql(sql, F)).toEqual([]);
  });

  it('still flags a quota refusal that merely mentions not found', () => {
    const sql = `RAISE EXCEPTION 'Quota exceeded: plan not found' USING ERRCODE = 'P0002';`;
    expect(findViolationsInSql(sql, F)).toHaveLength(1);
  });

  it('reports 1-indexed line numbers', () => {
    const sql = `SELECT 1;\nRAISE EXCEPTION 'Quota exceeded' USING ERRCODE = 'P0002';`;
    expect(findViolationsInSql(sql, F)[0]).toMatchObject({ file: F, line: 2 });
  });
});
