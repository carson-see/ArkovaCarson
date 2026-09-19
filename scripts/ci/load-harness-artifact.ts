import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const LOAD_ARTIFACT_REFERENCE = /\bartifact=(docs\/staging\/[^\s`]+\/load-[^\s`]+\.json)\b/i;
const SHA256_REFERENCE = /\bsha256=([0-9a-f]{64})\b/;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MODES = new Set(['anchor', 'burst', 'oscillate', 'webhooks', 'events', 'cron', 'classifier', 'reads', 'mixed']);

function finite(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

function producerShapeError(value: Record<string, unknown>): string | null {
  const started = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : Number.NaN;
  const ended = typeof value.endedAt === 'string' ? Date.parse(value.endedAt) : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return 'timestamps are invalid';
  if (!finite(value.durationSec) || Math.abs((ended - started) / 1000 - value.durationSec) > 5) return 'durationSec does not match its timestamps';
  if (typeof value.apiBase !== 'string' || !/^https:\/\/[^\s]+\.run\.app\/?$/i.test(value.apiBase)) return 'apiBase is not a staging run.app URL';
  if (typeof value.mode !== 'string' || !MODES.has(value.mode)) return 'mode is invalid';
  if (!Number.isInteger(value.concurrency) || !finite(value.concurrency, 1)) return 'concurrency is invalid';
  if (!Number.isInteger(value.totalRequests) || !finite(value.totalRequests, 1)) return 'totalRequests must be a positive integer';
  if (typeof value.byMode !== 'object' || value.byMode === null || Array.isArray(value.byMode)) return 'byMode is invalid';
  let counted = 0;
  for (const metrics of Object.values(value.byMode as Record<string, unknown>)) {
    if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) return 'byMode metrics are invalid';
    const m = metrics as Record<string, unknown>;
    if (!Number.isInteger(m.ok) || !finite(m.ok) || !Number.isInteger(m.fail) || !finite(m.fail)) return 'byMode counts are invalid';
    if (!finite(m.errorRate) || m.errorRate > 1 || !finite(m.p50Ms) || !finite(m.p95Ms) || !finite(m.p99Ms)) return 'byMode rates or latency percentiles are invalid';
    if (typeof m.byStatus !== 'object' || m.byStatus === null || Array.isArray(m.byStatus)) return 'byStatus is invalid';
    counted += (m.ok as number) + (m.fail as number);
  }
  return counted === value.totalRequests ? null : 'totalRequests does not equal the per-mode counts';
}

export function validateLoadHarnessArtifactReference(value: string, repoRoot = process.cwd()): string | null {
  const claimsHarness = /\bload-harness\b/i.test(value);
  const artifactMatch = value.match(LOAD_ARTIFACT_REFERENCE);
  if (!claimsHarness && !artifactMatch) return null;
  if (!artifactMatch) return 'Load/concurrency evidence that claims load-harness output must include artifact=docs/staging/.../load-*.json.';
  const digestMatch = value.match(SHA256_REFERENCE);
  if (!digestMatch) return 'Load/concurrency evidence that claims a load-harness artifact must include sha256=<64 lowercase hex>.';

  const root = realpathSync(repoRoot);
  const stagingRoot = realpathSync(resolve(root, 'docs/staging'));
  const candidate = resolve(root, artifactMatch[1]);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(candidate) !== candidate || !candidate.startsWith(`${stagingRoot}${sep}`)) {
      return 'Load-harness artifact must be a real, non-symlinked file under docs/staging.';
    }
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', artifactMatch[1]], { stdio: 'ignore' });
  } catch {
    return 'Load-harness artifact must be a git-tracked, non-symlinked file under docs/staging.';
  }
  if (stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) return `Load-harness artifact must be between 1 and ${MAX_ARTIFACT_BYTES} bytes.`;
  const bytes = Buffer.alloc(stat.size);
  const fd = openSync(candidate, 'r');
  try {
    if (readSync(fd, bytes, 0, stat.size, 0) !== stat.size) return 'Load-harness artifact changed or truncated while being read.';
  } finally {
    closeSync(fd);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digestMatch[1]) return `Load-harness artifact SHA-256 mismatch: declared ${digestMatch[1]}, actual ${actual}.`;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return 'Load-harness artifact is not valid JSON.'; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'Load-harness artifact must be a JSON object.';
  if (Object.prototype.hasOwnProperty.call(parsed, 'partial')) return 'Load-harness artifact carries the interruption marker `partial`; salvage artifacts cannot satisfy release evidence.';
  const shapeError = producerShapeError(parsed as Record<string, unknown>);
  return shapeError === null ? null : `Load-harness artifact is not completed producer output: ${shapeError}.`;
}
