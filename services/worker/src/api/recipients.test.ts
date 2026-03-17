/**
 * Unit tests for createPendingRecipient (BETA-04)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----

const {
  mockLogger,
  mockSendEmail,
  mockBuildActivationEmail,
  mockDbFrom,
  mockConfig,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockSendEmail = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-1' });
  const mockBuildActivationEmail = vi.fn().mockReturnValue({
    subject: 'Test Subject',
    html: '<p>Test</p>',
  });
  const mockDbFrom = vi.fn();
  const mockConfig = {
    frontendUrl: 'https://app.arkova.io',
    resendApiKey: 'test-key',
    emailFrom: 'noreply@arkova.ai',
  };

  return { mockLogger, mockSendEmail, mockBuildActivationEmail, mockDbFrom, mockConfig };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom },
}));

vi.mock('../email/index.js', () => ({
  sendEmail: mockSendEmail,
  buildActivationEmail: mockBuildActivationEmail,
}));

// ---- Import after mocks ----
import { createPendingRecipient } from './recipients.js';

// ---- Helpers ----

function mockDbChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = ['select', 'eq', 'is', 'maybeSingle', 'single', 'insert', 'update'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Make the chain thenable so it can be awaited (SonarQube S7739: use defineProperty)
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => resolve(result),
    enumerable: false,
  });
  return chain;
}

describe('createPendingRecipient', () => {
  const baseRequest = {
    email: 'student@example.com',
    orgId: 'org-uuid-1',
    fullName: 'Jane Doe',
    credentialLabel: 'Bachelor of Science',
    actorId: 'admin-uuid-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' });
  });

  it('returns existing profile ID when recipient already exists', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // profiles.select — existing profile found
        return mockDbChain({ data: { id: 'existing-uuid', status: 'ACTIVE' }, error: null });
      }
      return mockDbChain({ data: null, error: null });
    });

    const result = await createPendingRecipient(baseRequest);

    expect(result.profileId).toBe('existing-uuid');
    expect(result.isNew).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('creates new pending profile when recipient does not exist', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // profiles.select — no existing
        return mockDbChain({ data: null, error: null });
      }
      if (callCount === 2) {
        // profiles.insert
        return mockDbChain({ error: null });
      }
      if (callCount === 3) {
        // audit_events.insert
        return mockDbChain({ error: null });
      }
      if (callCount === 4) {
        // organizations.select
        return mockDbChain({ data: { display_name: 'University of Michigan' }, error: null });
      }
      return mockDbChain({ data: null, error: null });
    });

    const result = await createPendingRecipient(baseRequest);

    expect(result.isNew).toBe(true);
    expect(result.profileId).toBeDefined();
    expect(result.activationEmailSent).toBe(true);
  });

  it('sends activation email with correct data', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      if (callCount === 4) return mockDbChain({ data: { display_name: 'Acme Corp' }, error: null });
      return mockDbChain({ data: null, error: null });
    });

    await createPendingRecipient(baseRequest);

    expect(mockBuildActivationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: 'student@example.com',
        organizationName: 'Acme Corp',
        credentialLabel: 'Bachelor of Science',
      }),
    );
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'student@example.com',
        emailType: 'activation',
      }),
    );
  });

  it('normalizes email to lowercase', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      return mockDbChain({ data: null, error: null });
    });

    const result = await createPendingRecipient({
      ...baseRequest,
      email: '  Student@Example.COM  ',
    });

    expect(result.isNew).toBe(true);
    // The email should be normalized
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'student@example.com',
      }),
    );
  });

  it('throws when profile insert fails', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      if (callCount === 2) return mockDbChain({ error: { message: 'unique constraint' } });
      return mockDbChain({ data: null, error: null });
    });

    await expect(createPendingRecipient(baseRequest)).rejects.toThrow('Failed to create pending recipient');
  });

  it('still succeeds when activation email fails to send', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      return mockDbChain({ data: null, error: null });
    });
    mockSendEmail.mockResolvedValue({ success: false, error: 'SMTP timeout' });

    const result = await createPendingRecipient(baseRequest);

    expect(result.isNew).toBe(true);
    expect(result.activationEmailSent).toBe(false);
  });

  it('uses default org name when org lookup fails', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      if (callCount === 4) return mockDbChain({ data: null, error: { message: 'not found' } });
      return mockDbChain({ data: null, error: null });
    });

    await createPendingRecipient(baseRequest);

    expect(mockBuildActivationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationName: 'Your organization',
      }),
    );
  });
});
