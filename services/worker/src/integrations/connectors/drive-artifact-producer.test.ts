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
    expect(shape.sort()).toEqual(
      ['file_id', 'integration_id', 'mime_type', 'modified_time', 'org_id', 'revision_id', 'rule_event_id'].sort(),
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
