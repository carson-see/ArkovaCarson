/**
 * scripts/staging/ai-eval/harness-core.ts — pure stats + payload helpers for the
 * AI load harness. Side-effect-free (no network, no clock beyond the caller's
 * timestamps) so the aggregation + evidence shape is unit-testable.
 *
 * Constitution §1.6 / §1.6A note: the /ai/template + /ai/tags payloads carry
 * ONLY the golden entry's already-PII-stripped metadata FIELDS + confidence —
 * never `strippedText`, never document bytes. The endpoints reject byte-shaped
 * payloads; the harness respects that boundary by construction.
 */

import type { AiCallResult, AiEndpoint } from './ai-client.js';
import type { GoldenEntry, GroundTruthFields } from './scoring.js';

// ── Stats ────────────────────────────────────────────────────────────────────

export interface EndpointSlot {
  ok: number;
  fail: number;
  latencyMs: number[];
  byStatus: Record<number, number>;
}

export interface AiStats {
  startedAt: number;
  total: number;
  byEndpoint: Record<AiEndpoint, EndpointSlot>;
  rateLimited429: number;
  transportErrors: number;
}

function emptySlot(): EndpointSlot {
  return { ok: 0, fail: 0, latencyMs: [], byStatus: {} };
}

export function newAiStats(startedAt: number = Date.now()): AiStats {
  return {
    startedAt,
    total: 0,
    byEndpoint: { extract: emptySlot(), template: emptySlot(), tags: emptySlot() },
    rateLimited429: 0,
    transportErrors: 0,
  };
}

export function recordAiOutcome(stats: AiStats, outcome: AiCallResult): void {
  stats.total++;
  const slot = stats.byEndpoint[outcome.endpoint];
  if (outcome.ok) slot.ok++;
  else slot.fail++;
  slot.latencyMs.push(outcome.latencyMs);
  slot.byStatus[outcome.status] = (slot.byStatus[outcome.status] ?? 0) + 1;
  if (outcome.status === 429) stats.rateLimited429++;
  if (outcome.status === 0) stats.transportErrors++;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

// ── Evidence summary ─────────────────────────────────────────────────────────

export interface EndpointEvidence {
  ok: number;
  fail: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  byStatus: Record<number, number>;
}

export interface AiRunSummary {
  startedAt: string;
  endedAt: string;
  durationSec: number;
  apiBase: string;
  mode: string;
  totalRequests: number;
  achievedRequestsPerHour: number;
  rateLimited429: number;
  transportErrors: number;
  byEndpoint: Record<string, EndpointEvidence>;
}

export function summarizeAiRun(
  stats: AiStats,
  mode: string,
  apiBase: string,
  durationSec: number,
  endedAt: number = Date.now(),
): AiRunSummary {
  const byEndpoint: Record<string, EndpointEvidence> = {};
  for (const [endpoint, slot] of Object.entries(stats.byEndpoint)) {
    if (slot.ok + slot.fail === 0) continue;
    byEndpoint[endpoint] = {
      ok: slot.ok,
      fail: slot.fail,
      errorRate: slot.fail / Math.max(slot.ok + slot.fail, 1),
      p50Ms: percentile(slot.latencyMs, 50),
      p95Ms: percentile(slot.latencyMs, 95),
      p99Ms: percentile(slot.latencyMs, 99),
      byStatus: slot.byStatus,
    };
  }
  const safeDuration = Math.max(durationSec, 1);
  return {
    startedAt: new Date(stats.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSec,
    apiBase,
    mode,
    totalRequests: stats.total,
    achievedRequestsPerHour: (stats.total / safeDuration) * 3600,
    rateLimited429: stats.rateLimited429,
    transportErrors: stats.transportErrors,
    byEndpoint,
  };
}

// ── Payload builders (metadata-only; no document bytes) ──────────────────────

/**
 * The template/tags endpoints run AFTER extraction — they take extracted,
 * PII-stripped metadata FIELDS. For a representative soak we feed the golden
 * entry's ground-truth metadata (which is exactly the shape a real extraction
 * would produce), NOT the raw stripped text. Ground truth includes only
 * synthetic, PII-free values.
 */
function metadataFieldsFor(entry: GoldenEntry): Record<string, unknown> {
  const gt: GroundTruthFields = entry.groundTruth;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(gt)) {
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

export interface TemplatePayload {
  fields: Record<string, unknown>;
  confidence: number;
}

export function buildTemplatePayload(entry: GoldenEntry): TemplatePayload {
  return { fields: metadataFieldsFor(entry), confidence: 0.9 };
}

export interface TagsPayload {
  fields: Record<string, unknown>;
}

export function buildTagsPayload(entry: GoldenEntry): TagsPayload {
  return { fields: metadataFieldsFor(entry) };
}

/**
 * Deterministic endpoint rotation. With the default [extract, template, tags]
 * set, extract is weighted 2x (it is the eval-scored path and the heaviest
 * inference) via the 4-slot cycle extract, template, extract, tags.
 */
export function selectEndpointForSequence(sequence: number, endpoints: AiEndpoint[]): AiEndpoint {
  if (endpoints.length === 0) throw new Error('endpoints must be non-empty');
  if (endpoints.length === 1) return endpoints[0];
  if (
    endpoints.length === 3 &&
    endpoints[0] === 'extract' &&
    endpoints[1] === 'template' &&
    endpoints[2] === 'tags'
  ) {
    const cycle: AiEndpoint[] = ['extract', 'template', 'extract', 'tags'];
    return cycle[sequence % cycle.length];
  }
  return endpoints[sequence % endpoints.length];
}
