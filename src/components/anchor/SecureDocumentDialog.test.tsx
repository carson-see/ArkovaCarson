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
import { detectFraudForDocument } from '@/lib/fraudDetection';
import { supabase } from '@/lib/supabase';

type FileUploadMockProps = {
  onFileSelect?: (file: File, fingerprint: string) => void;
  onBulkDetected?: (files: File[]) => void;
  onAttestationDetected?: (data: {
    attestation_type: 'VERIFICATION';
    attester_name: string;
    attester_type: 'INSTITUTION';
    subject_type: 'credential';
    subject_identifier: string;
    claims: Array<{ claim: string }>;
  }) => void;
};

let lastFileUploadProps: FileUploadMockProps | null = null;
const mockProfileOrgId = vi.hoisted(() => ({ current: null as string | null }));

function createTemplateSelectMock() {
  const query = {
    eq: vi.fn(() => query),
    limit: vi.fn(() => Promise.resolve({ data: [] })),
  };
  return vi.fn(() => query);
}

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
    from: vi.fn(),
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'test-user-id' } }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { org_id: mockProfileOrgId.current } }),
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

vi.mock('@/lib/fraudDetection', () => ({
  detectFraudForDocument: vi.fn(async () => null),
  fraudResultToMetadata: vi.fn((result) => result ? ({
    fraud_risk_level: result.fraud_risk_level,
    fraud_score: result.fraud_score,
    fraud_signals: result.fraud_signals,
    fraud_analysis_method: result.analysis_method,
    fraud_processing_time_ms: result.processing_time_ms,
  }) : {}),
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
    mockProfileOrgId.current = null;
    vi.mocked(detectFraudForDocument).mockResolvedValue(null);
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn() })) })),
      select: createTemplateSelectMock(),
    } as unknown as ReturnType<typeof supabase.from>);
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
    const dialog = screen.getByRole('dialog', { name: new RegExp(SECURE_DIALOG_LABELS.TITLE, 'i') });
    expect(dialog).not.toHaveAccessibleName(/^Bulk Upload$/i);
  });

  it('blocks profile-scoped bulk paths when opened for a different viewed org', () => {
    mockProfileOrgId.current = 'profile-org';
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} orgId="viewed-org" />);

    act(() => {
      lastFileUploadProps?.onBulkDetected?.([
        new File(['a,b\n1,2'], 'docs.csv', { type: 'text/csv' }),
      ]);
    });

    expect(screen.queryByTestId('bulk-wizard-stub')).not.toBeInTheDocument();
    expect(screen.getByText(SECURE_DIALOG_LABELS.PROFILE_SCOPED_FLOW_UNAVAILABLE)).toBeInTheDocument();
  });

  it('stores only structured fraud findings in anchor metadata when detection is enabled', async () => {
    const insert = vi.fn((_payload: unknown) => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => ({
          data: { id: 'anchor-id', public_id: 'public-id' },
          error: null,
        })),
      })),
    }));
    vi.mocked(supabase.from).mockReturnValue({
      insert,
      select: createTemplateSelectMock(),
    } as unknown as ReturnType<typeof supabase.from>);
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(detectFraudForDocument).mockResolvedValue({
      fraud_risk_level: 'low',
      fraud_score: 0.02,
      fraud_signals: [],
      analysis_method: 'client_side_worker_v2',
      processing_time_ms: 3,
    });
    const file = new File(['raw-document-bytes-that-must-not-leak'], 'degree.pdf', {
      type: 'application/pdf',
    });

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);

    act(() => {
      lastFileUploadProps?.onFileSelect?.(file, 'safe-fingerprint');
    });
    await act(async () => {
      screen.getByTestId('secure-document-continue').click();
    });

    expect(detectFraudForDocument).toHaveBeenCalledWith(file, {
      credentialType: 'OTHER',
      metadataHints: {},
    });
    expect(insert).toHaveBeenCalledTimes(1);
    const payload = insert.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> };
    expect(payload.metadata).toMatchObject({
      fraud_risk_level: 'low',
      fraud_score: 0.02,
      fraud_signals: [],
      fraud_analysis_method: 'client_side_worker_v2',
      fraud_processing_time_ms: 3,
    });
    expect(JSON.stringify(payload)).not.toContain('raw-document-bytes-that-must-not-leak');
  });
});
