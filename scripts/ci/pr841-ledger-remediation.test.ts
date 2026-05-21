import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const migrationsDir = resolve(repoRoot, 'supabase', 'migrations');

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

describe('PR #841 migration ledger remediation', () => {
  it('aligns the 0313-0315 migration filenames with production ledger reality', () => {
    const files = migrationFiles();

    expect(files).toContain('0313_anchors_index_consolidation.sql');
    expect(files).toContain('0314_legally_binding_attestations.sql');
    expect(files).toContain('0315_professional_education_foundations.sql');

    expect(files).not.toContain('0313_legally_binding_attestations.sql');
    expect(files).not.toContain('0314_professional_education_foundations.sql');

    const remediationWindow = files.filter((file) => /^031[3-5]_/.test(file));
    expect(remediationWindow).toEqual([
      '0313_anchors_index_consolidation.sql',
      '0314_legally_binding_attestations.sql',
      '0315_professional_education_foundations.sql',
    ]);
  });
});
