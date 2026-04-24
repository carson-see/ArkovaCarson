/**
 * NPH-12: Fraud Signal Training Data Pipeline
 *
 * Generates JSONL training examples for fraud detection fine-tuning.
 * Takes golden dataset entries tagged with fraud + fraud eval dataset entries,
 * augments them with variations, and exports balanced positive/negative sets.
 *
 * Constitution refs:
 *   - 1.6: No PII — all text is PII-stripped
 *   - 4A: Only metadata flows to server
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { FULL_GOLDEN_DATASET } from '../eval/golden-dataset.js';
import { FRAUD_EVAL_DATASET } from '../eval/fraud-eval-dataset.js';

// ============================================================
// Types
// ============================================================

export interface FraudTrainingOutput {
  fraudSignals: string[];
  reasoning: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface FraudTrainingExample {
  input: string;
  output: FraudTrainingOutput;
  source: string;
  isFraud: boolean;
}

export interface FraudPipelineOptions {
  outputPath: string;
  returnExamples?: boolean;
}

export interface FraudPipelineResult {
  totalExamples: number;
  fraudExamples: number;
  cleanExamples: number;
  outputPath: string;
  examples?: FraudTrainingExample[];
}

// ============================================================
// Constants — known fraud indicators
// ============================================================

/** Known diploma mills for augmentation */
export const DIPLOMA_MILLS: readonly string[] = [
  'Belford University',
  'Almeda University',
  'Rochville University',
  'Corllins University',
  'Bircham International University',
  'Preston University',
  'Ashford University of Technology',
  'Pacific Western University',
  'Columbia State University',
  'Hamilton University',
  'Lexington University',
  'Thornhill University',
  'Headway University',
  'Adams State Institute',
  'Breyer State University',
];

/** Suspicious phrases indicating potential fraud */
export const SUSPICIOUS_PHRASES: readonly string[] = [
  'no coursework required',
  'life experience credit only',
  'degree in 7 days',
  'guaranteed diploma',
  'accredited by the Universal Accreditation Council',
  'instant degree verification',
  'buy your degree today',
  'no exams needed',
  'honorary degree for professional experience',
  'fast track degree program',
  'based on prior learning assessment only',
  'no attendance required',
];

// ============================================================
// Augmentation strategies
// ============================================================

/**
 * Augment a fraud example with variations using the specified strategy.
 */
export function augmentFraudExample(
  text: string,
  strategy: 'date_shift' | 'issuer_substitution' | 'content_modification',
): string[] {
  switch (strategy) {
    case 'date_shift':
      return augmentDateShift(text);
    case 'issuer_substitution':
      return augmentIssuerSubstitution(text);
    case 'content_modification':
      return augmentContentModification(text);
    default:
      return [text];
  }
}

function augmentDateShift(text: string): string[] {
  const variations: string[] = [];

  // Future date — suspicious for a credential issued "already"
  const futureText = text
    .replace(/20\d{2}/g, '2030')
    .replace(/January|February|March|April|May|June|July|August|September|October|November|December/gi, 'December');
  if (futureText !== text) variations.push(futureText);

  // Very old date with recent expiry — suspicious gap
  const oldText = text
    .replace(/20\d{2}(?![-/]\d)/g, (match) => {
      const year = parseInt(match, 10);
      return year > 2000 ? '1985' : match;
    });
  if (oldText !== text) variations.push(oldText);

  // Same day for issue and expiry — suspicious
  const sameDayText = text
    .replace(/(expir\w*[:\s]+)[\w\s,]+(\d{4})/gi, '$1January 1, $2')
    .replace(/(issued?[:\s]+)[\w\s,]+(\d{4})/gi, '$1January 1, $2');
  if (sameDayText !== text) variations.push(sameDayText);

  // If no date patterns matched, create at least one variation
  if (variations.length === 0) {
    variations.push(text + ' Issued: January 1, 2035.');
  }

  return variations;
}

function augmentIssuerSubstitution(text: string): string[] {
  const variations: string[] = [];

  // Replace university/institution names with known diploma mills
  for (const mill of DIPLOMA_MILLS.slice(0, 3)) {
    const modified = text
      .replace(/University of \[REDACTED\]/gi, mill)
      .replace(/\[INSTITUTION_REDACTED\]/gi, mill)
      .replace(/\[ORG_REDACTED\]/gi, mill);
    if (modified !== text) {
      variations.push(modified);
    }
  }

  // If no substitution patterns matched, insert a diploma mill reference
  if (variations.length === 0) {
    variations.push(`${text} Issued by ${DIPLOMA_MILLS[0]}.`);
  }

  return variations;
}

function augmentContentModification(text: string): string[] {
  const variations: string[] = [];

  // Add suspicious phrases
  for (const phrase of SUSPICIOUS_PHRASES.slice(0, 3)) {
    variations.push(`${text} ${phrase}.`);
  }

  return variations;
}

// ============================================================
// Deduplication
// ============================================================

/**
 * Remove duplicate examples by input text hash. Keeps first occurrence.
 */
export function deduplicateExamples(examples: FraudTrainingExample[]): FraudTrainingExample[] {
  const seen = new Set<string>();
  const result: FraudTrainingExample[] = [];

  for (const example of examples) {
    const hash = createHash('sha256').update(example.input).digest('hex');
    if (!seen.has(hash)) {
      seen.add(hash);
      result.push(example);
    }
  }

  return result;
}

// ============================================================
// JSONL formatting
// ============================================================

/**
 * Format a single fraud training example as a JSONL line.
 */
export function formatFraudTrainingLine(example: FraudTrainingExample): string {
  return JSON.stringify({
    input: example.input,
    output: {
      fraudSignals: example.output.fraudSignals,
      reasoning: example.output.reasoning,
      riskLevel: example.output.riskLevel,
    },
  });
}

// ============================================================
// Main pipeline
// ============================================================

/**
 * Generate fraud training data from golden dataset + fraud eval dataset.
 *
 * Produces balanced JSONL with ~50% fraud, ~50% clean examples.
 * Augments fraud examples with date shifts, issuer substitutions,
 * and content modifications for variety.
 */
export function generateFraudTrainingData(options: FraudPipelineOptions): FraudPipelineResult {
  const examples: FraudTrainingExample[] = [];

  // ---- 1. Collect fraud examples from golden dataset (entries with fraud tags/signals) ----
  const fraudGoldenEntries = FULL_GOLDEN_DATASET.filter(
    e =>
      e.tags.includes('fraud') ||
      e.tags.includes('tampered') ||
      e.tags.includes('suspicious') ||
      (e.groundTruth.fraudSignals && e.groundTruth.fraudSignals.length > 0),
  );

  for (const entry of fraudGoldenEntries) {
    // Ensure fraud-tagged entries always have at least one signal
    const signals = entry.groundTruth.fraudSignals && entry.groundTruth.fraudSignals.length > 0
      ? entry.groundTruth.fraudSignals
      : ['suspicious_document'];
    examples.push({
      input: entry.strippedText,
      output: {
        fraudSignals: signals,
        reasoning: entry.groundTruth.reasoning ?? `Suspicious credential: ${entry.description}`,
        riskLevel: determineFraudRiskLevel(signals),
      },
      source: `golden-dataset:${entry.id}`,
      isFraud: true,
    });

    // Augment each fraud entry with variations
    for (const strategy of ['date_shift', 'issuer_substitution', 'content_modification'] as const) {
      const variations = augmentFraudExample(entry.strippedText, strategy);
      for (const variation of variations) {
        const augSignals = [...signals, `augmented_${strategy}`];
        examples.push({
          input: variation,
          output: {
            fraudSignals: augSignals,
            reasoning: `Augmented (${strategy}): ${entry.groundTruth.reasoning ?? entry.description}`,
            riskLevel: determineFraudRiskLevel(augSignals),
          },
          source: `golden-dataset:${entry.id}:aug-${strategy}`,
          isFraud: true,
        });
      }
    }
  }

  // ---- 2. Collect fraud examples from fraud eval dataset ----
  const tamperedEvalEntries = FRAUD_EVAL_DATASET.filter(e => e.isTampered);

  for (const entry of tamperedEvalEntries) {
    const syntheticText = generateSyntheticFraudText(entry);
    examples.push({
      input: syntheticText,
      output: {
        fraudSignals: entry.expectedSignals,
        reasoning: `${entry.tamperingDescription ?? entry.description}. Technique: ${entry.tamperingTechnique ?? 'unknown'}.`,
        riskLevel: entry.expectedRiskLevel,
      },
      source: `fraud-eval:${entry.id}`,
      isFraud: true,
    });
  }

  // ---- 3. Collect clean examples from golden dataset ----
  const cleanGoldenEntries = FULL_GOLDEN_DATASET.filter(
    e =>
      !e.tags.includes('fraud') &&
      !e.tags.includes('tampered') &&
      !e.tags.includes('suspicious') &&
      (!e.groundTruth.fraudSignals || e.groundTruth.fraudSignals.length === 0),
  );

  for (const entry of cleanGoldenEntries) {
    examples.push({
      input: entry.strippedText,
      output: {
        fraudSignals: [],
        reasoning: entry.groundTruth.reasoning ?? `Legitimate ${entry.groundTruth.credentialType?.toLowerCase() ?? 'credential'}: ${entry.description}`,
        riskLevel: 'LOW',
      },
      source: `golden-dataset:${entry.id}`,
      isFraud: false,
    });
  }

  // ---- 4. Collect clean examples from fraud eval dataset ----
  const cleanEvalEntries = FRAUD_EVAL_DATASET.filter(e => !e.isTampered);

  for (const entry of cleanEvalEntries) {
    const syntheticText = generateSyntheticCleanText(entry);
    examples.push({
      input: syntheticText,
      output: {
        fraudSignals: [],
        reasoning: `Clean ${entry.credentialType.toLowerCase()}: ${entry.description}. No signs of tampering.`,
        riskLevel: 'LOW',
      },
      source: `fraud-eval:${entry.id}`,
      isFraud: false,
    });
  }

  // ---- 5. Deduplicate ----
  const deduped = deduplicateExamples(examples);

  // ---- 6. Balance classes ----
  const fraudExamples = deduped.filter(e => e.isFraud);
  const cleanExamples = deduped.filter(e => !e.isFraud);

  // Balance to ~50/50 by taking min count from each class
  const targetCount = Math.min(fraudExamples.length, cleanExamples.length);
  const balancedFraud = shuffleArray(fraudExamples).slice(0, targetCount);
  const balancedClean = shuffleArray(cleanExamples).slice(0, targetCount);

  const balanced = shuffleArray([...balancedFraud, ...balancedClean]);

  // ---- 7. Write JSONL ----
  const lines = balanced.map(formatFraudTrainingLine);
  const outputPath = options.outputPath;

  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, lines.join('\n'), 'utf-8');
    logger.info(
      {
        totalExamples: balanced.length,
        fraudExamples: balancedFraud.length,
        cleanExamples: balancedClean.length,
        outputPath,
      },
      'Fraud training data exported',
    );
  } catch (err) {
    logger.error({ error: err, outputPath }, 'Failed to write fraud training data');
  }

  const result: FraudPipelineResult = {
    totalExamples: balanced.length,
    fraudExamples: balancedFraud.length,
    cleanExamples: balancedClean.length,
    outputPath,
  };

  if (options.returnExamples) {
    result.examples = balanced;
  }

  return result;
}

// ============================================================
// Helpers
// ============================================================

function determineFraudRiskLevel(signals: string[]): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (signals.length === 0) return 'LOW';
  if (signals.length === 1) return 'MEDIUM';
  if (signals.length <= 3) return 'HIGH';
  return 'CRITICAL';
}

function generateSyntheticFraudText(entry: { credentialType: string; description: string; tamperingTechnique: string | null }): string {
  const base = `[PII-STRIPPED CREDENTIAL] Type: ${entry.credentialType}. ${entry.description}.`;
  if (entry.tamperingTechnique) {
    return `${base} [Indicators: ${entry.tamperingTechnique}]`;
  }
  return base;
}

function generateSyntheticCleanText(entry: { credentialType: string; description: string }): string {
  return `[PII-STRIPPED CREDENTIAL] Type: ${entry.credentialType}. ${entry.description}. Verified formatting consistent with issuer standards.`;
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
