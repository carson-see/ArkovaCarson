/**
 * Fine-Tune Data Exporter (Phase 3 — Training Pipeline Scale-Up)
 *
 * Produces stratified, instruction-tuning format JSONL for Nessie fine-tuning.
 * Builds on the basic trainingExporter with:
 *   - Instruction/output pairs (conversation format)
 *   - Stratified sampling by credential type
 *   - Quality filtering (minimum text length, valid extraction)
 *   - Export statistics with per-type breakdown
 *
 * Output format (one JSON object per line):
 *   {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
 *
 * Constitution refs:
 *   - 4A: Only PII-stripped metadata is used (no raw documents)
 *   - 1.6: Documents never leave user's device
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { EXTRACTION_SYSTEM_PROMPT } from '../prompts/extraction.js';
import type { ModelTarget, TrainingExample } from '../modelTargets.js';
import { getExportConfigs } from '../modelTargets.js';

/** Minimum text length for a training example to be useful */
const MIN_TEXT_LENGTH = 50;

/** Maximum text length to avoid context overflow */
const MAX_TEXT_LENGTH = 20_000;

/** All credential types for stratification */
const ALL_TYPES = [
  'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL',
  'CLE', 'BADGE', 'ATTESTATION', 'FINANCIAL', 'LEGAL', 'INSURANCE',
  'SEC_FILING', 'PATENT', 'REGULATION', 'PUBLICATION', 'OTHER',
] as const;

/** Configuration for fine-tune export */
export interface FineTuneExportConfig {
  /** Base output directory */
  outputDir: string;
  /** Target model (affects sequence length limits) */
  target: ModelTarget;
  /** Maximum examples per credential type (for balanced datasets) */
  maxPerType?: number;
  /** Minimum examples per type before oversampling warning */
  minPerType?: number;
  /** Whether to include the full system prompt in each example */
  includeSystemPrompt?: boolean;
}

/** Statistics for an export run */
export interface ExportStats {
  totalExported: number;
  totalFiltered: number;
  byCredentialType: Record<string, number>;
  filteredReasons: Record<string, number>;
  outputPath: string;
  warnings: string[];
}

/** A raw record from the database */
export interface RawTrainingRecord {
  id: string;
  text: string;
  credentialType: string;
  extractedFields: Record<string, unknown>;
  fingerprint: string;
  sourceUrl?: string;
}

/**
 * Convert a raw training record to instruction-tuning conversation format.
 *
 * @param record - Raw record with text and extracted fields
 * @param includeSystemPrompt - Whether to include system prompt
 * @returns JSONL-ready object or null if record fails quality checks
 */
export function formatTrainingExample(
  record: RawTrainingRecord,
  includeSystemPrompt = true,
): { messages: Array<{ role: string; content: string }> } | null {
  // Quality filters
  if (!record.text || record.text.length < MIN_TEXT_LENGTH) return null;
  if (record.text.length > MAX_TEXT_LENGTH) return null;
  if (!record.credentialType || record.credentialType === '') return null;
  if (!record.extractedFields || Object.keys(record.extractedFields).length === 0) return null;

  const userPrompt = `Extract metadata from the following PII-stripped credential text.\nCredential type hint: ${record.credentialType}\n\n--- BEGIN CREDENTIAL TEXT ---\n${JSON.stringify(record.text)}\n--- END CREDENTIAL TEXT ---\n\nReturn a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`;

  const assistantResponse = JSON.stringify(record.extractedFields);

  const messages: Array<{ role: string; content: string }> = [];

  if (includeSystemPrompt) {
    messages.push({ role: 'system', content: EXTRACTION_SYSTEM_PROMPT });
  }

  messages.push({ role: 'user', content: userPrompt });
  messages.push({ role: 'assistant', content: assistantResponse });

  return { messages };
}

/**
 * Stratify records by credential type for balanced training.
 *
 * @param records - All raw records
 * @param maxPerType - Maximum records per type (caps overrepresented types)
 * @returns Stratified records + statistics
 */
export function stratifyByType(
  records: RawTrainingRecord[],
  maxPerType?: number,
): { stratified: RawTrainingRecord[]; stats: Record<string, number>; warnings: string[] } {
  const byType = new Map<string, RawTrainingRecord[]>();

  for (const record of records) {
    const type = record.credentialType || 'OTHER';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(record);
  }

  const stats: Record<string, number> = {};
  const stratified: RawTrainingRecord[] = [];
  const warnings: string[] = [];

  for (const type of ALL_TYPES) {
    const typeRecords = byType.get(type) || [];
    const capped = maxPerType ? typeRecords.slice(0, maxPerType) : typeRecords;
    stats[type] = capped.length;
    stratified.push(...capped);

    if (typeRecords.length === 0) {
      warnings.push(`No records for type ${type} — consider adding synthetic examples`);
    } else if (typeRecords.length < 10) {
      warnings.push(`Only ${typeRecords.length} records for type ${type} — may be underrepresented in training`);
    }
  }

  // Include any types not in ALL_TYPES
  for (const [type, typeRecords] of byType) {
    if (!ALL_TYPES.includes(type as typeof ALL_TYPES[number])) {
      const capped = maxPerType ? typeRecords.slice(0, maxPerType) : typeRecords;
      stats[type] = capped.length;
      stratified.push(...capped);
    }
  }

  return { stratified, stats, warnings };
}

/**
 * Export training data as stratified instruction-tuning JSONL.
 *
 * @param records - Raw training records from database
 * @param config - Export configuration
 * @returns Export statistics
 */
export function exportFineTuneData(
  records: RawTrainingRecord[],
  config: FineTuneExportConfig,
): ExportStats {
  const { stratified, stats, warnings } = stratifyByType(records, config.maxPerType);

  const outputPath = join(config.outputDir, `finetune-${config.target.environment}-${config.target.parametersBillions}b.jsonl`);

  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });

  let totalExported = 0;
  let totalFiltered = 0;
  const filteredReasons: Record<string, number> = {};
  const lines: string[] = [];

  for (const record of stratified) {
    const example = formatTrainingExample(record, config.includeSystemPrompt ?? true);

    if (!example) {
      totalFiltered++;
      // Determine filter reason
      if (!record.text || record.text.length < MIN_TEXT_LENGTH) {
        filteredReasons['text_too_short'] = (filteredReasons['text_too_short'] ?? 0) + 1;
      } else if (record.text.length > MAX_TEXT_LENGTH) {
        filteredReasons['text_too_long'] = (filteredReasons['text_too_long'] ?? 0) + 1;
      } else if (!record.extractedFields || Object.keys(record.extractedFields).length === 0) {
        filteredReasons['no_extracted_fields'] = (filteredReasons['no_extracted_fields'] ?? 0) + 1;
      } else {
        filteredReasons['other'] = (filteredReasons['other'] ?? 0) + 1;
      }
      continue;
    }

    // Check token budget for user+assistant only (system prompt is handled
    // separately by fine-tuning frameworks). Approximate: 4 chars per token.
    const userAssistantChars = example.messages
      .filter(m => m.role !== 'system')
      .reduce((sum, m) => sum + m.content.length, 0);
    const approxTokens = Math.ceil(userAssistantChars / 4);
    if (approxTokens > config.target.minContextTokens) {
      totalFiltered++;
      filteredReasons['exceeds_context'] = (filteredReasons['exceeds_context'] ?? 0) + 1;
      continue;
    }

    lines.push(JSON.stringify(example));
    totalExported++;
  }

  // Write all at once (atomic file write)
  writeFileSync(outputPath, lines.join('\n') + '\n', 'utf-8');

  logger.info({
    totalExported,
    totalFiltered,
    byType: stats,
    outputPath,
  }, 'Fine-tune export complete');

  return {
    totalExported,
    totalFiltered,
    byCredentialType: stats,
    filteredReasons,
    outputPath,
    warnings,
  };
}

/**
 * Export fine-tune data for all configured model targets.
 *
 * @param records - Raw training records
 * @param baseOutputDir - Base directory for exports
 * @returns Export stats for each target
 */
export function exportForAllTargets(
  records: RawTrainingRecord[],
  baseOutputDir: string,
): ExportStats[] {
  const configs = getExportConfigs(baseOutputDir);
  const results: ExportStats[] = [];

  for (const exportConfig of configs) {
    const stats = exportFineTuneData(records, {
      outputDir: exportConfig.outputDir,
      target: exportConfig.target,
      maxPerType: undefined, // No cap by default
      includeSystemPrompt: exportConfig.includeFewShot,
    });
    results.push(stats);
  }

  return results;
}
