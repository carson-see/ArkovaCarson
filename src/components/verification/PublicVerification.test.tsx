/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT */
/**
 * PublicVerification — hero state machine tests (SCRUM-952).
 *
 * Pins the rule that SUBMITTED ≠ SECURED on `/verify/:publicId`:
 *   - PENDING → "Submitting to Network…" + amber clock + Processing badge
 *   - SUBMITTED → "Record Submitted · Awaiting Network Confirmation" + amber clock + "Awaiting Confirmation" badge
 *   - SECURED → "Document Verified" + green check + "Secured" badge
 *
 * Before this fix, SUBMITTED fell through to the SECURED branch and rendered
 * a green "Document Verified" hero next to a yellow "Awaiting Confirmation"
 * pill — contradictory trust signals on the same anchor (BUG-2026-04-21-005).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicVerification } from './PublicVerification';
import { ANCHOR_STATUS_LABELS, ANCHORING_STATUS_LABELS, PUBLIC_VERIFICATION_LABELS } from '@/lib/copy';

// Mock supabase RPC at module scope; per-test we rebind the resolver
// via vi.mocked() so each test controls the returned status.
vi.mock('@/lib/supabase', () => {
  return {
    supabase: {
      rpc: vi.fn(),
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            in: vi.fn(() => ({
              is: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              })),
            })),
          })),
        })),
      })),
    },
  };
});

vi.mock('@/lib/logVerificationEvent', () => ({
  logVerificationEvent: vi.fn(),
}));

vi.mock('@/hooks/useCredentialTemplate', () => ({
  useCredentialTemplate: () => ({ template: null }),
}));

import { supabase } from '@/lib/supabase';

const baseAnchor = {
  public_id: 'ARK-DOC-DMJFDF',
  fingerprint: 'a'.repeat(64),
  filename: 'demo-cert.pdf',
  verified: true,
  credential_type: 'CERTIFICATE',
  org_id: 'org-1',
  metadata: {},
  created_at: '2026-04-21T10:00:00Z',
};

function mockAnchor(overrides: Record<string, unknown> & { status: string }) {
  vi.mocked(supabase.rpc).mockResolvedValue({
    data: { ...baseAnchor, ...overrides },
    error: null,
  } as never);
}

function renderPublic(publicId = 'ARK-DOC-DMJFDF') {
  return render(
    <MemoryRouter>
      <PublicVerification publicId={publicId} />
    </MemoryRouter>,
  );
}

describe('PublicVerification hero state (SCRUM-952)', () => {
  it('SUBMITTED → "Record Submitted · Awaiting Network Confirmation" with no green-check signal', async () => {
    mockAnchor({ status: 'SUBMITTED' });
    renderPublic();

    await waitFor(() =>
      expect(screen.getByText(ANCHORING_STATUS_LABELS.SUBMITTED_PUBLIC_TITLE)).toBeDefined(),
    );

    // CRITICAL: must NOT render the SECURED affordance simultaneously.
    expect(screen.queryByText(PUBLIC_VERIFICATION_LABELS.DOCUMENT_VERIFIED)).toBeNull();
    expect(screen.queryByText(PUBLIC_VERIFICATION_LABELS.VERIFIED_DESC)).toBeNull();

    // Subtitle present.
    expect(screen.getByText(ANCHORING_STATUS_LABELS.SUBMITTED_PUBLIC_SUBTITLE)).toBeDefined();

    // Badge reads "Awaiting Confirmation" — sourced from the canonical
    // ANCHOR_STATUS_LABELS.SUBMITTED so we have one source of truth.
    // The string may appear in more than one DOM node (the badge + e.g.
    // a status reference); we only need to confirm at least one
    // occurrence on the page.
    expect(screen.getAllByText(ANCHOR_STATUS_LABELS.SUBMITTED).length).toBeGreaterThan(0);
  });

  it('PENDING → "Submitting to Network…" hero (distinct from SUBMITTED)', async () => {
    mockAnchor({ status: 'PENDING' });
    renderPublic();

    await waitFor(() =>
      expect(screen.getByText(ANCHORING_STATUS_LABELS.PENDING_PUBLIC_TITLE)).toBeDefined(),
    );
    expect(screen.queryByText(ANCHORING_STATUS_LABELS.SUBMITTED_PUBLIC_TITLE)).toBeNull();
    expect(screen.queryByText(PUBLIC_VERIFICATION_LABELS.DOCUMENT_VERIFIED)).toBeNull();
  });

  it('SECURED → "Document Verified" hero with green-check affordance', async () => {
    mockAnchor({ status: 'SECURED', secured_at: '2026-04-21T10:30:00Z' });
    renderPublic();

    await waitFor(() =>
      expect(screen.getByText(PUBLIC_VERIFICATION_LABELS.DOCUMENT_VERIFIED)).toBeDefined(),
    );
    expect(screen.queryByText(ANCHORING_STATUS_LABELS.SUBMITTED_PUBLIC_TITLE)).toBeNull();
    expect(screen.queryByText(ANCHORING_STATUS_LABELS.PENDING_PUBLIC_TITLE)).toBeNull();
  });

  it('SUBMITTED hero gates the cryptographic-proof section (it is not yet secured)', async () => {
    mockAnchor({ status: 'SUBMITTED' });
    renderPublic();

    await waitFor(() =>
      expect(screen.getByText(ANCHORING_STATUS_LABELS.SUBMITTED_PUBLIC_TITLE)).toBeDefined(),
    );

    // Cryptographic-proof section is hidden for not-yet-secured anchors —
    // the green-tinged "verified" affordances must not appear next to a
    // SUBMITTED hero.
    expect(screen.queryByText(PUBLIC_VERIFICATION_LABELS.CRYPTOGRAPHIC_PROOF)).toBeNull();
  });
});
