/**
 * Parent-delinquent split-off email tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendEmail } = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
}));

vi.mock('../email/sender.js', () => ({
  sendEmail: mockSendEmail,
}));

import {
  buildParentDelinquentSplitEmail,
  sendParentDelinquentSplitEmail,
} from './parent-delinquent-split.js';

const baseData = {
  recipientEmail: 'sub-admin@example.com',
  subOrganizationName: 'North Campus',
  parentOrganizationName: 'Acme University',
  splitUrl: 'https://app.arkova.ai/billing/split?token=abc123',
  tokenExpiresAt: '2026-05-24T12:30:00.000Z',
  actorId: 'user-2',
  orgId: 'sub-org-1',
};

describe('buildParentDelinquentSplitEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-2' });
  });

  it('returns subject and HTML with split-off action', () => {
    const result = buildParentDelinquentSplitEmail(baseData);
    expect(result.subject).toContain('North Campus');
    expect(result.html).toContain('Acme University');
    expect(result.html).toContain('Set Up Independent Billing');
    expect(result.html).toContain('2026-05-24 12:30:00 UTC');
    expect(result.html).toContain('token=abc123');
  });

  it('escapes organization names and URL parameters', () => {
    const result = buildParentDelinquentSplitEmail({
      ...baseData,
      subOrganizationName: '<b>Sub</b>',
      parentOrganizationName: '<script>alert("x")</script>',
      splitUrl: 'https://app.arkova.ai/split?token=a&next=b',
    });
    expect(result.html).not.toContain('<script>');
    expect(result.html).not.toContain('<b>Sub</b>');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('&lt;b&gt;Sub&lt;/b&gt;');
    expect(result.html).toContain('token=a&amp;next=b');
  });

  it('does not render undefined values', () => {
    const result = buildParentDelinquentSplitEmail({
      ...baseData,
      actorId: undefined,
      orgId: undefined,
    });
    expect(result.html).not.toContain('undefined');
  });

  it('sends through the shared Resend sender convention', async () => {
    await sendParentDelinquentSplitEmail(baseData);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'sub-admin@example.com',
        emailType: 'notification',
        actorId: 'user-2',
        orgId: 'sub-org-1',
      }),
    );
  });
});
