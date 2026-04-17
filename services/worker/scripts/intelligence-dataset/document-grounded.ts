/**
 * NVI-09 — Document-grounded scenarios (SCRUM-813).
 *
 * Abstract Q&A trains Nessie to reason about compliance rules in the
 * abstract. The production Arkova use case is concrete: "customer uploads
 * a background-check PDF — is this §615(a)-compliant?" This module
 * threads document text into training data so the model learns to reason
 * over actual artifacts.
 *
 * Shape:
 *   - `DocumentEntry` — one anonymized artifact (adverse-action notice,
 *     pre-adverse notice, §604(b)(2) disclosure, credential PDF, etc.).
 *   - `DocumentGroundedScenario` — references a document by id + asks a
 *     compliance question + provides the expected structured answer.
 *   - `documentGroundedToTogetherRow` — flattens to Together chat format
 *     with the document text embedded as user context under a clear
 *     delimiter.
 *
 * Privacy guarantee: every `DocumentEntry` must carry an
 * `anonymisedAt` date — the point at which PII was stripped. The
 * maintainer is responsible for the stripping; this module validates
 * only that the field is present.
 */

import type { CategoryId, IntelligenceAnswer, TogetherTrainingRow } from './types';
import { NESSIE_INTELLIGENCE_PROMPT_V2 } from './prompts';

export type DocumentKind =
  | 'consumer-report'
  | 'pre-adverse-notice'
  | 'adverse-action-notice'
  | 'standalone-disclosure'       // FCRA §604(b)(2)
  | 'credential-verification'
  | 'tenant-screening-report';

export interface DocumentEntry {
  /** Stable corpus id (kebab-case). Scenarios reference this. */
  id: string;
  kind: DocumentKind;
  /** Short human-readable label of what's interesting about this doc. */
  description: string;
  /** ISO date PII was stripped. */
  anonymisedAt: string;
  /** Full anonymized document text. */
  text: string;
}

export interface CorpusIndex {
  /** O(1) lookup by id. */
  byId: Map<string, DocumentEntry>;
}

export function buildCorpusIndex(entries: DocumentEntry[]): CorpusIndex {
  const byId = new Map<string, DocumentEntry>();
  for (const e of entries) {
    if (byId.has(e.id)) throw new Error(`duplicate document id: ${e.id}`);
    byId.set(e.id, e);
  }
  return { byId };
}

export function lookupDocument(idx: CorpusIndex, id: string): DocumentEntry | undefined {
  return idx.byId.get(id);
}

export interface DocumentGroundedScenario {
  id: string;
  category: CategoryId;
  documentCorpusId: string;
  query: string;
  expected: IntelligenceAnswer;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateDocumentGroundedScenario(
  sc: DocumentGroundedScenario,
  corpus: CorpusIndex,
): string[] {
  const errs: string[] = [];
  if (!sc.query || sc.query.trim().length === 0) errs.push('empty query');
  if (!sc.expected || typeof sc.expected.analysis !== 'string' || sc.expected.analysis.trim().length === 0) {
    errs.push('expected.analysis is empty');
  }
  if (!Array.isArray(sc.expected?.citations) || sc.expected.citations.length === 0) {
    errs.push('expected.citations is empty');
  }
  if (!Array.isArray(sc.expected?.risks) || sc.expected.risks.length === 0) {
    errs.push('expected.risks is empty');
  }
  if (!Array.isArray(sc.expected?.recommendations) || sc.expected.recommendations.length === 0) {
    errs.push('expected.recommendations is empty');
  }
  if (!corpus.byId.has(sc.documentCorpusId)) {
    errs.push(`documentCorpusId "${sc.documentCorpusId}" not in corpus`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Together JSONL serialisation
// ---------------------------------------------------------------------------

/** Render a user message that includes the document under a delimiter. */
function renderUserMessage(doc: DocumentEntry, query: string): string {
  return [
    '# Document',
    `_id: ${doc.id} | kind: ${doc.kind} | anonymisedAt: ${doc.anonymisedAt}_`,
    '',
    '```',
    doc.text.trim(),
    '```',
    '',
    '# Question',
    query,
  ].join('\n');
}

export function documentGroundedToTogetherRow(
  sc: DocumentGroundedScenario,
  corpus: CorpusIndex,
): TogetherTrainingRow {
  const errs = validateDocumentGroundedScenario(sc, corpus);
  if (errs.length > 0) {
    throw new Error(`document-grounded scenario ${sc.id} failed validation: ${errs.join('; ')}`);
  }
  const doc = corpus.byId.get(sc.documentCorpusId)!;
  return {
    messages: [
      { role: 'system', content: NESSIE_INTELLIGENCE_PROMPT_V2 },
      { role: 'user', content: renderUserMessage(doc, sc.query) },
      { role: 'assistant', content: JSON.stringify(sc.expected) },
    ],
  };
}
