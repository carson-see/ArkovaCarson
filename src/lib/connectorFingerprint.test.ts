/**
 * Connector-sourced fingerprint detection (BUG-2026-08-13-010, §1.5 / §1.6A).
 *
 * A connector-sourced anchor's fingerprint commits the exact bytes Arkova
 * retrieved from the connected source at fetch time. Source systems may
 * regenerate the file on every retrieval, so a re-download is NOT expected to
 * reproduce the fingerprint — UI surfaces keyed on this helper must state
 * that caveat (and must NOT show it for client-uploaded documents, where
 * recomputing the fingerprint of the retained file always reproduces it).
 */

import { describe, it, expect } from 'vitest';
import {
  CONNECTOR_FETCH_SOURCE_MARKERS,
  isConnectorSourcedAnchorMetadata,
} from './connectorFingerprint';

describe('isConnectorSourcedAnchorMetadata', () => {
  it('recognises the server-written connector fetch markers', () => {
    for (const marker of ['docusign', 'google_drive', 'microsoft_365', 'connector']) {
      expect(isConnectorSourcedAnchorMetadata({ connector_source: marker })).toBe(true);
    }
  });

  it('rejects upload-origin connector_artifact sources (bytes were user-supplied, not fetched)', () => {
    expect(isConnectorSourcedAnchorMetadata({ connector_source: 'manual_upload' })).toBe(false);
    expect(isConnectorSourcedAnchorMetadata({ connector_source: 'batch_upload' })).toBe(false);
  });

  it('rejects free text, case variants, and non-strings — closed set only', () => {
    expect(isConnectorSourcedAnchorMetadata({ connector_source: 'DocuSign' })).toBe(false);
    expect(isConnectorSourcedAnchorMetadata({ connector_source: 'dropbox' })).toBe(false);
    expect(isConnectorSourcedAnchorMetadata({ connector_source: 42 })).toBe(false);
    expect(isConnectorSourcedAnchorMetadata({ connector_source: null })).toBe(false);
  });

  it('returns false for absent metadata (client uploads, pre-connector anchors)', () => {
    expect(isConnectorSourcedAnchorMetadata({})).toBe(false);
    expect(isConnectorSourcedAnchorMetadata(null)).toBe(false);
    expect(isConnectorSourcedAnchorMetadata(undefined)).toBe(false);
  });

  it('the marker set excludes upload-origin sources', () => {
    expect(CONNECTOR_FETCH_SOURCE_MARKERS).not.toContain('manual_upload');
    expect(CONNECTOR_FETCH_SOURCE_MARKERS).not.toContain('batch_upload');
  });
});
