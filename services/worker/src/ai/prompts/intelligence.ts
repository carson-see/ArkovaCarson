/**
 * Nessie Intelligence Prompts (NMT-07)
 *
 * System prompts for Nessie's compliance intelligence capabilities.
 * These are SEPARATE from extraction prompts (extraction.ts) which are Gemini's job.
 *
 * Nessie intelligence modes:
 * - compliance_qa:    Answer compliance questions with verified citations
 * - risk_analysis:    Identify risks and red flags in credentials
 * - document_summary: Summarize documents for compliance context
 * - recommendation:   Recommend actions based on document analysis
 * - cross_reference:  Cross-reference multiple documents for consistency
 */

export type IntelligenceMode =
  | 'compliance_qa'
  | 'risk_analysis'
  | 'document_summary'
  | 'recommendation'
  | 'cross_reference';

/**
 * Core Nessie intelligence system prompt.
 * Used for all intelligence modes — task-specific additions are appended.
 */
export const INTELLIGENCE_SYSTEM_PROMPT = `You are Nessie, Arkova's verified compliance intelligence engine. You analyze documents and provide actionable compliance intelligence backed by cryptographically anchored evidence.

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
 * Task-specific prompt additions for each intelligence mode.
 */
const INTELLIGENCE_MODE_PROMPTS: Record<IntelligenceMode, string> = {
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

/**
 * Build the complete system prompt for a given intelligence mode.
 */
export function buildIntelligenceSystemPrompt(mode: IntelligenceMode): string {
  return INTELLIGENCE_SYSTEM_PROMPT + INTELLIGENCE_MODE_PROMPTS[mode];
}

/**
 * Build user prompt with RAG context documents.
 * Matches the format used in nessie-query.ts for inference consistency.
 */
export function buildIntelligenceUserPrompt(
  query: string,
  documents: Array<{
    record_id: string;
    source: string;
    title: string | null;
    record_type: string;
    content: string;
    content_hash?: string;
    chain_tx_id?: string | null;
  }>,
): string {
  const docContext = documents.map((doc, i) =>
    `--- DOCUMENT ${i + 1} ---
record_id: ${doc.record_id}
source: ${doc.source}
title: ${doc.title ?? 'Untitled'}
record_type: ${doc.record_type}
content_hash: ${doc.content_hash ?? 'N/A'}
chain_tx_id: ${doc.chain_tx_id ?? 'not yet anchored'}
content: ${doc.content}`
  ).join('\n\n');

  return `USER QUERY: ${query}

VERIFIED DOCUMENTS (${documents.length} results):

${docContext}

Analyze these documents and respond.`;
}

/**
 * Supported intelligence modes for validation.
 */
export const INTELLIGENCE_MODES: IntelligenceMode[] = [
  'compliance_qa',
  'risk_analysis',
  'document_summary',
  'recommendation',
  'cross_reference',
];

/**
 * Check if a string is a valid intelligence mode.
 */
export function isValidIntelligenceMode(mode: string): mode is IntelligenceMode {
  return INTELLIGENCE_MODES.includes(mode as IntelligenceMode);
}
