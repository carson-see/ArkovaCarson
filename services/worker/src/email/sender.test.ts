/**
 * Unit tests for email sender service (BETA-03)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----

const { mockLogger, mockAuditInsert, mockResendSend, mockConfig } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockAuditInsert = vi.fn().mockResolvedValue({ error: null });
  const mockResendSend = vi.fn();
  const mockConfig: { resendApiKey: string | undefined; emailFrom: string } = {
    resendApiKey: 'test-api-key',
    emailFrom: 'noreply@arkova.ai',
  };

  return { mockLogger, mockAuditInsert, mockResendSend, mockConfig };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({
      insert: mockAuditInsert,
    })),
  },
}));

vi.mock('resend', () => {
  return {
    Resend: class MockResend {
      emails = { send: mockResendSend };
    },
  };
});

// ---- Import after mocks ----
import { sendEmail, _resetClient } from './sender.js';

describe('sendEmail', () => {
  const baseOptions = {
    to: 'student@example.com',
    subject: 'Test Email',
    html: '<p>Hello</p>',
    emailType: 'notification' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetClient();
    mockConfig.resendApiKey = 'test-api-key';
    mockResendSend.mockResolvedValue({ data: { id: 'msg-123' }, error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  it('sends email via Resend and returns success', async () => {
    const result = await sendEmail(baseOptions);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-123');
    expect(mockResendSend).toHaveBeenCalledWith({
      from: 'noreply@arkova.ai',
      to: ['student@example.com'],
      subject: 'Test Email',
      html: '<p>Hello</p>',
    });
  });

  it('logs audit event on success', async () => {
    await sendEmail(baseOptions);

    expect(mockAuditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'EMAIL_SENT',
        event_category: 'NOTIFICATION',
      }),
    );
  });

  it('includes anchor ID in audit when provided', async () => {
    await sendEmail({
      ...baseOptions,
      anchorId: 'anchor-uuid-1',
      actorId: 'user-uuid-1',
      orgId: 'org-uuid-1',
    });

    expect(mockAuditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: 'user-uuid-1',
        org_id: 'org-uuid-1',
        target_id: 'anchor-uuid-1',
      }),
    );
  });

  it('returns failure when Resend returns error', async () => {
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'Invalid API key' } });

    const result = await sendEmail(baseOptions);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid API key');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('returns failure when Resend throws', async () => {
    mockResendSend.mockRejectedValue(new Error('Network timeout'));

    const result = await sendEmail(baseOptions);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network timeout');
  });

  it('skips sending when RESEND_API_KEY is not configured', async () => {
    mockConfig.resendApiKey = undefined;
    _resetClient();

    const result = await sendEmail(baseOptions);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('dev-mode-skipped');
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notification' }),
      expect.stringContaining('skipped'),
    );
  });

  it('does not throw when audit logging fails', async () => {
    mockAuditInsert.mockRejectedValue(new Error('DB down'));

    const result = await sendEmail(baseOptions);

    // Email still sent successfully despite audit failure
    expect(result.success).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
