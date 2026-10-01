/**
 * SCRUM-2903 GD-PROD — Drive file-changed sink §1.6A tests.
 *
 * The sink (makeDriveFileChangedJobDeps().enqueueArtifact) is the ONE place
 * Drive bytes are touched. These tests enforce the pre-mortem mitigations:
 *   (b) metadata is a fixed ids-only shape — NO key holds bytes / a Buffer,
 *   (c) errors are fixed strings; a Buffer-bearing error is redacted before it
 *       could reach job_queue.last_error; the feature flag gates hashing,
 *   plus: the fingerprint equals an independent SHA-256 of the exact bytes.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

// The job module eagerly imports `../utils/db.js`, which validates the full
// worker env at import and throws without it. Every test injects its own `db`
// mock into makeDriveFileChangedJobDeps, so the real client is never used —
// stub it out (same approach as docusign-envelope-completed.test.ts). jobQueue
// stays REAL so we exercise the actual sanitizeLastError redaction.
vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../config.js', () => ({ config: { enableConnectorArtifactEnqueue: true } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { makeDriveFileChangedJobDeps } from './drive-file-changed.js';
import { sanitizeLastError, REDACTED_LAST_ERROR_TOKEN } from '../utils/jobQueue.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const INT = '22222222-2222-2222-2222-222222222222';

function makeDb(opts: {
  rpcResult?: { data: unknown; error: unknown };
  auditResult?: { data: unknown; error: unknown };
} = {}) {
  const rpc = vi.fn(async (..._args: unknown[]) => opts.rpcResult ?? { data: 'artifact-1', error: null });
  const single = vi.fn(async (..._args: unknown[]) => opts.auditResult ?? { data: { id: 'evt-1' }, error: null });
  const insert = vi.fn((..._args: unknown[]) => ({ select: () => ({ single }) }));
  const from = vi.fn(() => ({ insert }));
  return { db: { rpc, from }, rpc, insert };
}

const sinkInput = {
  orgId: ORG,
  integrationId: INT,
  fileId: 'file-42',
  revisionId: 'rev-7',
  documentBytes: Buffer.from('the confidential drive document bytes'),
  contentType: 'application/pdf',
  exportMimeType: null,
  mimeType: 'application/pdf',
  sourceTimestamp: '2026-07-22T10:00:00.000Z',
  ruleEventId: 'evt-src',
  // SCRUM-4507 link-back fields. Always supplied by
  // processDriveFileChangedJob (`?? null`), never undefined at this boundary.
  sharedDriveId: 'shared-drive-legal',
  folderId: 'folder-legal',
  folderPath: '/Legal/Contracts',
  revisionKind: 'head_revision' as const,
  // BUG-2026-09-29: the Drive file's human name. Always supplied by
  // processDriveFileChangedJob (`?? null`), never undefined at this boundary.
  filename: 'msa.pdf',
};

describe('drive sink — fingerprint + idempotent enqueue', () => {
  it('computes the exact server-side SHA-256 and enqueues source=google_drive', async () => {
    const { db, rpc } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    const result = await deps.enqueueArtifact(sinkInput);

    const expected = createHash('sha256').update(sinkInput.documentBytes).digest('hex');
    const rpcArgs = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(rpcArgs.p_source).toBe('google_drive');
    expect(rpcArgs.p_fingerprint_sha256).toBe(expected);
    expect(rpcArgs.p_external_ref).toBe('file-42');
    expect(rpcArgs.p_external_revision).toBe('rev-7');
    expect(rpcArgs.p_byte_length).toBe(sinkInput.documentBytes.byteLength);
    expect(result.artifactId).toBe('artifact-1');
  });
});

describe('drive sink — §1.6A pre-mortem (b): metadata is ids-only, never bytes', () => {
  it('no RPC metadata value is a Buffer / holds raw bytes', async () => {
    const { db, rpc } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await deps.enqueueArtifact(sinkInput);

    const rpcArgs = rpc.mock.calls[0]![1] as { p_metadata: Record<string, unknown> };
    const meta = rpcArgs.p_metadata;
    // Fixed ids-only shape.
    expect(Object.keys(meta).sort()).toEqual(
      [
        'content_type',
        'export_mime_type',
        'file_id',
        'integration_id',
        'mime_type',
        'revision_id',
        'rule_event_id',
        // SCRUM-4507: underscore-prefixed so the record page's generic
        // metadata dump (which hides `_`-prefixed keys) does not show them
        // raw — they are rendered by the dedicated Drive source block.
        '_drive_shared_drive_id',
        '_drive_folder_id',
        '_drive_folder_path',
        '_drive_revision_kind',
        // BUG-2026-09-29: deliberately NOT underscore-prefixed —
        // connector-artifact-drain.ts's defaultMaterializeAnchor reads a
        // plain top-level `filename` key off connector_artifact.metadata
        // (same convention DocuSign's `external_filename`/`filename` already
        // use) to name the anchor. Underscoring it would hide it from that
        // lookup, not just from the generic metadata dump.
        'filename',
      ].sort(),
    );
    // No value is a Buffer/typed-array, and the doc bytes appear nowhere.
    for (const v of Object.values(meta)) {
      expect(Buffer.isBuffer(v)).toBe(false);
      expect(ArrayBuffer.isView(v as ArrayBufferView)).toBe(false);
    }
    const docText = sinkInput.documentBytes.toString('utf8');
    expect(JSON.stringify(rpcArgs)).not.toContain(docText);
  });

  it('the audit event details carry ids + byte_length but never the fingerprint or bytes', async () => {
    const { db, insert } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await deps.enqueueArtifact(sinkInput);

    const auditRow = insert.mock.calls[0]![0] as { details: Record<string, unknown> };
    expect(auditRow.details.connector_artifact_id).toBe('artifact-1');
    expect(auditRow.details.byte_length).toBe(sinkInput.documentBytes.byteLength);
    expect(auditRow.details).not.toHaveProperty('fingerprint_sha256');
    const docText = sinkInput.documentBytes.toString('utf8');
    expect(JSON.stringify(auditRow)).not.toContain(docText);
  });
});

describe('drive sink — §1.6A pre-mortem (c): fixed-string errors + feature gate', () => {
  it('does NOT hash or enqueue when the feature flag is disabled', async () => {
    const { db, rpc, insert } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: false });
    const result = await deps.enqueueArtifact(sinkInput);
    expect(rpc).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(result.artifactId).toBe('connector_artifact_enqueue_disabled');
  });

  it('throws a fixed string (no bytes) when the enqueue RPC errors', async () => {
    const { db } = makeDb({ rpcResult: { data: null, error: { message: 'db down' } } });
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await expect(deps.enqueueArtifact(sinkInput)).rejects.toThrow('drive_connector_artifact_enqueue_failed');
  });

  it('throws a fixed string when the audit insert errors', async () => {
    const { db } = makeDb({ auditResult: { data: null, error: { message: 'audit down' } } });
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await expect(deps.enqueueArtifact(sinkInput)).rejects.toThrow('drive_document_sink_failed');
  });

  it('a Buffer-bearing error is redacted before it could reach job_queue.last_error', () => {
    // Defense-in-depth: even if some future path handed the byte Buffer to the
    // failJob sanitizer, sanitizeLastError collapses it to a redaction token.
    expect(sanitizeLastError(sinkInput.documentBytes)).toBe(REDACTED_LAST_ERROR_TOKEN);
    // And a serialized-buffer shape is caught too.
    expect(sanitizeLastError(JSON.stringify(sinkInput.documentBytes))).toBe(REDACTED_LAST_ERROR_TOKEN);
    // The fixed error strings the sink throws are byte-free and pass through.
    expect(sanitizeLastError('drive_connector_artifact_enqueue_failed')).toBe('drive_connector_artifact_enqueue_failed');
  });
});

/**
 * SCRUM-4507 — the Drive source link-back metadata the record page reads.
 *
 * This is the LAST producer-side hop: whatever lands in `p_metadata` here is
 * what `connector-artifact-drain.ts` later spreads onto `anchors.metadata`
 * (the drain is T3 and deliberately untouched by this change — the mapping
 * belongs in the producer). So the shape assertions that matter live here.
 */
describe('SCRUM-4507 Drive source link-back metadata', () => {
  it('writes the four _drive_* keys verbatim from the sink input', async () => {
    const { db, rpc } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await deps.enqueueArtifact(sinkInput);

    const meta = (rpc.mock.calls[0]![1] as { p_metadata: Record<string, unknown> }).p_metadata;
    expect(meta._drive_shared_drive_id).toBe('shared-drive-legal');
    expect(meta._drive_folder_id).toBe('folder-legal');
    expect(meta._drive_folder_path).toBe('/Legal/Contracts');
    expect(meta._drive_revision_kind).toBe('head_revision');
    // file_id / revision_id keep their existing names — the record page's
    // Drive link builder reads those, so renaming them would silently break
    // every anchor written before this change.
    expect(meta.file_id).toBe('file-42');
    expect(meta.revision_id).toBe('rev-7');
  });

  it('writes null (never undefined) for every absent link-back field', async () => {
    const { db, rpc } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await deps.enqueueArtifact({
      ...sinkInput,
      sharedDriveId: null,
      folderId: null,
      folderPath: null,
      revisionKind: null,
    });

    const meta = (rpc.mock.calls[0]![1] as { p_metadata: Record<string, unknown> }).p_metadata;
    for (const key of ['_drive_shared_drive_id', '_drive_folder_id', '_drive_folder_path', '_drive_revision_kind']) {
      expect(meta).toHaveProperty(key);
      expect(meta[key]).toBeNull();
    }
  });

  it('never writes an email, an account label, or a Drive environment marker', async () => {
    // §1.4 + §1.6A. `drive-account-label.ts` parses a blob whose
    // `account_label` IS the connected Google account's email address; the
    // link-back fields must not become a back door for it. `_drive_env` is
    // deliberately absent too — unlike DocuSign there is no demo/prod Drive
    // split, so an env key would be a field with no measured value behind it.
    const { db, rpc, insert } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await deps.enqueueArtifact({
      ...sinkInput,
      folderPath: '/Legal/Contracts',
    });

    const rpcArgs = rpc.mock.calls[0]![1] as { p_metadata: Record<string, unknown> };
    const serialized = JSON.stringify(rpcArgs.p_metadata);
    expect(serialized).not.toContain('@');
    expect(rpcArgs.p_metadata).not.toHaveProperty('account_label');
    expect(rpcArgs.p_metadata).not.toHaveProperty('actor_email');
    expect(rpcArgs.p_metadata).not.toHaveProperty('_drive_env');
    // The audit breadcrumb is the second persisted surface — same rule.
    const auditRow = insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(auditRow)).not.toContain('@');
  });

  it('keeps the byte-discard invariant with the link-back fields present', async () => {
    const { db, rpc, insert } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await deps.enqueueArtifact(sinkInput);

    const docText = sinkInput.documentBytes.toString('utf8');
    const rpcArgs = rpc.mock.calls[0]![1] as { p_metadata: Record<string, unknown> };
    for (const v of Object.values(rpcArgs.p_metadata)) {
      expect(Buffer.isBuffer(v)).toBe(false);
      expect(ArrayBuffer.isView(v as ArrayBufferView)).toBe(false);
    }
    expect(JSON.stringify(rpcArgs)).not.toContain(docText);
    expect(JSON.stringify(insert.mock.calls[0]![0])).not.toContain(docText);
  });
});

/**
 * BUG-2026-09-29 — display-name fix.
 *
 * (Filing root cause: `resolve_connector_destination_folder` has always read
 * the connection id out of `metadata->>'integration_id'`, never a COLUMN —
 * the leading hypothesis that the column mattered was refuted by reading
 * 0462 directly, and confirmed a second time against production: the actual
 * per-anchor gap is a connection that is momentarily `revoked_at` at anchor
 * INSERT time, fixed in `connector-artifact-drain.ts`'s retry sweep instead
 * of here — see that file's agents.md entry. `enqueue_connector_artifact`'s
 * `integration_id` COLUMN stays unpopulated; tracked as a hygiene-only
 * follow-up, not part of this fix.)
 */
describe('BUG-2026-09-29 filing + display-name fixes', () => {
  it('writes the Drive file name as a plain (non-underscore) `filename` metadata key', async () => {
    const { db, rpc } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await deps.enqueueArtifact(sinkInput);

    const meta = (rpc.mock.calls[0]![1] as { p_metadata: Record<string, unknown> }).p_metadata;
    expect(meta.filename).toBe('msa.pdf');
  });

  it('writes a null filename (never undefined) when Drive gave no name', async () => {
    const { db, rpc } = makeDb();
    const deps = makeDriveFileChangedJobDeps({ db, enableConnectorArtifactEnqueue: true });
    await deps.enqueueArtifact({ ...sinkInput, filename: null });

    const meta = (rpc.mock.calls[0]![1] as { p_metadata: Record<string, unknown> }).p_metadata;
    expect(meta).toHaveProperty('filename');
    expect(meta.filename).toBeNull();
  });
});
