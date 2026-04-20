/**
 * Weekly Calibration Refit Job (GME7.3 — SCRUM-856)
 *
 * Samples last 7 days of extraction results and re-derives per-type
 * calibration knots. Returns the proposed knots and a delta comparison
 * against the current production knots.
 *
 * Does NOT auto-apply knots. The cron endpoint returns the proposed
 * changes for review. A GitHub Action (future) will open a PR with the
 * new knots when ΔPearson-r ≥ 0.02.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { pearsonCorrelation } from '../ai/eval/scoring.js';
import {
  derivePerTypeCalibrationKnots,
  getPerTypeCalibrationKnots,
  interpolateKnots,
} from '../ai/eval/calibration.js';
import type { EntryEvalResult } from '../ai/eval/types.js';

export interface CalibrationRefitResult {
  sampledEntries: number;
  typesWithKnots: number;
  proposedKnots: Record<string, [number, number][]>;
  currentKnots: Record<string, [number, number][]>;
  deltaPearsonR: number;
  stale: boolean;
  timestamp: string;
}

export async function runCalibrationRefit(): Promise<CalibrationRefitResult> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // NOTE: `confidence` and `extraction_accuracy` are not yet exposed as
  // columns on the `anchors` table (they live in extraction_manifests /
  // ai_usage_events and still need a view or column-mirror migration).
  // Cast through unknown until that migration lands so supabase-js v2.104's
  // stricter column-type checks don't trip the worker build.
  // TODO(SCRUM-908 follow-up): move this query to a proper view once the
  // calibration-features view is added.
  const { data: samples, error } = await (db
    .from('anchors')
    .select('id, credential_type, confidence, extraction_accuracy, created_at' as '*')
    .gte('created_at', sevenDaysAgo)
    .not('confidence', 'is', null)
    .not('extraction_accuracy', 'is', null)
    .limit(5000) as unknown as Promise<{
      data: Array<{ id: string; credential_type: string; confidence: number; extraction_accuracy: number; created_at: string }> | null;
      error: { message: string } | null;
    }>);

  if (error) {
    logger.error({ error }, 'Failed to fetch calibration samples');
    throw new Error(`Failed to fetch calibration samples: ${error.message}`);
  }

  const entries: EntryEvalResult[] = (samples || []).map((row: {
    id: string;
    credential_type: string;
    confidence: number;
    extraction_accuracy: number;
  }) => ({
    entryId: row.id,
    credentialType: row.credential_type || 'UNKNOWN',
    category: '',
    tags: [],
    fieldResults: [],
    reportedConfidence: row.confidence,
    actualAccuracy: row.extraction_accuracy,
    latencyMs: 0,
    provider: 'gemini',
    tokensUsed: 0,
  }));

  logger.info({ count: entries.length }, 'Sampled extraction results for calibration refit');

  const proposed = derivePerTypeCalibrationKnots(entries, 10, 5);
  const current = getPerTypeCalibrationKnots();

  const proposedObj: Record<string, [number, number][]> = {};
  for (const [type, knots] of proposed) {
    proposedObj[type] = knots;
  }

  let deltaPearsonR = 0;
  if (entries.length >= 10) {
    const confs = entries.map(e => e.reportedConfidence);
    const accs = entries.map(e => e.actualAccuracy);
    const currentR = pearsonCorrelation(confs, accs);

    const calibratedConfs = entries.map(e => {
      const typeKnots = proposed.get(e.credentialType);
      if (!typeKnots) return e.reportedConfidence;
      return interpolateKnots(typeKnots, e.reportedConfidence);
    });
    const proposedR = pearsonCorrelation(calibratedConfs, accs);
    deltaPearsonR = proposedR - currentR;
  }

  const stale = deltaPearsonR < 0.02 && proposed.size > 0;

  return {
    sampledEntries: entries.length,
    typesWithKnots: proposed.size,
    proposedKnots: proposedObj,
    currentKnots: current,
    deltaPearsonR: Math.round(deltaPearsonR * 1000) / 1000,
    stale,
    timestamp: new Date().toISOString(),
  };
}
