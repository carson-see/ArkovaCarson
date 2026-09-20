import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/0468_allocate_monthly_credits_singleton.sql', 'utf8');
const executable = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

describe('0468 monthly credit singleton', () => {
  it('takes a distinct transaction lock before selecting or writing credits', () => {
    const lock = executable.indexOf('pg_try_advisory_xact_lock(8675309, 3)');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(executable.indexOf('SELECT c.*'));
    expect(executable).not.toMatch(/pg_try_advisory_xact_lock\(8675309, [12]\)/);
  });
  it('preserves the integer return contract and makes the loser a zero-work success', () => {
    expect(executable).toMatch(/RETURNS integer/);
    expect(executable).toMatch(/IF NOT pg_try_advisory_xact_lock[\s\S]*RETURN 0;[\s\S]*END IF;/);
  });
  it('locks eligible rows and advances the cycle before writing one allocation row', () => {
    expect(executable).toMatch(/WHERE c\.cycle_end <= now\(\) FOR UPDATE OF c/);
    expect(executable.match(/INSERT INTO credit_transactions/g)).toHaveLength(2);
    expect(executable).toMatch(/cycle_end = date_trunc\('month', now\(\)\) \+ interval '1 month'/);
  });
  it('keeps service-role authorization and explicit grants', () => {
    expect(executable).toMatch(/auth\.role\(\) != 'service_role'/);
    expect(executable).toMatch(/REVOKE ALL ON FUNCTION public\.allocate_monthly_credits\(\) FROM PUBLIC, anon, authenticated/);
    expect(executable).toMatch(/GRANT EXECUTE ON FUNCTION public\.allocate_monthly_credits\(\) TO service_role/);
  });
});
