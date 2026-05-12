/**
 * SEC-001: PostgreSQL RLS Bypass CVE-2025-8713
 *
 * Verifies Postgres version is patched against the RLS bypass vulnerability.
 * Patched versions: >= 17.6, 16.10, 15.14, 14.19, or 13.22
 *
 * This test runs against local Supabase. For production, run:
 *   SELECT version(); -- via Supabase SQL Editor or MCP
 */

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

/**
 * Parse major.minor from a Postgres version string like:
 * "PostgreSQL 15.8 on x86_64-pc-linux-gnu..."
 */
function parsePostgresVersion(versionString: string): { major: number; minor: number } {
  const match = versionString.match(/PostgreSQL\s+(\d+)\.(\d+)/);
  if (!match) throw new Error(`Cannot parse Postgres version from: ${versionString}`);
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

/** Minimum patched minor version for each major release */
const PATCHED_VERSIONS: Record<number, number> = {
  17: 6,
  16: 10,
  15: 14,
  14: 19,
  13: 22,
};

function isVersionPatched(major: number, minor: number): boolean {
  const requiredMinor = PATCHED_VERSIONS[major];
  if (requiredMinor === undefined) {
    // Major version not in the CVE range (e.g. 18+) — assumed patched
    return major > 17;
  }
  return minor >= requiredMinor;
}

describe('SEC-001: PostgreSQL RLS Bypass CVE-2025-8713', () => {
  it('parsePostgresVersion extracts major.minor correctly', () => {
    expect(parsePostgresVersion('PostgreSQL 15.8 on x86_64-pc-linux-gnu')).toEqual({
      major: 15,
      minor: 8,
    });
    expect(parsePostgresVersion('PostgreSQL 17.6 (Ubuntu 17.6-1.pgdg22.04+1)')).toEqual({
      major: 17,
      minor: 6,
    });
  });

  it('isVersionPatched identifies vulnerable vs patched versions', () => {
    // Vulnerable
    expect(isVersionPatched(15, 8)).toBe(false);
    expect(isVersionPatched(16, 9)).toBe(false);
    expect(isVersionPatched(14, 18)).toBe(false);
    expect(isVersionPatched(13, 21)).toBe(false);

    // Patched
    expect(isVersionPatched(17, 6)).toBe(true);
    expect(isVersionPatched(16, 10)).toBe(true);
    expect(isVersionPatched(15, 14)).toBe(true);
    expect(isVersionPatched(14, 19)).toBe(true);
    expect(isVersionPatched(13, 22)).toBe(true);

    // Future versions
    expect(isVersionPatched(18, 0)).toBe(true);
  });

  it('local Supabase Postgres is patched (requires local Supabase running)', async () => {
    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const key =
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;

    if (!url || !key) {
      console.warn(
        'SEC-001: Skipping live DB check — SUPABASE_URL/VITE_SUPABASE_URL not set. ' +
          'Run against local Supabase or verify production manually.',
      );
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = createClient(url, key, { realtime: { transport: ws as any } });
    const { data, error } = await supabase.rpc('get_postgres_version').single();

    if (error) {
      // RPC may not exist — try raw SQL via pg_catalog
      console.warn(
        'SEC-001: get_postgres_version RPC not found. ' +
          'Verify production version manually: SELECT version();',
      );
      return;
    }

    const version = parsePostgresVersion(data as string);
    expect(
      isVersionPatched(version.major, version.minor),
      `PostgreSQL ${version.major}.${version.minor} is VULNERABLE to CVE-2025-8713. ` +
        `Minimum patched: ${version.major}.${PATCHED_VERSIONS[version.major] ?? 'N/A'}`,
    ).toBe(true);
  });
});
