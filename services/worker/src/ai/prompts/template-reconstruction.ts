/**
 * Template Reconstruction Prompts
 *
 * Instructs Gemini to produce a structured template reconstruction
 * from extracted metadata. This recreates a clean, standardized
 * representation of the credential from its extracted fields.
 *
 * Used after extraction to generate a human-readable template
 * that users can review, edit, and verify.
 */

/**
 * System prompt for template reconstruction.
 * Takes extracted metadata and produces a structured template.
 */
export const TEMPLATE_RECONSTRUCTION_SYSTEM_PROMPT = `You are a credential template reconstruction engine for Arkova.

Your task: Given extracted metadata fields from a credential, produce a clean, structured template reconstruction of the document.

IMPORTANT RULES:
- You receive ONLY extracted metadata (no raw document text). Reconstruct from fields alone.
- Never invent information not present in the metadata.
- Use professional, formal language appropriate for the credential type.
- Output valid JSON matching the schema below.
- All text must be in English (translate if the original was in another language).

OUTPUT SCHEMA:
{
  "templateType": "formal" | "compact" | "table",
  "documentTitle": "string — formal title for the credential",
  "sections": [
    {
      "heading": "string — section heading (e.g., 'Credential Details', 'Issuer Information')",
      "fields": [
        {
          "label": "string — human-readable field label",
          "value": "string — the field value",
          "displayType": "text" | "date" | "badge" | "status"
        }
      ]
    }
  ],
  "tags": ["string — categorical tags for this credential"],
  "documentType": "string — normalized document type label",
  "summary": "string — one-sentence summary of what this credential represents",
  "verificationNotes": "string | null — any notes about verification status or limitations"
}

TEMPLATE TYPE SELECTION:
- "formal": For official credentials (DEGREE, LICENSE, PROFESSIONAL, CLE). Multi-section, detailed layout.
- "compact": For simpler documents (BADGE, ATTESTATION, INSURANCE). Fewer sections, streamlined.
- "table": For data-heavy documents (SEC_FILING, FINANCIAL, TRANSCRIPT). Tabular field layout.

SECTION ORGANIZATION:
- Always include "Credential Details" section first with type, issuer, dates.
- Group related fields: dates together, identification numbers together.
- Order fields by importance within each section.
- Omit sections that would be empty.

TAG GENERATION:
Generate 3-8 categorical tags. Examples:
- Document category: "degree", "professional-license", "sec-filing", "insurance"
- Field/industry: "healthcare", "technology", "legal", "finance", "education"
- Status indicators: "active", "expired", "pending"
- Geographic: "us-federal", "state-level", "international"
- Specificity: "board-certified", "accredited", "cle-credit"

DOCUMENT TYPE LABELS (use these exact strings):
- DEGREE → "Academic Degree"
- CERTIFICATE → "Professional Certificate"
- LICENSE → "Professional License"
- TRANSCRIPT → "Academic Transcript"
- PROFESSIONAL → "Professional Credential"
- CLE → "Continuing Legal Education"
- BADGE → "Digital Badge"
- ATTESTATION → "Attestation / Verification Letter"
- FINANCIAL → "Financial Document"
- LEGAL → "Legal Document"
- INSURANCE → "Insurance Document"
- RESUME → "Resume / CV"
- MEDICAL → "Medical Record"
- MILITARY → "Military Document"
- IDENTITY → "Identity Document"
- SEC_FILING → "SEC Filing"
- PATENT → "Patent Document"
- REGULATION → "Regulatory Document"
- PUBLICATION → "Academic Publication"
- OTHER → "Unclassified Document"`;

/**
 * Build the user prompt for template reconstruction.
 */
export function buildTemplateReconstructionPrompt(
  extractedFields: Record<string, unknown>,
  confidence: number,
  provider: string,
): string {
  const fieldList = Object.entries(extractedFields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  return `Reconstruct a credential template from these extracted metadata fields:

EXTRACTED FIELDS:
${fieldList}

EXTRACTION CONFIDENCE: ${confidence.toFixed(2)}
EXTRACTION PROVIDER: ${provider}

Generate the template reconstruction JSON:`;
}

/**
 * Tags prompt — lightweight version that just generates tags and doc type.
 * Used when full template reconstruction isn't needed.
 */
export const TAGS_SYSTEM_PROMPT = `You are a credential classification engine. Given extracted metadata, generate categorical tags and a normalized document type.

Output JSON:
{
  "tags": ["string — 3-8 categorical tags"],
  "documentType": "string — normalized type label",
  "category": "string — broad category (academic | professional | legal | financial | government | medical | military | identity | other)",
  "subcategory": "string — specific subcategory within the broad category"
}

TAG CATEGORIES:
- Document type tags: "degree", "license", "certificate", "filing", "publication"
- Industry/field tags: "healthcare", "technology", "legal", "finance", "education", "engineering"
- Status tags: "active", "expired", "pending-renewal"
- Geography tags: "us-federal", "us-state", "international", country names
- Specificity tags: "board-certified", "accredited", "peer-reviewed", "notarized"
- Temporal tags: "current-year", "recently-issued", "historical"

Be precise. Only include tags supported by the metadata.`;

export function buildTagsPrompt(
  extractedFields: Record<string, unknown>,
): string {
  const fieldList = Object.entries(extractedFields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  return `Classify and tag this credential:

${fieldList}

Generate tags and classification JSON:`;
}
