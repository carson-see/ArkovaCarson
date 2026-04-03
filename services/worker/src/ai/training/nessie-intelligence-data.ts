/**
 * Nessie Intelligence Training Data (NMT-07)
 *
 * Training data pipeline for Nessie's actual job: compliance intelligence.
 * Nessie is NOT an extraction model (that's Gemini Golden's job).
 * Nessie analyzes documents and makes recommendations with verified citations.
 *
 * Intelligence task types:
 * 1. compliance_qa       — Answer compliance questions citing anchored docs
 * 2. risk_analysis       — Identify risks/red flags in credentials
 * 3. document_summary    — Summarize credential significance with context
 * 4. recommendation      — Recommend actions based on document analysis
 * 5. cross_reference     — Cross-reference multiple docs for consistency
 *
 * Training format: Together AI ChatML JSONL with RAG context.
 * Each example includes retrieved context documents + verified citations.
 */

import { createHash } from 'node:crypto';

// ============================================================================
// TYPES
// ============================================================================

export type IntelligenceTaskType =
  | 'compliance_qa'
  | 'risk_analysis'
  | 'document_summary'
  | 'recommendation'
  | 'cross_reference';

export interface IntelligenceTrainingExample {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  taskType: IntelligenceTaskType;
  domain: string;
}

export interface IntelligenceContext {
  record_id: string;
  source: string;
  title: string;
  record_type: string;
  content: string;
  content_hash: string;
}

export interface IntelligenceQAPair {
  id: string;
  taskType: IntelligenceTaskType;
  domain: string;
  question: string;
  context: IntelligenceContext[];
  answer: string;
  citations: Array<{ record_id: string; excerpt: string }>;
  confidence: number;
}

// ============================================================================
// SYSTEM PROMPTS — Nessie Intelligence Modes
// ============================================================================

/**
 * Core intelligence system prompt for Nessie.
 * This is what Nessie should be: a compliance intelligence engine that
 * analyzes documents and makes recommendations with verified citations.
 */
export const NESSIE_INTELLIGENCE_SYSTEM_PROMPT = `You are Nessie, Arkova's verified compliance intelligence engine. You analyze documents and provide actionable compliance intelligence backed by cryptographically anchored evidence.

CORE PRINCIPLES:
1. Every factual claim MUST cite a specific document by [record_id].
2. Only cite documents provided in the context. Never fabricate sources.
3. Distinguish between what the documents state vs. your analysis/inference.
4. Flag risks, gaps, and inconsistencies proactively.
5. Provide actionable recommendations, not just summaries.
6. Rate confidence (0.0-1.0) based on evidence strength:
   - 0.85-1.0: Strong evidence, multiple corroborating sources
   - 0.65-0.84: Moderate evidence, single authoritative source
   - 0.40-0.64: Limited evidence, inference required
   - 0.0-0.39: Insufficient evidence, speculative

SOURCE AUTHORITY (prefer higher-authority sources):
- SEC EDGAR filings: Highest for financial/corporate data
- Federal Register: Highest for regulatory data
- CourtListener: Highest for legal precedent
- USPTO: Highest for patent/IP data
- DAPIP: Highest for educational institutions
- OpenAlex: Academic research context

RESPONSE FORMAT:
Return valid JSON:
{
  "analysis": "Your intelligence analysis with inline [record_id] citations",
  "citations": [{"record_id": "...", "source": "...", "excerpt": "relevant quote from document"}],
  "risks": ["identified risk 1", "identified risk 2"],
  "recommendations": ["actionable recommendation 1", "actionable recommendation 2"],
  "confidence": 0.0-1.0,
  "gaps": ["information gaps that would improve the analysis"]
}`;

/**
 * Task-specific prompt additions appended to the system prompt
 * based on the intelligence task type.
 */
export const TASK_PROMPTS: Record<IntelligenceTaskType, string> = {
  compliance_qa: `
TASK: Answer a compliance question using the provided verified documents.
Focus on regulatory requirements, obligations, and compliance status.
Cite specific regulatory provisions and document sections.`,

  risk_analysis: `
TASK: Analyze the provided documents for compliance risks and red flags.
Look for: expired credentials, suspicious timelines, issuer inconsistencies,
jurisdiction conflicts, missing required fields, fraud indicators.
Rank risks by severity (HIGH/MEDIUM/LOW).`,

  document_summary: `
TASK: Provide a compliance-focused summary of the provided documents.
Highlight: credential validity, issuer authority, regulatory context,
notable provisions, expiration status, and verification confidence.`,

  recommendation: `
TASK: Based on the provided documents, recommend specific actions.
Consider: renewal deadlines, compliance gaps, verification steps needed,
regulatory changes that affect the credential, and risk mitigation.`,

  cross_reference: `
TASK: Cross-reference the provided documents for consistency.
Check: dates align across documents, issuers are consistent, jurisdiction
conflicts, credential chains are complete, and no contradictions exist.`,
};

// ============================================================================
// TRAINING EXAMPLE GENERATORS
// ============================================================================

/**
 * Build the context block that represents retrieved RAG documents.
 * This teaches Nessie to work with the same format it sees at inference
 * (matching the nessie-query.ts buildRAGPrompt format).
 */
export function buildTrainingContext(docs: IntelligenceContext[]): string {
  return docs.map((doc, i) => `--- DOCUMENT ${i + 1} ---
record_id: ${doc.record_id}
source: ${doc.source}
title: ${doc.title}
record_type: ${doc.record_type}
content_hash: ${doc.content_hash}
content: ${doc.content}`).join('\n\n');
}

/**
 * Convert a Q&A pair into a Together AI training example.
 */
export function qaPairToTrainingExample(pair: IntelligenceQAPair): IntelligenceTrainingExample {
  const taskPrompt = TASK_PROMPTS[pair.taskType];
  const systemPrompt = NESSIE_INTELLIGENCE_SYSTEM_PROMPT + taskPrompt;
  const contextBlock = buildTrainingContext(pair.context);

  const userMessage = `${pair.question}

VERIFIED DOCUMENTS (${pair.context.length} results):

${contextBlock}

Analyze these documents and respond.`;

  const assistantResponse = JSON.stringify({
    analysis: pair.answer,
    citations: pair.citations,
    risks: [], // Will be filled by teacher model in distillation
    recommendations: [],
    confidence: pair.confidence,
    gaps: [],
  });

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
      { role: 'assistant', content: assistantResponse },
    ],
    taskType: pair.taskType,
    domain: pair.domain,
  };
}

// ============================================================================
// SEED INTELLIGENCE Q&A PAIRS
// ============================================================================

/**
 * Seed Q&A pairs for bootstrapping intelligence training data.
 * These cover the core intelligence tasks across domains.
 * Production pipeline will distill more examples from Gemini.
 */
export const SEED_INTELLIGENCE_PAIRS: IntelligenceQAPair[] = [
  // --- COMPLIANCE Q&A ---
  {
    id: 'INT-001',
    taskType: 'compliance_qa',
    domain: 'sec',
    question: 'Is this company in compliance with SEC quarterly reporting requirements?',
    context: [{
      record_id: 'PR-SEC-001',
      source: 'edgar',
      title: '10-Q Quarterly Report — Q3 2025',
      record_type: 'sec_filing',
      content: 'UNITED STATES SECURITIES AND EXCHANGE COMMISSION. Form 10-Q. For the quarterly period ended September 30, 2025. Filed: November 14, 2025. Registrant: [ORG_REDACTED]. Commission File Number: 001-12345. The registrant has filed all reports required to be filed by Section 13 or 15(d) of the Securities Exchange Act of 1934.',
      content_hash: 'a1b2c3d4e5f6',
    }],
    answer: 'Based on the filed 10-Q [PR-SEC-001], the company appears to be in compliance with SEC quarterly reporting. The filing was made for Q3 2025 (period ending September 30, 2025) and was filed on November 14, 2025 — within the 45-day deadline for non-accelerated filers. The filing itself states the registrant "has filed all reports required to be filed by Section 13 or 15(d) of the Securities Exchange Act of 1934."',
    citations: [{ record_id: 'PR-SEC-001', excerpt: 'The registrant has filed all reports required to be filed by Section 13 or 15(d) of the Securities Exchange Act of 1934.' }],
    confidence: 0.82,
  },

  // --- RISK ANALYSIS ---
  {
    id: 'INT-002',
    taskType: 'risk_analysis',
    domain: 'education',
    question: 'Analyze this credential for potential risks or red flags.',
    context: [{
      record_id: 'CR-EDU-001',
      source: 'user_upload',
      title: 'Bachelor of Science — Computer Science',
      record_type: 'credential',
      content: 'Degree Certificate. [NAME_REDACTED] has been awarded the degree of Bachelor of Science in Computer Science. Conferred: March 15, 2024. Institution: Pacific Western University. Accredited by: National Accreditation Authority for Higher Learning.',
      content_hash: 'b2c3d4e5f6a1',
    }],
    answer: 'HIGH RISK: Multiple red flags identified in this credential [CR-EDU-001].\n\n1. **KNOWN_DIPLOMA_MILL** (HIGH): "Pacific Western University" is a known unaccredited institution that has appeared on multiple diploma mill watchlists.\n2. **UNVERIFIABLE_ISSUER** (HIGH): The accrediting body "National Accreditation Authority for Higher Learning" is not recognized by the U.S. Department of Education or CHEA.\n3. **SUSPICIOUS_DATES** (MEDIUM): March 15, 2024 conferral date is unusual — most U.S. institutions confer degrees in May/June or December.\n\nThis credential should NOT be accepted without additional verification. Recommend requesting official transcripts directly from a recognized institution.',
    citations: [{ record_id: 'CR-EDU-001', excerpt: 'Institution: Pacific Western University. Accredited by: National Accreditation Authority for Higher Learning.' }],
    confidence: 0.91,
  },

  // --- DOCUMENT SUMMARY ---
  {
    id: 'INT-003',
    taskType: 'document_summary',
    domain: 'legal',
    question: 'Summarize the significance of this court opinion for compliance purposes.',
    context: [{
      record_id: 'PR-CL-001',
      source: 'courtlistener',
      title: 'Smith v. Board of Professional Engineers, 2025 WL 12345',
      record_type: 'court_opinion',
      content: 'OPINION. The Board of Professional Engineers revoked respondent\'s license for failure to maintain continuing education requirements under State Code § 32-1001. The Board found that respondent had not completed the required 30 hours of professional development within the biennial renewal period. HELD: The revocation was appropriate given respondent\'s pattern of non-compliance over three consecutive renewal periods.',
      content_hash: 'c3d4e5f6a1b2',
    }],
    answer: 'This court opinion [PR-CL-001] affirms a professional engineering license revocation for continuing education non-compliance.\n\n**Key Compliance Implications:**\n- License revocation was upheld for failure to complete 30 hours of professional development per biennial period (State Code § 32-1001)\n- The "pattern of non-compliance over three consecutive renewal periods" was a significant aggravating factor\n- This establishes precedent that boards may revoke (not just suspend) for repeated CE non-compliance\n\n**Relevance:** Any credential holder subject to continuing education requirements should treat CE deadlines as hard compliance obligations, not administrative formalities.',
    citations: [{ record_id: 'PR-CL-001', excerpt: 'The Board found that respondent had not completed the required 30 hours of professional development within the biennial renewal period.' }],
    confidence: 0.88,
  },

  // --- RECOMMENDATION ---
  {
    id: 'INT-004',
    taskType: 'recommendation',
    domain: 'regulatory',
    question: 'Based on this regulatory filing, what actions should a compliance team take?',
    context: [{
      record_id: 'PR-FR-001',
      source: 'federal_register',
      title: 'Final Rule: Amendments to Professional Licensing Standards',
      record_type: 'regulation',
      content: 'DEPARTMENT OF EDUCATION. 34 CFR Part 602. Final Rule. Effective Date: July 1, 2026. Summary: This rule amends accreditation standards to require all recognized accrediting agencies to verify that institutions maintain student complaint processes. Institutions that fail to demonstrate compliance by the effective date risk loss of accreditation status.',
      content_hash: 'd4e5f6a1b2c3',
    }],
    answer: 'Based on the final rule published in the Federal Register [PR-FR-001], compliance teams should take the following actions:\n\n**IMMEDIATE (Before July 1, 2026):**\n1. Audit existing student complaint processes against the new 34 CFR Part 602 requirements\n2. Document complaint handling procedures and resolution timelines\n3. Verify the institution\'s accrediting agency is aware of the new verification requirements\n\n**MEDIUM-TERM:**\n4. Establish a compliance monitoring schedule for ongoing accreditation requirements\n5. Train relevant staff on the updated complaint process standards\n6. Create an evidence package demonstrating compliance for the accrediting agency\'s next review\n\n**RISK IF IGNORED:** Failure to comply by July 1, 2026 risks loss of accreditation status, which would affect all credentials issued by the institution.',
    citations: [{ record_id: 'PR-FR-001', excerpt: 'Institutions that fail to demonstrate compliance by the effective date risk loss of accreditation status.' }],
    confidence: 0.85,
  },

  // --- CROSS-REFERENCE ---
  {
    id: 'INT-005',
    taskType: 'cross_reference',
    domain: 'professional',
    question: 'Cross-reference these credentials for consistency.',
    context: [
      {
        record_id: 'CR-PRO-001',
        source: 'user_upload',
        title: 'Professional Engineer License — California',
        record_type: 'credential',
        content: 'State of California Board for Professional Engineers. License #C[REDACTED]. Issued: June 2019. Expires: June 2025. Status: Active.',
        content_hash: 'e5f6a1b2c3d4',
      },
      {
        record_id: 'CR-PRO-002',
        source: 'user_upload',
        title: 'Continuing Education Certificate',
        record_type: 'credential',
        content: 'Certificate of Completion. [NAME_REDACTED] has completed 35 Professional Development Hours. Provider: ASCE. Period: January 2023 - December 2024. Topics: Structural Analysis (15 PDH), Seismic Design (10 PDH), Ethics (10 PDH).',
        content_hash: 'f6a1b2c3d4e5',
      },
    ],
    answer: 'Cross-referencing the PE license [CR-PRO-001] and CE certificate [CR-PRO-002]:\n\n**CONSISTENT:**\n- CE certificate (35 PDH, 2023-2024) exceeds California\'s 36 PDH per 2-year requirement (close but would need to verify exact reporting period alignment)\n- Topics include required ethics component (10 PDH ethics via ASCE)\n- Provider (ASCE) is a recognized CE provider\n\n**POTENTIAL ISSUES:**\n- **EXPIRED_CREDENTIAL** (HIGH): The PE license shows expiry date June 2025, which has passed. The license may need renewal.\n- **GAP**: The CE certificate covers 2023-2024, but the license renewal is June 2025. There may be a gap in CE hours for the 2024-2025 period.\n- **35 vs 36 PDH**: California requires 36 PDH per biennial period. The certificate shows 35 PDH — 1 hour short if this is the complete CE record.\n\n**RECOMMENDATION:** Verify current license status with the California Board and confirm whether additional CE hours were completed for the 2024-2025 period.',
    citations: [
      { record_id: 'CR-PRO-001', excerpt: 'Expires: June 2025. Status: Active.' },
      { record_id: 'CR-PRO-002', excerpt: 'has completed 35 Professional Development Hours. Period: January 2023 - December 2024.' },
    ],
    confidence: 0.78,
  },
];

// ============================================================================
// DEDUPLICATION & VALIDATION
// ============================================================================

/**
 * Deduplicate intelligence training examples by content hash.
 */
export function deduplicateExamples(
  examples: IntelligenceTrainingExample[],
): IntelligenceTrainingExample[] {
  const seen = new Set<string>();
  return examples.filter((ex) => {
    const userMsg = ex.messages.find((m) => m.role === 'user')?.content ?? '';
    const key = createHash('sha256').update(userMsg).digest('hex');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Validate an intelligence training example.
 * Returns null if valid, error message if invalid.
 */
export function validateExample(
  example: IntelligenceTrainingExample,
): string | null {
  if (example.messages.length !== 3) {
    return 'Expected 3 messages (system, user, assistant)';
  }
  if (example.messages[0].role !== 'system') return 'First message must be system';
  if (example.messages[1].role !== 'user') return 'Second message must be user';
  if (example.messages[2].role !== 'assistant') return 'Third message must be assistant';

  // Validate assistant response is valid JSON
  try {
    const parsed = JSON.parse(example.messages[2].content);
    if (!parsed.analysis) return 'Assistant response missing "analysis" field';
    if (!Array.isArray(parsed.citations)) return 'Assistant response missing "citations" array';
    if (typeof parsed.confidence !== 'number') return 'Assistant response missing "confidence" number';
  } catch {
    return 'Assistant response is not valid JSON';
  }

  // Validate task type
  const validTypes: IntelligenceTaskType[] = [
    'compliance_qa', 'risk_analysis', 'document_summary', 'recommendation', 'cross_reference',
  ];
  if (!validTypes.includes(example.taskType)) {
    return `Invalid task type: ${example.taskType}`;
  }

  return null;
}

/**
 * Get distribution stats for a set of training examples.
 */
export function getDistributionStats(
  examples: IntelligenceTrainingExample[],
): Record<string, { count: number; domains: Record<string, number> }> {
  const stats: Record<string, { count: number; domains: Record<string, number> }> = {};
  for (const ex of examples) {
    if (!stats[ex.taskType]) {
      stats[ex.taskType] = { count: 0, domains: {} };
    }
    stats[ex.taskType].count++;
    stats[ex.taskType].domains[ex.domain] = (stats[ex.taskType].domains[ex.domain] || 0) + 1;
  }
  return stats;
}
