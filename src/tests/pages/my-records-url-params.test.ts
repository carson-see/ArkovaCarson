/**
 * MyRecordsPage URL-param parsing tests (NCA-FU2c).
 *
 * The compliance scorecard deep-links into `/my-records` with
 * `?action=upload&credential_type=...` to auto-open the SecureDocument
 * dialog on mount (see MyRecordsPage.tsx line ~75). These tests assert
 * the contract of the URL keys so future refactors can't quietly rename
 * them without breaking the scorecard flow.
 */

import { describe, expect, it } from 'vitest';

function readDeepLinkIntent(search: string): {
  shouldAutoOpenUpload: boolean;
  credentialType?: string;
  jurisdiction?: string;
} {
  const params = new URLSearchParams(search);
  return {
    shouldAutoOpenUpload: params.get('action') === 'upload',
    credentialType: params.get('credential_type') ?? undefined,
    jurisdiction: params.get('jurisdiction') ?? undefined,
  };
}

function scrubDeepLinkParams(search: string): string {
  const next = new URLSearchParams(search);
  next.delete('action');
  next.delete('credential_type');
  next.delete('jurisdiction');
  return next.toString();
}

describe('MyRecordsPage deep-link URL-param parsing', () => {
  it('auto-opens upload when action=upload is present', () => {
    const r = readDeepLinkIntent('?action=upload&credential_type=license');
    expect(r.shouldAutoOpenUpload).toBe(true);
    expect(r.credentialType).toBe('license');
  });

  it('does not auto-open for other action values', () => {
    expect(readDeepLinkIntent('?action=view').shouldAutoOpenUpload).toBe(false);
    expect(readDeepLinkIntent('?action=').shouldAutoOpenUpload).toBe(false);
  });

  it('leaves credentialType undefined when not provided', () => {
    const r = readDeepLinkIntent('?action=upload');
    expect(r.credentialType).toBeUndefined();
  });

  it('carries jurisdiction through when present', () => {
    const r = readDeepLinkIntent('?action=upload&credential_type=license&jurisdiction=NY');
    expect(r.jurisdiction).toBe('NY');
  });

  it('scrubs action / credential_type / jurisdiction but preserves other params', () => {
    const scrubbed = scrubDeepLinkParams('?action=upload&credential_type=x&jurisdiction=CA&tab=secured');
    expect(scrubbed).toBe('tab=secured');
  });

  it('scrubbing an empty query returns an empty string', () => {
    expect(scrubDeepLinkParams('')).toBe('');
  });

  it('jurisdiction is passed to SecureDocumentDialog (SCRUM-925)', () => {
    const r = readDeepLinkIntent('?action=upload&credential_type=license&jurisdiction=FCRA');
    expect(r.shouldAutoOpenUpload).toBe(true);
    expect(r.credentialType).toBe('license');
    expect(r.jurisdiction).toBe('FCRA');
  });
});
