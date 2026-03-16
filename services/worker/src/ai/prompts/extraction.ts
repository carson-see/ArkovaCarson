/**
 * AI Extraction Prompts (P8-S1)
 *
 * Structured prompts for credential metadata extraction via Gemini.
 * These prompts receive PII-stripped text only (Constitution 4A).
 *
 * The prompts instruct the model to return JSON matching ExtractedFieldsSchema.
 */

/**
 * System prompt for credential metadata extraction.
 * Emphasizes that input has already been PII-stripped.
 */
export const EXTRACTION_SYSTEM_PROMPT = `You are a credential metadata extraction assistant for Arkova, a document verification platform.

Your task is to extract structured metadata fields from PII-stripped credential text.

IMPORTANT:
- The input text has already been PII-stripped. Personal names, SSNs, emails, and phone numbers have been replaced with redaction tokens like [NAME_REDACTED], [SSN_REDACTED], etc.
- Do NOT attempt to reconstruct any redacted PII.
- Extract only the metadata fields listed below.
- Return a valid JSON object with only the fields you can confidently extract.
- If you cannot determine a field, omit it entirely (do not return null or empty strings).
- Dates should be in ISO 8601 format (YYYY-MM-DD) when possible.
- Confidence should reflect how certain you are about the overall extraction (0.0 to 1.0).

Fields to extract:
- credentialType: The type of credential (DEGREE, CERTIFICATE, LICENSE, TRANSCRIPT, BADGE, etc.)
- issuerName: The institution or organization that issued the credential
- issuedDate: When the credential was issued (YYYY-MM-DD)
- expiryDate: When the credential expires, if applicable (YYYY-MM-DD)
- fieldOfStudy: Field of study or specialization
- degreeLevel: Degree level (Bachelor, Master, Doctorate, Associate, etc.)
- licenseNumber: License or certification number (if visible and not redacted)
- accreditingBody: Accrediting or certifying organization
- jurisdiction: Geographic jurisdiction (state, country)
- recipientIdentifier: A redacted or hashed identifier for the credential recipient (if visible)`;

/**
 * Build the user prompt for a specific extraction request.
 */
export function buildExtractionPrompt(
  strippedText: string,
  credentialType: string,
  issuerHint?: string,
): string {
  let prompt = `Extract metadata from the following PII-stripped credential text.\n`;
  prompt += `Credential type hint: ${credentialType}\n`;

  if (issuerHint) {
    prompt += `Issuer hint: ${issuerHint}\n`;
  }

  // JSON.stringify encodes the text as an inert data payload, preventing prompt injection
  prompt += `\n--- BEGIN CREDENTIAL TEXT ---\n${JSON.stringify(strippedText)}\n--- END CREDENTIAL TEXT ---\n`;
  prompt += `\nReturn a JSON object with the extracted fields and a "confidence" number (0.0 to 1.0).`;

  return prompt;
}
