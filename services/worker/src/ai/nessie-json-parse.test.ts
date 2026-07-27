/**
 * Tests for parseNessieJson (hardened Nessie model-output JSON parser)
 *
 * Nessie (fine-tuned Llama 3.1) responses are prone to the same failure
 * modes as Gemini Flash: wrapping the JSON payload in ```json fences and
 * appending trailing prose/continuation tokens after the closing brace. A
 * naked JSON.parse throws SyntaxError on either shape. This mirrors the
 * hardening pattern in gemini.ts's parseModelJson (BUG-2026-06-24-014).
 */

import { describe, it, expect } from 'vitest';
import { parseNessieJson } from './nessie-json-parse.js';

describe('parseNessieJson', () => {
  it('parses clean JSON unchanged', () => {
    const input = '{"credentialType":"DEGREE","issuerName":"MIT","confidence":0.9}';
    expect(parseNessieJson(input)).toEqual({
      credentialType: 'DEGREE',
      issuerName: 'MIT',
      confidence: 0.9,
    });
  });

  it('strips a ```json ... ``` markdown fence before parsing', () => {
    const input = [
      '```json',
      '{"credentialType":"LICENSE","issuerName":"State Board","confidence":0.85}',
      '```',
    ].join('\n');

    expect(parseNessieJson(input)).toEqual({
      credentialType: 'LICENSE',
      issuerName: 'State Board',
      confidence: 0.85,
    });
  });

  it('strips a bare ``` ... ``` fence (no language tag) before parsing', () => {
    const input = [
      '```',
      '{"credentialType":"CERTIFICATE","issuerName":"Acme"}',
      '```',
    ].join('\n');

    expect(parseNessieJson(input)).toEqual({
      credentialType: 'CERTIFICATE',
      issuerName: 'Acme',
    });
  });

  it('salvages JSON with trailing prose after the closing brace', () => {
    const input =
      '{"credentialType":"DEGREE","issuerName":"Stanford University"}\n\nI hope this helps! Let me know if you need anything else.';

    expect(parseNessieJson(input)).toEqual({
      credentialType: 'DEGREE',
      issuerName: 'Stanford University',
    });
  });

  it('salvages fenced JSON that also has trailing prose', () => {
    const input = [
      '```json',
      '{"credentialType":"LICENSE","issuerName":"Texas Board of Nursing"}',
      '```',
      '',
      'Let me know if you need any clarification on this extraction.',
    ].join('\n');

    expect(parseNessieJson(input)).toEqual({
      credentialType: 'LICENSE',
      issuerName: 'Texas Board of Nursing',
    });
  });

  it('repairs a trailing comma before the closing brace', () => {
    const input = '{"credentialType":"DEGREE","issuerName":"MIT",}';
    expect(parseNessieJson(input)).toEqual({
      credentialType: 'DEGREE',
      issuerName: 'MIT',
    });
  });

  it('repairs an unterminated/truncated JSON object by balancing delimiters', () => {
    const input = '{"credentialType":"DEGREE","issuerName":"MIT"';
    expect(parseNessieJson(input)).toEqual({
      credentialType: 'DEGREE',
      issuerName: 'MIT',
    });
  });

  it('throws when there is no salvageable JSON object at all', () => {
    expect(() => parseNessieJson('not json at all')).toThrow();
  });

  it('throws when the parsed value is a JSON array, not an object', () => {
    expect(() => parseNessieJson('[1,2,3]')).toThrow('not a JSON object');
  });

  it('still strips JS-style comments before parsing (NMT-02 parity)', () => {
    const input = [
      '{',
      '  "credentialType": "DEGREE", // inline comment',
      '  "issuerName": "MIT"',
      '}',
    ].join('\n');

    expect(parseNessieJson(input)).toEqual({
      credentialType: 'DEGREE',
      issuerName: 'MIT',
    });
  });
});
