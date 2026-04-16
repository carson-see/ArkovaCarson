/**
 * Nessie Intelligence Dataset — Shared Types
 *
 * Canonical schema for every Nessie intelligence training dataset
 * (v27.1 FCRA, v28 HIPAA, v29 FERPA, and beyond).
 *
 * Design principles:
 *   1. Every citation is ANCHORED to a real statute / case / agency bulletin
 *      in a central source registry. Scenarios reference sources by ID only.
 *   2. Every scenario is HAND-CRAFTED — no mechanical rephrasing variations.
 *   3. Every scenario has non-empty `risks` and `recommendations`. Compliance
 *      answers without risks are not compliance answers.
 *   4. Confidence varies by actual legal uncertainty (0.55 – 0.99).
 *   5. Splits are category-balanced and leakage-free: no paraphrase of a
 *      training entry may appear in the test set.
 *   6. A dataset is only valid if every citation.record_id exists in the
 *      source registry and every jurisdiction / applicable_law is canonical.
 */

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

/**
 * A single authoritative source the model may cite.
 *
 * Each source is pinned to a specific statute / regulation / agency guidance
 * / court decision / CFPB or FTC bulletin. `id` is the only thing a scenario
 * references; the model learns to emit this id exactly.
 */
export interface IntelligenceSource {
  /** Stable kebab-case id. Scenarios reference this. Never change after publish. */
  id: string;
  /** Short verbatim quote (or tightly paraphrased statutory text). */
  quote: string;
  /** Authoritative citation label (e.g. "FCRA §604(b)(3)", "45 CFR 164.524"). */
  source: string;
  /** Optional public URL for human verification. */
  url?: string;
  /** ISO date the source content was last verified against the primary source. */
  lastVerified: string;
  /** Canonical tags for filtering / coverage checks. */
  tags: string[];
  /** Jurisdiction scope. */
  jurisdiction: Jurisdiction;
}

// ---------------------------------------------------------------------------
// Canonical enums
// ---------------------------------------------------------------------------

/**
 * Canonical jurisdiction strings. The model is trained to produce EXACTLY
 * these strings — inventing a new string is a validation failure.
 */
export type Jurisdiction =
  // Federal
  | 'federal'
  // Multi-level
  | 'federal+state'
  // States (expand as needed; only add when first cited)
  | 'CA' | 'NY' | 'NYC' | 'IL' | 'TX' | 'MA' | 'OR' | 'WA' | 'NJ' | 'MN'
  | 'CO' | 'FL' | 'GA' | 'OH' | 'PA' | 'NV' | 'HI' | 'MT' | 'NM' | 'CT'
  // Specific substates
  | 'Cook-County' | 'Philadelphia' | 'San-Francisco'
  // International (future — HIPAA/FERPA may cross borders for research + ed)
  | 'EU' | 'UK' | 'CA-intl';

/**
 * Canonical applicable-law short codes.
 *
 * Prefer specificity: "FCRA §604(b)(3)" beats "FCRA" when the query targets
 * a specific section. Compound codes are allowed with " + " separator.
 */
export type ApplicableLaw = string; // freeform but validated against registry

/**
 * Scenario category ids used for balanced splitting + coverage reporting.
 * Each regulation defines its own category set in scenarios/<reg>/index.ts.
 */
export type CategoryId = string;

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/**
 * A single compliance Q&A scenario. This is what the model is trained to
 * reproduce — one user query → one structured assistant answer.
 */
export interface IntelligenceScenario {
  /** Stable kebab-case id. Used for split reproducibility + dedup. */
  id: string;
  /** Category the scenario belongs to (drives balanced splits + coverage). */
  category: CategoryId;
  /** The user-facing natural-language query. One phrasing only. No variations. */
  query: string;
  /** Ground-truth compliance answer. */
  expected: IntelligenceAnswer;
  /** Optional free-text notes for dataset maintainers (not emitted to model). */
  notes?: string;
}

/**
 * The structured compliance answer the model must produce.
 *
 * This MIRRORS the production NESSIE_INTELLIGENCE_PROMPT output schema so
 * the training signal matches what eval measures.
 */
export interface IntelligenceAnswer {
  /**
   * Prose reasoning. Must cite specific statute sections by number
   * (e.g. "Per FCRA §604(b)(3) [15 U.S.C. §1681b(b)(3)]…").
   * No vague appeals ("under federal law") — always name the statute.
   */
  analysis: string;
  /** One entry per distinct source cited. record_id MUST exist in registry. */
  citations: ScenarioCitation[];
  /** Non-empty array of concrete risks. Empty = scenario rejected at validation. */
  risks: string[];
  /** Actionable, imperative recommendations. Non-empty. */
  recommendations: string[];
  /** 0.55 – 0.99. Reflects real legal uncertainty, not model-self-report bias. */
  confidence: number;
  /** Canonical jurisdiction. */
  jurisdiction: Jurisdiction;
  /** Applicable law short code (e.g. "FCRA §604(b)(3)", "HIPAA Privacy Rule"). */
  applicable_law: ApplicableLaw;
}

export interface ScenarioCitation {
  /** Must match an IntelligenceSource.id in the registry. */
  record_id: string;
  /** Verbatim quote — should match the registry entry quote. */
  quote: string;
  /** Citation label — should match registry source field. */
  source: string;
}

// ---------------------------------------------------------------------------
// Dataset + manifest
// ---------------------------------------------------------------------------

/**
 * A complete regulation dataset: sources + scenarios + category definitions.
 */
export interface RegulationDataset {
  /** Human-readable regulation name (e.g. "FCRA", "HIPAA", "FERPA"). */
  regulation: string;
  /** Version string (e.g. "v27.1", "v28.0"). */
  version: string;
  /** All sources the scenarios may cite. */
  sources: IntelligenceSource[];
  /** All hand-crafted scenarios. */
  scenarios: IntelligenceScenario[];
  /** Category metadata: display name + target count. */
  categories: Array<{ id: CategoryId; name: string; targetCount: number }>;
}

/**
 * Manifest emitted alongside the JSONL files. Summarizes coverage + split.
 */
export interface DatasetManifest {
  regulation: string;
  version: string;
  generatedAt: string;
  sourceCount: number;
  scenarioCount: number;
  trainCount: number;
  testCount: number;
  byCategory: Record<CategoryId, { total: number; train: number; test: number }>;
  coverageWarnings: string[];
  validationErrors: string[];
}

// ---------------------------------------------------------------------------
// Training-format emission
// ---------------------------------------------------------------------------

/**
 * Together.ai chat-completions training row.
 */
export interface TogetherTrainingRow {
  messages: Array<
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string }
  >;
}
