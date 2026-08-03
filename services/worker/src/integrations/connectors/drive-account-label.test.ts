/**
 * PR #1944 review follow-up — canonical Drive account_label parser tests.
 */
import { describe, it, expect } from 'vitest';
import { parseDriveAccountLabel, stringifyDriveAccountLabel } from './drive-account-label.js';

describe('parseDriveAccountLabel', () => {
  it('parses the full canonical shape', () => {
    const raw = JSON.stringify({ email: 'admin@example.com', channel_token: 'tok-1', resource_id: 'res-1' });
    expect(parseDriveAccountLabel(raw)).toEqual({
      email: 'admin@example.com',
      channel_token: 'tok-1',
      resource_id: 'res-1',
    });
  });

  it('returns null for null input', () => {
    expect(parseDriveAccountLabel(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseDriveAccountLabel(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseDriveAccountLabel('')).toBeNull();
  });

  it('returns null for invalid JSON (never throws)', () => {
    expect(parseDriveAccountLabel('{not json')).toBeNull();
  });

  it('returns null for a plain non-JSON display string (a DocuSign/Adobe-style label)', () => {
    expect(parseDriveAccountLabel('Acme Corp')).toBeNull();
  });

  it('returns null for a JSON array', () => {
    expect(parseDriveAccountLabel('[1,2,3]')).toBeNull();
  });

  it('returns null for a JSON primitive (number)', () => {
    expect(parseDriveAccountLabel('12345')).toBeNull();
  });

  it('returns null for a JSON primitive (string that happens to be valid JSON)', () => {
    // JSON.parse('"hello"') => 'hello' — a string, not an object.
    expect(parseDriveAccountLabel('"hello"')).toBeNull();
  });

  it('fills missing keys with null individually rather than failing the whole parse', () => {
    expect(parseDriveAccountLabel(JSON.stringify({ channel_token: 'tok-only' }))).toEqual({
      email: null,
      channel_token: 'tok-only',
      resource_id: null,
    });
  });

  it('treats a non-string value for a known key as null (defensive typing)', () => {
    expect(parseDriveAccountLabel(JSON.stringify({ email: 123, channel_token: 'tok-1' }))).toEqual({
      email: null,
      channel_token: 'tok-1',
      resource_id: null,
    });
  });

  it('returns null for a JSON null literal', () => {
    expect(parseDriveAccountLabel('null')).toBeNull();
  });
});

describe('stringifyDriveAccountLabel', () => {
  it('round-trips through parseDriveAccountLabel', () => {
    const label = { email: 'a@b.com', channel_token: 'tok', resource_id: 'res' };
    expect(parseDriveAccountLabel(stringifyDriveAccountLabel(label))).toEqual(label);
  });

  it('round-trips null fields', () => {
    const label = { email: null, channel_token: 'tok', resource_id: null };
    expect(parseDriveAccountLabel(stringifyDriveAccountLabel(label))).toEqual(label);
  });
});
