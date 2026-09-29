/**
 * recordDisplay.test.ts
 *
 * TDD red-first for the record-detail readability pass (founder-reported,
 * 2026-09-29): a Google Drive record's title rendered as the raw internal id
 * (`google_drive:1IxoL...`), the subtitle showed "0 B" for an unknown size and
 * the raw MIME string instead of a plain-language type, and the Drive
 * "Source modification time" row rendered the raw `mtime:` token unformatted.
 *
 * @see src/components/anchor/AssetDetailView.tsx
 */

import { describe, it, expect } from 'vitest';
import {
  looksLikeConnectorInternalId,
  deriveDisplayTitle,
  deriveDisplayType,
  formatDisplayFileSize,
  formatSourceModifiedTime,
  stripSourceModifiedTimePrefix,
  CONNECTOR_INTERNAL_METADATA_KEYS,
  deriveConnectorSourceLabel,
} from './recordDisplay';
import { RECORD_DETAIL_LABELS, DOCUMENT_TYPE_LABELS } from './copy';

describe('looksLikeConnectorInternalId', () => {
  it('recognizes a google_drive-prefixed opaque id', () => {
    expect(looksLikeConnectorInternalId('google_drive:1IxoLk_vWeuU-BB-2Qkmvs8QmV1qi_GKnGxZF8YheIu8')).toBe(true);
  });

  it('does not flag an ordinary human filename', () => {
    expect(looksLikeConnectorInternalId('Q3-Contract-Signed.pdf')).toBe(false);
  });

  it('does not flag a filename that merely contains a colon in a human name', () => {
    // A real filename with a colon and spaces/periods is not an opaque id.
    expect(looksLikeConnectorInternalId('Chapter: Intro.pdf')).toBe(false);
  });

  it('requires the prefix to match the known connector_source when provided', () => {
    expect(looksLikeConnectorInternalId('google_drive:abc123', 'docusign')).toBe(false);
    expect(looksLikeConnectorInternalId('google_drive:abc123', 'google_drive')).toBe(true);
  });

  it('returns false for empty/undefined input', () => {
    expect(looksLikeConnectorInternalId(undefined)).toBe(false);
    expect(looksLikeConnectorInternalId('')).toBe(false);
  });
});

// Review finding (PR #3190, production-data check): the drive-file-changed.test.ts
// worker fixture ('/Legal/Contracts') is FOLDER-ONLY — it does not end in a
// filename. All 12 distinct Drive files in prod carry a path whose LAST
// segment IS the real file name (e.g. ".../CyberGlobal Product
// Descriptions.docx"), so deriving from the last path segment is correct for
// today's data — but the contract is ambiguous, and a sibling worker change
// (branch fix/drive-records-filed-and-named, not yet merged) will start
// writing the real name into `anchors.filename` and a plain `filename` key
// in metadata. `deriveDisplayTitle` is written to precedence rather than a
// single derivation so it keeps working once that lands, without a second
// change here:
//   (a) `anchors.filename` when it is not a connector-internal id (unchanged)
//   (b) metadata.filename, then .file_name, then .name, when non-empty
//   (c) last segment of `_drive_folder_path`
//   (d) a controlled generic fallback ("{Source} document" / "Secured
//       document") — never the raw id
describe('deriveDisplayTitle', () => {
  const DRIVE_ID_FILENAME = 'google_drive:1IxoLk_vWeuU-BB-2Qkmvs8QmV1qi_GKnGxZF8YheIu8';

  describe('(a) stored filename is human', () => {
    it('leaves an ordinary human filename unchanged (non-connector records must not regress)', () => {
      expect(deriveDisplayTitle('Q3-Contract-Signed.pdf', null)).toBe('Q3-Contract-Signed.pdf');
    });

    it('leaves an ordinary human filename unchanged even with unrelated metadata present', () => {
      expect(deriveDisplayTitle('offer-letter.docx', { pipeline_source: 'sos' })).toBe('offer-letter.docx');
    });

    it('wins even when metadata also carries a filename field (stored value takes precedence)', () => {
      expect(deriveDisplayTitle('offer-letter.docx', { filename: 'Something Else.docx' })).toBe('offer-letter.docx');
    });
  });

  describe('(b) metadata filename/file_name/name (forward-compat with the sibling worker change)', () => {
    it('uses metadata.filename when the stored filename is a connector id', () => {
      const metadata = { connector_source: 'google_drive', filename: 'Q3 Vendor Agreement.gsheet' };
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).toBe('Q3 Vendor Agreement.gsheet');
    });

    it('falls back to metadata.file_name when metadata.filename is absent', () => {
      const metadata = { connector_source: 'google_drive', file_name: 'Q3 Vendor Agreement.gsheet' };
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).toBe('Q3 Vendor Agreement.gsheet');
    });

    it('falls back to metadata.name when filename/file_name are both absent', () => {
      const metadata = { connector_source: 'google_drive', name: 'Q3 Vendor Agreement.gsheet' };
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).toBe('Q3 Vendor Agreement.gsheet');
    });

    it('ignores a blank/whitespace-only metadata.filename and falls through to the next step', () => {
      const metadata = {
        connector_source: 'google_drive',
        filename: '   ',
        _drive_folder_path: '/Legal/Contracts/Q3 Vendor Agreement.gsheet',
      };
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).toBe('Q3 Vendor Agreement.gsheet');
    });

    it('ignores a non-string metadata.filename', () => {
      const metadata = { connector_source: 'google_drive', filename: 123, name: 'Real Name.pdf' };
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).toBe('Real Name.pdf');
    });
  });

  describe('(c) last segment of the Drive folder path', () => {
    it('derives the human name from the last segment of the Drive folder path', () => {
      const metadata = {
        connector_source: 'google_drive',
        _drive_folder_path: '/Shared/Contracts/Q3 Vendor Agreement.gsheet',
      };
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).toBe('Q3 Vendor Agreement.gsheet');
    });

    it('matches real production shapes (deeply nested path ending in the file name)', () => {
      const metadata = {
        connector_source: 'google_drive',
        _drive_folder_path:
          '/My Drive/Arkova Team/Sales/CyberGlobal/CyberGlobal x Arkova Team Folder/Copy of CyberGlobal Product Descriptions.docx',
      };
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).toBe('Copy of CyberGlobal Product Descriptions.docx');
    });
  });

  describe('(d) generic fallback — never the raw id', () => {
    it('falls back to a connector-specific generic label when no name field or folder path is present', () => {
      const metadata = { connector_source: 'google_drive' };
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).toBe('Google Drive document');
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).not.toContain('google_drive:');
    });

    it('falls back to a connector-specific generic label when the folder path is empty/root', () => {
      const metadata = { connector_source: 'google_drive', _drive_folder_path: '/' };
      expect(deriveDisplayTitle(DRIVE_ID_FILENAME, metadata)).toBe('Google Drive document');
    });

    it('falls back to the bare generic label when the connector source is unrecognized', () => {
      const metadata = { connector_source: 'sharepoint' };
      expect(deriveDisplayTitle('sharepoint:abc123', metadata)).toBe(RECORD_DETAIL_LABELS.UNTITLED_DOCUMENT_TITLE);
    });
  });

  it('never returns the raw internal id, for any connector-prefixed filename', () => {
    const result = deriveDisplayTitle(DRIVE_ID_FILENAME, { connector_source: 'google_drive' });
    expect(result).not.toBe(DRIVE_ID_FILENAME);
  });
});

describe('deriveDisplayType', () => {
  it('maps common MIME types to a plain-language label', () => {
    expect(deriveDisplayType('application/pdf')).toBe(DOCUMENT_TYPE_LABELS.PDF);
    expect(deriveDisplayType('application/vnd.google-apps.spreadsheet')).toBe(DOCUMENT_TYPE_LABELS.SPREADSHEET);
    expect(deriveDisplayType('application/vnd.google-apps.document')).toBe(DOCUMENT_TYPE_LABELS.DOCUMENT);
    expect(deriveDisplayType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      DOCUMENT_TYPE_LABELS.SPREADSHEET,
    );
    expect(deriveDisplayType('image/png')).toBe(DOCUMENT_TYPE_LABELS.IMAGE);
  });

  it('is case- and parameter-insensitive', () => {
    expect(deriveDisplayType('APPLICATION/PDF')).toBe(DOCUMENT_TYPE_LABELS.PDF);
    expect(deriveDisplayType('text/csv; charset=utf-8')).toBe(DOCUMENT_TYPE_LABELS.SPREADSHEET);
  });

  it('falls back to metadata content_type / export_mime_type when fileMime is absent', () => {
    expect(deriveDisplayType(null, { content_type: 'application/vnd.google-apps.spreadsheet' })).toBe(
      DOCUMENT_TYPE_LABELS.SPREADSHEET,
    );
    expect(deriveDisplayType(undefined, { export_mime_type: 'application/pdf' })).toBe(DOCUMENT_TYPE_LABELS.PDF);
  });

  it('returns null for an unrecognized or missing MIME type (caller falls back to the raw value)', () => {
    expect(deriveDisplayType('application/x-mystery')).toBeNull();
    expect(deriveDisplayType(null)).toBeNull();
    expect(deriveDisplayType(undefined, {})).toBeNull();
  });
});

describe('formatDisplayFileSize', () => {
  it('hides the size entirely when it is zero, null, or undefined (unknown size)', () => {
    expect(formatDisplayFileSize(0)).toBeNull();
    expect(formatDisplayFileSize(null)).toBeNull();
    expect(formatDisplayFileSize(undefined)).toBeNull();
  });

  it('formats bytes/KB/MB the same way the existing detail page did', () => {
    expect(formatDisplayFileSize(500)).toBe('500 B');
    expect(formatDisplayFileSize(102400)).toBe('100.0 KB');
    expect(formatDisplayFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('stripSourceModifiedTimePrefix', () => {
  it('strips a leading mtime: token', () => {
    expect(stripSourceModifiedTimePrefix('mtime:2026-09-29T20:47:10.002Z')).toBe('2026-09-29T20:47:10.002Z');
  });

  it('strips a leading evt: token', () => {
    expect(stripSourceModifiedTimePrefix('evt:2026-05-04T02:00:00Z:file-evt')).toBe('2026-05-04T02:00:00Z:file-evt');
  });

  it('leaves a value with no known prefix untouched', () => {
    expect(stripSourceModifiedTimePrefix('rev-head-0001')).toBe('rev-head-0001');
  });
});

describe('formatSourceModifiedTime', () => {
  it('strips the mtime: prefix and formats the remainder as a locale date/time (the founder-reported bug)', () => {
    const result = formatSourceModifiedTime('mtime:2026-09-29T20:47:10.002Z');
    expect(result).not.toContain('mtime:');
    expect(result).not.toBeNull();
    // A real formatted date string contains the year, at minimum.
    expect(result).toContain('2026');
  });

  it('strips the evt: prefix, reads the leading ISO timestamp, and formats it', () => {
    const result = formatSourceModifiedTime('evt:2026-05-04T02:00:00Z:file-evt');
    expect(result).not.toContain('evt:');
    expect(result).not.toBeNull();
    expect(result).toContain('2026');
  });

  it('does not invent a date for a token that is not a time — returns the stripped text as-is', () => {
    // §1.5: never render a non-time token as if it were formatted from a date.
    expect(formatSourceModifiedTime('mtime:not-a-real-timestamp')).toBe('not-a-real-timestamp');
  });

  it('returns null for empty/absent input', () => {
    expect(formatSourceModifiedTime(null)).toBeNull();
    expect(formatSourceModifiedTime(undefined)).toBeNull();
    expect(formatSourceModifiedTime('')).toBeNull();
  });
});

// Dashboard/list follow-up (founder-reported, 2026-09-29): the record CARD
// on /dashboard and /records dumped these ten raw connector identifiers
// because its metadata filter was allow-everything. This is the single
// shared list every list/card surface must filter against.
describe('CONNECTOR_INTERNAL_METADATA_KEYS', () => {
  it('names every raw identifier the founder saw on the dashboard card', () => {
    const reported = [
      'file_id',
      'mime_type',
      'revision_id',
      'content_type',
      'external_ref',
      'rule_event_id',
      'integration_id',
      'connector_source',
      'export_mime_type',
      'connector_artifact_id',
    ];
    for (const key of reported) {
      expect(CONNECTOR_INTERNAL_METADATA_KEYS).toContain(key);
    }
  });
});

describe('deriveConnectorSourceLabel', () => {
  it('maps known connector_source markers to a plain-language label', () => {
    expect(deriveConnectorSourceLabel('google_drive')).toBe('Google Drive');
    expect(deriveConnectorSourceLabel('docusign')).toBe('DocuSign');
  });

  it('returns null for an unknown or absent marker', () => {
    expect(deriveConnectorSourceLabel('sharepoint')).toBeNull();
    expect(deriveConnectorSourceLabel(undefined)).toBeNull();
    expect(deriveConnectorSourceLabel(null)).toBeNull();
  });
});
