/**
 * SCRUM-5023 — expiry is visible on the card, and extendable from it.
 *
 * SCRUM-4515 established that the badge must not say "Active" on an expired
 * key, and the badge already handles that. What it still could not say is
 * "this key dies next Tuesday" — the state HakiChain spent a month in with no
 * way to know. Nor could an admin do anything about it: the only remedy was
 * creating a new key, i.e. distributing new credentials to a partner.
 *
 * These tests drive the SERVER-DERIVED `status` field rather than re-deriving
 * from `expires_at` in the component. One derivation, on the server
 * (`keyExpiryStatus.ts`); the client renders the answer. A second client-side
 * derivation is precisely how the dashboard and the auth middleware came to
 * disagree in the first place.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiKeySettings } from './ApiKeySettings';
import { API_KEY_LABELS } from '@/lib/copy';
import type { ApiKeyMasked, ApiKeyCreated } from '@/hooks/useApiKeys';

const baseKey: ApiKeyMasked = {
  id: 'key-1',
  key_prefix: 'ak_live_a172',
  name: 'HakiChain Production',
  scopes: ['verify'],
  rate_limit_tier: 'standard',
  is_active: true,
  created_at: '2026-06-01T00:00:00Z',
  expires_at: '2026-09-20T00:00:00Z',
  last_used_at: null,
  status: 'expiring_soon',
  days_until_expiry: 8,
};

function props(keys: ApiKeyMasked[], overrides: Record<string, unknown> = {}) {
  return {
    keys,
    onCreate: vi.fn().mockResolvedValue({} as ApiKeyCreated) as unknown as (
      name: string, scopes: string[], expiresInDays?: number,
    ) => Promise<ApiKeyCreated>,
    onRevoke: vi.fn().mockResolvedValue(undefined) as unknown as (keyId: string) => Promise<void>,
    onDelete: vi.fn().mockResolvedValue(undefined) as unknown as (keyId: string) => Promise<void>,
    onExtend: vi.fn().mockResolvedValue(undefined) as unknown as (
      keyId: string, expiresInDays: number | null, allowShorten?: boolean,
    ) => Promise<void>,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('expiry status badge', () => {
  it('warns with an amber expiring-soon badge and the days remaining', () => {
    render(<ApiKeySettings {...props([baseKey])} />);

    const badge = screen.getByText(new RegExp(API_KEY_LABELS.EXPIRING_SOON, 'i'));
    expect(badge).toBeInTheDocument();
    // Amber, not green: the whole point is that this reads as a warning at a
    // glance on a page where every other key is green.
    expect(badge.className).toMatch(/amber/);
    expect(badge.textContent).toMatch(/8/);
  });

  it('says "today" rather than "0 days" on the final day', () => {
    render(<ApiKeySettings {...props([{ ...baseKey, days_until_expiry: 0 }])} />);

    const badge = screen.getByText(new RegExp(API_KEY_LABELS.EXPIRING_SOON, 'i'));
    expect(badge.textContent).toMatch(/today/i);
    expect(badge.textContent).not.toMatch(/0 days/);
  });

  it('says "1 day", not "1 days"', () => {
    render(<ApiKeySettings {...props([{ ...baseKey, days_until_expiry: 1 }])} />);
    expect(screen.getByText(/1 day\b/)).toBeInTheDocument();
  });

  it('renders Expired from the server status even though is_active is true', () => {
    // The exact prod shape: is_active true, expiry long past. Reading
    // is_active alone is SCRUM-4515; reading `status` is the fix that holds.
    render(<ApiKeySettings {...props([
      { ...baseKey, status: 'expired', days_until_expiry: -73, expires_at: '2026-07-01T00:00:00Z' },
    ])} />);

    expect(screen.getByText(API_KEY_LABELS.EXPIRED)).toBeInTheDocument();
    expect(screen.queryByText(API_KEY_LABELS.ACTIVE)).not.toBeInTheDocument();
  });

  it('renders Revoked for a revoked key', () => {
    render(<ApiKeySettings {...props([{ ...baseKey, status: 'revoked', is_active: false }])} />);
    expect(screen.getByText(API_KEY_LABELS.REVOKED)).toBeInTheDocument();
  });

  it('renders Active for a key with plenty of life left', () => {
    render(<ApiKeySettings {...props([{ ...baseKey, status: 'active', days_until_expiry: 200 }])} />);
    expect(screen.getByText(API_KEY_LABELS.ACTIVE)).toBeInTheDocument();
  });

  it('falls back to local derivation when the worker predates the status field', () => {
    // A deployed frontend can talk to an older worker mid-rollout. Without the
    // fallback every key would render Active for the length of that window —
    // reintroducing SCRUM-4515 for exactly as long as the deploy takes.
    const legacy = { ...baseKey };
    delete (legacy as Partial<ApiKeyMasked>).status;
    delete (legacy as Partial<ApiKeyMasked>).days_until_expiry;

    render(<ApiKeySettings {...props([{ ...legacy, expires_at: '2026-07-01T00:00:00Z' }])} />);
    expect(screen.getByText(API_KEY_LABELS.EXPIRED)).toBeInTheDocument();
  });
});

describe('extend action', () => {
  it('offers Extend on an expiring key', () => {
    render(<ApiKeySettings {...props([baseKey])} />);
    expect(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY })).toBeInTheDocument();
  });

  it('offers Extend on an EXPIRED key — the remedy has to be reachable from the failure', () => {
    render(<ApiKeySettings {...props([{ ...baseKey, status: 'expired', days_until_expiry: -73 }])} />);
    expect(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY })).toBeInTheDocument();
  });

  it('does NOT offer Extend on a revoked key — revocation is terminal', () => {
    render(<ApiKeySettings {...props([{ ...baseKey, status: 'revoked', is_active: false }])} />);
    expect(screen.queryByRole('button', { name: API_KEY_LABELS.EXTEND_KEY })).not.toBeInTheDocument();
  });

  it('extends by the chosen number of days', async () => {
    const onExtend = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeySettings {...props([baseKey], { onExtend })} />);

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));
    fireEvent.click(await screen.findByRole('button', { name: API_KEY_LABELS.EXTEND_90_DAYS }));

    await waitFor(() => expect(onExtend).toHaveBeenCalledWith('key-1', 90, false));
  });

  it('removes the expiry entirely, but only after a confirmation', async () => {
    // Removing the expiry is the one option that makes a credential permanent.
    const onExtend = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeySettings {...props([baseKey], { onExtend })} />);

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));
    fireEvent.click(await screen.findByRole('button', { name: API_KEY_LABELS.EXTEND_REMOVE }));

    // Not applied yet — the confirmation is the step.
    expect(onExtend).not.toHaveBeenCalled();
    expect(screen.getByText(API_KEY_LABELS.EXTEND_CONFIRM_REMOVE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_CONFIRM_APPLY }));
    await waitFor(() => expect(onExtend).toHaveBeenCalledWith('key-1', null, true));
  });

  // ── An "Extend" button that shortens ──────────────────────────────────────
  //
  // Every preset REPLACES the expiry. On a key with eleven months left, "30
  // days" cuts ten of them; on a key with no expiry, any preset invents one.
  // Both are one click from a button labelled "Extend", and both break a live
  // partner integration. The server 409s them; the dialog asks first.

  it('states the CURRENT expiry, so the presets can be read as longer or shorter', () => {
    render(<ApiKeySettings {...props([baseKey])} />);
    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));

    expect(screen.getByTestId('extend-current-expiry').textContent)
      .toMatch(/Currently expires/);
  });

  it('says so when the key has no expiry at all', () => {
    render(<ApiKeySettings {...props([
      { ...baseKey, status: 'active', expires_at: null, days_until_expiry: null },
    ])} />);
    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));

    expect(screen.getByTestId('extend-current-expiry'))
      .toHaveTextContent(API_KEY_LABELS.EXTEND_CURRENT_NONE);
  });

  it('asks before SHORTENING a healthy key, and does not call through until confirmed', async () => {
    const longLived: ApiKeyMasked = {
      ...baseKey,
      status: 'active',
      expires_at: new Date(Date.now() + 330 * 24 * 60 * 60 * 1000).toISOString(),
      days_until_expiry: 330,
    };
    const onExtend = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeySettings {...props([longLived], { onExtend })} />);

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));
    fireEvent.click(await screen.findByRole('button', { name: API_KEY_LABELS.EXTEND_30_DAYS }));

    expect(onExtend).not.toHaveBeenCalled();
    expect(screen.getByText(/EARLIER than/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_CONFIRM_APPLY }));
    // allow_shorten is what stops the server 409ing the confirmed change.
    await waitFor(() => expect(onExtend).toHaveBeenCalledWith('key-1', 30, true));
  });

  it('lets the user back out of a shortening without changing anything', async () => {
    const longLived: ApiKeyMasked = {
      ...baseKey,
      status: 'active',
      expires_at: new Date(Date.now() + 330 * 24 * 60 * 60 * 1000).toISOString(),
      days_until_expiry: 330,
    };
    const onExtend = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeySettings {...props([longLived], { onExtend })} />);

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));
    fireEvent.click(await screen.findByRole('button', { name: API_KEY_LABELS.EXTEND_30_DAYS }));
    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_CONFIRM_CANCEL }));

    expect(onExtend).not.toHaveBeenCalled();
    // Back to the presets, dialog still open.
    expect(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_90_DAYS })).toBeInTheDocument();
  });

  it('asks before putting an expiry on a key that currently has none', async () => {
    const immortal: ApiKeyMasked = {
      ...baseKey, status: 'active', expires_at: null, days_until_expiry: null,
    };
    const onExtend = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeySettings {...props([immortal], { onExtend })} />);

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));
    fireEvent.click(await screen.findByRole('button', { name: API_KEY_LABELS.EXTEND_365_DAYS }));

    expect(onExtend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_CONFIRM_APPLY }));
    await waitFor(() => expect(onExtend).toHaveBeenCalledWith('key-1', 365, true));
  });

  it('does NOT ask when extending an already-EXPIRED key — every move forward helps', async () => {
    const onExtend = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeySettings {...props([
      { ...baseKey, status: 'expired', expires_at: '2026-07-01T00:00:00Z', days_until_expiry: -73 },
    ], { onExtend })} />);

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));
    fireEvent.click(await screen.findByRole('button', { name: API_KEY_LABELS.EXTEND_30_DAYS }));

    await waitFor(() => expect(onExtend).toHaveBeenCalledWith('key-1', 30, false));
  });

  it('surfaces a scrubbed failure and keeps the dialog open — the expiry did NOT change', async () => {
    const onExtend = vi.fn().mockRejectedValue(new Error('PGRST301: jwt expired for role authenticated'));
    render(<ApiKeySettings {...props([baseKey], { onExtend })} />);

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));
    fireEvent.click(await screen.findByRole('button', { name: API_KEY_LABELS.EXTEND_30_DAYS }));

    await waitFor(() => {
      expect(screen.getByText(API_KEY_LABELS.EXTEND_FAILED)).toBeInTheDocument();
    });
    // No server internals reach the user (mirrors the revoke/delete handling).
    expect(screen.queryByText(/PGRST301|jwt|authenticated/i)).not.toBeInTheDocument();
    // Dialog still open: closing would imply the extension took.
    expect(screen.getByText(API_KEY_LABELS.EXTEND_TITLE)).toBeInTheDocument();
  });

  it('closes cleanly on success', async () => {
    const onExtend = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeySettings {...props([baseKey], { onExtend })} />);

    fireEvent.click(screen.getByRole('button', { name: API_KEY_LABELS.EXTEND_KEY }));
    fireEvent.click(await screen.findByRole('button', { name: API_KEY_LABELS.EXTEND_365_DAYS }));

    await waitFor(() => expect(onExtend).toHaveBeenCalledWith('key-1', 365, false));
    await waitFor(() => {
      expect(screen.queryByText(API_KEY_LABELS.EXTEND_TITLE)).not.toBeInTheDocument();
    });
  });
});
