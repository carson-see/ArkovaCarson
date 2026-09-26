/**
 * GoogleDriveAdapter tests (PR-1 of the connector-adapter contract series).
 *
 * Proves:
 *   - every `ConnectorAdapter` method delegates to the exact underlying
 *     `oauth/drive.ts` function, with the expected arguments, and shapes the
 *     result into the vendor-neutral contract type (ZERO behavior change —
 *     this is a thin translation layer, not a reimplementation);
 *   - `isCursorInvalidError` recognizes a `pageTokenInvalid` `DriveApiError`
 *     and rejects every other error;
 *   - `classifyFetchError` maps the 403 taxonomy (`DriveFileAccessError` /
 *     `DriveExportSizeLimitError` / `DriveDocumentTooLargeError`) to the
 *     contract's three-way outcome;
 *   - §1.6A: `fetchBytes` never logs, never lets a byte value reach an Error
 *     message, and its thrown error types carry no raw response body.
 *
 * Network is fully mocked — no real Google calls. Each `oauth/drive.ts` export
 * used by the adapter is replaced with a `vi.fn()` via `vi.mock`, so these
 * tests exercise the SAME functions production wiring calls, just stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const driveMocks = vi.hoisted(() => ({
  buildAuthorizationUrl: vi.fn(),
  exchangeCode: vi.fn(),
  refreshAccessToken: vi.fn(),
  revokeOAuthToken: vi.fn(),
  createChangesWatch: vi.fn(),
  stopDriveChannel: vi.fn(),
  getStartPageToken: vi.fn(),
  listChanges: vi.fn(),
  fetchDriveFileBytes: vi.fn(),
}));

vi.mock('../oauth/drive.js', async () => {
  const actual = await vi.importActual<typeof import('../oauth/drive.js')>('../oauth/drive.js');
  return {
    ...actual,
    buildAuthorizationUrl: driveMocks.buildAuthorizationUrl,
    exchangeCode: driveMocks.exchangeCode,
    refreshAccessToken: driveMocks.refreshAccessToken,
    revokeOAuthToken: driveMocks.revokeOAuthToken,
    createChangesWatch: driveMocks.createChangesWatch,
    stopDriveChannel: driveMocks.stopDriveChannel,
    getStartPageToken: driveMocks.getStartPageToken,
    listChanges: driveMocks.listChanges,
    fetchDriveFileBytes: driveMocks.fetchDriveFileBytes,
  };
});

import {
  DriveApiError,
  DriveFileAccessError,
  DriveExportSizeLimitError,
  DriveDocumentTooLargeError,
} from '../oauth/drive.js';
import { GoogleDriveAdapter } from './google-drive-adapter.js';

const ACCESS_TOKEN = 'live-access-token';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GoogleDriveAdapter', () => {
  describe('vendor', () => {
    it('identifies itself as google_drive', () => {
      const adapter = new GoogleDriveAdapter();
      expect(adapter.vendor).toBe('google_drive');
    });
  });

  describe('buildAuthorizationUrl', () => {
    it('delegates to oauth/drive.ts buildAuthorizationUrl with redirectUri + state', () => {
      driveMocks.buildAuthorizationUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?x=1');
      const adapter = new GoogleDriveAdapter();

      const url = adapter.buildAuthorizationUrl({ redirectUri: 'https://app.arkova.ai/cb', state: 'state-123' });

      expect(url).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');
      expect(driveMocks.buildAuthorizationUrl).toHaveBeenCalledTimes(1);
      const call = driveMocks.buildAuthorizationUrl.mock.calls[0][0];
      expect(call.redirectUri).toBe('https://app.arkova.ai/cb');
      expect(call.state).toBe('state-123');
      // No `scopes` override — production callers never pass one either, so
      // the adapter must not change the effective default-scope behavior.
      expect(call.scopes).toBeUndefined();
    });
  });

  describe('exchangeCode', () => {
    it('delegates to exchangeCode and maps snake_case → camelCase OAuthTokenSet', async () => {
      driveMocks.exchangeCode.mockResolvedValue({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/drive.file',
        token_type: 'Bearer',
      });
      const adapter = new GoogleDriveAdapter();

      const tokens = await adapter.exchangeCode({ code: 'auth-code', redirectUri: 'https://app.arkova.ai/cb' });

      expect(driveMocks.exchangeCode).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'auth-code', redirectUri: 'https://app.arkova.ai/cb' }),
      );
      expect(tokens).toEqual({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresInSec: 3600,
        scope: 'https://www.googleapis.com/auth/drive.file',
        tokenType: 'Bearer',
      });
    });

    it('maps a response with no refresh_token to an undefined refreshToken', async () => {
      driveMocks.exchangeCode.mockResolvedValue({ access_token: 'at-1', expires_in: 3600 });
      const adapter = new GoogleDriveAdapter();

      const tokens = await adapter.exchangeCode({ code: 'c', redirectUri: 'r' });

      expect(tokens.refreshToken).toBeUndefined();
      expect(tokens.accessToken).toBe('at-1');
      expect(tokens.expiresInSec).toBe(3600);
    });
  });

  describe('refreshToken', () => {
    it('delegates to refreshAccessToken and maps the response', async () => {
      driveMocks.refreshAccessToken.mockResolvedValue({
        access_token: 'at-2',
        expires_in: 1800,
      });
      const adapter = new GoogleDriveAdapter();

      const tokens = await adapter.refreshToken({ refreshToken: 'rt-1' });

      expect(driveMocks.refreshAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ refreshToken: 'rt-1' }),
      );
      expect(tokens).toEqual({
        accessToken: 'at-2',
        refreshToken: undefined,
        expiresInSec: 1800,
        scope: undefined,
        tokenType: undefined,
      });
    });
  });

  describe('revokeVendorTokenUnsafe', () => {
    it('delegates to revokeOAuthToken with the given token', async () => {
      driveMocks.revokeOAuthToken.mockResolvedValue(undefined);
      const adapter = new GoogleDriveAdapter();

      await adapter.revokeVendorTokenUnsafe({ token: 'tok-1' });

      expect(driveMocks.revokeOAuthToken).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'tok-1' }),
      );
    });
  });

  describe('createWatch / stopWatch (channelId + resourceId round-trip)', () => {
    it('createWatch generates a channelId, delegates to createChangesWatch, and returns a subscriptionId that encodes both ids', async () => {
      driveMocks.createChangesWatch.mockResolvedValue({
        resourceId: 'resource-abc',
        expiration: '2026-10-02T00:00:00.000Z',
        startPageToken: 'page-token-1',
      });
      const adapter = new GoogleDriveAdapter();

      const result = await adapter.createWatch({
        accessToken: ACCESS_TOKEN,
        address: 'https://worker.arkova.ai/webhooks/drive',
      });

      expect(driveMocks.createChangesWatch).toHaveBeenCalledTimes(1);
      const call = driveMocks.createChangesWatch.mock.calls[0][0];
      expect(call.accessToken).toBe(ACCESS_TOKEN);
      expect(call.address).toBe('https://worker.arkova.ai/webhooks/drive');
      expect(typeof call.channelId).toBe('string');
      expect(call.channelId.length).toBeGreaterThan(0);

      expect(result.expiresAt).toBe('2026-10-02T00:00:00.000Z');
      expect(result.cursor).toBe('page-token-1');
      // subscriptionId must encode BOTH the client-generated channelId (needed
      // by stopWatch/channels.stop) and Google's server-issued resourceId — the
      // contract's stopWatch takes ONE id, but Drive's channels.stop needs both.
      expect(result.subscriptionId).toBe(`${call.channelId}:resource-abc`);
    });

    it('passes resourceScope through as driveId (shared-drive scoping)', async () => {
      driveMocks.createChangesWatch.mockResolvedValue({
        resourceId: 'r-1',
        expiration: '2026-10-02T00:00:00.000Z',
        startPageToken: 'pt-1',
      });
      const adapter = new GoogleDriveAdapter();

      await adapter.createWatch({
        accessToken: ACCESS_TOKEN,
        address: 'https://worker.arkova.ai/webhooks/drive',
        resourceScope: 'shared-drive-9',
      });

      expect(driveMocks.createChangesWatch.mock.calls[0][0].driveId).toBe('shared-drive-9');
    });

    it('stopWatch decodes the subscriptionId and delegates to stopDriveChannel with channelId + resourceId', async () => {
      driveMocks.stopDriveChannel.mockResolvedValue(undefined);
      const adapter = new GoogleDriveAdapter();

      await adapter.stopWatch({ accessToken: ACCESS_TOKEN, subscriptionId: 'channel-xyz:resource-abc' });

      expect(driveMocks.stopDriveChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: ACCESS_TOKEN,
          channelId: 'channel-xyz',
          resourceId: 'resource-abc',
        }),
      );
    });

    it('stopWatch throws a clear error on a malformed subscriptionId rather than silently calling Drive with a bad id', async () => {
      const adapter = new GoogleDriveAdapter();

      await expect(
        adapter.stopWatch({ accessToken: ACCESS_TOKEN, subscriptionId: 'no-separator-here' }),
      ).rejects.toThrow(/subscriptionId/);
      expect(driveMocks.stopDriveChannel).not.toHaveBeenCalled();
    });
  });

  describe('getFreshCursor', () => {
    it('delegates to getStartPageToken, mapping resourceScope → driveId', async () => {
      driveMocks.getStartPageToken.mockResolvedValue('fresh-token-1');
      const adapter = new GoogleDriveAdapter();

      const cursor = await adapter.getFreshCursor({ accessToken: ACCESS_TOKEN, resourceScope: 'drive-42' });

      expect(cursor).toBe('fresh-token-1');
      expect(driveMocks.getStartPageToken).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: ACCESS_TOKEN, driveId: 'drive-42' }),
      );
    });

    it('omits driveId when no resourceScope is given (My Drive)', async () => {
      driveMocks.getStartPageToken.mockResolvedValue('fresh-token-2');
      const adapter = new GoogleDriveAdapter();

      await adapter.getFreshCursor({ accessToken: ACCESS_TOKEN });

      expect(driveMocks.getStartPageToken.mock.calls[0][0].driveId).toBeUndefined();
    });
  });

  describe('listChanges', () => {
    it('delegates to listChanges and maps each entry to a SourceChangeEvent using the SAME revision fallback chain (headRevisionId → mtime: → evt:)', async () => {
      driveMocks.listChanges.mockResolvedValue({
        changes: [
          {
            fileId: 'file-1',
            removed: false,
            file: {
              id: 'file-1',
              name: 'contract.pdf',
              parents: ['folder-a'],
              driveId: 'shared-drive-1',
              modifiedTime: '2026-09-20T00:00:00.000Z',
              headRevisionId: 'rev-abc',
              mimeType: 'application/pdf',
              trashed: false,
              lastModifyingUser: { emailAddress: 'alice@example.com' },
            },
          },
          {
            // Google Workspace-native doc: no headRevisionId → falls back to mtime:
            fileId: 'file-2',
            file: {
              id: 'file-2',
              parents: ['folder-b'],
              modifiedTime: '2026-09-21T00:00:00.000Z',
              mimeType: 'application/vnd.google-apps.document',
            },
          },
          {
            // Neither a file object nor a fileId → cannot be identified at all,
            // must be dropped (mirrors drive-changes-processor.ts's `onSkip`).
            removed: true,
            time: '2026-09-22T00:00:00.000Z',
          },
        ],
        nextPageToken: 'next-page-1',
      });
      const adapter = new GoogleDriveAdapter();

      const result = await adapter.listChanges({ accessToken: ACCESS_TOKEN, cursor: 'cursor-1' });

      expect(driveMocks.listChanges).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: ACCESS_TOKEN, pageToken: 'cursor-1' }),
      );
      expect(result.nextCursor).toBe('next-page-1');
      expect(result.newCursor).toBeNull();
      expect(result.changes).toHaveLength(2);

      expect(result.changes[0]).toEqual({
        version: { externalRef: 'file-1', externalRevision: 'rev-abc', revisionKind: 'head_revision' },
        parentIds: ['folder-a'],
        mimeType: 'application/pdf',
        modifiedTime: '2026-09-20T00:00:00.000Z',
        actorEmail: 'alice@example.com',
        removed: false,
        trashed: false,
      });

      expect(result.changes[1]).toEqual({
        version: { externalRef: 'file-2', externalRevision: 'mtime:2026-09-21T00:00:00.000Z', revisionKind: 'modified_time' },
        parentIds: ['folder-b'],
        mimeType: 'application/vnd.google-apps.document',
        modifiedTime: '2026-09-21T00:00:00.000Z',
        actorEmail: null,
        removed: false,
        trashed: false,
      });
    });

    it('surfaces newCursor (final page) and an empty changes array', async () => {
      driveMocks.listChanges.mockResolvedValue({ changes: [], newStartPageToken: 'new-start-token' });
      const adapter = new GoogleDriveAdapter();

      const result = await adapter.listChanges({ accessToken: ACCESS_TOKEN, cursor: 'cursor-2' });

      expect(result.changes).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.newCursor).toBe('new-start-token');
    });
  });

  describe('isCursorInvalidError', () => {
    it('returns true for a DriveApiError with pageTokenInvalid set', () => {
      const adapter = new GoogleDriveAdapter();
      const err = new DriveApiError('Drive changes.list failed', 410, undefined, true);
      expect(adapter.isCursorInvalidError(err)).toBe(true);
    });

    it('returns false for a DriveApiError without pageTokenInvalid', () => {
      const adapter = new GoogleDriveAdapter();
      const err = new DriveApiError('Drive changes.list failed', 400);
      expect(adapter.isCursorInvalidError(err)).toBe(false);
    });

    it('returns false for a non-DriveApiError', () => {
      const adapter = new GoogleDriveAdapter();
      expect(adapter.isCursorInvalidError(new Error('boom'))).toBe(false);
      expect(adapter.isCursorInvalidError('not an error')).toBe(false);
      expect(adapter.isCursorInvalidError(null)).toBe(false);
    });
  });

  describe('fetchBytes', () => {
    it('delegates to fetchDriveFileBytes, mapping externalRef → fileId', async () => {
      const bytes = Buffer.from('pdf bytes');
      driveMocks.fetchDriveFileBytes.mockResolvedValue({
        bytes,
        contentType: 'application/pdf',
        exportMimeType: null,
      });
      const adapter = new GoogleDriveAdapter();

      const result = await adapter.fetchBytes({
        externalRef: 'file-9',
        accessToken: ACCESS_TOKEN,
        mimeType: 'application/pdf',
      });

      expect(driveMocks.fetchDriveFileBytes).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'file-9', accessToken: ACCESS_TOKEN, mimeType: 'application/pdf' }),
      );
      expect(result.bytes).toBe(bytes);
      expect(result.contentType).toBe('application/pdf');
      expect(result.exportMimeType).toBeNull();
    });

    // §1.6A: the adapter itself must never log, throw-with-body, or otherwise
    // sink the fetched bytes. It has no logger and no catch block around this
    // call — a failure propagates the underlying (already byte-safe) error
    // untouched, so there is no additional surface for bytes to leak through.
    it('propagates a fetchDriveFileBytes failure without wrapping it in a new Error that could carry a body', async () => {
      const underlying = new DriveApiError('Drive file bytes fetch failed', 500);
      driveMocks.fetchDriveFileBytes.mockRejectedValue(underlying);
      const adapter = new GoogleDriveAdapter();

      await expect(
        adapter.fetchBytes({ externalRef: 'file-9', accessToken: ACCESS_TOKEN }),
      ).rejects.toBe(underlying);
    });
  });

  describe('classifyFetchError', () => {
    it('classifies DriveFileAccessError as permanent_access_denied', () => {
      const adapter = new GoogleDriveAdapter();
      expect(adapter.classifyFetchError(new DriveFileAccessError('appNotAuthorizedToFile'))).toBe(
        'permanent_access_denied',
      );
    });

    it('classifies DriveExportSizeLimitError as permanent_too_large', () => {
      const adapter = new GoogleDriveAdapter();
      expect(adapter.classifyFetchError(new DriveExportSizeLimitError())).toBe('permanent_too_large');
    });

    it('classifies DriveDocumentTooLargeError as permanent_too_large', () => {
      const adapter = new GoogleDriveAdapter();
      expect(adapter.classifyFetchError(new DriveDocumentTooLargeError(999))).toBe('permanent_too_large');
    });

    it('classifies a generic DriveApiError (e.g. transient 500/429) as retryable', () => {
      const adapter = new GoogleDriveAdapter();
      expect(adapter.classifyFetchError(new DriveApiError('Drive file bytes fetch failed', 500))).toBe('retryable');
      expect(adapter.classifyFetchError(new DriveApiError('Drive file bytes fetch failed', 403))).toBe('retryable');
    });

    it('classifies an unrecognized error as retryable (fail open to retry, never silently permanent)', () => {
      const adapter = new GoogleDriveAdapter();
      expect(adapter.classifyFetchError(new Error('unexpected'))).toBe('retryable');
      expect(adapter.classifyFetchError('not an error')).toBe('retryable');
    });
  });
});
