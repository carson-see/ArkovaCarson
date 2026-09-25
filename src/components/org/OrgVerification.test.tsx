/**
 * OrgVerification — SCRUM-5285.
 *
 * The worker's domain-verification writes are compare-and-swapped against the
 * domain (and pending code) they were issued for, and answer
 * 409 `verification_superseded` when the row moved underneath them. This suite
 * pins the two things the card must do with that answer:
 *
 *   - say the proof no longer binds, in the words of src/lib/copy.ts — not a
 *     generic "Failed to verify domain", which reads as a transient error and
 *     invites the user to resubmit the same dead code;
 *   - put the flow back at its start, so "again" is actually actionable.
 *
 * A 409 must never leave the card claiming the domain is verified.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

import { OrgVerification } from './OrgVerification';
import { ORG_VERIFICATION_LABELS } from '@/lib/copy';

const SUPERSEDED = {
  status: 409,
  body: {
    error: 'server-side wording that the card must not surface verbatim',
    code: 'verification_superseded',
  },
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Queue of fetch answers, consumed in order. */
function mockFetchSequence(answers: { status: number; body: unknown }[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return jsonResponse(next.status, next.body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function renderCard() {
  return render(
    <OrgVerification
      verificationStatus="PENDING"
      domain="example.com"
      domainVerified={false}
      hasEin
    />,
  );
}

/** Drive the card into the "enter your code" state via a successful start. */
async function startVerification() {
  fireEvent.click(screen.getByRole('button', { name: /Send Verification Email/i }));
  await waitFor(() =>
    expect(screen.getByPlaceholderText(/6-digit code/i)).toBeInTheDocument(),
  );
}

describe('OrgVerification — 409 verification_superseded (SCRUM-5285)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('explains a superseded confirmation in copy.ts words and never shows Verified', async () => {
    mockFetchSequence([
      { status: 200, body: { status: 'pending', message: 'sent', devCode: '123456', domain: 'example.com' } },
      SUPERSEDED,
    ]);

    renderCard();
    await startVerification();

    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/i }));

    await waitFor(() =>
      expect(
        screen.getByText(ORG_VERIFICATION_LABELS.DOMAIN_CONFIRM_SUPERSEDED),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(SUPERSEDED.body.error)).not.toBeInTheDocument();
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
  });

  it('returns the card to the start step so "again" is actionable', async () => {
    mockFetchSequence([
      { status: 200, body: { status: 'pending', message: 'sent', devCode: '123456', domain: 'example.com' } },
      SUPERSEDED,
    ]);

    renderCard();
    await startVerification();
    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Send Verification Email/i })).toBeInTheDocument(),
    );
    // The dead code is gone with it — nothing left to resubmit.
    expect(screen.queryByPlaceholderText(/6-digit code/i)).not.toBeInTheDocument();
  });

  it('explains a superseded START and does not advance to the code step', async () => {
    mockFetchSequence([SUPERSEDED]);

    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Send Verification Email/i }));

    await waitFor(() =>
      expect(
        screen.getByText(ORG_VERIFICATION_LABELS.DOMAIN_START_SUPERSEDED),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByPlaceholderText(/6-digit code/i)).not.toBeInTheDocument();
  });

  it('still surfaces the server message for an ordinary failure', async () => {
    // The superseded branch must be narrow: a plain 400 keeps its own wording.
    mockFetchSequence([
      { status: 400, body: { error: 'Organization must have a domain set before verification' } },
    ]);

    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Send Verification Email/i }));

    await waitFor(() =>
      expect(
        screen.getByText('Organization must have a domain set before verification'),
      ).toBeInTheDocument(),
    );
  });
});
