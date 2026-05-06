/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side */
/**
 * SCRUM-1755 — IssueCredentialForm gate banner + proof_url field.
 *
 * Pins:
 *   1. Renders the distinct "Issue Credential" title (not the conflated
 *      "Secure Document" string from the pre-1755 alias).
 *   2. Renders the public proof URL field with help text.
 *   3. Surfaces a gate-blocked banner when the resolver says the org cannot
 *      issue (e.g. UNVERIFIED) AND the split flag is on.
 *   4. Does NOT render the gate-blocked banner when the split flag is off
 *      (preserves pre-1755 behavior).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IssueCredentialForm } from './IssueCredentialForm';
import { CREDENTIAL_TYPE_LABELS, ISSUE_CREDENTIAL_LABELS } from '@/lib/copy';

const mockProfile: { id: string; role: string; org_id: string | null } = {
  id: 'user-1',
  role: 'ORG_ADMIN',
  org_id: 'org-unverified',
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: mockProfile, loading: false }),
}));

const mockSplitEnabled = vi.fn(async () => false);
vi.mock('@/lib/switchboard', () => ({
  isAIExtractionEnabled: vi.fn(async () => false),
  isIssueCredentialSplitEnabled: () => mockSplitEnabled(),
}));

const selectController = vi.hoisted(() => ({
  onValueChange: undefined as ((value: string) => void) | undefined,
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    disabled,
    onValueChange,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
  }) => {
    selectController.onValueChange = disabled ? undefined : onValueChange;
    return <div data-testid="credential-select">{children}</div>;
  },
  SelectTrigger: ({ children, id }: { children: ReactNode; id?: string }) => (
    <button type="button" id={id}>{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <button type="button" onClick={() => selectController.onValueChange?.(value)}>
      {children}
    </button>
  ),
}));

vi.mock('@/components/anchor/FileUpload', () => ({
  FileUpload: ({
    disabled,
    onFileSelect,
  }: {
    disabled?: boolean;
    onFileSelect: (file: File, fingerprint: string) => void;
  }) => (
    <button
      type="button"
      data-testid="mock-file-upload"
      disabled={disabled}
      onClick={() => onFileSelect(
        new File(['credential'], 'credential.pdf', { type: 'application/pdf' }),
        'fingerprint-123',
      )}
    >
      Upload test file
    </button>
  ),
}));

vi.mock('@/hooks/useCredentialTemplate', () => ({
  useCredentialTemplate: () => ({ template: null, loading: false }),
}));

vi.mock('@/lib/auditLog', () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock('@/lib/aiExtraction', () => ({
  runExtraction: vi.fn(),
}));

vi.mock('@/lib/fileHasher', () => ({
  hashEmail: vi.fn(async () => 'mock-hash'),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/validators', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/validators');
  return {
    ...actual,
    validateAnchorCreate: vi.fn((x) => x),
  };
});

const mockAnchorInsert = vi.hoisted(() => vi.fn());
const anchorInsertPayloads = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const mockOrgGateResult = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  error: null as { code?: string; message?: string } | null,
}));

function createAnchorInsertSingleResult() {
  return Promise.resolve({
    data: { id: 'anchor-1', public_id: 'public-anchor-1' },
    error: null,
  });
}

function createAnchorInsertSelectChain() {
  return { single: vi.fn(createAnchorInsertSingleResult) };
}

function createAnchorInsertChain(payload: Record<string, unknown>) {
  anchorInsertPayloads.push(payload);
  return { select: vi.fn(createAnchorInsertSelectChain) };
}

function createOrgSingleResult() {
  return Promise.resolve({
    data: mockOrgGateResult.data,
    error: mockOrgGateResult.error,
  });
}

function createOrgEqChain() {
  return { single: vi.fn(createOrgSingleResult) };
}

function createOrgSelectChain() {
  return { eq: vi.fn(createOrgEqChain) };
}

function createFallbackEqChain() {
  return { single: vi.fn(async () => ({ data: null, error: null })) };
}

function createFallbackSelectChain() {
  return { eq: vi.fn(createFallbackEqChain) };
}

function createSupabaseTableMock(table: string) {
  if (table === 'anchors') {
    return { insert: mockAnchorInsert.mockImplementation(createAnchorInsertChain) };
  }
  if (table === 'organizations') {
    return { select: vi.fn(createOrgSelectChain) };
  }
  return {
    insert: vi.fn(async () => ({ data: null, error: null })),
    select: vi.fn(createFallbackSelectChain),
  };
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(createSupabaseTableMock),
  },
}));

function renderForm(props: Partial<ComponentProps<typeof IssueCredentialForm>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IssueCredentialForm open={true} onOpenChange={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

async function waitForUploadReady(assertNoGate = false) {
  await waitFor(() => {
    if (assertNoGate) {
      expect(screen.queryByTestId('issue-credential-gate-blocked')).not.toBeInTheDocument();
    }
    expect(screen.getByTestId('mock-file-upload')).not.toBeDisabled();
  });
}

async function chooseCertificate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('mock-file-upload'));
  await user.click(screen.getByRole('button', { name: CREDENTIAL_TYPE_LABELS.CERTIFICATE }));
}

async function submitCertificate(user: ReturnType<typeof userEvent.setup>, proofUrl?: string) {
  await chooseCertificate(user);
  if (proofUrl) {
    await user.type(
      screen.getByLabelText(new RegExp(ISSUE_CREDENTIAL_LABELS.PROOF_URL_LABEL, 'i')),
      proofUrl,
    );
  }
  await user.click(screen.getByRole('button', { name: ISSUE_CREDENTIAL_LABELS.ISSUE_BUTTON }));
}

describe('SCRUM-1755 IssueCredentialForm split + proof_url', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectController.onValueChange = undefined;
    anchorInsertPayloads.length = 0;
    mockSplitEnabled.mockResolvedValue(false);
    mockProfile.org_id = 'org-unverified';
    // Default org row: UNVERIFIED root, not a sub-org.
    mockOrgGateResult.data = {
      id: 'org-unverified',
      verification_status: 'UNVERIFIED',
      suspended: false,
      parent_org_id: null,
      parent_approval_status: null,
    };
    mockOrgGateResult.error = null;
  });

  it('fails closed during the flag-fetch window (Codex P1)', async () => {
    // Flag fetch never resolves — simulates "still loading" forever.
    mockSplitEnabled.mockReturnValue(new Promise<boolean>(() => {}));
    renderForm();
    // Banner must render immediately because `loading` is treated as gate-on.
    const banner = await screen.findByTestId('issue-credential-gate-blocked', {}, { timeout: 200 });
    expect(banner).toBeInTheDocument();
  });

  it('renders distinct GATE_PARENT_UNAPPROVED copy for sub-orgs without parent approval (Codex P2)', async () => {
    mockSplitEnabled.mockResolvedValue(true);
    mockOrgGateResult.data = {
      id: 'sub-org',
      verification_status: 'VERIFIED',
      suspended: false,
      parent_org_id: 'parent-org',
      parent_approval_status: 'PENDING',
    };
    renderForm();
    await screen.findByText(ISSUE_CREDENTIAL_LABELS.GATE_PARENT_UNAPPROVED, {}, { timeout: 2000 });
    const banner = screen.getByTestId('issue-credential-gate-blocked');
    expect(banner.textContent).toContain(ISSUE_CREDENTIAL_LABELS.GATE_PARENT_UNAPPROVED);
    // And specifically NOT the parent-unverified copy — the conditions are different.
    expect(banner.textContent).not.toContain(ISSUE_CREDENTIAL_LABELS.GATE_PARENT_UNVERIFIED);
  });

  it('renders the distinct "Issue Credential" title (not the conflated label)', () => {
    renderForm();
    const title = screen.getByRole('dialog').querySelector('h2');
    expect(title?.textContent).toBe(ISSUE_CREDENTIAL_LABELS.TITLE);
  });

  it('renders the Public Proof URL field with help text', () => {
    renderForm();
    expect(screen.getByLabelText(new RegExp(ISSUE_CREDENTIAL_LABELS.PROOF_URL_LABEL, 'i'))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(ISSUE_CREDENTIAL_LABELS.PROOF_URL_HELP.slice(0, 30), 'i'))).toBeInTheDocument();
  });

  it('does NOT render the gate-blocked banner when ENABLE_ISSUE_CREDENTIAL_SPLIT is off', async () => {
    mockSplitEnabled.mockResolvedValue(false);
    renderForm();
    // Wait on the actual condition rather than a timer — flag/gate state must
    // settle before the banner check is meaningful, but the settle time can
    // vary on CI.
    await waitFor(() => {
      expect(screen.queryByTestId('issue-credential-gate-blocked')).not.toBeInTheDocument();
    });
  });

  it('renders the gate-blocked banner when split flag is on and the org is UNVERIFIED', async () => {
    mockSplitEnabled.mockResolvedValue(true);
    renderForm();
    // Wait for the resolved (post-fetch) copy — pre-resolution the banner
    // shows GATE_LOADING; we want to assert the final reason matches.
    await screen.findByText(ISSUE_CREDENTIAL_LABELS.GATE_NOT_VERIFIED, {}, { timeout: 2000 });
    const banner = screen.getByTestId('issue-credential-gate-blocked');
    expect(banner.textContent).toContain(ISSUE_CREDENTIAL_LABELS.GATE_NOT_VERIFIED);
  });

  it('submits a valid https proof_url into anchors.metadata.proof_url when the split is off', async () => {
    const user = userEvent.setup();
    mockSplitEnabled.mockResolvedValue(false);
    renderForm();

    await waitForUploadReady(true);
    await submitCertificate(user, 'https://example.test/proof/credential-1');

    await waitFor(() => expect(mockAnchorInsert).toHaveBeenCalledTimes(1));
    expect(anchorInsertPayloads[0]).toMatchObject({
      org_id: 'org-unverified',
      metadata: { proof_url: 'https://example.test/proof/credential-1' },
    });
  });

  it('submits against an explicit viewed org instead of the profile org', async () => {
    const user = userEvent.setup();
    mockProfile.org_id = 'profile-org';
    mockSplitEnabled.mockResolvedValue(false);
    renderForm({ orgId: 'viewed-org', role: 'ORG_ADMIN' });

    await waitForUploadReady();
    await submitCertificate(user);

    await waitFor(() => expect(mockAnchorInsert).toHaveBeenCalledTimes(1));
    expect(anchorInsertPayloads[0]).toMatchObject({ org_id: 'viewed-org' });
  });

  it('honors an explicit null role instead of falling back to the profile role', async () => {
    mockSplitEnabled.mockResolvedValue(true);
    mockOrgGateResult.data = {
      id: 'verified-org',
      verification_status: 'VERIFIED',
      suspended: false,
      parent_org_id: null,
      parent_approval_status: null,
    };
    renderForm({ orgId: 'verified-org', role: null, profileLoading: false });

    const banner = await screen.findByTestId('issue-credential-gate-blocked', {}, { timeout: 2000 });
    expect(banner).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ISSUE_CREDENTIAL_LABELS.ISSUE_BUTTON })).toBeDisabled();
    expect(mockAnchorInsert).not.toHaveBeenCalled();
  });

  it('rejects non-https proof_url values and wires the error into aria-describedby', async () => {
    const user = userEvent.setup();
    mockSplitEnabled.mockResolvedValue(false);
    renderForm();

    await waitForUploadReady(true);

    const proofInput = screen.getByLabelText(new RegExp(ISSUE_CREDENTIAL_LABELS.PROOF_URL_LABEL, 'i'));
    await chooseCertificate(user);
    await user.type(proofInput, 'http://example.test/proof');
    await user.click(screen.getByRole('button', { name: ISSUE_CREDENTIAL_LABELS.ISSUE_BUTTON }));

    expect(await screen.findByText(ISSUE_CREDENTIAL_LABELS.HINT_PROOF_URL_INVALID)).toBeInTheDocument();
    expect(proofInput).toHaveAttribute('aria-describedby', 'proof-url-help proof-url-error');
    expect(mockAnchorInsert).not.toHaveBeenCalled();
  });

  it('blocks submit for an unverified org when the split flag is on', async () => {
    mockSplitEnabled.mockResolvedValue(true);
    renderForm();

    await screen.findByText(ISSUE_CREDENTIAL_LABELS.GATE_NOT_VERIFIED, {}, { timeout: 2000 });
    expect(screen.getByRole('button', { name: ISSUE_CREDENTIAL_LABELS.ISSUE_BUTTON })).toBeDisabled();
    expect(mockAnchorInsert).not.toHaveBeenCalled();
  });

  afterEach(() => cleanup());
});
