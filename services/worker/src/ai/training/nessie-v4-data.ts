/**
 * Nessie v4 Training Data Utilities (NMT-06)
 *
 * Core data preparation functions for Nessie v4 fine-tuning.
 * Addresses the three critical gaps from the training best-practices audit:
 *
 * 1. Realistic confidence assignment (not hardcoded 0.92)
 * 2. Deduplication of training examples
 * 3. General instruction data mixing (20-30% to prevent catastrophic forgetting)
 * 4. LoRA-appropriate hyperparameters (2e-4 LR, rank 16, 2 epochs)
 *
 * Used by the nessie-v4-pipeline.ts script for data export and training.
 */

import { createHash } from 'node:crypto';

// ============================================================================
// TYPES
// ============================================================================

export interface V4TrainingExample {
  messages: Array<{ role: string; content: string }>;
  domain: string;
}

export interface V4DomainConfig {
  domain: string;
  credentialTypes: string[];
  minExamples: number;
}

// ============================================================================
// TRAINING DEFAULTS — Per best practices doc Section 11.1
// ============================================================================

export const V4_TRAINING_DEFAULTS = {
  // Learning rate: 2e-4 for LoRA (doc Section 3.1: "LoRA requires ~10x higher LR")
  // v3 used 5e-6 which was 40x too low
  learningRate: 2e-4,

  // Epochs: 2 (doc Section 3.6: "Beyond 3 epochs, most models overfit dramatically")
  // v3 used 4 epochs
  epochs: 2,

  // General data mix: 25% (doc Section 4.2: "20-30% general-purpose instruction data")
  // v3 had 0% general data — catastrophic forgetting
  generalDataMixRatio: 0.25,

  // LoRA rank 16 with alpha = 2x rank (doc Section 3.2)
  loraRank: 16,
  loraAlpha: 32,

  // Target ALL linear layers (doc Section 3.3: "targeting only attention underperforms by 5-15%")
  loraTargetModules: [
    'q_proj', 'k_proj', 'v_proj', 'o_proj',
    'gate_proj', 'up_proj', 'down_proj',
  ],

  // Precision: bf16 (doc Section 3.5: "Prefer bf16 over fp16")
  precision: 'bf16' as const,

  // LR scheduler: cosine with warmup (doc Section 3.1)
  lrScheduler: 'cosine' as const,
  warmupRatio: 0.05,

  // Gradient clipping (doc Section 3.5: "Set max_grad_norm=0.3")
  maxGradNorm: 0.3,

  // Batch size config (doc Section 3.4: "effective batch 8-16")
  batchSize: 2,
  gradientAccumulationSteps: 8, // effective batch = 16

  // Weight decay (doc Section 3.7: "0.01-0.1 for LoRA")
  weightDecay: 0.05,

  // LoRA dropout (doc Section 3.7: "0.1-0.2")
  loraDropout: 0.1,

  // Base model
  baseModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference',
} as const;

// ============================================================================
// DOMAIN CONFIGS — Nessie's four specialty areas
// ============================================================================

export const V4_DOMAIN_CONFIGS: V4DomainConfig[] = [
  { domain: 'sec', credentialTypes: ['SEC_FILING'], minExamples: 500 },
  { domain: 'legal', credentialTypes: ['LEGAL'], minExamples: 500 },
  { domain: 'regulatory', credentialTypes: ['REGULATION'], minExamples: 500 },
  { domain: 'academic', credentialTypes: ['PUBLICATION'], minExamples: 500 },
];

// ============================================================================
// REALISTIC CONFIDENCE ASSIGNMENT
// ============================================================================

/**
 * Key fields that indicate extraction quality.
 * More present = higher confidence is warranted.
 */
const KEY_FIELDS = [
  'issuerName',
  'issuedDate',
  'jurisdiction',
  'fieldOfStudy',
  'registrationNumber',
  'accreditingBody',
] as const;

/**
 * Compute a realistic confidence score based on extraction completeness and text evidence.
 *
 * Unlike v3 which hardcoded 0.92 for every example (teaching the model to always
 * report ~0.92 regardless of actual extraction quality), this function assigns
 * confidence that reflects how much evidence was actually available.
 *
 * Scoring:
 * - Base score starts at 0.40 (credentialType alone)
 * - Each key field present adds 0.06-0.08
 * - Text length bonus: longer text = more evidence (up to +0.08)
 * - Domain bonus: structured domains (SEC, academic) get small boost
 * - Jitter: ±0.02 to prevent exact value clustering
 *
 * Target distribution:
 * - 0.30-0.55: Sparse documents (few fields, short text)
 * - 0.55-0.80: Partial documents (some fields, moderate text)
 * - 0.80-0.95: Complete documents (most fields, substantial text)
 */
export function computeRealisticConfidence(
  fields: Record<string, unknown>,
  sourceText: string,
): number {
  // Base score for having credentialType
  // Nessie always targets domain docs, so base is slightly higher than generic
  let score = 0.45;

  // Key field presence — each adds 0.08
  // 6 key fields × 0.08 = +0.48 max → base 0.40 + 0.48 = 0.88 with all fields
  let keyFieldCount = 0;
  for (const key of KEY_FIELDS) {
    if (fields[key] !== undefined && fields[key] !== null && fields[key] !== '') {
      keyFieldCount++;
      score += 0.08;
    }
  }

  // Text length bonus (logarithmic — diminishing returns)
  // 20 chars = +0.01, 100 chars = +0.04, 500 chars = +0.06, 2000+ chars = +0.08
  const textLen = sourceText.length;
  if (textLen > 10) {
    const lengthBonus = Math.min(0.08, 0.035 * Math.log10(textLen / 10));
    score += lengthBonus;
  }

  // Domain-specific boost for well-structured sources
  const credType = fields.credentialType as string | undefined;
  if (credType === 'SEC_FILING' || credType === 'PUBLICATION') {
    score += 0.02; // Structured data sources
  }

  // Jitter: deterministic based on text content (reproducible but varied)
  const hash = createHash('md5').update(sourceText).digest();
  const jitter = ((hash[0] % 5) - 2) * 0.01; // -0.02 to +0.02
  score += jitter;

  // Clamp to valid range
  return Math.round(Math.min(0.95, Math.max(0.25, score)) * 100) / 100;
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

/**
 * Remove exact-duplicate training examples based on user message content.
 *
 * Two examples are duplicates if they have the same user prompt AND same assistant response.
 * Examples with the same user prompt but different assistant responses are kept
 * (these represent different valid extractions).
 *
 * Doc Section 2.2: "SEC filings contain 40-60% boilerplate"
 */
export function deduplicateByContent(examples: V4TrainingExample[]): V4TrainingExample[] {
  if (examples.length === 0) return [];

  const seen = new Set<string>();
  const deduped: V4TrainingExample[] = [];

  for (const example of examples) {
    const userMsg = example.messages.find(m => m.role === 'user')?.content ?? '';
    const assistantMsg = example.messages.find(m => m.role === 'assistant')?.content ?? '';

    // Hash both user + assistant to detect true duplicates
    // but keep same-user-different-assistant (valid extraction variants)
    const key = createHash('sha256')
      .update(userMsg + '|||' + assistantMsg)
      .digest('hex');

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(example);
    }
  }

  return deduped;
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate a training example meets v4 quality standards.
 *
 * Rejects:
 * - Less than 3 messages (system + user + assistant)
 * - Non-JSON assistant response
 * - Missing credentialType in response
 * - Hardcoded 0.92 confidence (the v3 mistake that caused overconfidence)
 */
export function validateTrainingExample(example: V4TrainingExample): boolean {
  // Must have system + user + assistant
  if (!example.messages || example.messages.length < 3) return false;

  const assistantMsg = example.messages.find(m => m.role === 'assistant');
  if (!assistantMsg) return false;

  // Must be valid JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(assistantMsg.content);
  } catch {
    return false;
  }

  // Must have credentialType
  if (!parsed.credentialType) return false;

  // REJECT hardcoded 0.92 confidence — this was the v3 training bug
  // that taught the model to always report ~0.92 regardless of actual quality
  if (parsed.confidence === 0.92) return false;

  return true;
}

// ============================================================================
// DISTILLATION PROMPT
// ============================================================================

/**
 * Build the prompt used when distilling from Gemini Golden to create
 * Nessie v4 training data.
 *
 * Unlike v3 which just echoed structured metadata back, this prompt
 * asks Gemini to perform real extraction from natural text, producing
 * training examples that teach Nessie actual extraction skills.
 */
export function buildDistillationPrompt(
  sourceText: string,
  credentialTypeHint: string,
): string {
  return `Extract metadata from the following PII-stripped credential text.
Credential type hint: ${credentialTypeHint}

--- BEGIN CREDENTIAL TEXT ---
${sourceText}
--- END CREDENTIAL TEXT ---

Return a valid JSON object with these fields (omit any you cannot determine):
- credentialType: The document type (${credentialTypeHint} or correct if different)
- issuerName: Full official name of the issuing institution/organization
- issuedDate: When issued (YYYY-MM-DD format)
- expiryDate: When it expires, if applicable (YYYY-MM-DD)
- fieldOfStudy: Field of study, specialization, or subject area
- jurisdiction: Geographic jurisdiction (e.g., "California, USA")
- registrationNumber: License/filing/document number
- accreditingBody: Accrediting organization (if distinct from issuer)
- fraudSignals: Array of fraud indicators (default [])
- confidence: Your confidence in this extraction (0.0-1.0)
  - 0.85-0.95: All key fields clearly present in text
  - 0.65-0.84: Most fields present, some inferred
  - 0.45-0.64: Sparse text, significant inference required
  - 0.25-0.44: Very limited information available

Be precise. Only extract what the text explicitly states. Assess your confidence honestly based on how much evidence the text provides — do NOT default to high confidence.

Return ONLY a valid JSON object.`;
}

// ============================================================================
// GENERAL DATA MIXING
// ============================================================================

/**
 * General instruction examples to prevent catastrophic forgetting.
 *
 * Doc Section 4.2: "Include 20-30% general-purpose instruction data"
 *
 * These cover basic instruction following, formatting, reasoning,
 * and conversation tasks that the base model already knows.
 * Without these, fine-tuning causes the model to forget how to
 * follow instructions, format JSON, and reason clearly.
 */
const GENERAL_INSTRUCTION_EXAMPLES: Array<{ messages: Array<{ role: string; content: string }> }> = [
  // JSON formatting
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Convert this to JSON: Name is John Smith, age 35, city Portland.' },
      { role: 'assistant', content: '{"name": "John Smith", "age": 35, "city": "Portland"}' },
    ],
  },
  // Instruction following
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'List three benefits of regular exercise in bullet points.' },
      { role: 'assistant', content: '- Improves cardiovascular health and reduces risk of heart disease\n- Enhances mental health by reducing anxiety and depression symptoms\n- Strengthens muscles and bones, improving overall physical function' },
    ],
  },
  // Summarization
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Summarize in one sentence: The Federal Reserve raised interest rates by 0.25 percentage points on Wednesday, marking the tenth consecutive increase in the central bank\'s campaign to combat inflation. The move brings the benchmark federal funds rate to a range of 5% to 5.25%, the highest level since 2007.' },
      { role: 'assistant', content: 'The Federal Reserve raised interest rates by 0.25 percentage points for the tenth consecutive time, reaching a 16-year high of 5%-5.25% in its ongoing effort to combat inflation.' },
    ],
  },
  // Basic reasoning
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'If a company had revenue of $10M in Q1 and $12M in Q2, what is the quarter-over-quarter growth rate?' },
      { role: 'assistant', content: 'The quarter-over-quarter growth rate is 20%.\n\nCalculation: ($12M - $10M) / $10M = $2M / $10M = 0.20 = 20%' },
    ],
  },
  // Date formatting
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Convert "March 15, 2025" to ISO 8601 format.' },
      { role: 'assistant', content: '2025-03-15' },
    ],
  },
  // Classification
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Classify this document type: "This certifies that Jane Doe has successfully completed the requirements for the degree of Master of Science in Computer Science, conferred this 15th day of May, 2024, by the Board of Trustees of Stanford University."' },
      { role: 'assistant', content: '{"documentType": "DEGREE", "degreeLevel": "Master", "fieldOfStudy": "Computer Science", "issuer": "Stanford University"}' },
    ],
  },
  // Refusal / uncertainty
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant. If you cannot determine something, say so clearly.' },
      { role: 'user', content: 'What is the current stock price of Apple?' },
      { role: 'assistant', content: 'I cannot provide real-time stock prices as I don\'t have access to live market data. For current Apple (AAPL) stock prices, check financial platforms like Yahoo Finance, Google Finance, or your brokerage account.' },
    ],
  },
  // Legal terminology
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the difference between a statute and a regulation?' },
      { role: 'assistant', content: 'A statute is a law enacted by a legislative body (Congress, state legislature), while a regulation is a rule created by an executive agency to implement a statute. Statutes are broader in scope; regulations provide specific details and procedures. For example, Congress passes the Clean Air Act (statute), and the EPA creates detailed emissions standards (regulations) to enforce it.' },
    ],
  },
  // SEC domain knowledge
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the difference between a 10-K and a 10-Q filing?' },
      { role: 'assistant', content: 'A 10-K is an annual comprehensive report filed with the SEC that includes audited financial statements, business overview, risk factors, and management discussion. A 10-Q is a quarterly report with unaudited financials and a more limited scope. 10-K filings are due 60-90 days after fiscal year end; 10-Q filings are due 40-45 days after each of the first three fiscal quarters.' },
    ],
  },
  // Structured extraction practice
  {
    messages: [
      { role: 'system', content: 'You are a metadata extraction assistant. Return only valid JSON.' },
      { role: 'user', content: 'Extract key information: "Patent No. US 11,234,567 B2, issued January 10, 2023, to Acme Corporation, for \'Improved Widget Assembly Method\', assigned to the field of mechanical engineering."' },
      { role: 'assistant', content: '{"credentialType": "PATENT", "issuerName": "United States Patent and Trademark Office", "issuedDate": "2023-01-10", "registrationNumber": "US 11,234,567 B2", "fieldOfStudy": "Mechanical Engineering", "jurisdiction": "United States", "confidence": 0.91, "fraudSignals": []}' },
    ],
  },
  // Regulatory knowledge
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What does CFR stand for and how is it organized?' },
      { role: 'assistant', content: 'CFR stands for Code of Federal Regulations. It is the codification of general and permanent rules published by federal agencies. It is organized into 50 titles representing broad subject areas (e.g., Title 17 covers Commodity and Securities Exchanges, Title 21 covers Food and Drugs). Each title is divided into chapters (usually one per agency), then parts, subparts, and sections.' },
    ],
  },
  // Court citation format
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Parse this legal citation: "Brown v. Board of Education, 347 U.S. 483 (1954)"' },
      { role: 'assistant', content: '{"caseName": "Brown v. Board of Education", "volume": 347, "reporter": "U.S.", "page": 483, "year": 1954, "court": "Supreme Court of the United States", "jurisdiction": "United States (Federal)"}' },
    ],
  },
  // Multi-step reasoning
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'A company reports total assets of $500M and total liabilities of $300M. The company has 10M shares outstanding trading at $25 per share. Calculate the book value per share and the price-to-book ratio.' },
      { role: 'assistant', content: 'Book Value per Share:\n- Shareholders\' Equity = Total Assets - Total Liabilities = $500M - $300M = $200M\n- Book Value per Share = $200M / 10M shares = $20.00\n\nPrice-to-Book Ratio:\n- P/B = Market Price / Book Value = $25.00 / $20.00 = 1.25\n\nThe stock trades at 1.25x book value, meaning the market values it at a 25% premium to its accounting value.' },
    ],
  },
  // Confidence calibration example
  {
    messages: [
      { role: 'system', content: 'You are a metadata extraction assistant. Be honest about your confidence level.' },
      { role: 'user', content: 'Extract metadata: "[REDACTED] certification. Possibly issued sometime in 2020s. Organization unclear."' },
      { role: 'assistant', content: '{"credentialType": "CERTIFICATE", "confidence": 0.30, "fraudSignals": []}' },
    ],
  },
  // Edge case handling
  {
    messages: [
      { role: 'system', content: 'You are a metadata extraction assistant. Return only valid JSON.' },
      { role: 'user', content: 'Extract metadata: ""' },
      { role: 'assistant', content: '{"credentialType": "OTHER", "confidence": 0.10, "fraudSignals": ["EMPTY_DOCUMENT"]}' },
    ],
  },
];

/**
 * Mix general instruction data into domain-specific training examples.
 *
 * Doc Section 4.2: "Include 20-30% general-purpose instruction data in your
 * training mix (70% domain, 30% general)."
 *
 * Without this, the model suffers catastrophic forgetting — it becomes good
 * at domain extraction but forgets how to follow instructions, format JSON,
 * or reason about basic concepts.
 *
 * @param domainExamples - Domain-specific training examples
 * @param ratio - Target ratio of general data (0.25 = 25% general, 75% domain)
 * @returns Mixed and shuffled training examples
 */
export function mixGeneralData(
  domainExamples: V4TrainingExample[],
  ratio: number = V4_TRAINING_DEFAULTS.generalDataMixRatio,
): V4TrainingExample[] {
  if (domainExamples.length === 0) return [];

  // Calculate how many general examples we need
  // If we have 100 domain examples and want 25% general:
  // total = domain / (1 - ratio) = 100 / 0.75 ≈ 133
  // general = 133 - 100 = 33
  const targetTotal = Math.ceil(domainExamples.length / (1 - ratio));
  const generalNeeded = targetTotal - domainExamples.length;

  // Repeat general examples to fill the quota
  const generalExamples: V4TrainingExample[] = [];
  for (let i = 0; i < generalNeeded; i++) {
    const template = GENERAL_INSTRUCTION_EXAMPLES[i % GENERAL_INSTRUCTION_EXAMPLES.length];
    generalExamples.push({
      messages: [...template.messages],
      domain: 'general',
    });
  }

  // Combine and shuffle (Fisher-Yates)
  const combined = [...domainExamples, ...generalExamples];
  for (let i = combined.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }

  return combined;
}
