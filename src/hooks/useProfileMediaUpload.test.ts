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
vi.mock('@/lib/profileMedia', () => ({ replaceProfileMedia }));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError, warning: toastWarning } }));

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
});
