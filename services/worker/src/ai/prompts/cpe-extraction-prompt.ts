import { stripProfessionalEducationPii } from '../../compliance/professional-education.js';

export function buildCpeExtractionPrompt(evidence: unknown): string {
  const piiStrippedEvidence = stripProfessionalEducationPii(evidence);

  return [
    'Extract CPE metadata from this credential evidence package.',
    'Return only JSON matching CpeMetadata.',
    'CpeMetadata fields: credit_hours, field_of_study, delivery_method, sponsor_id, reporting_period_start, reporting_period_end, extraction_confidence, extraction_source, nasba_status, nasba_lookup_date, requires_manual_review.',
    'Use only NASBA fields of study and approved CPE delivery methods. Set extraction_source to "ai".',
    'Set requires_manual_review true when extraction_confidence is below 0.85 or any required CPE compliance field is missing.',
    'Do not include recipient name, email, postal address, or any other PII in the output.',
    `PII-stripped evidence: ${JSON.stringify(piiStrippedEvidence)}`,
  ].join('\n');
}
