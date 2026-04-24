import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export const GPL_DENYLIST = /\b(?:AGPL|GPL|SSPL)(?:[-\s]?(?:v?\d+(?:\.\d+)?(?:-only|-or-later|\+)?))?\b/i;

interface PackageLockPackage {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
}

interface PackageLock {
  lockfileVersion?: number;
  packages?: Record<string, PackageLockPackage>;
  [key: string]: unknown;
}

export interface DeniedLicenseMatch {
  lockfile: string;
  name: string;
  version: string;
  license: string;
  path: string;
}

interface AllowlistEntry {
  name: string;
  version: string;
  reason: string;
}

interface AllowlistFile {
  allowed: AllowlistEntry[];
}

export function findDeniedLicenses(lockfile: PackageLock, lockfilePath: string): DeniedLicenseMatch[] {
  const packages = lockfile.packages ?? {};
  const matches: DeniedLicenseMatch[] = [];

  for (const [path, pkg] of Object.entries(packages)) {
    if (!path || !pkg) continue;
    const license = normalizeLicense(pkg.license ?? pkg.licenses);
    if (!license || !GPL_DENYLIST.test(license)) continue;

    matches.push({
      lockfile: lockfilePath,
      name: pkg.name ?? packageNameFromLockPath(path),
      version: pkg.version ?? 'unknown',
      license,
      path,
    });
  }

  return matches.sort((a, b) => `${a.lockfile}:${a.name}`.localeCompare(`${b.lockfile}:${b.name}`));
}

export function formatDeniedLicenseReport(matches: DeniedLicenseMatch[]): string {
  if (matches.length === 0) return 'No unapproved GPL/AGPL/SSPL licenses found.';

  return [
    'Denied licenses found:',
    ...matches.map((match) =>
      `- ${match.lockfile}: ${match.name}@${match.version} (${match.license}) at ${match.path}`),
  ].join('\n');
}

export function filterAllowedMatches(
  matches: DeniedLicenseMatch[],
  allowlist: AllowlistEntry[],
): DeniedLicenseMatch[] {
  const allowed = new Set(allowlist.map((entry) => `${entry.name}@${entry.version}`));
  return matches.filter((match) => !allowed.has(`${match.name}@${match.version}`));
}

function scanLockfile(path: string): DeniedLicenseMatch[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PackageLock;
  return findDeniedLicenses(parsed, path);
}

function loadAllowlist(): AllowlistEntry[] {
  const path = resolve(process.cwd(), 'scripts/security/license-denylist.allowlist.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as AllowlistFile;
  return parsed.allowed ?? [];
}

function normalizeLicense(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeLicense(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join(' OR ');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return normalizeLicense(record.type ?? record.name ?? record.license);
  }
  return undefined;
}

function packageNameFromLockPath(path: string): string {
  const segments = path.split('node_modules/').filter(Boolean);
  const tail = segments[segments.length - 1] ?? path;
  const parts = tail.split('/').filter(Boolean);
  if (parts[0]?.startsWith('@') && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? basename(path);
}

if (process.argv[1]?.endsWith('license-denylist.ts')) {
  const lockfiles = process.argv.slice(2);
  if (lockfiles.length === 0) {
    console.error('Usage: tsx scripts/security/license-denylist.ts <package-lock.json> [...]');
    process.exitCode = 2;
  } else {
    const matches = filterAllowedMatches(
      lockfiles.flatMap((lockfile) => scanLockfile(lockfile)),
      loadAllowlist(),
    );
    const report = formatDeniedLicenseReport(matches);
    if (matches.length > 0) {
      console.error(report);
      process.exitCode = 1;
    } else {
      console.log(report);
    }
  }
}
