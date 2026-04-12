/**
 * Gemini Model Deprecation Monitor (GME-05)
 *
 * Tracks known deprecation dates and emits warnings when active models
 * approach their sunset. Integrated into the worker health check.
 *
 * Deprecation reference: https://ai.google.dev/gemini-api/docs/deprecations
 */

import { getGeminiConfig, GEMINI_DISTILLATION_MODEL } from './gemini-config.js';

/** Known model deprecation dates (ISO format) */
export const MODEL_DEPRECATION_DATES: Record<string, string> = {
  'gemini-2.5-flash': '2026-06-17',
  'gemini-2.5-pro': '2026-06-17',
  'gemini-2.0-flash': '2026-06-01',
  'gemini-embedding-001': '2026-07-14',
  'embedding-001': '2026-08-14',
};

export interface DeprecationWarning {
  model: string;
  shutdownDate: string;
  daysRemaining: number;
  severity: 'warning' | 'critical';
}

export interface DeprecationStatus {
  activeModels: string[];
  warnings: DeprecationWarning[];
  checkedAt: string;
}

/**
 * Check if any of the given model names are approaching deprecation.
 * Returns warnings sorted by urgency (fewest days remaining first).
 */
export function getDeprecationWarnings(modelNames: string[]): DeprecationWarning[] {
  const now = Date.now();
  const warnings: DeprecationWarning[] = [];

  for (const model of modelNames) {
    const shutdownDate = MODEL_DEPRECATION_DATES[model];
    if (!shutdownDate) continue;

    const shutdownMs = new Date(shutdownDate).getTime();
    const daysRemaining = Math.ceil((shutdownMs - now) / (1000 * 60 * 60 * 24));

    if (daysRemaining <= 0) {
      warnings.push({
        model,
        shutdownDate,
        daysRemaining: 0,
        severity: 'critical',
      });
    } else {
      warnings.push({
        model,
        shutdownDate,
        daysRemaining,
        severity: daysRemaining <= 30 ? 'critical' : 'warning',
      });
    }
  }

  return warnings.sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/**
 * Check deprecation status for all currently active Gemini models.
 * Called from worker health check endpoint.
 */
export function checkDeprecationStatus(): DeprecationStatus {
  const config = getGeminiConfig();
  const activeModels = [
    config.generationModel,
    config.embeddingModel,
    config.visionModel,
    GEMINI_DISTILLATION_MODEL,
  ].filter((v, i, arr) => arr.indexOf(v) === i); // dedupe

  const warnings = getDeprecationWarnings(activeModels);

  // Log warnings (lazy import to avoid config initialization during tests)
  if (warnings.length > 0) {
    import('../utils/logger.js').then(({ logger: log }) => {
      for (const w of warnings) {
        const logFn = w.severity === 'critical' ? log.error.bind(log) : log.warn.bind(log);
        logFn(
          { model: w.model, shutdownDate: w.shutdownDate, daysRemaining: w.daysRemaining },
          `Model deprecation ${w.severity}: ${w.model} shuts down in ${w.daysRemaining} days`,
        );
      }
    }).catch(() => { /* logger unavailable in test env */ });
  }

  return {
    activeModels,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}
