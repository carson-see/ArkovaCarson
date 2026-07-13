import { describe, expect, it } from 'vitest';
import { EXTRACTION_V6_SYSTEM_PROMPT } from '../prompts/extraction-v6.js';
import {
  S33_PROPOSED_SUBTYPES,
  V6_SUBTYPE_TAXONOMY,
  normalizeForFingerprint,
} from './golden-dataset-s33-types.js';

function promptSubtypeTaxonomy(): Record<string, string[]> {
  const block = EXTRACTION_V6_SYSTEM_PROMPT
    .split('SUBTYPE TAXONOMY (use these exact values when applicable):')[1]
    ?.split('Other →')[0];
  if (!block) throw new Error('v6 subtype taxonomy block is missing');
  return Object.fromEntries(block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Z_]+:/.test(line))
    .map((line) => {
      const [credentialType, valuesWithNote] = line.split(':', 2);
      const values = valuesWithNote.split(' (e.g.,', 1)[0]
        .split('|')
        .map((value) => value.trim());
      return [credentialType, values];
    }));
}

describe('S3.3 held-out shared taxonomy support', () => {
  it('mirrors the ratified v6 prompt taxonomy exactly', () => {
    expect(V6_SUBTYPE_TAXONOMY).toEqual(promptSubtypeTaxonomy());
  });

  it('keeps the CPE extension quarantined as proposed and absent from v6', () => {
    expect(S33_PROPOSED_SUBTYPES).toEqual({
      CPE: ['general_cpe', 'ethics_cpe', 'specialized_cpe'],
    });
    expect(V6_SUBTYPE_TAXONOMY).not.toHaveProperty('CPE');
    expect(EXTRACTION_V6_SYSTEM_PROMPT).not.toMatch(/^CPE:/m);
  });

  it('normalizes case and whitespace without changing substantive tokens', () => {
    expect(normalizeForFingerprint('  Nursing\n Council\tCertificate  '))
      .toBe('nursing council certificate');
  });
});
