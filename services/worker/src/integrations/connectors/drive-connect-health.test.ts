/**
 * Tests for the Drive processing-failure Sentry reporter (P0-2 hardening
 * audit, 2026-09-14 — "Google Drive pipeline failures visible").
 *
 * Before this module, `logger.error(...)` calls in webhooks/drive.ts,
 * drive-changes-runner.ts, drive-changes-processor.ts and
 * jobs/drive-file-changed.ts never reached Sentry — only the renewal sweep's
 * `alertDriveSubscriptionRenewal` did. These tests cover:
 *   1. A real failure reaches Sentry.captureException with actionable,
 *      PII-free context (org id, integration id, file id, revision id, job
 *      id, error class).
 *   2. The same error object is never double-reported once an inner call
 *      site has already reported it (the webhook's outer catch is the
 *      catch-all for errors that were never seen by an inner site).
 *   3. §1.1 / §1.6A: even if a caller accidentally attached document bytes
 *      to the failure context, the event that would actually leave the
 *      process (after running through the real `scrubPiiFromEvent`
 *      `beforeSend` pipeline) never carries raw bytes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const captureException = vi.fn();

vi.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

const { reportDriveProcessingFailure } = await import('./drive-connect-health.js');
const { scrubPiiFromEvent, REDACTED_BYTES_TOKEN } = await import('../../utils/sentry.js');

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTEGRATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportDriveProcessingFailure (P0-2)', () => {
  it('captures the error to Sentry with actionable, id-only context', () => {
    const err = new Error('drive changes.list failed: 500');
    reportDriveProcessingFailure(err, {
      stage: 'changes_list',
      orgId: ORG_ID,
      integrationId: INTEGRATION_ID,
      fileId: 'file-1',
      revisionId: 'rev-1',
      jobId: 'job-1',
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [capturedErr, options] = captureException.mock.calls[0];
    expect(capturedErr).toBe(err);
    expect(options.tags).toMatchObject({
      connector_id: 'google_drive',
      stage: 'changes_list',
    });
    expect(options.extra).toMatchObject({
      org_id: ORG_ID,
      integration_id: INTEGRATION_ID,
      file_id: 'file-1',
      revision_id: 'rev-1',
      job_id: 'job-1',
      error_class: 'Error',
    });
  });

  it('wraps a non-Error throw in an Error before capturing', () => {
    reportDriveProcessingFailure('boom', { stage: 'watched_folder_lookup', orgId: ORG_ID });
    expect(captureException).toHaveBeenCalledTimes(1);
    const [capturedErr] = captureException.mock.calls[0];
    expect(capturedErr).toBeInstanceOf(Error);
    expect(capturedErr.message).toContain('boom');
  });

  it('never double-reports the same error object across two call sites', () => {
    const err = new Error('drive enqueueRuleEvent threw');
    // Inner site (processor, rich context) reports first.
    reportDriveProcessingFailure(err, {
      stage: 'enqueue',
      orgId: ORG_ID,
      integrationId: INTEGRATION_ID,
      fileId: 'file-2',
      revisionId: 'rev-2',
    });
    // Outer catch-all (webhook) sees the SAME error object after it
    // propagates up the call stack.
    reportDriveProcessingFailure(err, {
      stage: 'webhook_run_changes',
      orgId: ORG_ID,
      integrationId: INTEGRATION_ID,
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    // The richer, inner-site context won — not the generic outer one.
    const [, options] = captureException.mock.calls[0];
    expect(options.tags.stage).toBe('enqueue');
    expect(options.extra.file_id).toBe('file-2');
  });

  it('reports independently for two distinct error objects', () => {
    reportDriveProcessingFailure(new Error('first'), { stage: 'changes_list', orgId: ORG_ID });
    reportDriveProcessingFailure(new Error('second'), { stage: 'webhook_run_changes', orgId: ORG_ID });
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('typed context never forwards a byte-shaped field to Sentry `extra`', () => {
    const err = new Error('drive_connector_artifact_enqueue_failed');
    reportDriveProcessingFailure(err, {
      stage: 'file_changed_job',
      orgId: ORG_ID,
      integrationId: INTEGRATION_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ leakedDocumentBytes: Buffer.from('not-a-real-document-but-pretend-bytes') } as any),
    });

    const [, options] = captureException.mock.calls[0];
    // `DriveFailureContext` only declares string/null fields — an extra
    // property on the input object is never read, let alone forwarded. This
    // is the FIRST line of defense: the function's own shape rules bytes out
    // structurally, before the Sentry scrubber ever runs.
    expect(options.extra).not.toHaveProperty('leakedDocumentBytes');
    expect(JSON.stringify(options.extra)).not.toContain('not-a-real-document-but-pretend-bytes');
  });

  it('§1.1/§1.6A: the real beforeSend scrubber (scrubPiiFromEvent) drops document bytes by type wherever they appear in an event', () => {
    // Second line of defense, tested directly: even if some OTHER Drive call
    // site (or a future edit to this module) ever attached a Buffer to a
    // Sentry event — bypassing reportDriveProcessingFailure's own typed
    // safety — the SAME beforeSend pipeline Sentry.init wires up for every
    // event in this service (utils/sentry.ts initSentry -> beforeSend ->
    // scrubPiiFromEvent) must still strip it. This is the mechanism the task
    // asks to be confirmed by reading, and proven by a test.
    const fakeEventWithLeakedBytes = {
      exception: { values: [{ value: 'drive_connector_artifact_enqueue_failed' }] },
      extra: {
        org_id: ORG_ID,
        integration_id: INTEGRATION_ID,
        // Simulates a raw document byte buffer riding on the event, the
        // exact shape §1.6A forbids reaching Sentry from the connector path.
        accidentally_attached_document_bytes: Buffer.from('not-a-real-document-but-pretend-bytes'),
      },
      tags: { connector_id: 'google_drive', stage: 'file_changed_job' },
    };

    const scrubbed = scrubPiiFromEvent(fakeEventWithLeakedBytes as never);
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain('not-a-real-document-but-pretend-bytes');
    expect(serialized).toContain(REDACTED_BYTES_TOKEN);
  });
});
