/**
 * RecordsList.connector-readability.test.tsx
 *
 * TDD red-first (coordinator scope addition, 2026-09-29): the founder looked
 * at /dashboard and saw every Drive record card dumping raw internal
 * metadata (file id, mime type, revision id, content type, external ref,
 * rule event id, integration id, connector source, export mime type,
 * connector artifact id), titled with the raw internal id
 * (`google_drive:<fileId>`), with no version indication.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RecordsList, type Record } from './RecordsList';
import { CONNECTOR_INTERNAL_METADATA_KEYS } from '@/lib/recordDisplay';

const DRIVE_INTERNAL_FILENAME = 'google_drive:1IxoLk_vWeuU-BB-2Qkmvs8QmV1qi_GKnGxZF8YheIu8';

const driveRecord: Record = {
  id: 'rec-drive-1',
  filename: DRIVE_INTERNAL_FILENAME,
  fingerprint: 'a'.repeat(64),
  status: 'SECURED',
  createdAt: '2026-09-01T00:00:00Z',
  securedAt: '2026-09-01T00:05:00Z',
  fileSize: 0,
  publicId: 'ARK-DOC-1',
  metadata: {
    connector_source: 'google_drive',
    _drive_folder_path: '/Legal/Contracts/Q3 Vendor Agreement.gsheet',
    file_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
    mime_type: 'application/vnd.google-apps.spreadsheet',
    content_type: 'application/vnd.google-apps.spreadsheet',
    external_ref: 'ext-ref-12345',
    rule_event_id: 'rule-event-98765',
    integration_id: 'integration-555',
    connector_artifact_id: 'artifact-777',
    export_mime_type: 'text/csv',
    revision_id: 'rev-head-0001',
  },
};

describe('RecordsList — connector record cards (2026-09-29 dashboard follow-up)', () => {
  it('never renders any of the ten raw connector identifiers on the card', () => {
    const { container } = render(<RecordsList records={[driveRecord]} />);
    const text = container.textContent ?? '';
    for (const key of CONNECTOR_INTERNAL_METADATA_KEYS) {
      // Neither the raw key label nor its values should leak onto the card.
      expect(text).not.toContain(key);
    }
    expect(text).not.toContain('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
    expect(text).not.toContain('ext-ref-12345');
    expect(text).not.toContain('rule-event-98765');
    expect(text).not.toContain('artifact-777');
  });

  it('derives the card title from the Drive folder path instead of the raw internal id', () => {
    const { getByText, queryByText } = render(<RecordsList records={[driveRecord]} />);
    expect(getByText('Q3 Vendor Agreement.gsheet')).toBeInTheDocument();
    expect(queryByText(DRIVE_INTERNAL_FILENAME)).not.toBeInTheDocument();
  });

  it('shows a truthful type and a source label for a connector record', () => {
    const { getByText } = render(<RecordsList records={[driveRecord]} />);
    // The credential-type badge lowercases its text (existing convention).
    expect(getByText('spreadsheet')).toBeInTheDocument();
    expect(getByText('Google Drive')).toBeInTheDocument();
  });

  it('shows a version chip for a version > 1 record', () => {
    const v2: Record = { ...driveRecord, id: 'rec-drive-2', versionNumber: 2 };
    const { getByTestId } = render(<RecordsList records={[v2]} />);
    expect(getByTestId('record-version-chip')).toHaveTextContent('Version 2');
  });

  it('shows a "replaced by newer version" chip for a SUPERSEDED record, without hiding the row', () => {
    const superseded: Record = { ...driveRecord, id: 'rec-drive-1', status: 'SUPERSEDED', versionNumber: 1 };
    const { getByTestId, getByText } = render(<RecordsList records={[superseded]} />);
    // Still a visible row — superseded records remain valid evidence.
    expect(getByText('Q3 Vendor Agreement.gsheet')).toBeInTheDocument();
    expect(getByTestId('record-superseded-chip')).toHaveTextContent(/replaced by/i);
  });

  it('does not affect a non-connector record (regression guard)', () => {
    const plain: Record = {
      id: 'rec-plain-1',
      filename: 'diploma.pdf',
      fingerprint: 'b'.repeat(64),
      status: 'SECURED',
      createdAt: '2026-01-01T00:00:00Z',
      securedAt: '2026-01-01T00:05:00Z',
      fileSize: 102400,
      publicId: 'ARK-DOC-2',
    };
    const { getByText, queryByTestId } = render(<RecordsList records={[plain]} />);
    expect(getByText('diploma.pdf')).toBeInTheDocument();
    expect(queryByTestId('record-version-chip')).not.toBeInTheDocument();
    expect(queryByTestId('record-superseded-chip')).not.toBeInTheDocument();
  });

  it('keeps fraud_* filtering intact alongside the connector denylist (BUG-2026-07-17-010 regression)', () => {
    const withFraud: Record = {
      ...driveRecord,
      metadata: { ...driveRecord.metadata, fraud_score: 0.87, fraud_risk_level: 'high' },
    };
    const { container } = render(<RecordsList records={[withFraud]} />);
    expect(container.textContent?.toLowerCase()).not.toContain('fraud');
  });
});
