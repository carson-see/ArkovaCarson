/**
 * SEC-003: Service Role Key Audit
 *
 * 170+ Supabase applications were breached in 2025 due to exposed service role keys.
 * Service role keys bypass ALL RLS policies.
 *
 * This test ensures:
 * 1. No hardcoded keys in source code
 * 2. Service role key references only exist in server-side code or test helpers
 * 3. No service role key is imported in any client-side (src/) file (except tests)
 * 4. supabase.auth.admin is never used in client code
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Recursively get all .ts/.tsx files in a directory, excluding node_modules and tests */
function getSourceFiles(dir: string, exclude: RegExp[] = []): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (exclude.some((re) => re.test(fullPath))) continue;

    if (entry.isDirectory()) {
      results.push(...getSourceFiles(fullPath, exclude));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('SEC-003: Service Role Key Audit', () => {
  const srcDir = path.join(process.cwd(), 'src');
  // Match either path separator — paths use `\` on Windows, `/` elsewhere.
  const clientFiles = getSourceFiles(srcDir, [/[\\/]tests[\\/]/, /\.test\./, /\.spec\./]);

  it('no hardcoded Supabase JWT tokens in client source files', () => {
    const jwtPattern = /eyJhbGciOi[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
    const violations: string[] = [];

    for (const file of clientFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (jwtPattern.test(content)) {
        violations.push(path.relative(process.cwd(), file));
      }
    }

    expect(
      violations,
      `Hardcoded JWT tokens found in: ${violations.join(', ')}`,
    ).toHaveLength(0);
  });

  it('SUPABASE_SERVICE_ROLE_KEY never referenced in client code (only tests/worker)', () => {
    const violations: string[] = [];

    for (const file of clientFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('SUPABASE_SERVICE_ROLE_KEY') || content.includes('service_role_key')) {
        violations.push(path.relative(process.cwd(), file));
      }
    }

    expect(
      violations,
      `Service role key referenced in client code: ${violations.join(', ')}`,
    ).toHaveLength(0);
  });

  it('supabase.auth.admin never used in client code', () => {
    const violations: string[] = [];

    for (const file of clientFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (/supabase\.auth\.admin/i.test(content)) {
        violations.push(path.relative(process.cwd(), file));
      }
    }

    expect(
      violations,
      `supabase.auth.admin used in client code: ${violations.join(', ')}`,
    ).toHaveLength(0);
  });

  it('no VITE_SUPABASE_SERVICE_ROLE_KEY env variable (would expose to browser)', () => {
    const envFiles = ['.env', '.env.local', '.env.example', '.env.development']
      .map((f) => path.join(process.cwd(), f))
      .filter((f) => fs.existsSync(f));

    for (const envFile of envFiles) {
      const content = fs.readFileSync(envFile, 'utf8');
      expect(
        content.includes('VITE_SUPABASE_SERVICE_ROLE_KEY'),
        `${path.basename(envFile)} contains VITE_SUPABASE_SERVICE_ROLE_KEY — this would expose the service role key to the browser!`,
      ).toBe(false);
    }
  });
});
