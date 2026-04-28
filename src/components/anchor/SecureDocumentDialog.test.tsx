/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * SCRUM-949 — UAT 2026-04-21 reported the Continue button on the Secure
 * Document dialog was clickable with no file (silent no-op). The fix is the
 * `disabled={!fileData}` + `aria-disabled={!fileData}` guard on the
 * Continue button in the upload step. This regression test pins it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecureDocumentDialog } from './SecureDocumentDialog';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn() })) })),
      select: vi.fn(() => ({ eq: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve({ data: [] })) })) })),
    })),
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'test-user-id' } }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { org_id: null } }),
}));

vi.mock('@/hooks/useAuditorMode', () => ({
  useAuditorMode: () => ({ isAuditorMode: false }),
}));

vi.mock('@/lib/switchboard', () => ({
  isAIExtractionEnabled: vi.fn(async () => false),
}));

vi.mock('@/lib/auditLog', () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock('@/lib/aiExtraction', () => ({
  runExtraction: vi.fn(),
  fetchTemplateReconstruction: vi.fn(),
}));

vi.mock('@/lib/templateMapper', () => ({
  applyTemplate: vi.fn(),
}));

vi.mock('@/lib/validators', () => ({
  validateAnchorCreate: vi.fn((x) => x),
}));

vi.mock('@/lib/workerClient', () => ({
  WORKER_URL: 'http://localhost:8787',
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

describe('SCRUM-949 SecureDocumentDialog — Continue disabled when no file', () => {
  beforeEach(() => vi.clearAllMocks());

  it('disables Continue (and reflects aria-disabled) on initial open with no file', () => {
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);

    const continueBtn = screen.getByTestId('secure-document-continue');
    expect(continueBtn).toHaveProperty('disabled', true);
    expect(continueBtn.getAttribute('aria-disabled')).toBe('true');
  });
});
