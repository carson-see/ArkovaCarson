import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = join(process.cwd(), 'supabase', 'migrations');
const filename = readdirSync(migrations).find((name) => name.endsWith('_uat04_mandatory_mfa.sql'));

describe('UAT-04 database MFA boundary', () => {
  it('guards old and refreshed AAL1 sessions without blocking service credentials', () => {
    expect(filename, 'missing UAT-04 migration').toBeDefined();
    const sql = readFileSync(join(migrations, filename!), 'utf8');

    expect(sql).toMatch(/request\.jwt\.claims[\s\S]*aal[\s\S]*aal2/i);
    expect(sql).toMatch(/pgrst\.db_pre_request/i);
    expect(sql).toMatch(/AS RESTRICTIVE[\s\S]*TO authenticated/i);
    expect(sql).toMatch(/storage[\s\S]*objects/i);
    expect(sql).toMatch(/arkova_mfa_pending/i);
    expect(sql).toMatch(/arkova_email_pending[\s\S]*arkova_mfa_pending[\s\S]*authenticated/i);
    expect(sql).toMatch(/service_role/i);
    expect(sql).toMatch(/SET LOCAL lock_timeout\s*=\s*'5s'/i);
  });
});
