/* eslint-disable arkova/no-unscoped-service-test -- Storage object ownership is encoded in and asserted through the exact generated path; no table query exists here. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upload = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { storage: { from: () => ({ upload, remove }) } } }));

import { replaceProfileMedia, validateProfileImage } from './profileMedia';

const close = vi.fn();
vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 100, height: 100, close }));
vi.stubGlobal('OffscreenCanvas', class {
  getContext() { return { drawImage: vi.fn() }; }
  async convertToBlob() { return new Blob([new Uint8Array([1])], { type: 'image/png' }); }
});

function file(bytes: number[], type: string, name = 'image.bin') {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('validateProfileImage', () => {
  beforeEach(() => { upload.mockReset().mockResolvedValue({ error: null }); remove.mockReset().mockResolvedValue({ error: null }); });
  it.each([
    [file([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png', 'a.png'), 'png'],
    [file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg'), 'jpg'],
    [file([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 'image/webp', 'a.webp'), 'webp'],
  ])('accepts a declared image only when its bytes match', async (input, _extension) => {
    await expect(validateProfileImage(input)).resolves.toMatchObject({ extension: 'png', contentType: 'image/png' });
  });

  it.each([
    file(Array.from(new TextEncoder().encode('<svg onload=alert(1)>')), 'image/svg+xml', 'x.svg'),
    file(Array.from(new TextEncoder().encode('<script>')), 'image/png', 'x.png'),
    file([0xff, 0xd8, 0xff], 'image/png', 'x.png'),
  ])('rejects SVG, polyglot text and MIME/signature mismatch', async (input) => {
    await expect(validateProfileImage(input)).rejects.toThrow(/PNG, JPG, or WebP/i);
  });

  it('rejects an oversized image before reading it', async () => {
    const input = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' });
    await expect(validateProfileImage(input)).rejects.toThrow(/2 MB/i);
  });

  it('rejects a header-valid file when the browser decoder rejects truncated/polyglot bytes', async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('decode failed'));
    await expect(validateProfileImage(file([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x3c, 0x73, 0x63, 0x72], 'image/png'))).rejects.toThrow(/decodable/i);
  });

  it('removes only the newly uploaded object when the metadata commit fails', async () => {
    const input = file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg');
    const commit = vi.fn().mockResolvedValue(false);
    await expect(replaceProfileMedia({ file: input, scope: 'users', scopeId: '11111111-1111-4111-8111-111111111111', kind: 'avatar', previousPath: 'users/old', commit })).rejects.toThrow(/metadata/i);
    const uploadedPath = upload.mock.calls[0][0] as string;
    expect(remove).toHaveBeenCalledWith([uploadedPath]);
    expect(remove).not.toHaveBeenCalledWith(['users/old']);
  });

  it('preserves the metadata failure when cleanup also rejects', async () => {
    remove.mockRejectedValueOnce(new Error('cleanup unavailable'));
    const input = file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg');
    await expect(replaceProfileMedia({
      file: input,
      scope: 'users',
      scopeId: '11111111-1111-4111-8111-111111111111',
      kind: 'avatar',
      commit: vi.fn().mockResolvedValue(false),
    })).rejects.toThrow('Image metadata update failed.');
  });

  it('deletes the prior object only after a successful metadata commit', async () => {
    const input = file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg');
    const commit = vi.fn().mockResolvedValue(true);
    const previousPath = 'users/11111111-1111-4111-8111-111111111111/avatar/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';
    await replaceProfileMedia({ file: input, scope: 'users', scopeId: '11111111-1111-4111-8111-111111111111', kind: 'avatar', previousPath, commit });
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    expect(remove).toHaveBeenCalledWith([previousPath]);
  });
});
