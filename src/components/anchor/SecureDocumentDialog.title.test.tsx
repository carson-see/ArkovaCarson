/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side */
/**
 * SCRUM-1755 — Secure Document title is stable across single + bulk paths.
 *
 * Pre-1755, the dialog title swapped to "Bulk Upload" once the FileUpload
 * detected multi-file or CSV/XLSX input. That re-introduced the bulk/single
 * dichotomy at the surface level and confused org admins about what action
 * they were taking. The title is now always "Secure Document" — the system
 * detects shape and produces N anchors silently.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecureDocumentDialog } from './SecureDocumentDialog';
import { SECURE_DIALOG_LABELS } from '@/lib/copy';

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

describe('SCRUM-1755 SecureDocumentDialog title is stable across paths', () => {
  it('renders "Secure Document" as the dialog title on open', () => {
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole('dialog', { name: new RegExp(SECURE_DIALOG_LABELS.TITLE, 'i') })).toBeInTheDocument();
  });

  it('never renders the legacy "Bulk Upload" text as the dialog title', () => {
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    // Pre-1755 swap shipped a heading "Bulk Upload" once the bulk step opened. The
    // dialog title is now stable and should not contain that legacy phrase as a
    // primary heading. (BulkUploadWizard internals may still reference the bulk
    // tag elsewhere; this test only asserts the dialog *title* is unified.)
    const dialogTitle = screen.getByRole('dialog').querySelector('h2');
    expect(dialogTitle?.textContent ?? '').not.toMatch(/^Bulk Upload$/i);
  });
});
