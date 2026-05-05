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
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IssueCredentialForm } from './IssueCredentialForm';
import { ISSUE_CREDENTIAL_LABELS } from '@/lib/copy';

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

const mockSelectSingle = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single: mockSelectSingle })) })),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ single: mockSelectSingle })),
      })),
    })),
  },
}));

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IssueCredentialForm open={true} onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe('SCRUM-1755 IssueCredentialForm split + proof_url', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSplitEnabled.mockResolvedValue(false);
    // Default org row: UNVERIFIED root, not a sub-org.
    mockSelectSingle.mockResolvedValue({
      data: {
        id: 'org-unverified',
        verification_status: 'UNVERIFIED',
        suspended: false,
        parent_org_id: null,
        parent_approval_status: null,
      },
      error: null,
    });
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
    mockSelectSingle.mockResolvedValue({
      data: {
        id: 'sub-org',
        verification_status: 'VERIFIED',
        suspended: false,
        parent_org_id: 'parent-org',
        parent_approval_status: 'PENDING',
      },
      error: null,
    });
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

  afterEach(() => cleanup());
});
