import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const LOAD_ARTIFACT_REFERENCE = /\bartifact=(docs\/staging\/[^\s`]+\/load-[^\s`]+\.json)\b/i;
const SHA256_REFERENCE = /\bsha256=([0-9a-f]{64})\b/i;

export function validateLoadHarnessArtifactReference(value: string, repoRoot = process.cwd()): string | null {
  const claimsHarness = /\bload-harness\b/i.test(value);
  const artifactMatch = value.match(LOAD_ARTIFACT_REFERENCE);
  if (!claimsHarness && !artifactMatch) return null;
  if (!artifactMatch) {
    return 'Load/concurrency evidence that claims load-harness output must include artifact=docs/staging/.../load-*.json.';
  }
  const digestMatch = value.match(SHA256_REFERENCE);
  if (!digestMatch) {
    return 'Load/concurrency evidence that claims a load-harness artifact must include sha256=<64 lowercase hex>.';
  }
  const root = realpathSync(repoRoot);
  const candidate = resolve(root, artifactMatch[1]);
  if (!candidate.startsWith(`${root}${sep}`)) {
    return 'Load-harness artifact must be a real, non-symlinked file under docs/staging.';
  }
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(candidate) !== candidate) {
      return 'Load-harness artifact must be a real, non-symlinked file under docs/staging.';
    }
  } catch {
    return 'Load-harness artifact must be a real, non-symlinked file under docs/staging.';
  }
  const bytes = readFileSync(candidate);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digestMatch[1]) {
    return `Load-harness artifact SHA-256 mismatch: declared ${digestMatch[1]}, actual ${actual}.`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return 'Load-harness artifact is not valid JSON.';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'Load-harness artifact must be a JSON object.';
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'partial')) {
    return 'Load-harness artifact carries the interruption marker `partial`; salvage artifacts cannot satisfy release evidence.';
  }
  return null;
}
