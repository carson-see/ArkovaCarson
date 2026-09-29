/**
 * useProfileMediaUpload — the one upload path shared by SettingsPage (user
 * avatar/banner) and OrgProfilePage (org logo/banner).
 *
 * Independent review of PR #3033, pass 4: the two hand-written handlers had
 * drifted apart — the org one did not reset its file input on an early return,
 * fired TWO success toasts (its own plus useOrganization's generic one), and
 * disabled the logo and banner inputs on different conditions. The hook owns
 * all three.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replaceProfileMedia = vi.hoisted(() => vi.fn());
vi.mock('@/lib/profileMedia', async () => {
  const actual = await vi.importActual<typeof import('@/lib/profileMedia')>('@/lib/profileMedia');
  return { ...actual, replaceProfileMedia };
});

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError, warning: toastWarning } }));

import { PROFILE_MEDIA_LABELS } from '@/lib/copy';
import { ProfileMediaError } from '@/lib/profileMedia';
import { useProfileMediaUpload } from './useProfileMediaUpload';

function fileInputEvent(file?: File) {
  const input = document.createElement('input');
  input.type = 'file';
  Object.defineProperty(input, 'files', { value: file ? [file] : [], configurable: true });
  input.value = '';
  // jsdom forbids assigning a non-empty value to a file input; the handler only
  // ever writes '' back, so a plain spy records that it did.
  const reset = vi.fn();
  Object.defineProperty(input, 'value', { get: () => '', set: reset, configurable: true });
  return { event: { target: input } as unknown as React.ChangeEvent<HTMLInputElement>, reset };
}

const png = () => new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });

describe('useProfileMediaUpload', () => {
  beforeEach(() => {
    replaceProfileMedia.mockReset().mockResolvedValue('organizations/pub_acme/logo/x.png');
    toastSuccess.mockReset(); toastError.mockReset(); toastWarning.mockReset();
  });

  function setup(overrides: Record<string, unknown> = {}) {
    return renderHook(() => useProfileMediaUpload({
      scope: 'organizations',
      scopeId: 'pub_acme',
      ownerId: 'org-1',
      previousPathFor: () => null,
      commit: vi.fn().mockResolvedValue(true),
      successMessage: () => 'Logo updated successfully.',
      ...overrides,
    }));
  }

  it('resets the file input even when the upload never starts', async () => {
    const { result } = setup({ scopeId: null });
    const { event, reset } = fileInputEvent(png());
    await act(async () => { await result.current.onInputChange('logo')(event); });
    expect(replaceProfileMedia).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledWith('');
  });

  it('resets the file input after a completed upload', async () => {
    const { result } = setup();
    const { event, reset } = fileInputEvent(png());
    await act(async () => { await result.current.onInputChange('logo')(event); });
    expect(replaceProfileMedia).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith('');
  });

  it('fires exactly one success toast per successful upload', async () => {
    const { result } = setup();
    const { event } = fileInputEvent(png());
    await act(async () => { await result.current.onInputChange('logo')(event); });
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith('Logo updated successfully.');
  });

  it('exposes one busy flag so every input is disabled on the same condition', async () => {
    let release: (value: string) => void = () => {};
    replaceProfileMedia.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const { result } = setup();
    const { event } = fileInputEvent(png());
    let pending!: Promise<void>;
    act(() => { pending = result.current.onInputChange('logo')(event); });
    expect(result.current.uploading).toBe('logo');
    expect(result.current.busy).toBe(true);
    await act(async () => { release('organizations/pub_acme/logo/x.png'); await pending; });
    expect(result.current.busy).toBe(false);
  });

  it('treats an externally supplied busy flag as busy too', () => {
    const { result } = setup({ externallyBusy: true });
    expect(result.current.busy).toBe(true);
  });

  it('discards the outcome when the owner changed while the upload was in flight', async () => {
    let release: (value: string) => void = () => {};
    replaceProfileMedia.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const { result, rerender } = renderHook(
      ({ ownerId }: { ownerId: string }) => useProfileMediaUpload({
        scope: 'organizations', scopeId: 'pub_acme', ownerId,
        previousPathFor: () => null,
        commit: vi.fn().mockResolvedValue(true),
        successMessage: () => 'Logo updated successfully.',
      }),
      { initialProps: { ownerId: 'org-1' } },
    );
    const { event } = fileInputEvent(png());
    let pending!: Promise<void>;
    act(() => { pending = result.current.onInputChange('logo')(event); });
    rerender({ ownerId: 'org-2' });
    await act(async () => { release('organizations/pub_acme/logo/x.png'); await pending; });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('refuses the pointer commit when the owner changes after object upload', async () => {
    let release!: () => void;
    const uploaded = new Promise<void>((resolve) => { release = resolve; });
    const commit = vi.fn().mockResolvedValue(true);
    replaceProfileMedia.mockImplementationOnce(async (opts: { commit: (path: string) => Promise<boolean> }) => {
      await uploaded;
      const committed = await opts.commit('organizations/pub_acme/logo/stale.png');
      if (!committed) throw new ProfileMediaError(PROFILE_MEDIA_LABELS.METADATA_UPDATE_FAILED);
      return 'organizations/pub_acme/logo/stale.png';
    });
    const { result, rerender } = renderHook(
      ({ ownerId }: { ownerId: string }) => useProfileMediaUpload({
        scope: 'organizations', scopeId: 'pub_acme', ownerId,
        previousPathFor: () => null, commit,
        successMessage: () => 'Logo updated successfully.',
      }),
      { initialProps: { ownerId: 'org-1' } },
    );
    const { event } = fileInputEvent(png());
    let pending!: Promise<void>;
    act(() => { pending = result.current.onInputChange('logo')(event); });
    rerender({ ownerId: 'org-2' });
    await act(async () => { release(); await pending; });
    expect(commit).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('lets the new owner upload while the old owner request settles', async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    replaceProfileMedia
      .mockImplementationOnce(async () => { await oldGate; return 'organizations/pub_acme/logo/old.png'; })
      .mockResolvedValueOnce('organizations/pub_acme/logo/new.png');
    const { result, rerender } = renderHook(
      ({ ownerId }: { ownerId: string }) => useProfileMediaUpload({
        scope: 'organizations', scopeId: 'pub_acme', ownerId,
        previousPathFor: () => null, commit: vi.fn().mockResolvedValue(true),
        successMessage: () => 'Logo updated successfully.',
      }),
      { initialProps: { ownerId: 'org-1' } },
    );
    let oldPending!: Promise<void>;
    act(() => { oldPending = result.current.onInputChange('logo')(fileInputEvent(png()).event); });
    rerender({ ownerId: 'org-2' });
    expect(result.current.busy).toBe(false);
    await act(async () => { await result.current.onInputChange('logo')(fileInputEvent(png()).event); });
    expect(replaceProfileMedia).toHaveBeenCalledTimes(2);
    await act(async () => { releaseOld(); await oldPending; });
    expect(result.current.busy).toBe(false);
  });

  it('rejects an old request after an A to B to A owner cycle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const commit = vi.fn().mockResolvedValue(true);
    replaceProfileMedia.mockImplementationOnce(async (opts: { commit: (path: string) => Promise<boolean> }) => {
      await gate;
      await opts.commit('organizations/pub_acme/logo/stale.png');
      return 'organizations/pub_acme/logo/stale.png';
    });
    const { result, rerender } = renderHook(
      ({ ownerId }: { ownerId: string }) => useProfileMediaUpload({
        scope: 'organizations', scopeId: 'pub_acme', ownerId,
        previousPathFor: () => null, commit,
        successMessage: () => 'Logo updated successfully.',
      }),
      { initialProps: { ownerId: 'org-a' } },
    );
    let pending!: Promise<void>;
    act(() => { pending = result.current.onInputChange('logo')(fileInputEvent(png()).event); });
    rerender({ ownerId: 'org-b' });
    rerender({ ownerId: 'org-a' });
    await act(async () => { release(); await pending; });
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects the pointer commit after unmount', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const commit = vi.fn().mockResolvedValue(true);
    replaceProfileMedia.mockImplementationOnce(async (opts: { commit: (path: string) => Promise<boolean> }) => {
      await gate;
      await opts.commit('organizations/pub_acme/logo/unmounted.png');
      return 'organizations/pub_acme/logo/unmounted.png';
    });
    const { result, unmount } = setup({ commit });
    let pending!: Promise<void>;
    act(() => { pending = result.current.onInputChange('logo')(fileInputEvent(png()).event); });
    unmount();
    await act(async () => { release(); await pending; });
    expect(commit).not.toHaveBeenCalled();
  });

  it('suppresses a stale cleanup warning after the owner changes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    replaceProfileMedia.mockImplementationOnce(async (opts: { onCleanupWarning?: () => void }) => {
      await gate;
      opts.onCleanupWarning?.();
      return 'organizations/pub_acme/logo/stale.png';
    });
    const { result, rerender } = renderHook(
      ({ ownerId }: { ownerId: string }) => useProfileMediaUpload({
        scope: 'organizations', scopeId: 'pub_acme', ownerId,
        previousPathFor: () => null, commit: vi.fn().mockResolvedValue(true),
        successMessage: () => 'Logo updated successfully.',
      }),
      { initialProps: { ownerId: 'org-1' } },
    );
    let pending!: Promise<void>;
    act(() => { pending = result.current.onInputChange('logo')(fileInputEvent(png()).event); });
    rerender({ ownerId: 'org-2' });
    await act(async () => { release(); await pending; });
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('retains a cleanup warning for the current owner', async () => {
    replaceProfileMedia.mockImplementationOnce(async (opts: { onCleanupWarning?: () => void }) => {
      opts.onCleanupWarning?.();
      return 'organizations/pub_acme/logo/current.png';
    });
    const { result } = setup();
    await act(async () => { await result.current.onInputChange('logo')(fileInputEvent(png()).event); });
    expect(toastWarning).toHaveBeenCalledWith(PROFILE_MEDIA_LABELS.CLEANUP_WARNING);
  });

  // D1: the org logo goes to the private CAS object AND a public mirror, and
  // the resulting public URL reaches the commit so it can be written alongside
  // the storage path in one row update.
  it('forwards the public mirror and hands its URL to the commit', async () => {
    const commit = vi.fn().mockResolvedValue(true);
    const mirror = { bucket: 'org-logos', ownerPrefix: 'org-1/', previousPath: null };
    replaceProfileMedia.mockImplementationOnce(async (opts: { commit: (p: string, u?: string) => Promise<boolean> }) => {
      await opts.commit('organizations/pub_acme/logo/x.png', 'https://cdn.example/public/org-1/logo-x.png');
      return 'organizations/pub_acme/logo/x.png';
    });
    const { result } = setup({ commit, publicMirrorFor: (kind: string) => kind === 'logo' ? mirror : undefined });
    const { event } = fileInputEvent(png());
    await act(async () => { await result.current.onInputChange('logo')(event); });
    expect(replaceProfileMedia).toHaveBeenCalledWith(expect.objectContaining({ publicMirror: mirror }));
    expect(commit).toHaveBeenCalledWith('logo', 'organizations/pub_acme/logo/x.png', null, 'https://cdn.example/public/org-1/logo-x.png');
  });

  // D3 — a Supabase/PostgREST failure (an RLS denial at AAL1 is the common one)
  // must never reach a toast verbatim: it is not actionable and §1.3 requires
  // all user-visible text to come from copy.ts.
  describe('AAL1 / raw-error handling', () => {
    it('renders the generic failure label for a raw PostgREST error and logs the original', async () => {
      const raw = Object.assign(new Error('new row violates row-level security policy for table "objects"'), {
        code: '42501', details: null, hint: null,
      });
      replaceProfileMedia.mockRejectedValueOnce(raw);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = setup();
      const { event } = fileInputEvent(png());
      await act(async () => { await result.current.onInputChange('logo')(event); });
      expect(toastError).toHaveBeenCalledWith(PROFILE_MEDIA_LABELS.UPLOAD_FAILED);
      expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining('row-level security'));
      expect(consoleError).toHaveBeenCalledWith(expect.any(String), raw);
      consoleError.mockRestore();
    });

    it('still surfaces the module\'s own typed errors verbatim', async () => {
      replaceProfileMedia.mockRejectedValueOnce(new ProfileMediaError(PROFILE_MEDIA_LABELS.TOO_LARGE));
      const { result } = setup();
      const { event } = fileInputEvent(png());
      await act(async () => { await result.current.onInputChange('logo')(event); });
      expect(toastError).toHaveBeenCalledWith(PROFILE_MEDIA_LABELS.TOO_LARGE);
    });

    it('blocks uploads and reports the MFA requirement when the session is not AAL2', async () => {
      const { result } = setup({ canUpload: false });
      expect(result.current.blocked).toBe(true);
      expect(result.current.busy).toBe(true);
      const { event } = fileInputEvent(png());
      await act(async () => { await result.current.onInputChange('logo')(event); });
      expect(replaceProfileMedia).not.toHaveBeenCalled();
    });
  });
});
