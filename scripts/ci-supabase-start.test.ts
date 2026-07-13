import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = readFileSync(resolve(process.cwd(), 'scripts/ci-supabase-start.sh'), 'utf8');

describe('ci-supabase-start registry fallbacks', () => {
  it('pre-seeds the postgres-meta image used by generated types from GHCR before Supabase starts', () => {
    expect(script).toContain('seed_supabase_ecr_image_from_ghcr');
    expect(script).toContain('public.ecr.aws/supabase/postgres-meta:v0.96.1');
    expect(script).toContain('ghcr.io/supabase/postgres-meta:v0.96.1');

    const seedIndex = script.indexOf('seed_supabase_ecr_image_from_ghcr');
    const startIndex = script.indexOf('echo "Starting Supabase..."');
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(seedIndex).toBeLessThan(startIndex);
  });
});
