/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * SCRUM-949 — UAT 2026-04-21 reported the Continue button on the Secure
 * Document dialog was clickable with no file (silent no-op). The fix is the
 * `disabled={!fileData}` + `aria-disabled={!fileData}` guard on the
 * Continue button in the upload step. This regression test pins it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { SecureDocumentDialog } from './SecureDocumentDialog';
import { SECURE_DIALOG_LABELS } from '@/lib/copy';

type FileUploadMockProps = {
  onBulkDetected?: (files: File[]) => void;
};

let lastFileUploadProps: FileUploadMockProps | null = null;

vi.mock('./FileUpload', () => ({
  FileUpload: (props: FileUploadMockProps) => {
    lastFileUploadProps = props;
    return (
      <div data-testid="file-upload-stub">
        <button
          type="button"
          onClick={() =>
            props.onBulkDetected?.([new File(['bulk'], 'bulk.csv', { type: 'text/csv' })])
          }
        >
          Drive bulk path
        </button>
      </div>
    );
  },
}));

vi.mock('@/components/upload', () => ({
  BulkUploadWizard: () => <div data-testid="bulk-wizard-stub" />,
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
    lastFileUploadProps = null;
  });

  it('disables Continue (and reflects aria-disabled) on initial open with no file', () => {
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);

    const continueBtn = screen.getByTestId('secure-document-continue');
    expect(continueBtn).toHaveProperty('disabled', true);
    expect(continueBtn.getAttribute('aria-disabled')).toBe('true');
  });

  it('renders "Secure Document" as the dialog title on open', () => {
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole('dialog', { name: new RegExp(SECURE_DIALOG_LABELS.TITLE, 'i') })).toBeInTheDocument();
  });

  it('keeps the title stable after bulk detection', () => {
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);

    expect(lastFileUploadProps?.onBulkDetected).toBeTypeOf('function');
    act(() => {
      lastFileUploadProps?.onBulkDetected?.([
        new File(['a,b\n1,2'], 'docs.csv', { type: 'text/csv' }),
      ]);
    });

    expect(screen.getByTestId('bulk-wizard-stub')).toBeInTheDocument();
    const dialogTitle = screen.getByRole('dialog').querySelector('h2');
    expect(dialogTitle?.textContent ?? '').not.toMatch(/^Bulk Upload$/i);
    expect(dialogTitle?.textContent ?? '').toContain(SECURE_DIALOG_LABELS.TITLE);
  });
});
