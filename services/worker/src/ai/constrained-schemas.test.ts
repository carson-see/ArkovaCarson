/**
 * Constrained Decoding Schema Tests (NVI-16)
 *
 * Validates per-regulation JSON schemas used for vLLM guided decoding.
 * Each schema constrains citation record_ids to an enum of canonical IDs
 * from the training set, eliminating ID hallucination.
 */

import { describe, it, expect } from 'vitest';
import {
  getConstrainedSchema,
  detectRegulation,
  FCRA_SCHEMA,
  HIPAA_SCHEMA,
  FERPA_SCHEMA,
  type ConstrainedDecodingSchema,
} from './constrained-schemas.js';

function validateSchemaStructure(schema: ConstrainedDecodingSchema) {
  const s = schema.jsonSchema;
  expect(s.type).toBe('object');
  expect(s.required).toEqual(
    expect.arrayContaining(['answer', 'confidence', 'risks', 'recommendations', 'citations']),
  );

  const props = s.properties as Record<string, any>;
  expect(props.answer.type).toBe('string');
  expect(props.confidence.type).toBe('number');
  expect(props.confidence.minimum).toBe(0.55);
  expect(props.confidence.maximum).toBe(0.99);
  expect(props.risks.type).toBe('array');
  expect(props.recommendations.type).toBe('array');
  expect(props.citations.type).toBe('array');

  const citationItem = props.citations.items;
  expect(citationItem.type).toBe('object');
  expect(citationItem.properties.record_id.enum).toBeDefined();
  expect(Array.isArray(citationItem.properties.record_id.enum)).toBe(true);
  expect(citationItem.properties.record_id.enum.length).toBeGreaterThan(0);
  expect(citationItem.properties.relevance.type).toBe('string');
}

describe('ConstrainedDecodingSchemas', () => {
  describe('FCRA schema', () => {
    it('has correct regulation and version', () => {
      expect(FCRA_SCHEMA.regulation).toBe('FCRA');
      expect(FCRA_SCHEMA.version).toBeDefined();
    });

    it('has non-empty canonical IDs', () => {
      expect(FCRA_SCHEMA.canonicalIds.length).toBeGreaterThanOrEqual(80);
    });

    it('includes core FCRA statute IDs', () => {
      expect(FCRA_SCHEMA.canonicalIds).toContain('fcra-604-b-3');
      expect(FCRA_SCHEMA.canonicalIds).toContain('fcra-605-a');
      expect(FCRA_SCHEMA.canonicalIds).toContain('fcra-611-a');
      expect(FCRA_SCHEMA.canonicalIds).toContain('fcra-615-a');
    });

    it('includes case law IDs', () => {
      expect(FCRA_SCHEMA.canonicalIds).toContain('spokeo-2016');
      expect(FCRA_SCHEMA.canonicalIds).toContain('safeco-2007');
      expect(FCRA_SCHEMA.canonicalIds).toContain('syed-2017');
    });

    it('produces valid JSON schema structure', () => {
      validateSchemaStructure(FCRA_SCHEMA);
    });

    it('enum IDs match canonicalIds', () => {
      const citationEnum = (FCRA_SCHEMA.jsonSchema.properties as any).citations.items.properties
        .record_id.enum;
      expect(citationEnum).toEqual(FCRA_SCHEMA.canonicalIds);
    });
  });

  describe('HIPAA schema', () => {
    it('has correct regulation and version', () => {
      expect(HIPAA_SCHEMA.regulation).toBe('HIPAA');
      expect(HIPAA_SCHEMA.version).toBeDefined();
    });

    it('has non-empty canonical IDs', () => {
      expect(HIPAA_SCHEMA.canonicalIds.length).toBeGreaterThanOrEqual(50);
    });

    it('includes core HIPAA regulation IDs', () => {
      expect(HIPAA_SCHEMA.canonicalIds).toContain('hipaa-164-502');
      expect(HIPAA_SCHEMA.canonicalIds).toContain('hipaa-164-524-access');
      expect(HIPAA_SCHEMA.canonicalIds).toContain('hipaa-164-308-admin');
    });

    it('produces valid JSON schema structure', () => {
      validateSchemaStructure(HIPAA_SCHEMA);
    });
  });

  describe('FERPA schema', () => {
    it('has correct regulation and version', () => {
      expect(FERPA_SCHEMA.regulation).toBe('FERPA');
      expect(FERPA_SCHEMA.version).toBeDefined();
    });

    it('has non-empty canonical IDs', () => {
      expect(FERPA_SCHEMA.canonicalIds.length).toBeGreaterThanOrEqual(30);
    });

    it('includes core FERPA statute IDs', () => {
      expect(FERPA_SCHEMA.canonicalIds).toContain('ferpa-20-1232g');
      expect(FERPA_SCHEMA.canonicalIds).toContain('ferpa-99-31');
      expect(FERPA_SCHEMA.canonicalIds).toContain('ferpa-99-3-education-record');
    });

    it('produces valid JSON schema structure', () => {
      validateSchemaStructure(FERPA_SCHEMA);
    });
  });

  describe('all schemas have unique IDs', () => {
    for (const schema of [FCRA_SCHEMA, HIPAA_SCHEMA, FERPA_SCHEMA]) {
      it(`${schema.regulation} has no duplicate IDs`, () => {
        const unique = new Set(schema.canonicalIds);
        expect(unique.size).toBe(schema.canonicalIds.length);
      });
    }
  });
});

describe('detectRegulation', () => {
  it('detects FCRA from query text', () => {
    expect(detectRegulation('What are the FCRA requirements for adverse action?')).toBe('FCRA');
    expect(detectRegulation('Fair Credit Reporting Act compliance')).toBe('FCRA');
  });

  it('detects HIPAA from query text', () => {
    expect(detectRegulation('HIPAA breach notification requirements')).toBe('HIPAA');
    expect(detectRegulation('PHI disclosure under the Privacy Rule')).toBe('HIPAA');
  });

  it('detects FERPA from query text', () => {
    expect(detectRegulation('FERPA directory information opt-out')).toBe('FERPA');
    expect(detectRegulation('student education records privacy')).toBe('FERPA');
  });

  it('returns null for unrecognized queries', () => {
    expect(detectRegulation('What is the weather today?')).toBeNull();
    expect(detectRegulation('General compliance question')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectRegulation('fcra requirements')).toBe('FCRA');
    expect(detectRegulation('hipaa privacy rule')).toBe('HIPAA');
    expect(detectRegulation('ferpa records')).toBe('FERPA');
  });
});

describe('getConstrainedSchema', () => {
  it('returns FCRA schema for FCRA regulation', () => {
    const schema = getConstrainedSchema('FCRA');
    expect(schema).toBe(FCRA_SCHEMA);
  });

  it('returns HIPAA schema for HIPAA regulation', () => {
    const schema = getConstrainedSchema('HIPAA');
    expect(schema).toBe(HIPAA_SCHEMA);
  });

  it('returns FERPA schema for FERPA regulation', () => {
    const schema = getConstrainedSchema('FERPA');
    expect(schema).toBe(FERPA_SCHEMA);
  });

  it('returns null for unsupported regulation', () => {
    expect(getConstrainedSchema('SOX')).toBeNull();
    expect(getConstrainedSchema('GDPR')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(getConstrainedSchema('fcra')).toBe(FCRA_SCHEMA);
    expect(getConstrainedSchema('Hipaa')).toBe(HIPAA_SCHEMA);
  });
});
