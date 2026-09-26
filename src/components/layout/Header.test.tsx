/**
 * Header — top-nav avatar.
 *
 * D2 (PR #3033 independent review, pass 2): UAT-14 uploads write
 * `profiles.avatar_storage_path`, not `avatar_url`, so the own-avatar in the
 * top nav must resolve the storage path through the signed-URL hook. It is the
 * user's own media, so signing succeeds for them; a denial degrades to initials.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const createSignedUrl = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { storage: { from: () => ({ createSignedUrl }) } } }));

vi.mock('./NotificationBell', () => ({ NotificationBell: () => null }));

import { Header } from './Header';

const STORAGE_PATH = 'users/profile_public_1/avatar/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';

function renderHeader(profile: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <Header user={{ email: 'ada@example.test' }} profile={profile} onSignOut={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('Header avatar', () => {
  beforeEach(() => { createSignedUrl.mockReset(); });

  it('signs the storage path for an avatar uploaded through the UAT-14 path', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/avatar' }, error: null });
    renderHeader({ full_name: 'Ada Lovelace', avatar_url: null, avatar_storage_path: STORAGE_PATH });
    await waitFor(() => expect(createSignedUrl).toHaveBeenCalledWith(STORAGE_PATH, 30));
  });

  it('falls back to initials when signing is denied, without rendering a broken image', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'denied' } });
    renderHeader({ full_name: 'Ada Lovelace', avatar_url: null, avatar_storage_path: STORAGE_PATH });
    await waitFor(() => expect(createSignedUrl).toHaveBeenCalled());
    expect(screen.queryByRole('img', { name: 'Ada Lovelace profile photo' })).not.toBeInTheDocument();
    expect(await screen.findByText('AL')).toBeInTheDocument();
  });

  it('never signs anything for a legacy avatar_url row', async () => {
    renderHeader({ full_name: 'Ada Lovelace', avatar_url: 'https://cdn.example/legacy.png', avatar_storage_path: null });
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});
