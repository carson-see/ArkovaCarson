/**
 * Tests for stripJsonComments utility (NMT-02)
 *
 * Nessie reasoning/DPO models output JavaScript-style comments in JSON,
 * causing JSON.parse failures. This utility strips them before parsing.
 */

import { describe, it, expect } from 'vitest';
import { stripJsonComments } from './strip-json-comments.js';

describe('stripJsonComments (NMT-02)', () => {
  it('returns valid JSON unchanged', () => {
    const json = '{"name": "John", "age": 30}';
    expect(stripJsonComments(json)).toBe(json);
  });

  it('strips single-line comments at end of line', () => {
    const input = `{
  "credentialType": "DEGREE", // this is a degree
  "issuerName": "MIT" // Massachusetts Institute of Technology
}`;
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.credentialType).toBe('DEGREE');
    expect(parsed.issuerName).toBe('MIT');
  });

  it('strips standalone single-line comments', () => {
    const input = `{
  // Extracted fields below
  "credentialType": "LICENSE",
  // confidence is high
  "confidence": 0.95
}`;
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.credentialType).toBe('LICENSE');
    expect(parsed.confidence).toBe(0.95);
  });

  it('strips multi-line comments', () => {
    const input = `{
  /* This is a
     multi-line comment */
  "credentialType": "CERTIFICATE",
  "issuerName": "Red Cross"
}`;
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.credentialType).toBe('CERTIFICATE');
  });

  it('does not strip // inside string values', () => {
    const input = '{"url": "https://example.com/path", "note": "see // details"}';
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.url).toBe('https://example.com/path');
    expect(parsed.note).toBe('see // details');
  });

  it('does not strip /* inside string values', () => {
    const input = '{"pattern": "/* match */", "value": "test"}';
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.pattern).toBe('/* match */');
  });

  it('handles escaped quotes in strings', () => {
    const input = '{"name": "O\\"Brien", "type": "DEGREE"} // comment';
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe('O"Brien');
  });

  it('handles mixed comment styles', () => {
    const input = `{
  // Single-line comment
  "a": 1, /* inline block */ "b": 2,
  /* Multi-line
     block comment */
  "c": 3 // trailing
}`;
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('handles empty input', () => {
    expect(stripJsonComments('')).toBe('');
  });

  it('handles trailing comma before closing brace (common LLM mistake)', () => {
    const input = `{
  "credentialType": "DEGREE",
  "issuerName": "MIT", // trailing comma
}`;
    const stripped = stripJsonComments(input);
    // Comment stripped, but trailing comma remains (separate concern)
    expect(stripped).not.toContain('//');
  });
});
