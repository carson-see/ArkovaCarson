/**
 * SCRUM-1973 — Auto-queue Notification Tests
 *
 * Verifies that document.auto_queued notification fires when a rule
 * adds a document to the anchoring queue (not for manual uploads).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEmitNotifications = vi.hoisted(() => vi.fn());

vi.mock('../notifications/dispatcher.js', () => ({
  emitOrgAdminNotifications: mockEmitNotifications,
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { emitAutoQueuedNotification } from './auto-queue-notifier.js';

describe('SCRUM-1973: emitAutoQueuedNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits document.auto_queued notification with correct payload', async () => {
    await emitAutoQueuedNotification({
      org_id: 'org-1',
      filename: 'contract.pdf',
      source: 'docusign',
      rule_name: 'Law Firm — Signed Contracts',
      rule_id: 'rule-1',
    });

    expect(mockEmitNotifications).toHaveBeenCalledTimes(1);
    expect(mockEmitNotifications).toHaveBeenCalledWith({
      type: 'document.auto_queued',
      organizationId: 'org-1',
      payload: expect.objectContaining({
        filename: 'contract.pdf',
        source: 'docusign',
        rule_name: 'Law Firm — Signed Contracts',
      }),
    });
  });

  it('does not throw on notification failure (non-fatal)', async () => {
    mockEmitNotifications.mockRejectedValueOnce(new Error('notification service down'));

    await expect(
      emitAutoQueuedNotification({
        org_id: 'org-1',
        filename: 'test.pdf',
        source: 'google_drive',
        rule_name: 'Test Rule',
        rule_id: 'rule-2',
      }),
    ).resolves.not.toThrow();
  });
});
