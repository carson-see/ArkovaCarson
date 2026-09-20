/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * SCRUM-949 — UAT 2026-04-21 reported the Continue button on the Secure
 * Document dialog was clickable with no file (silent no-op). The fix is the
 * `disabled={!fileData}` + `aria-disabled={!fileData}` guard on the
 * Continue button in the upload step. This regression test pins it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { SecureDocumentDialog } from './SecureDocumentDialog';
import {
  SECURE_DIALOG_LABELS,
  AI_EXTRACTION_LABELS,
  EXTRACTION_RECOVERY_LABELS,
  EXTRACTION_FAILURE_REASON_COPY,
  SECURING_CHOICE_LABELS,
  SECURE_QUEUE_LABELS,
  DESCRIPTION_LABELS,
  ANCHORING_STATUS_LABELS,
  CONFIRMATION_PROGRESS_LABELS,
  TOAST,
} from '@/lib/copy';
import { detectFraudForDocument } from '@/lib/fraudDetection';
import { supabase } from '@/lib/supabase';
import { isAIExtractionEnabled } from '@/lib/switchboard';
import { runExtraction, fetchTemplateReconstruction } from '@/lib/aiExtraction';
import type { ExtractionFailureReason } from '@/lib/aiExtraction';
import { applyTemplate } from '@/lib/templateMapper';
import { workerPostForUrl } from '@/lib/workerClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

type FileUploadMockProps = {
  onFileSelect?: (file: File, fingerprint: string) => void;
  onBulkDetected?: (files: File[]) => void;
  onMixedBatchDetected?: (files: File[]) => void;
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
// QUEUE-01 / SCRUM-2894 (L2-A1) — controllable securing-capability + navigate
// mocks so tests can exercise both capability states without a QueryClient.
const mockCapability = vi.hoisted(() => ({
  current: { canSecureInstantly: false, creditBalance: 5, instantSecureCost: 1 } as {
    canSecureInstantly: boolean;
    creditBalance: number;
    instantSecureCost: number;
    canPurchase?: boolean;
    purchaseGuidance?: string | null;
  },
}));
const mockCapabilityRefresh = vi.hoisted(() => vi.fn(async () => ({ data: mockCapability.current })));
const mockSubmissionState = vi.hoisted(() => ({ current: null as null | {
  action: 'instant'; instantStatus: 'QUEUED' | 'PROCESSING' | 'NEEDS_CREDIT' | 'RETRYABLE' | 'HELD' | 'SUBMITTED' | 'FAILED' | null; retryable: boolean;
} }));
const mockSubmissionRefresh = vi.hoisted(() => vi.fn(async () => ({})));
const mockSubmissionError = vi.hoisted(() => ({ current: null as string | null }));
const mockNavigate = vi.hoisted(() => vi.fn());
const DEFAULT_CAPABILITY = { canSecureInstantly: false, creditBalance: 5, instantSecureCost: 1 };

function createTemplateSelectMock(data: unknown[] = []) {
  const query = {
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => Promise.resolve({ data })),
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
        <button
          type="button"
          onClick={() =>
            props.onMixedBatchDetected?.([
              new File(['a'], 'one.pdf', { type: 'application/pdf' }),
              new File(['b'], 'two.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
            ])
          }
        >
          Drive mixed-batch path
        </button>
      </div>
    );
  },
}));

vi.mock('@/components/upload', () => ({
  BulkUploadWizard: () => <div data-testid="bulk-wizard-stub" />,
  MixedBatchUploadWizard: () => <div data-testid="mixed-batch-wizard-stub" />,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/hooks/useSecuringCapability', () => ({
  useSecuringCapability: () => ({ capability: mockCapability.current, loading: false, error: null, refresh: mockCapabilityRefresh }),
}));

vi.mock('@/hooks/useAnchorSubmissionStatus', () => ({
  useAnchorSubmissionStatus: () => ({ status: mockSubmissionState.current, loading: false, error: mockSubmissionError.current, refresh: mockSubmissionRefresh }),
}));

vi.mock('@/hooks/usePrivateTagSuggestions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/hooks/usePrivateTagSuggestions')>();
  return {
    ...original,
    usePrivateTagSuggestions: () => ({ suggestions: { user: ['personal'], organization: ['audit'] }, loading: false, error: null }),
  };
});

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
  workerPostForUrl: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

describe('SCRUM-949 SecureDocumentDialog — Continue disabled when no file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastFileUploadProps = null;
    mockProfileOrgId.current = null;
    mockCapability.current = { ...DEFAULT_CAPABILITY };
    mockSubmissionState.current = null;
    mockSubmissionError.current = null;
    mockCapabilityRefresh.mockImplementation(async () => ({ data: mockCapability.current }));
    mockSubmissionState.current = null;
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

  // SCRUM-2911 W1 — routes a mixed-format multi-file drop (from FileUpload's
  // onMixedBatchDetected) to the new MixedBatchUploadWizard, distinct from
  // the CSV-only BulkUploadWizard path.
  it('routes onMixedBatchDetected to the mixed-batch wizard', () => {
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);

    expect(lastFileUploadProps?.onMixedBatchDetected).toBeTypeOf('function');
    act(() => {
      lastFileUploadProps?.onMixedBatchDetected?.([
        new File(['a'], 'one.pdf', { type: 'application/pdf' }),
        new File(['b'], 'two.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      ]);
    });

    expect(screen.getByTestId('mixed-batch-wizard-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-wizard-stub')).not.toBeInTheDocument();
  });

  it('blocks profile-scoped mixed-batch paths when opened for a different viewed org', () => {
    mockProfileOrgId.current = 'profile-org';
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} orgId="viewed-org" />);

    act(() => {
      lastFileUploadProps?.onMixedBatchDetected?.([
        new File(['a'], 'one.pdf', { type: 'application/pdf' }),
      ]);
    });

    expect(screen.queryByTestId('mixed-batch-wizard-stub')).not.toBeInTheDocument();
    expect(screen.getByText(SECURE_DIALOG_LABELS.PROFILE_SCOPED_FLOW_UNAVAILABLE)).toBeInTheDocument();
  });

  it('stores only structured fraud findings in anchor metadata when detection is enabled', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ public_id: 'public-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = { eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: { id: 'anchor-id' }, error: null })) };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);
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

    // QUEUE-01 / SCRUM-2894: AI-disabled Continue now lands on the confirm
    // step's securing-path choice instead of inserting immediately — pick
    // "Add to Queue" (the only path exposed this sprint, R5 dark).
    expect(screen.getByTestId('securing-path-queue')).toBeInTheDocument();
    expect(screen.queryByTestId('securing-path-instant')).not.toBeInTheDocument();
    await act(async () => {
      screen.getByTestId('securing-path-queue').click();
    });

    expect(detectFraudForDocument).toHaveBeenCalledWith(file, {
      credentialType: 'OTHER',
      metadataHints: {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1];
    const payload = JSON.parse(String(request?.body)) as { metadata?: Record<string, unknown> };
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
    mockCapability.current = { ...DEFAULT_CAPABILITY };
    mockSubmissionState.current = null;
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

  // ─────────────────────────────────────────────────────────────────────────
  // SCRUM-2911 sub-item 2 — scanned (image-only) PDF no-text ROUTING guards.
  // A no-text soft failure must land on the 'extraction-failed' recovery step
  // (retry / manual / skip), NEVER on the §1.6 'privacy-blocked' screen — and
  // a genuine fail-closed signal must STILL land on 'privacy-blocked'.
  // ─────────────────────────────────────────────────────────────────────────
  it('routes a scanned-PDF no-text soft failure to extraction-failed, NOT privacy-blocked', async () => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    // Simulate the orchestrator's no-text soft path: an error progress event
    // WITHOUT failClosed, then null.
    vi.mocked(runExtraction).mockImplementationOnce(async (_f, _fp, _t, onProgress) => {
      onProgress?.({ stage: 'error', progress: 0, message: AI_EXTRACTION_LABELS.NO_TEXT_FOUND });
      return null;
    });

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();

    // Soft recovery step with all three exits visible. The rendered heading is
    // the specific soft-recovery copy (not the privacy-failure copy).
    expect(screen.getByText(EXTRACTION_RECOVERY_LABELS.TITLE)).toBeInTheDocument();
    expect(EXTRACTION_RECOVERY_LABELS.TITLE).toContain('Extraction Unsuccessful');
    expect(screen.getByText(EXTRACTION_RECOVERY_LABELS.RETRY)).toBeInTheDocument();
    expect(screen.getByText(EXTRACTION_RECOVERY_LABELS.ENTER_MANUALLY)).toBeInTheDocument();
    expect(screen.getByText(EXTRACTION_RECOVERY_LABELS.SKIP)).toBeInTheDocument();
    // NOT the loud §1.6 privacy screen.
    expect(screen.queryByTestId('privacy-blocked')).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    // The soft path warns with the specific recovery toast copy.
    expect(toast.warning).toHaveBeenCalledWith(AI_EXTRACTION_LABELS.EXTRACTION_FAILED_TOAST);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCRUM — extraction-failed reason accuracy.
  // The orchestrator computes WHY extraction failed and reports it through
  // `onProgress` as a bounded `reasonCode`. The dialog previously discarded it
  // and rendered a FIXED string claiming "image quality or an unsupported
  // format" — false for a timeout, a dropped session, or a supported-but-slow
  // file (the founder hit this on a supported .xml). These tests pin the
  // rendered reason to the reported code.
  //
  // §1.6: the dialog renders copy looked up BY CODE. It must never render
  // free-form error text, so a code it does not recognize falls back to the
  // generic description rather than printing whatever string arrived.
  // ───────────────────────────────────────────────────────────────────────────
  it.each([
    ['timeout', EXTRACTION_FAILURE_REASON_COPY.timeout],
    ['network', EXTRACTION_FAILURE_REASON_COPY.network],
    ['auth', EXTRACTION_FAILURE_REASON_COPY.auth],
    ['no_text', EXTRACTION_FAILURE_REASON_COPY.no_text],
    ['unsupported_format', EXTRACTION_FAILURE_REASON_COPY.unsupported_format],
    ['server_error', EXTRACTION_FAILURE_REASON_COPY.server_error],
  ])('renders the reason copy for reasonCode=%s instead of the fixed image-quality string', async (reasonCode, expected) => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    vi.mocked(runExtraction).mockImplementationOnce(async (_f, _fp, _t, onProgress) => {
      onProgress?.({
        stage: 'error',
        progress: 0,
        reasonCode: reasonCode as ExtractionFailureReason,
        message: 'raw orchestrator message that must not be rendered',
      });
      return null;
    });

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();

    expect(screen.getByText(EXTRACTION_RECOVERY_LABELS.TITLE)).toBeInTheDocument();
    expect(screen.getByText(expected)).toBeInTheDocument();
    // The old, often-false fixed string is gone for a coded failure.
    expect(screen.queryByText(EXTRACTION_RECOVERY_LABELS.DESCRIPTION)).not.toBeInTheDocument();
    // §1.6: free-form text from the orchestrator is never rendered.
    expect(
      screen.queryByText(/raw orchestrator message/),
    ).not.toBeInTheDocument();
  });

  it('§1.6: falls back to the generic description and renders NO free-form text when the reason code is absent or unrecognized', async () => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    vi.mocked(runExtraction).mockImplementationOnce(async (_f, _fp, _t, onProgress) => {
      onProgress?.({
        stage: 'error',
        progress: 0,
        // No reasonCode: the pre-existing generic catch-all path, whose
        // `message` may be an arbitrary Error message and is NOT §1.6-safe.
        message: 'Applicant Jane Doe, licence 12345, of 4 Privet Drive',
      });
      return null;
    });

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();

    expect(screen.getByText(EXTRACTION_RECOVERY_LABELS.DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(/Jane Doe/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Privet Drive/)).not.toBeInTheDocument();
  });

  it('does not claim image quality or an unsupported format for a timeout', async () => {
    // Regression guard for the founder report: the fixed copy asserted a cause
    // it could not know. Whatever the timeout copy says, it must not blame the
    // document's image quality.
    expect(EXTRACTION_FAILURE_REASON_COPY.timeout).not.toMatch(/image quality/i);
    expect(EXTRACTION_FAILURE_REASON_COPY.timeout).not.toMatch(/unsupported format/i);
    expect(EXTRACTION_FAILURE_REASON_COPY.network).not.toMatch(/image quality/i);
    expect(EXTRACTION_FAILURE_REASON_COPY.auth).not.toMatch(/image quality/i);
  });

  it('STILL routes a fail-closed (OCR engine / NER model) failure to privacy-blocked', async () => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    // Simulate the orchestrator's §1.6 fail-closed path.
    vi.mocked(runExtraction).mockImplementationOnce(async (_f, _fp, _t, onProgress) => {
      onProgress?.({
        stage: 'error',
        progress: 0,
        failClosed: true,
        message: AI_EXTRACTION_LABELS.PRIVACY_GUARANTEE_FAILED,
      });
      return null;
    });

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();

    // LOUD privacy screen, not the soft recovery step.
    expect(screen.getByTestId('privacy-blocked')).toBeInTheDocument();
    expect(screen.queryByText(EXTRACTION_RECOVERY_LABELS.TITLE)).not.toBeInTheDocument();
  });
});

describe('AI-03 (SCRUM-2383) — extraction review gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastFileUploadProps = null;
    mockProfileOrgId.current = null;
    mockCapability.current = { ...DEFAULT_CAPABILITY };
    mockSubmissionState.current = null;
    mockSubmissionError.current = null;
    mockCapabilityRefresh.mockImplementation(async () => ({ data: mockCapability.current }));
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

  it('SCRUM-2914: never disables Continue on a low-confidence field — review/edit stays available but non-blocking', async () => {
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

    // The AI-03 confidence-driven gate is gone: Continue is never disabled,
    // before or after acknowledgment. Field review/edit remains available.
    const continueBtn = screen.getByTestId('extraction-review-continue');
    expect(continueBtn).not.toBeDisabled();
    expect(screen.getByTestId('review-ack-creditHours')).toBeInTheDocument();

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

  it('defers template reconstruction until review is complete and uses reviewed field values', async () => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: { id: 'anchor-id', public_id: 'public-id' },
            error: null,
          })),
        })),
      })),
      select: createTemplateSelectMock([
        {
          id: 'template-cpe',
          name: 'CPE Certificate',
          description: 'Continuing professional education',
          credential_type: 'CPE',
          is_system: true,
          org_id: null,
        },
      ]),
    } as unknown as ReturnType<typeof supabase.from>);
    vi.mocked(fetchTemplateReconstruction).mockResolvedValueOnce({
      templateType: 'formal',
      documentTitle: 'Reviewed CPE Certificate',
      sections: [],
      tags: ['reviewed'],
      documentType: 'CPE Certificate',
      summary: 'Reviewed continuing education certificate.',
      verificationNotes: null,
    });
    mockExtractionWith([
      { key: 'credentialType', value: 'CPE', confidence: 0.95, status: 'accepted' },
      { key: 'issuerName', value: 'Example Fixture Institute', confidence: 0.6, status: 'suggested' },
      { key: 'creditHours', value: '4', confidence: 0.4, status: 'suggested' },
    ]);

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    await flushAiEnabledState();
    await fileSelectAndContinue();
    await flushAiEnabledState();

    expect(fetchTemplateReconstruction).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByTestId('review-edit-creditHours').click();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('review-input-creditHours'), { target: { value: '6' } });
      screen.getByTestId('review-save-creditHours').click();
    });
    await act(async () => {
      screen.getByTestId('review-ack-issuerName').click();
    });

    await act(async () => {
      screen.getByTestId('extraction-review-continue').click();
    });

    expect(fetchTemplateReconstruction).toHaveBeenCalledWith(
      {
        credentialType: 'CPE',
        issuerName: 'Example Fixture Institute',
        creditHours: '6',
      },
      0.7,
    );
  });
});

// QUEUE-01 / SCRUM-2894 (L2-A1) — Add to Queue / Secure Instantly selector.
// Per CTO R5 (2026-07-28), canSecureInstantly is hardcoded false this sprint
// (see useSecuringCapability.ts), so these tests mock the hook directly to
// exercise BOTH capability states — the "Secure Instantly" path is dark in
// prod, but must be built, correct, and tested per the sprint brief.
describe('SecureDocumentDialog — Add to Queue / Secure Instantly selector (QUEUE-01)', () => {
  async function reachConfirmStep() {
    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} />);
    const file = new File(['doc'], 'diploma.pdf', { type: 'application/pdf' });
    act(() => {
      lastFileUploadProps?.onFileSelect?.(file, 'fp');
    });
    await act(async () => {
      screen.getByTestId('secure-document-continue').click();
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    lastFileUploadProps = null;
    mockProfileOrgId.current = null;
    mockCapability.current = { ...DEFAULT_CAPABILITY };
    mockSubmissionState.current = null;
    mockSubmissionError.current = null;
    mockCapabilityRefresh.mockImplementation(async () => ({ data: mockCapability.current }));
    vi.mocked(detectFraudForDocument).mockResolvedValue(null);
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(false);
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
  });

  it('renders ONLY "Add to Queue" when capability.canSecureInstantly is false (R5 dark, this sprint)', async () => {
    await reachConfirmStep();

    expect(screen.getByTestId('securing-path-queue')).toHaveTextContent(SECURING_CHOICE_LABELS.queue);
    expect(screen.queryByTestId('securing-path-instant')).not.toBeInTheDocument();
  });

  it('renders BOTH paths when capability.canSecureInstantly is true', async () => {
    mockCapability.current = { canSecureInstantly: true, creditBalance: 5, instantSecureCost: 1 };
    await reachConfirmStep();

    expect(screen.getByTestId('securing-path-queue')).toHaveTextContent(SECURING_CHOICE_LABELS.queue);
    expect(screen.getByTestId('securing-path-instant')).toHaveTextContent(SECURING_CHOICE_LABELS.instant);
  });

  it('disables checkout while its request is pending so double clicks cannot create two sessions', async () => {
    mockCapability.current = { canSecureInstantly: true, creditBalance: 0, instantSecureCost: 1, canPurchase: true };
    let finishPurchase!: (url: string) => void;
    vi.mocked(workerPostForUrl).mockImplementation(() => new Promise(resolve => { finishPurchase = resolve; }));
    const checkout = { opener: window, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(checkout as unknown as Window);
    await reachConfirmStep();
    const purchase = screen.getByRole('button', { name: SECURE_QUEUE_LABELS.BUY_ONE_CREDIT });
    await act(async () => { purchase.click(); });
    expect(purchase).toBeDisabled();
    purchase.click();
    expect(workerPostForUrl).toHaveBeenCalledTimes(1);
    await act(async () => { finishPurchase('https://checkout.example/session'); });
    expect(checkout.opener).toBeNull();
    expect(checkout.location.href).toBe('https://checkout.example/session');
  });

  it('labels the description as public verification-page content', async () => {
    await reachConfirmStep();
    expect(screen.getByText(DESCRIPTION_LABELS.FIELD_HELP)).toHaveTextContent('public verification page');
    expect(screen.getByLabelText(DESCRIPTION_LABELS.FIELD_LABEL)).toHaveAttribute('maxlength', '1000');
  });

  it('keeps user and exact-organization suggestion lists separate', async () => {
    mockProfileOrgId.current = 'child-org';
    await reachConfirmStep();
    expect(document.querySelector('#anchor-user-tag-suggestions option')).toHaveAttribute('value', 'personal');
    expect(document.querySelector('#anchor-org-tag-suggestions option')).toHaveAttribute('value', 'audit');
  });

  it('rejects an overlong private tag before calling the canonical submit endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await reachConfirmStep();
    fireEvent.change(screen.getByLabelText(SECURE_QUEUE_LABELS.USER_TAGS), { target: { value: 'x'.repeat(65) } });
    await act(async () => { screen.getByTestId('securing-path-queue').click(); });
    expect(screen.getByText(SECURE_QUEUE_LABELS.TAG_TOO_LONG)).toHaveAttribute('role', 'alert');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"Add to Queue" uses the canonical worker path even without tags', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ public_id: 'p1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = {
          eq: vi.fn(() => query),
          maybeSingle: vi.fn(async () => ({ data: { id: 'a1' }, error: null })),
        };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);

    await reachConfirmStep();
    await act(async () => {
      screen.getByTestId('securing-path-queue').click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1];
    const payload = JSON.parse(String(request?.body)) as { action?: string; metadata?: Record<string, unknown>; private_tags?: unknown };
    expect(payload).toMatchObject({ action: 'queue', metadata: { securing_path: 'queue' }, private_tags: { user: [], organization: [] } });
    expect(toast.success).toHaveBeenCalledWith(SECURE_QUEUE_LABELS.QUEUED_TOAST);
  });

  it('treats the canonical worker receipt as success when the optional record lookup is unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ public_id: 'p-created' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = {
          eq: vi.fn(() => query),
          maybeSingle: vi.fn(async () => ({ data: null, error: { message: 'read unavailable' } })),
        };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);

    await reachConfirmStep();
    await act(async () => { screen.getByTestId('securing-path-queue').click(); });

    expect(screen.queryByRole('button', { name: ANCHORING_STATUS_LABELS.VIEW_RECORD })).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith(SECURE_QUEUE_LABELS.QUEUED_TOAST);
    expect(toast.error).not.toHaveBeenCalledWith(TOAST.ANCHOR_FAILED);
  });

  it('clears private classifications when retrying with a different document', async () => {
    mockProfileOrgId.current = 'org-id';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'failed' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await reachConfirmStep();
    fireEvent.change(screen.getByLabelText(SECURE_QUEUE_LABELS.USER_TAGS), { target: { value: 'personal' } });
    fireEvent.change(screen.getByLabelText(SECURE_QUEUE_LABELS.ORG_TAGS), { target: { value: 'audit' } });
    await act(async () => { screen.getByTestId('securing-path-queue').click(); });
    await act(async () => { screen.getByRole('button', { name: SECURE_DIALOG_LABELS.TRY_AGAIN }).click(); });

    act(() => { lastFileUploadProps?.onFileSelect?.(new File(['new'], 'new.pdf'), 'new-fp'); });
    await act(async () => { screen.getByTestId('secure-document-continue').click(); });
    expect(screen.getByLabelText(SECURE_QUEUE_LABELS.USER_TAGS)).toHaveValue('');
    expect(screen.getByLabelText(SECURE_QUEUE_LABELS.ORG_TAGS)).toHaveValue('');
  });

  it('routes an untagged selected child organization through the same canonical worker path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ public_id: 'p-child' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = { eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: { id: 'a-child' }, error: null })) };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);

    render(<SecureDocumentDialog open={true} onOpenChange={() => {}} orgId="child-org-id" />);
    act(() => { lastFileUploadProps?.onFileSelect?.(new File(['doc'], 'child.pdf'), 'fp-child'); });
    await act(async () => { screen.getByTestId('secure-document-continue').click(); });
    await act(async () => { screen.getByTestId('securing-path-queue').click(); });

    const request = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      org_id: 'child-org-id', action: 'queue', private_tags: { user: [], organization: [] },
    });
  });

  it('shows a truthful held status without a retry action', async () => {
    mockCapability.current = { canSecureInstantly: true, creditBalance: 5, instantSecureCost: 1, canPurchase: true, purchaseGuidance: null };
    mockSubmissionState.current = { action: 'instant', instantStatus: 'HELD', retryable: false };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ public_id: 'p-held' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = { eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: { id: 'a-held' }, error: null })) };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);
    await reachConfirmStep();
    await act(async () => { screen.getByTestId('securing-path-instant').click(); });
    expect(screen.getByTestId('instant-submission-status')).toHaveTextContent(SECURE_QUEUE_LABELS.INSTANT_STATUS.HELD);
    expect(screen.getByRole('heading', { name: SECURE_QUEUE_LABELS.INSTANT_SAVED_TITLE })).toBeInTheDocument();
    expect(screen.getByText(SECURE_QUEUE_LABELS.INSTANT_HELD_BODY)).toBeInTheDocument();
    expect(screen.queryByText(ANCHORING_STATUS_LABELS.SUCCESS_PROCESSING)).not.toBeInTheDocument();
    expect(screen.queryByText(CONFIRMATION_PROGRESS_LABELS.IN_PROGRESS)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SECURE_QUEUE_LABELS.REARM_INSTANT })).not.toBeInTheDocument();
  });

  it('does not fabricate QUEUED when an instant submission has no durable intent status', async () => {
    mockCapability.current = { canSecureInstantly: true, creditBalance: 5, instantSecureCost: 1, canPurchase: true, purchaseGuidance: null };
    mockSubmissionState.current = { action: 'instant', instantStatus: null, retryable: false };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ public_id: 'p-no-intent' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = { eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: { id: 'a-no-intent' }, error: null })) };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);
    await reachConfirmStep();
    await act(async () => { screen.getByTestId('securing-path-instant').click(); });
    expect(screen.getByTestId('instant-submission-status')).toHaveTextContent(SECURE_QUEUE_LABELS.STATUS_ERROR);
    expect(screen.getByText(SECURE_QUEUE_LABELS.INSTANT_STATUS_UNKNOWN_BODY)).toBeInTheDocument();
    expect(screen.getByTestId('instant-submission-status')).not.toHaveTextContent(SECURE_QUEUE_LABELS.INSTANT_STATUS.QUEUED);
    await act(async () => { screen.getByRole('button', { name: SECURE_DIALOG_LABELS.TRY_AGAIN }).click(); });
    expect(mockSubmissionRefresh).toHaveBeenCalled();
  });

  it('keeps instant copy fail-closed while the first status read is unavailable', async () => {
    mockCapability.current = { canSecureInstantly: true, creditBalance: 5, instantSecureCost: 1, canPurchase: true, purchaseGuidance: null };
    mockSubmissionState.current = null;
    mockSubmissionError.current = 'Could not load securing status';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ public_id: 'p-status-error' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = { eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: { id: 'a-status-error' }, error: null })) };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);
    await reachConfirmStep();
    await act(async () => { screen.getByTestId('securing-path-instant').click(); });
    expect(screen.getByRole('heading', { name: SECURE_QUEUE_LABELS.INSTANT_SAVED_TITLE })).toBeInTheDocument();
    expect(screen.getByText(SECURE_QUEUE_LABELS.INSTANT_STATUS_UNKNOWN_BODY)).toBeInTheDocument();
    expect(screen.queryByText(ANCHORING_STATUS_LABELS.SUCCESS_PROCESSING)).not.toBeInTheDocument();
    expect(screen.queryByText(CONFIRMATION_PROGRESS_LABELS.IN_PROGRESS)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: SECURE_DIALOG_LABELS.TRY_AGAIN })).toHaveLength(1);
  });

  it('rearms a NEEDS_CREDIT intent explicitly with the same fingerprint and prevents implicit retry', async () => {
    mockCapability.current = { canSecureInstantly: true, creditBalance: 5, instantSecureCost: 1, canPurchase: true, purchaseGuidance: null };
    mockSubmissionState.current = { action: 'instant', instantStatus: 'NEEDS_CREDIT', retryable: true };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ public_id: 'p-rearm' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = { eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: { id: 'a-rearm' }, error: null })) };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);
    await reachConfirmStep();
    await act(async () => { screen.getByTestId('securing-path-instant').click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { screen.getByRole('button', { name: SECURE_QUEUE_LABELS.REARM_INSTANT }).click(); });
    expect(mockCapabilityRefresh).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call as unknown as [unknown, RequestInit])[1].body)));
    expect(bodies[1]).toMatchObject({ fingerprint: 'fp', action: 'instant' });
  });

  it('does not rearm a NEEDS_CREDIT intent when the fresh capability remains unfunded', async () => {
    mockCapability.current = { canSecureInstantly: true, creditBalance: 5, instantSecureCost: 1, canPurchase: true, purchaseGuidance: null };
    mockCapabilityRefresh.mockResolvedValueOnce({ data: { ...mockCapability.current, creditBalance: 0 } });
    mockSubmissionState.current = { action: 'instant', instantStatus: 'NEEDS_CREDIT', retryable: true };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ public_id: 'p-unfunded' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = { eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: { id: 'a-unfunded' }, error: null })) };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);
    await reachConfirmStep();
    await act(async () => { screen.getByTestId('securing-path-instant').click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { screen.getByRole('button', { name: SECURE_QUEUE_LABELS.REARM_INSTANT }).click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(SECURE_QUEUE_LABELS.INSUFFICIENT_CREDITS);
  });

  it('"Secure Instantly" shows the dedicated credit guidance and does not submit when credits are insufficient', async () => {
    mockCapability.current = { canSecureInstantly: true, creditBalance: 0, instantSecureCost: 1 };
    const insert = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockReturnValue({
      insert,
      select: createTemplateSelectMock(),
    } as unknown as ReturnType<typeof supabase.from>);

    await reachConfirmStep();
    await act(async () => {
      screen.getByTestId('securing-path-instant').click();
    });

    expect(insert).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(SECURE_QUEUE_LABELS.INSUFFICIENT_CREDITS);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('"Secure Instantly" submits the atomic worker action and shows the started toast when credits suffice', async () => {
    mockCapability.current = { canSecureInstantly: true, creditBalance: 5, instantSecureCost: 1 };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ public_id: 'p1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table === 'anchors') {
        const query = {
          eq: vi.fn(() => query),
          maybeSingle: vi.fn(async () => ({ data: { id: 'a1' }, error: null })),
        };
        return { select: vi.fn(() => query) };
      }
      return { select: createTemplateSelectMock() };
    }) as unknown as typeof supabase.from);

    await reachConfirmStep();
    await act(async () => {
      screen.getByTestId('securing-path-instant').click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1];
    if (!request) throw new Error('instant submission request was not captured');
    const payload = JSON.parse(String(request.body)) as { action?: string; metadata?: Record<string, unknown> };
    expect(payload).toMatchObject({ action: 'instant', metadata: { securing_path: 'instant' } });
    expect(toast.success).toHaveBeenCalledWith(SECURE_QUEUE_LABELS.INSTANT_STARTED_TOAST);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
