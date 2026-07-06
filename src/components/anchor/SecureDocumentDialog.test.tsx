/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * SCRUM-949 — UAT 2026-04-21 reported the Continue button on the Secure
 * Document dialog was clickable with no file (silent no-op). The fix is the
 * `disabled={!fileData}` + `aria-disabled={!fileData}` guard on the
 * Continue button in the upload step. This regression test pins it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { SecureDocumentDialog } from './SecureDocumentDialog';
import {
  SECURE_DIALOG_LABELS,
  AI_EXTRACTION_LABELS,
  EXTRACTION_RECOVERY_LABELS,
} from '@/lib/copy';
import { detectFraudForDocument } from '@/lib/fraudDetection';
import { supabase } from '@/lib/supabase';
import { isAIExtractionEnabled } from '@/lib/switchboard';
import { runExtraction, fetchTemplateReconstruction } from '@/lib/aiExtraction';
import { applyTemplate } from '@/lib/templateMapper';

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

// BUG-2026-05-22-007 / SCRUM-1985 — pins the "AI extraction unavailable" toast
// behavior. Pre-fix, the dialog mocked isAIExtractionEnabled=false and silently
// dead-coded the toast branch. Post-fix, the toast still warns the user, but the
// dialog must NOT silently anchor with zero metadata — it must surface the
// extraction-failed recovery step (retry / enter manually / skip).
describe('SecureDocumentDialog — extraction-failed recovery + toast behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastFileUploadProps = null;
    mockProfileOrgId.current = null;
    vi.mocked(detectFraudForDocument).mockResolvedValue(null);
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: { id: 'anchor-id', public_id: 'public-id' },
            error: null,
          })),
        })),
      })),
      select: createTemplateSelectMock(),
    } as unknown as ReturnType<typeof supabase.from>);
    vi.mocked(applyTemplate).mockResolvedValue({
      mappedFields: [],
      unmappedFields: [],
    } as unknown as Awaited<ReturnType<typeof applyTemplate>>);
    // Non-blocking enrichment fire-and-forget — must return a Promise so
    // the `.then().catch()` chain doesn't throw on undefined.
    vi.mocked(fetchTemplateReconstruction).mockResolvedValue(null);
  });

  function fileSelectAndContinue(): Promise<void> {
    const file = new File(['x'], 'd.pdf', { type: 'application/pdf' });
    act(() => {
      lastFileUploadProps?.onFileSelect?.(file, 'a'.repeat(64));
    });
    return act(async () => {
      screen.getByTestId('secure-document-continue').click();
    });
  }

  // The dialog reads isAIExtractionEnabled() in a useEffect, so aiEnabled
  // starts false and flips true only after the Promise resolves. Drain
  // microtasks before exercising the file-select + Continue flow so the
  // tests don't race against the initial render's effect.
  async function flushAiEnabledState(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('does NOT warn when AI extraction returns a valid result', async () => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    vi.mocked(runExtraction).mockResolvedValueOnce({
      fields: [
        { key: 'credentialType', value: 'DEGREE', confidence: 0.9, status: 'suggested' },
      ],
      overallConfidence: 0.9,
      provider: 'gemini',
      creditsRemaining: 49,
      ocrResult: { text: 'x', pageCount: 1, method: 'pdfjs', durationMs: 1 },
      strippingReport: {
        strippedText: 'x',
        piiFound: [],
        redactionCount: 0,
        originalLength: 1,
        strippedLength: 1,
      },
    } as unknown as Awaited<ReturnType<typeof runExtraction>>);

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();

    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('warns with EXTRACTION_FAILED_TOAST and renders the extraction-failed recovery step when runExtraction returns null', async () => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    vi.mocked(runExtraction).mockResolvedValueOnce(null);

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();

    expect(toast.warning).toHaveBeenCalledWith(
      AI_EXTRACTION_LABELS.EXTRACTION_FAILED_TOAST,
    );
    expect(screen.getByText(EXTRACTION_RECOVERY_LABELS.TITLE)).toBeInTheDocument();
    expect(screen.getByText(EXTRACTION_RECOVERY_LABELS.RETRY)).toBeInTheDocument();
    expect(screen.getByText(EXTRACTION_RECOVERY_LABELS.ENTER_MANUALLY)).toBeInTheDocument();
  });

  it('does NOT silently insert an anchor when AI extraction fails — user must choose recovery action', async () => {
    const insert = vi.fn();
    vi.mocked(supabase.from).mockReturnValue({
      insert,
      select: createTemplateSelectMock(),
    } as unknown as ReturnType<typeof supabase.from>);
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    vi.mocked(runExtraction).mockResolvedValueOnce(null);

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();

    expect(insert).not.toHaveBeenCalled();
  });
});

describe('AI-03 (SCRUM-2383) — extraction review gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastFileUploadProps = null;
    mockProfileOrgId.current = null;
    vi.mocked(detectFraudForDocument).mockResolvedValue(null);
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: { id: 'anchor-id', public_id: 'public-id' },
            error: null,
          })),
        })),
      })),
      select: createTemplateSelectMock(),
    } as unknown as ReturnType<typeof supabase.from>);
    vi.mocked(fetchTemplateReconstruction).mockResolvedValue(null);
  });

  function fileSelectAndContinue(): Promise<void> {
    const file = new File(['x'], 'd.pdf', { type: 'application/pdf' });
    act(() => {
      lastFileUploadProps?.onFileSelect?.(file, 'a'.repeat(64));
    });
    return act(async () => {
      screen.getByTestId('secure-document-continue').click();
    });
  }

  async function flushAiEnabledState(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function mockExtractionWith(fields: Array<{ key: string; value: string; confidence: number; status: 'suggested' | 'accepted' }>): void {
    vi.mocked(runExtraction).mockResolvedValueOnce({
      fields,
      overallConfidence: 0.7,
      provider: 'gemini',
      creditsRemaining: 49,
      ocrResult: { text: 'x', pageCount: 1, method: 'pdfjs', durationMs: 1 },
      strippingReport: {
        strippedText: 'x',
        piiFound: [],
        redactionCount: 0,
        originalLength: 1,
        strippedLength: 1,
      },
    } as unknown as Awaited<ReturnType<typeof runExtraction>>);
    // applyTemplate passthrough so extractedFields keeps the mocked fields.
    vi.mocked(applyTemplate).mockImplementation(async (extractionFields) => ({
      mappedFields: extractionFields,
      unmappedFields: [],
    }) as unknown as Awaited<ReturnType<typeof applyTemplate>>);
  }

  it('disables Continue after extraction until the low-confidence field is acknowledged', async () => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    mockExtractionWith([
      { key: 'credentialType', value: 'CPE', confidence: 0.95, status: 'accepted' },
      { key: 'creditHours', value: '4', confidence: 0.4, status: 'suggested' },
    ]);

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();
    // Let the review panel resolve its own flag read + report state.
    await flushAiEnabledState();

    const continueBtn = screen.getByTestId('extraction-review-continue');
    expect(continueBtn).toBeDisabled();

    await act(async () => {
      screen.getByTestId('review-ack-creditHours').click();
    });

    expect(screen.getByTestId('extraction-review-continue')).not.toBeDisabled();
  });

  it('does NOT gate Continue when extraction succeeds with zero displayable fields (sparse extraction)', async () => {
    // Round-1 review HIGH: sparse extraction (e.g. only credentialType +
    // fraudSignals, both filtered out by the template mapper) yields zero
    // displayable fields. The review panel never mounts, so it can never
    // report review-complete — Continue must not stay disabled forever.
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    vi.mocked(runExtraction).mockResolvedValueOnce({
      fields: [
        { key: 'credentialType', value: 'CPE', confidence: 0.6, status: 'suggested' },
        { key: 'fraudSignals', value: '[]', confidence: 0.6, status: 'suggested' },
      ],
      overallConfidence: 0.6,
      provider: 'gemini',
      creditsRemaining: 49,
      ocrResult: { text: 'x', pageCount: 1, method: 'pdfjs', durationMs: 1 },
      strippingReport: {
        strippedText: 'x',
        piiFound: [],
        redactionCount: 0,
        originalLength: 1,
        strippedLength: 1,
      },
    } as unknown as Awaited<ReturnType<typeof runExtraction>>);
    // Template mapper filters both fields → nothing displayable.
    vi.mocked(applyTemplate).mockResolvedValue({
      mappedFields: [],
      unmappedFields: [],
    } as unknown as Awaited<ReturnType<typeof applyTemplate>>);

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();
    await flushAiEnabledState();

    // Panel absent AND non-blocking — same contract as flag-off.
    expect(screen.queryByTestId('template-review-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('extraction-review-continue')).not.toBeDisabled();
  });

  it('enables Continue immediately when every field is high-confidence', async () => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    mockExtractionWith([
      { key: 'credentialType', value: 'CPE', confidence: 0.95, status: 'accepted' },
      { key: 'issuerName', value: 'Example Institute', confidence: 0.92, status: 'accepted' },
    ]);

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();
    await flushAiEnabledState();

    expect(screen.getByTestId('extraction-review-continue')).not.toBeDisabled();
  });
});
