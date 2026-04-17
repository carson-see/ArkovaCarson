/**
 * NVI verification registry.
 *
 * Persists per-source verification results to a JSON file that the
 * build-dataset.ts pipeline (NVI-18 CI guard) consults before emitting
 * training JSONL. The file lives alongside the dataset so it is
 * version-controlled.
 *
 * Schema (verification-status.json):
 * {
 *   "version": "1",
 *   "lastRun": ISO8601,
 *   "sources": {
 *     "<source-id>": {
 *       "lastVerifiedAt": ISO8601,
 *       "overallPassed": boolean,
 *       "overallHardFail": boolean,
 *       "orphaned": boolean,
 *       "results": VerificationResult[]
 *     }
 *   }
 * }
 *
 * Staleness: if `lastVerifiedAt` is older than `maxAgeDays` (default 90),
 * the CI guard treats the source as unverified.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { SourceVerification } from './index';

export interface RegistryEntry {
  lastVerifiedAt: string;
  overallPassed: boolean;
  overallHardFail: boolean;
  orphaned: boolean;
  results: SourceVerification['results'];
}

export interface Registry {
  version: '1';
  lastRun: string;
  sources: Record<string, RegistryEntry>;
}

export function emptyRegistry(): Registry {
  return { version: '1', lastRun: new Date().toISOString(), sources: {} };
}

export function loadRegistry(path: string): Registry {
  if (!existsSync(path)) return emptyRegistry();
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Registry;
    if (parsed.version !== '1') {
      throw new Error(`unsupported verification-registry version "${parsed.version}"`);
    }
    return parsed;
  } catch (err) {
    throw new Error(`failed to parse verification registry at ${path}: ${(err as Error).message}`);
  }
}

export function saveRegistry(path: string, reg: Registry): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(reg, null, 2) + '\n');
}

export function upsertVerifications(
  reg: Registry,
  verifications: SourceVerification[],
  now: string = new Date().toISOString(),
): Registry {
  const next: Registry = { ...reg, lastRun: now, sources: { ...reg.sources } };
  for (const v of verifications) {
    next.sources[v.sourceId] = {
      lastVerifiedAt: now,
      overallPassed: v.overallPassed,
      overallHardFail: v.overallHardFail,
      orphaned: v.orphaned,
      results: v.results,
    };
  }
  return next;
}

/**
 * Inspect a registry for one or more source IDs and decide whether they
 * are currently trusted for training. A source is trusted iff:
 *   - it has a registry entry
 *   - the entry.overallPassed is true
 *   - the entry is not orphaned
 *   - lastVerifiedAt is within maxAgeDays of `now`
 */
export interface TrustDecision {
  sourceId: string;
  trusted: boolean;
  reason: string;
}

export function decideTrust(
  reg: Registry,
  sourceIds: string[],
  opts: { maxAgeDays?: number; now?: Date } = {},
): TrustDecision[] {
  const maxAgeMs = (opts.maxAgeDays ?? 90) * 24 * 60 * 60 * 1000;
  const now = opts.now ?? new Date();
  const decisions: TrustDecision[] = [];

  for (const id of sourceIds) {
    const entry = reg.sources[id];
    if (!entry) {
      decisions.push({ sourceId: id, trusted: false, reason: 'no verification record' });
      continue;
    }
    if (entry.orphaned) {
      decisions.push({ sourceId: id, trusted: false, reason: 'no applicable validator (orphaned)' });
      continue;
    }
    if (!entry.overallPassed) {
      const failingValidators = entry.results.filter((r) => !r.passed).map((r) => r.validator).join(', ');
      decisions.push({
        sourceId: id,
        trusted: false,
        reason: `verification failed (${failingValidators || 'unknown'})`,
      });
      continue;
    }
    const age = now.getTime() - new Date(entry.lastVerifiedAt).getTime();
    if (age > maxAgeMs) {
      const days = Math.floor(age / (24 * 60 * 60 * 1000));
      decisions.push({
        sourceId: id,
        trusted: false,
        reason: `verification stale (${days}d old, max ${opts.maxAgeDays ?? 90}d)`,
      });
      continue;
    }
    decisions.push({ sourceId: id, trusted: true, reason: 'verified' });
  }

  return decisions;
}

/** Default registry path relative to the intelligence-dataset dir. */
export function defaultRegistryPath(intelligenceDatasetDir: string): string {
  return resolve(intelligenceDatasetDir, 'verification-status.json');
}
