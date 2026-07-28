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
      ['content_type', 'export_mime_type', 'file_id', 'integration_id', 'mime_type', 'revision_id', 'rule_event_id'].sort(),
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
