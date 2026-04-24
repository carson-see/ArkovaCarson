/**
 * Payment grace warning email tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendEmail } = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
}));

vi.mock('../email/sender.js', () => ({
  sendEmail: mockSendEmail,
}));

import { buildGraceWarningEmail, sendGraceWarningEmail } from './grace-warning.js';

const baseData = {
  recipientEmail: 'admin@example.com',
  organizationName: 'Acme University',
  manageBillingUrl: 'https://app.arkova.ai/settings/billing',
  graceExpiresAt: '2026-04-27T16:00:00.000Z',
  daysRemaining: 3,
  actorId: 'user-1',
  orgId: 'org-1',
};

describe('buildGraceWarningEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' });
  });

  it('returns subject and HTML with billing action', () => {
    const result = buildGraceWarningEmail(baseData);
    expect(result.subject).toContain('Acme University');
    expect(result.html).toContain('Update Billing');
    expect(result.html).toContain('2026-04-27 16:00:00 UTC');
    expect(result.html).toContain(baseData.manageBillingUrl);
  });

  it('renders remaining time labels', () => {
    const oneDay = buildGraceWarningEmail({ ...baseData, daysRemaining: 1 });
    const today = buildGraceWarningEmail({ ...baseData, daysRemaining: 0 });
    expect(oneDay.html).toContain('ends in 1 day');
    expect(today.html).toContain('ends today');
  });

  it('escapes organization name and URLs', () => {
    const result = buildGraceWarningEmail({
      ...baseData,
      organizationName: '<script>alert("x")</script>',
      manageBillingUrl: 'https://app.arkova.ai/billing?a=1&b=2',
    });
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('a=1&amp;b=2');
  });

  it('does not render undefined values', () => {
    const result = buildGraceWarningEmail({
      ...baseData,
      daysRemaining: undefined,
    });
    expect(result.html).not.toContain('undefined');
  });

  it('sends through the shared Resend sender convention', async () => {
    await sendGraceWarningEmail(baseData);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@example.com',
        emailType: 'notification',
        actorId: 'user-1',
        orgId: 'org-1',
      }),
    );
  });
});
