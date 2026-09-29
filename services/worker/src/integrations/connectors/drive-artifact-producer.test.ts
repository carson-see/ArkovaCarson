/**
 * SCRUM-2903 GD-PROD — Drive connector-artifact producer tests.
 *
 * Proves the orchestration contract and pre-mortem (d): the producer never
 * carries actor_email / PII into the artifact. The payload schema has NO
 * actor_email field, so a Google actor email cannot ride into the sink.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  processDriveFileChangedJob,
  parseDriveFileChangedJobPayload,
  DriveFileChangedJobPayload,
  DRIVE_ARTIFACT_SOURCE,
  CONNECTOR_ARTIFACT_ENQUEUE_DISABLED_ID,
  DRIVE_REVISION_KINDS,
  type DriveArtifactProducerDeps,
} from './drive-artifact-producer.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const INT = '22222222-2222-4222-8222-222222222222';

function makeDeps(overrides: Partial<DriveArtifactProducerDeps> = {}): {
  deps: DriveArtifactProducerDeps;
  resolveAccessToken: ReturnType<typeof vi.fn>;
  fetchDocument: ReturnType<typeof vi.fn>;
  enqueueArtifact: ReturnType<typeof vi.fn>;
} {
  const resolveAccessToken = vi.fn(async () => ({ accessToken: 'live-access-token' }));
  const fetchDocument = vi.fn(async () => ({
    bytes: Buffer.from('drive doc bytes'),
    contentType: 'application/pdf',
    exportMimeType: null,
  }));
  const enqueueArtifact = vi.fn(async () => ({ artifactId: 'artifact-abc' }));
  const deps: DriveArtifactProducerDeps = {
    resolveAccessToken,
    fetchDocument,
    enqueueArtifact,
    ...overrides,
  };
  return { deps, resolveAccessToken, fetchDocument, enqueueArtifact };
}

describe('processDriveFileChangedJob', () => {
  it('resolves token → fetches bytes → hands them to the sink and returns its id', async () => {
    const { deps, resolveAccessToken, fetchDocument, enqueueArtifact } = makeDeps();
    const result = await processDriveFileChangedJob(
      {
        org_id: ORG,
        integration_id: INT,
        file_id: 'file-9',
        revision_id: 'rev-3',
        mime_type: 'application/pdf',
        modified_time: '2026-07-22T10:00:00.000Z',
        rule_event_id: 'evt-1',
      },
      deps,
    );

    expect(resolveAccessToken).toHaveBeenCalledWith({ orgId: ORG, integrationId: INT });
    expect(fetchDocument).toHaveBeenCalledWith({
      fileId: 'file-9',
      accessToken: 'live-access-token',
      mimeType: 'application/pdf',
    });
    const sinkArg = enqueueArtifact.mock.calls[0]![0];
    expect(sinkArg.orgId).toBe(ORG);
    expect(sinkArg.fileId).toBe('file-9');
    expect(sinkArg.revisionId).toBe('rev-3');
    expect(Buffer.isBuffer(sinkArg.documentBytes)).toBe(true);
    expect(sinkArg.sourceTimestamp).toBe('2026-07-22T10:00:00.000Z');
    expect(result).toEqual({ artifactId: 'artifact-abc' });
  });

  it('short-circuits BEFORE token resolve and byte fetch when the enqueue flag is off', async () => {
    // The sink also guards the flag, but guarding ONLY there meant a disabled
    // connector still decrypted a KMS-wrapped token, called the Drive API, and
    // buffered the whole document into a 2 GiB container every 5 minutes — all
    // to throw the bytes away.
    const { deps, resolveAccessToken, fetchDocument, enqueueArtifact } = makeDeps({
      isEnqueueEnabled: () => false,
    });

    const result = await processDriveFileChangedJob(
      { org_id: ORG, integration_id: INT, file_id: 'file-9', revision_id: 'rev-3' },
      deps,
    );

    expect(resolveAccessToken).not.toHaveBeenCalled();
    expect(fetchDocument).not.toHaveBeenCalled();
    expect(enqueueArtifact).not.toHaveBeenCalled();
    expect(result.artifactId).toBe(CONNECTOR_ARTIFACT_ENQUEUE_DISABLED_ID);
  });

  it('runs the full path when the flag is on', async () => {
    const { deps, resolveAccessToken, fetchDocument, enqueueArtifact } = makeDeps({
      isEnqueueEnabled: () => true,
    });

    await processDriveFileChangedJob({ org_id: ORG, integration_id: INT, file_id: 'f' }, deps);

    expect(resolveAccessToken).toHaveBeenCalled();
    expect(fetchDocument).toHaveBeenCalled();
    expect(enqueueArtifact).toHaveBeenCalled();
  });

  it('runs the full path when no flag probe is supplied (sink keeps its own guard)', async () => {
    const { deps, fetchDocument } = makeDeps();
    await processDriveFileChangedJob({ org_id: ORG, integration_id: INT, file_id: 'f' }, deps);
    expect(fetchDocument).toHaveBeenCalled();
  });

  it('defaults optional fields (revision/mime/timestamp/rule_event) to null', async () => {
    const { deps, enqueueArtifact } = makeDeps();
    await processDriveFileChangedJob({ org_id: ORG, integration_id: INT, file_id: 'f' }, deps);
    const sinkArg = enqueueArtifact.mock.calls[0]![0];
    expect(sinkArg.revisionId).toBeNull();
    expect(sinkArg.mimeType).toBeNull();
    expect(sinkArg.sourceTimestamp).toBeNull();
    expect(sinkArg.ruleEventId).toBeNull();
  });

  it('pre-mortem (d): schema strips unknown keys — actor_email cannot reach the sink', async () => {
    const { deps, enqueueArtifact } = makeDeps();
    await processDriveFileChangedJob(
      {
        org_id: ORG,
        integration_id: INT,
        file_id: 'f',
        // A hostile / careless enqueuer tries to smuggle PII through:
        actor_email: 'someone@example.com',
        lastModifyingUser: { emailAddress: 'leak@example.com' },
      } as unknown,
      deps,
    );
    const sinkArg = enqueueArtifact.mock.calls[0]![0];
    const serialized = JSON.stringify(sinkArg);
    expect(serialized).not.toContain('actor_email');
    expect(serialized).not.toContain('@example.com');
    expect(serialized).not.toContain('lastModifyingUser');
  });

  it('rejects a malformed payload before any fetch (Zod)', async () => {
    const { deps, resolveAccessToken } = makeDeps();
    await expect(
      processDriveFileChangedJob({ org_id: 'not-a-uuid', file_id: '' }, deps),
    ).rejects.toBeInstanceOf(Error);
    expect(resolveAccessToken).not.toHaveBeenCalled();
  });

  it('payload schema has no actor_email / PII field at all', () => {
    const shape = Object.keys((DriveFileChangedJobPayload as unknown as { shape: Record<string, unknown> }).shape);
    expect(shape).not.toContain('actor_email');
    expect(shape).not.toContain('sender_email');
    // Sanity: the fields we DO carry are all connector-native identifiers.
    // SCRUM-4507 added four of them — all opaque Drive ids plus a folder path.
    // This list is a RATCHET: a new payload field has to be added here
    // deliberately, which is the moment to ask whether it can carry PII.
    expect(shape.sort()).toEqual(
      [
        'file_id', 'integration_id', 'mime_type', 'modified_time', 'org_id',
        'revision_id', 'rule_event_id',
        'shared_drive_id', 'folder_id', 'folder_path', 'revision_kind',
        // BUG-2026-09-29: the file's human NAME — an opaque display label,
        // not PII (it is not an email/account identifier).
        'filename',
      ].sort(),
    );
  });

  it('parseDriveFileChangedJobPayload coerces + validates', () => {
    const parsed = parseDriveFileChangedJobPayload({ org_id: ORG, integration_id: INT, file_id: 'f' });
    expect(parsed.file_id).toBe('f');
  });

  it('source label is the canonical google_drive vendor', () => {
    expect(DRIVE_ARTIFACT_SOURCE).toBe('google_drive');
  });
});

/**
 * SCRUM-4507 — the four link-back fields across the job-payload boundary.
 *
 * These fields are OPTIONAL on purpose. Jobs enqueued before this change are
 * already sitting in `job_queue` with a payload that has none of them; if the
 * schema required them, every one of those rows would fail `parse` on its next
 * attempt and the Drive fetch pipeline would stall on a backlog it can never
 * drain. The legacy-parse test below is the guard on that.
 */
describe('SCRUM-4507 Drive source link-back payload fields', () => {
  it('parses a legacy payload that predates the link-back fields', () => {
    const parsed = parseDriveFileChangedJobPayload({
      org_id: ORG,
      integration_id: INT,
      file_id: 'file-legacy',
      revision_id: 'rev-legacy',
    });

    expect(parsed.shared_drive_id).toBeUndefined();
    expect(parsed.folder_id).toBeUndefined();
    expect(parsed.folder_path).toBeUndefined();
    expect(parsed.revision_kind).toBeUndefined();
    expect(parsed.filename).toBeUndefined();
  });

  it('accepts every member of the shared revision-kind vocabulary and rejects anything else', () => {
    for (const kind of DRIVE_REVISION_KINDS) {
      const parsed = DriveFileChangedJobPayload.safeParse({
        org_id: ORG,
        integration_id: INT,
        file_id: 'f',
        revision_kind: kind,
      });
      expect(parsed.success, `${kind} should parse`).toBe(true);
    }

    const rejected = DriveFileChangedJobPayload.safeParse({
      org_id: ORG,
      integration_id: INT,
      file_id: 'f',
      revision_kind: 'head-revision',
    });
    expect(rejected.success).toBe(false);
  });

  it('forwards all four link-back fields to the artifact sink', async () => {
    const { deps, enqueueArtifact } = makeDeps();

    await processDriveFileChangedJob(
      {
        org_id: ORG,
        integration_id: INT,
        file_id: 'file-1',
        revision_id: 'rev-1',
        mime_type: 'application/pdf',
        modified_time: '2026-05-04T01:00:00Z',
        shared_drive_id: 'shared-drive-legal',
        folder_id: 'folder-legal',
        folder_path: '/Legal/Contracts',
        revision_kind: 'head_revision',
      },
      deps,
    );

    expect(enqueueArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        sharedDriveId: 'shared-drive-legal',
        folderId: 'folder-legal',
        folderPath: '/Legal/Contracts',
        revisionKind: 'head_revision',
      }),
    );
  });

  it('converts absent link-back fields to null (never undefined) at the sink boundary', async () => {
    const { deps, enqueueArtifact } = makeDeps();

    await processDriveFileChangedJob(
      { org_id: ORG, integration_id: INT, file_id: 'file-legacy' },
      deps,
    );

    expect(enqueueArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        sharedDriveId: null,
        folderId: null,
        folderPath: null,
        revisionKind: null,
      }),
    );
  });

  it('BUG-2026-09-29: forwards the Drive file name to the artifact sink', async () => {
    const { deps, enqueueArtifact } = makeDeps();

    await processDriveFileChangedJob(
      {
        org_id: ORG,
        integration_id: INT,
        file_id: 'file-named',
        filename: '05 Financial Model, 24 Month Projection (draft assumptions)',
      },
      deps,
    );

    expect(enqueueArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: '05 Financial Model, 24 Month Projection (draft assumptions)',
      }),
    );
  });

  it('BUG-2026-09-29: converts an absent filename to null (never undefined) at the sink boundary', async () => {
    const { deps, enqueueArtifact } = makeDeps();

    await processDriveFileChangedJob(
      { org_id: ORG, integration_id: INT, file_id: 'file-legacy' },
      deps,
    );

    expect(enqueueArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ filename: null }),
    );
  });

  it('has no field that could carry a Drive account label or actor email', () => {
    // §1.4 / §1.6A. `drive-account-label.ts` parses a JSON blob whose
    // `account_label` IS the connected Google account's EMAIL. None of the
    // link-back fields may become a channel for it.
    const shape = Object.keys(DriveFileChangedJobPayload.shape);
    expect(shape).not.toContain('account_label');
    expect(shape).not.toContain('actor_email');
    expect(shape).not.toContain('owner_email');
    expect(shape.filter((k) => /email|label|actor|owner|user/i.test(k))).toEqual([]);
  });
});
