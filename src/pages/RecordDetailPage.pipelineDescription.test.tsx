/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping (same as useAnchor.test.ts) */
/**
 * RecordDetailPage — legacy pipeline-anchor description fallback (SCRUM-5105)
 *
 * Prod sample (Sept, reported): a large share of pipeline anchors have
 * `anchors.description` NULL even though the linked
 * `public_records.metadata.abstract` is present — early anchors wrote the
 * abstract into `description` directly at creation time; later ones did
 * not. This is the READ-SIDE fix for those legacy (and any future) rows:
 * when the anchor's own description is null/empty, fall back to the linked
 * public record's abstract/description/summary (priority order), truncated
 * CODE-POINT safely — the exact class of poison-record bug already fixed
 * on the WRITE side in
 * services/worker/src/jobs/publicRecordAnchor.ts's `publicRecordDescription`
 * (a `.slice(0, 500)` split a surrogate pair at unit 500 there; `Array.from`
 * here iterates by code point, so the same boundary cannot happen on read).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RecordDetailPage } from './RecordDetailPage';
import { truncateCodePointSafe, pipelineDescriptionFallback } from './RecordDetailPage';

const mockPublicRecordsMaybeSingle = vi.hoisted(() => vi.fn());
const publicRecordsChain = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn(() => c);
  c.limit = vi.fn(() => c);
  c.maybeSingle = mockPublicRecordsMaybeSingle;
  return c;
});

const mockFrom = vi.hoisted(() =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.fn((table: string): any => {
    if (table === 'public_records') return publicRecordsChain;
    // No credential_templates lookup fires in these tests (no credentialType/orgId).
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
  }),
);

const mockUseAnchor = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({ supabase: { from: mockFrom } }));
vi.mock('@/hooks/useAnchor', () => ({ useAnchor: mockUseAnchor }));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'owner@test.dev' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { role: 'INDIVIDUAL', org_id: null }, loading: false }),
}));
vi.mock('@/hooks/useHasCredentialImportEntitlement', () => ({
  useHasCredentialImportEntitlement: () => false,
}));
vi.mock('@/components/layout', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AppShell: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'anchor-pipeline-desc-1' }),
  useNavigate: () => vi.fn(),
}));

const baseAnchorRow = {
  id: 'anchor-pipeline-desc-1',
  public_id: 'pub_anchor_pipeline_desc_1',
  filename: 'openalex-w456.pdf',
  fingerprint: 'e'.repeat(64),
  fingerprint_source: null,
  status: 'SECURED',
  created_at: '2026-02-14T00:00:00Z',
  chain_timestamp: '2026-02-15T00:00:00Z',
  issued_at: null,
  revoked_at: null,
  revocation_reason: null,
  expires_at: null,
  file_size: 0,
  file_mime: null,
  credential_type: null,
  chain_tx_id: null,
  chain_block_height: null,
  chain_block_hash: null,
  metadata: { pipeline_source: 'openalex', source_id: 'W456' },
  cpe_metadata: null,
  cle_metadata: null,
  description: null,
  org_id: null,
  user_id: 'user-pipeline-owner',
  version_number: 1,
  parent_anchor_id: null,
  deleted_at: null,
};

describe('RecordDetailPage — pipeline description fallback (SCRUM-5105)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the linked record\'s abstract when the anchor has no description of its own', async () => {
    mockUseAnchor.mockReturnValue({ anchor: baseAnchorRow, loading: false, error: null, refreshAnchor: vi.fn() });
    mockPublicRecordsMaybeSingle.mockResolvedValue({
      data: { title: 'A Paper', source: 'openalex', metadata: { abstract: 'The abstract text for this legacy record.' } },
      error: null,
    });

    render(<RecordDetailPage />);

    await waitFor(() => expect(screen.getByText('The abstract text for this legacy record.')).toBeInTheDocument());
  });

  it('ignores the abstract when the anchor already has its own description', async () => {
    mockUseAnchor.mockReturnValue({
      anchor: { ...baseAnchorRow, description: 'The anchor’s own description.' },
      loading: false,
      error: null,
      refreshAnchor: vi.fn(),
    });
    mockPublicRecordsMaybeSingle.mockResolvedValue({
      data: { title: 'A Paper', source: 'openalex', metadata: { abstract: 'Should never be shown — anchor description wins.' } },
      error: null,
    });

    render(<RecordDetailPage />);

    await waitFor(() => expect(screen.getByText('The anchor’s own description.')).toBeInTheDocument());
    expect(screen.queryByText(/Should never be shown/)).not.toBeInTheDocument();
  });

  it('truncates a 2,000-char abstract with an astral character straddling position 500 without producing a lone surrogate', async () => {
    // U+1F600 (😀) is a surrogate pair in UTF-16. Place it so its first unit
    // lands exactly at code-point index 500 to test the truncation boundary.
    const filler = 'x'.repeat(500);
    const longAbstract = filler + '\u{1F600}' + 'y'.repeat(1499);
    expect(Array.from(longAbstract).length).toBe(2000);

    mockUseAnchor.mockReturnValue({ anchor: baseAnchorRow, loading: false, error: null, refreshAnchor: vi.fn() });
    mockPublicRecordsMaybeSingle.mockResolvedValue({
      data: { title: 'A Paper', source: 'openalex', metadata: { abstract: longAbstract } },
      error: null,
    });

    render(<RecordDetailPage />);

    await waitFor(() => expect(screen.getByText(/^x{100,}/)).toBeInTheDocument());
    const rendered = screen.getByText(/^x{100,}/).textContent ?? '';
    expect(rendered.length).toBeLessThanOrEqual(501); // 500 'x' + the whole emoji (2 UTF-16 units) at most
    expect(/[\uD800-\uDFFF]$/.test(rendered)).toBe(false);
  });
});

describe('pipelineDescriptionFallback (pure)', () => {
  it('returns null for a null record', () => {
    expect(pipelineDescriptionFallback(null)).toBeNull();
  });

  it('prefers abstract over description over summary', () => {
    expect(pipelineDescriptionFallback({ metadata: { abstract: 'A', description: 'B', summary: 'C' } })).toBe('A');
    expect(pipelineDescriptionFallback({ metadata: { description: 'B', summary: 'C' } })).toBe('B');
    expect(pipelineDescriptionFallback({ metadata: { summary: 'C' } })).toBe('C');
  });

  it('returns null when none of abstract/description/summary is a non-empty string', () => {
    expect(pipelineDescriptionFallback({ metadata: {} })).toBeNull();
    expect(pipelineDescriptionFallback({ metadata: { abstract: '   ' } })).toBeNull();
    expect(pipelineDescriptionFallback({ metadata: { abstract: 42 } })).toBeNull();
  });
});

describe('truncateCodePointSafe (pure)', () => {
  it('returns the string unchanged when at or under the cap', () => {
    expect(truncateCodePointSafe('short', 500)).toBe('short');
  });

  it('truncates by code point, never splitting a surrogate pair', () => {
    const value = 'a'.repeat(10) + '\u{1F600}';
    const truncated = truncateCodePointSafe(value, 10);
    expect(truncated).toBe('a'.repeat(10));
    expect(/[\uD800-\uDFFF]$/.test(truncated)).toBe(false);
  });

  it('keeps a whole astral character even when it is the last one included', () => {
    const value = 'a'.repeat(9) + '\u{1F600}' + 'b'.repeat(10);
    const truncated = truncateCodePointSafe(value, 10);
    expect(Array.from(truncated)).toHaveLength(10);
    expect(truncated.endsWith('\u{1F600}')).toBe(true);
    // The whole pair is present, so the string legitimately ends in a LOW
    // surrogate (0xDC00-0xDFFF) here — the invariant that must never hold
    // is ending on an UNPAIRED HIGH surrogate (0xD800-0xDBFF), i.e. a split.
    const lastUnit = truncated.charCodeAt(truncated.length - 1);
    const endsOnUnpairedHighSurrogate = lastUnit >= 0xD800 && lastUnit <= 0xDBFF;
    expect(endsOnUnpairedHighSurrogate).toBe(false);
  });
});
