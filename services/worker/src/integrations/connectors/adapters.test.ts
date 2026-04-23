/**
 * Tests for connector adapters (INT-10 / INT-12 / INT-13).
 */
import { describe, it, expect } from 'vitest';
import {
  adaptAdobeSign,
  adaptCheckr,
  adaptDocusign,
  adaptGoogleDrive,
  adaptMicrosoftGraph,
  adaptVeremark,
} from './adapters.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const ctx = { org_id: ORG };

describe('INT-12 — DocuSign adapter', () => {
  it('maps envelope-completed → ESIGN_COMPLETED', () => {
    const out = adaptDocusign(
      {
        event: 'envelope-completed',
        envelopeId: 'env-42',
        status: 'completed',
        sender: { email: 'HR@acme.com' },
        envelopeDocuments: [{ documentId: 'd1', name: 'msa.pdf' }],
      },
      ctx,
    );
    expect(out).toEqual({
      trigger_type: 'ESIGN_COMPLETED',
      org_id: ORG,
      vendor: 'docusign',
      external_file_id: 'env-42',
      filename: 'msa.pdf',
      folder_path: null,
      sender_email: 'hr@acme.com',
      subject: null,
    });
  });

  it('rejects malformed payloads', () => {
    expect(() => adaptDocusign({ event: 'other' }, ctx)).toThrow();
  });
});

describe('INT-12 — Adobe Sign adapter', () => {
  it('maps AGREEMENT_WORKFLOW_COMPLETED', () => {
    const out = adaptAdobeSign(
      {
        event: 'AGREEMENT_WORKFLOW_COMPLETED',
        agreement: {
          id: 'ag-1',
          name: 'contract.pdf',
          senderInfo: { email: 'SIGNER@acme.com' },
        },
      },
      ctx,
    );
    expect(out.vendor).toBe('adobe_sign');
    expect(out.external_file_id).toBe('ag-1');
    expect(out.sender_email).toBe('signer@acme.com');
  });
});

describe('INT-10 — Google Drive adapter', () => {
  it('builds folder_path from parents array', () => {
    const out = adaptGoogleDrive(
      {
        resourceId: 'r1',
        fileId: 'file-1',
        name: 'report.pdf',
        parents: ['folder-a', 'folder-b'],
      },
      ctx,
    );
    expect(out.trigger_type).toBe('WORKSPACE_FILE_MODIFIED');
    expect(out.vendor).toBe('google_drive');
    expect(out.folder_path).toBe('/folder-a/folder-b');
    expect(out.external_file_id).toBe('file-1');
  });
});

describe('INT-10 — Microsoft Graph adapter', () => {
  it('infers sharepoint when resource path contains /sites/', () => {
    const out = adaptMicrosoftGraph(
      {
        subscriptionId: 'sub-1',
        changeType: 'updated',
        resource: "sites('acme')/drive/items/42",
        resourceData: { id: 'item-42', name: 'spec.docx' },
      },
      ctx,
    );
    expect(out.vendor).toBe('sharepoint');
  });

  it('falls through to onedrive otherwise', () => {
    const out = adaptMicrosoftGraph(
      {
        subscriptionId: 'sub-1',
        changeType: 'updated',
        resource: 'me/drive/items/42',
        resourceData: { id: 'item-42' },
      },
      ctx,
    );
    expect(out.vendor).toBe('onedrive');
  });
});

describe('INT-13 — Veremark adapter', () => {
  it('prefers report.reportId over checkId when present', () => {
    const out = adaptVeremark(
      {
        event: 'check.completed',
        checkId: 'chk-1',
        candidate: { email: 'CANDIDATE@acme.com' },
        report: { reportId: 'rep-77' },
      },
      ctx,
    );
    expect(out.vendor).toBe('veremark');
    expect(out.external_file_id).toBe('rep-77');
    expect(out.sender_email).toBe('candidate@acme.com');
  });

  it('falls back to checkId when no report present', () => {
    const out = adaptVeremark(
      { event: 'check.completed', checkId: 'chk-1' },
      ctx,
    );
    expect(out.external_file_id).toBe('chk-1');
  });
});

describe('INT-13 — Checkr adapter', () => {
  it('maps report.completed', () => {
    const out = adaptCheckr(
      {
        type: 'report.completed',
        data: {
          object: {
            id: 'rep-1',
            status: 'complete',
            candidate_id: 'cand-1',
          },
        },
      },
      ctx,
    );
    expect(out.vendor).toBe('checkr');
    expect(out.external_file_id).toBe('rep-1');
  });
});
