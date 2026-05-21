import { stripProfessionalEducationPii } from '../../compliance/professional-education.js';

export function buildCleExtractionPrompt(evidence: unknown): string {
  const piiStrippedEvidence = stripProfessionalEducationPii(evidence);

  return [
    'Extract CLE metadata from this credential evidence package.',
    'Return only JSON matching CleMetadata.',
    'CleMetadata fields: credit_hours, ethics_hours, jurisdiction, approved_provider_name, provider_approval_status, provider_lookup_date, delivery_format, course_title, course_id, reporting_period_start, reporting_period_end, extraction_confidence, extraction_source, requires_manual_review.',
    'ethics_hours is a first-class separate field: never infer ethics_hours from total credit_hours and never default it to 0.',
    'Set requires_manual_review true when extraction_confidence is below 0.85, parsing is uncertain, or ethics_hours is null.',
    'Do not include attorney name, email, postal address, bar number, or any other PII in the output.',
    `PII-stripped evidence: ${JSON.stringify(piiStrippedEvidence)}`,
  ].join('\n');
}
