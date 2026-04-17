/**
 * NVI-07 — Claude Opus distillation types (SCRUM-811).
 *
 * The distillation pipeline is: query template → N variations →
 * teacher-model inference → validation → training JSONL row. Every shape
 * below is part of that assembly line.
 */

import type { IntelligenceAnswer, IntelligenceScenario } from '../intelligence-dataset/types';

/**
 * A template query that can be expanded into multiple concrete scenarios
 * by filling in facts slots (state, company size, credential context).
 */
export interface QueryTemplate {
  /** Stable kebab-case id. Distilled scenarios derive their id from this. */
  id: string;
  /** Category the template belongs to (must match an existing FCRA category). */
  category: string;
  /**
   * Query text with optional `{slot}` placeholders, e.g.
   * "In {state}, can a {size} employer run a credit check pre-offer?"
   */
  template: string;
  /**
   * Fact slots. Keys are slot names (`state`, `size`, …). Values are
   * concrete strings we'll fill in. The variation generator produces one
   * scenario per cartesian product of slot values.
   */
  slots: Record<string, string[]>;
  /**
   * Canonical FCRA sources the teacher model SHOULD anchor its answer to.
   * Non-exhaustive — the teacher may cite others — but these are the
   * "expected" sources for coverage-weighted variation picking.
   */
  expectedSources: string[];
}

/** A single slot-filled query ready to send to the teacher model. */
export interface VariationQuery {
  templateId: string;
  /** Deterministic id — `<templateId>::<slot=value>::...` */
  id: string;
  /** Fully-rendered query text. */
  query: string;
  /** Slot values for this variation. */
  slotValues: Record<string, string>;
  /** Copy of template's expectedSources for convenience. */
  expectedSources: string[];
  /** Category the template declared. */
  category: string;
}

/**
 * Teacher-model adapter. Tests use a mock; the production adapter calls
 * Claude Opus via the Anthropic SDK. The adapter is responsible for
 * prompt assembly + RAG context injection + JSON parsing.
 */
export interface TeacherModel {
  name: string;
  infer(v: VariationQuery, ragContext: string): Promise<IntelligenceAnswer>;
}

/**
 * Outcome of validating a single teacher response.
 */
export interface ValidationResult {
  variationId: string;
  accepted: boolean;
  reasons: string[];
  answer: IntelligenceAnswer;
}

/** Distillation run statistics. */
export interface DistillationReport {
  generatedAt: string;
  teacherModel: string;
  templateCount: number;
  variationCount: number;
  accepted: number;
  rejectedByReason: Record<string, number>;
  outPath: string;
}

/** A distilled row that lands in training JSONL. */
export interface DistilledScenario extends IntelligenceScenario {
  /** Marked so manifests can partition distilled vs hand-crafted data. */
  provenance: 'distilled';
  /** Which teacher model produced this row. */
  teacher: string;
}
