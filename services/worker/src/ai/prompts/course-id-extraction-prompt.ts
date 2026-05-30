/**
 * Course-ID extraction prompt (SCRUM-2187 / SCRUM-1953 Phase 5).
 *
 * Dedicated prompt for the course-id eval lane. The generic extraction prompt
 * emits `activityNumber` and never a first-class `courseId`, so the course-id
 * gate could never see the field. This prompt asks the model to read the course
 * / activity identifier verbatim off the document as `courseId`.
 *
 * Eval-only contract: extract the literal on-document value. Do NOT normalize,
 * map to a registry code, or invent a value — if the document says the course id
 * is "not assigned" or blank, return that text verbatim so manual-review
 * fixtures score honestly.
 */
export function buildCourseIdExtractionPrompt(documentText: string): string {
  return [
    'Extract the course or activity identifier from this professional-education document.',
    'Return only JSON: { "courseId": string|null, "credentialType": string|null, "issuerName": string|null, "issuedDate": string|null, "fieldOfStudy": string|null, "confidence": number }.',
    'courseId is the literal course number / activity number / course id printed on the document (e.g. a "Course ID:", "Course Number:", or "Activity Number:" line).',
    'Copy courseId verbatim — do not normalize case, strip hyphens, or map it to any registry code.',
    'If the identifier is missing, blank, or printed as text like "not assigned", return that text exactly as written rather than guessing.',
    'issuedDate must be ISO YYYY-MM-DD. credentialType is one of CPE, CLE, or OTHER.',
    'Do not include any participant, attendee, or recipient personal information in the output.',
    `Document text: ${documentText}`,
  ].join('\n');
}
