/**
 * DRIVE-03 (SCRUM-2368) — change classification + dedupe tests.
 *
 * Each file revision must queue at most once; trashed / removed / unsupported
 * MIME changes are ignored (safe status, not queued). Retry is idempotent by
 * (file_id, revision). Audit payloads are bounded + PII-scrubbed.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDriveChange,
  revisionKey,
  buildDriveChangeAudit,
  SUPPORTED_MIME_PREFIXES,
} from './drive-change-dedupe.js';

const WATCHED = ['folder-1'];

function change(over: Record<string, unknown> = {}) {
  const { file: fileOver, ...rest } = over;
  const base = {
    fileId: 'file-1',
    removed: false,
    file: {
      id: 'file-1',
      name: 'contract.pdf',
      mimeType: 'application/pdf',
      trashed: false,
      parents: ['folder-1'],
      headRevisionId: 'rev-1',
      ...(fileOver as Record<string, unknown> ?? {}),
    },
    ...rest,
  };
  // Allow tests to null out the whole file object (removed change).
  if (fileOver === undefined && 'file' in over) base.file = undefined as never;
  return base;
}

describe('classifyDriveChange — queue decisions', () => {
  it('queues a supported-MIME revision in a watched folder', () => {
    const c = classifyDriveChange(change(), WATCHED);
    expect(c.action).toBe('queue');
    expect(c.reason).toBe('queued');
    expect(c.revisionKey).toBe('file-1::rev-1');
  });

  it('ignores a change whose parents do not match any watched folder', () => {
    const c = classifyDriveChange(change({ file: { parents: ['other'] } }), WATCHED);
    expect(c.action).toBe('ignore');
    expect(c.reason).toBe('parent_mismatch');
  });

  it('ignores a removed change (safe status, not queued)', () => {
    const c = classifyDriveChange(change({ removed: true, file: undefined }), WATCHED);
    expect(c.action).toBe('ignore');
    expect(c.reason).toBe('removed');
  });

  it('ignores a trashed file', () => {
    const c = classifyDriveChange(change({ file: { trashed: true } }), WATCHED);
    expect(c.action).toBe('ignore');
    expect(c.reason).toBe('trashed');
  });

  it('ignores an unsupported MIME (e.g. a Google Drive folder)', () => {
    const c = classifyDriveChange(
      change({ file: { mimeType: 'application/vnd.google-apps.folder' } }),
      WATCHED,
    );
    expect(c.action).toBe('ignore');
    expect(c.reason).toBe('unsupported_mime');
  });

  it('ignores a shortcut MIME', () => {
    const c = classifyDriveChange(
      change({ file: { mimeType: 'application/vnd.google-apps.shortcut' } }),
      WATCHED,
    );
    expect(c.action).toBe('ignore');
    expect(c.reason).toBe('unsupported_mime');
  });

  it('accepts a native Google Doc (exportable, supported)', () => {
    const c = classifyDriveChange(
      change({ file: { mimeType: 'application/vnd.google-apps.document', headRevisionId: undefined, modifiedTime: '2026-01-01T00:00:00Z' } }),
      WATCHED,
    );
    expect(c.action).toBe('queue');
  });

  it('ignores a change missing both file id and revision', () => {
    const c = classifyDriveChange(change({ fileId: null, file: { id: undefined, headRevisionId: undefined, modifiedTime: undefined } }), WATCHED);
    expect(c.action).toBe('ignore');
    expect(c.reason).toBe('unresolvable');
  });
});

describe('revisionKey — dedupe identity', () => {
  it('is stable for the same file + revision (idempotent retry)', () => {
    const c1 = change();
    const c2 = change();
    expect(revisionKey(c1)).toBe(revisionKey(c2));
  });

  it('differs for a NEW revision of the same file', () => {
    const c1 = change();
    const c2 = change({ file: { headRevisionId: 'rev-2' } });
    expect(revisionKey(c1)).not.toBe(revisionKey(c2));
  });

  it('falls back to modifiedTime when there is no head revision (native Docs)', () => {
    const c = change({ file: { headRevisionId: undefined, modifiedTime: '2026-02-02T00:00:00Z' } });
    expect(revisionKey(c)).toContain('mtime:');
  });

  it('returns null when neither revision nor modifiedTime nor time is present', () => {
    const c = change({ fileId: null, time: undefined, file: { id: undefined, headRevisionId: undefined, modifiedTime: undefined } });
    expect(revisionKey(c)).toBeNull();
  });
});

describe('buildDriveChangeAudit — bounded + scrubbed', () => {
  it('emits only bounded, non-sensitive fields (no raw actor email, no folder path)', () => {
    const audit = buildDriveChangeAudit(
      change({ file: { lastModifyingUser: { emailAddress: 'actor@example.com' }, name: 'super-secret-contract.pdf' } }),
      { reason: 'queued', watched: WATCHED },
    );
    const json = JSON.stringify(audit);
    // Actor email is scrubbed; filename is not copied verbatim.
    expect(json).not.toContain('actor@example.com');
    expect(json).not.toContain('super-secret-contract.pdf');
    // Bounded, structured fields ARE present.
    expect(audit.reason).toBe('queued');
    expect(audit.file_id).toBe('file-1');
    expect(audit.mime_type).toBe('application/pdf');
  });

  it('caps an oversized field to a bounded length', () => {
    const audit = buildDriveChangeAudit(
      change({ file: { headRevisionId: 'r'.repeat(5000) } }),
      { reason: 'queued', watched: WATCHED },
    );
    expect((audit.revision_id ?? '').length).toBeLessThanOrEqual(256);
  });

  it('exposes the supported-MIME allowlist for reuse', () => {
    expect(SUPPORTED_MIME_PREFIXES.length).toBeGreaterThan(0);
  });
});
