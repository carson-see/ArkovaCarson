/* eslint-disable arkova/no-unscoped-service-test -- Storage object ownership is encoded in and asserted through the exact generated path; no table query exists here. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upload = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const publicUpload = vi.hoisted(() => vi.fn());
const publicRemove = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({
  supabase: {
    storage: {
      from: (bucket: string) => bucket === 'profile-media'
        ? { upload, remove }
        : {
            upload: publicUpload,
            remove: publicRemove,
            getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example/storage/v1/object/public/${bucket}/${path}` } }),
          },
    },
  },
}));

import { publicMirrorObjectPath, publicMirrorPathFromUrl, replaceProfileMedia, validateProfileImage } from './profileMedia';

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
  beforeEach(() => {
    upload.mockReset().mockResolvedValue({ error: null });
    remove.mockReset().mockResolvedValue({ error: null });
    publicUpload.mockReset().mockResolvedValue({ error: null });
    publicRemove.mockReset().mockResolvedValue({ error: null });
  });
  it.each([
    file([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png', 'a.png'),
    file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg'),
    file([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 'image/webp', 'a.webp'),
  ])('accepts a declared image only when its bytes match', async (input) => {
    await expect(validateProfileImage(input)).resolves.toMatchObject({ contentType: 'image/png' });
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
    const warning = vi.fn();
    const input = file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg');
    await expect(replaceProfileMedia({
      file: input,
      scope: 'users',
      scopeId: '11111111-1111-4111-8111-111111111111',
      kind: 'avatar',
      commit: vi.fn().mockResolvedValue(false),
      previousPath: 'users/11111111-1111-4111-8111-111111111111/avatar/old.png',
      onCleanupWarning: warning,
    })).rejects.toThrow('Image metadata update failed.');
    const uploadedPath = upload.mock.calls[0][0] as string;
    expect(remove).toHaveBeenCalledWith([uploadedPath]);
    expect(remove).not.toHaveBeenCalledWith(['users/11111111-1111-4111-8111-111111111111/avatar/old.png']);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('preserves the metadata failure and warns when new-object cleanup resolves with an error', async () => {
    remove.mockResolvedValueOnce({ error: new Error('cleanup denied') });
    const warning = vi.fn();
    const previousPath = 'users/11111111-1111-4111-8111-111111111111/avatar/old.png';
    await expect(replaceProfileMedia({
      file: file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg'),
      scope: 'users', scopeId: '11111111-1111-4111-8111-111111111111',
      kind: 'avatar', previousPath,
      commit: vi.fn().mockResolvedValue(false), onCleanupWarning: warning,
    })).rejects.toThrow('Image metadata update failed.');
    const uploadedPath = upload.mock.calls[0][0] as string;
    expect(remove).toHaveBeenCalledWith([uploadedPath]);
    expect(remove).not.toHaveBeenCalledWith([previousPath]);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('deletes the prior object only after a successful metadata commit', async () => {
    const input = file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg');
    const commit = vi.fn().mockResolvedValue(true);
    const previousPath = 'users/11111111-1111-4111-8111-111111111111/avatar/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';
    await replaceProfileMedia({ file: input, scope: 'users', scopeId: '11111111-1111-4111-8111-111111111111', kind: 'avatar', previousPath, commit });
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    expect(remove).toHaveBeenCalledWith([previousPath]);
  });

  it('surfaces a resolved old-object cleanup error without undoing the committed pointer', async () => {
    remove.mockResolvedValueOnce({ error: new Error('storage cleanup denied') });
    const warning = vi.fn();
    const commit = vi.fn().mockResolvedValue(true);
    const previousPath = 'users/11111111-1111-4111-8111-111111111111/avatar/old.png';
    await expect(replaceProfileMedia({
      file: file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg'),
      scope: 'users', scopeId: '11111111-1111-4111-8111-111111111111',
      kind: 'avatar', previousPath, commit, onCleanupWarning: warning,
    })).resolves.toMatch(/\.png$/);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([previousPath]);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('keeps one winner when two replacements race from the same old pointer', async () => {
    const previousPath = 'users/11111111-1111-4111-8111-111111111111/avatar/old.png';
    let currentPath = previousPath;
    const commit = vi.fn(async (nextPath: string) => {
      if (currentPath !== previousPath) return false;
      currentPath = nextPath;
      return true;
    });
    const input = file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg');
    const settled = await Promise.allSettled([
      replaceProfileMedia({ file: input, scope: 'users', scopeId: '11111111-1111-4111-8111-111111111111', kind: 'avatar', previousPath, commit }),
      replaceProfileMedia({ file: input, scope: 'users', scopeId: '11111111-1111-4111-8111-111111111111', kind: 'avatar', previousPath, commit }),
    ]);
    const winner = settled.find((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled');
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(currentPath).toBe(winner?.value);
    expect(remove).toHaveBeenCalledWith([previousPath]);
    const uploadedPaths = upload.mock.calls.map(call => call[0] as string);
    const loserPath = uploadedPaths.find(path => path !== winner?.value);
    expect(remove).toHaveBeenCalledWith([loserPath]);
    expect(remove).not.toHaveBeenCalledWith([winner?.value]);
  });
});

// ── D1: organization logo public mirror ──────────────────────────────────────
// Organizations have no visibility toggle, and a 30 s signed URL cannot serve
// an out-of-band crawler, so the org logo stays PUBLICLY addressable: every
// successful upload writes the private CAS object AND a public `org-logos`
// object, and commits `logo_url` + `logo_storage_path` in ONE update.
describe('organization logo public mirror', () => {
  const ORG_ID = '22222222-2222-4222-8222-222222222222';
  const PUBLIC_ID = 'pub_acme';
  const jpeg = () => file([0xff, 0xd8, 0xff, 0xe0], 'image/jpeg', 'a.jpg');

  beforeEach(() => {
    upload.mockReset().mockResolvedValue({ error: null });
    remove.mockReset().mockResolvedValue({ error: null });
    publicUpload.mockReset().mockResolvedValue({ error: null });
    publicRemove.mockReset().mockResolvedValue({ error: null });
  });

  function mirror(previousPublicPath: string | null = null) {
    return { bucket: 'org-logos' as const, ownerPrefix: `${ORG_ID}/`, previousPath: previousPublicPath };
  }

  it('derives the public object path from the org UUID folder the org-logos policy checks', () => {
    const path = publicMirrorObjectPath(ORG_ID, 'logo', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(path).toBe(`${ORG_ID}/logo-cccccccc-cccc-4ccc-8ccc-cccccccccccc.png`);
  });

  it('uploads both objects and commits the public URL together with the storage path', async () => {
    const commit = vi.fn().mockResolvedValue(true);
    const path = await replaceProfileMedia({
      file: jpeg(), scope: 'organizations', scopeId: PUBLIC_ID, kind: 'logo', commit,
      publicMirror: mirror(),
    });
    const publicPath = publicUpload.mock.calls[0][0] as string;
    expect(publicPath.startsWith(`${ORG_ID}/logo-`)).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(path, `https://cdn.example/storage/v1/object/public/org-logos/${publicPath}`);
  });

  it('removes the private object and fails the whole upload when the public copy fails', async () => {
    publicUpload.mockResolvedValueOnce({ error: new Error('public upload denied') });
    const commit = vi.fn();
    await expect(replaceProfileMedia({
      file: jpeg(), scope: 'organizations', scopeId: PUBLIC_ID, kind: 'logo', commit,
      publicMirror: mirror(),
    })).rejects.toThrow(/public upload denied/);
    expect(commit).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith([upload.mock.calls[0][0]]);
  });

  it('removes BOTH new objects when the commit fails', async () => {
    const commit = vi.fn().mockResolvedValue(false);
    await expect(replaceProfileMedia({
      file: jpeg(), scope: 'organizations', scopeId: PUBLIC_ID, kind: 'logo', commit,
      publicMirror: mirror(),
    })).rejects.toThrow(/metadata/i);
    expect(remove).toHaveBeenCalledWith([upload.mock.calls[0][0]]);
    expect(publicRemove).toHaveBeenCalledWith([publicUpload.mock.calls[0][0]]);
  });

  it('deletes the previous public object only after the commit, and only inside the org prefix', async () => {
    const previousPublic = `${ORG_ID}/logo-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
    const commit = vi.fn().mockResolvedValue(true);
    await replaceProfileMedia({
      file: jpeg(), scope: 'organizations', scopeId: PUBLIC_ID, kind: 'logo', commit,
      publicMirror: mirror(previousPublic),
    });
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(publicRemove.mock.invocationCallOrder[0]);
    expect(publicRemove).toHaveBeenCalledWith([previousPublic]);
  });

  it('never deletes a public object outside the org prefix', async () => {
    const commit = vi.fn().mockResolvedValue(true);
    await replaceProfileMedia({
      file: jpeg(), scope: 'organizations', scopeId: PUBLIC_ID, kind: 'logo', commit,
      publicMirror: mirror('33333333-3333-4333-8333-333333333333/logo-x.png'),
    });
    expect(publicRemove).not.toHaveBeenCalled();
  });

  it('keeps the committed pointer and warns when old public cleanup fails', async () => {
    const previousPublic = `${ORG_ID}/logo-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
    publicRemove.mockResolvedValueOnce({ error: new Error('cleanup denied') });
    const warning = vi.fn();
    const commit = vi.fn().mockResolvedValue(true);
    await expect(replaceProfileMedia({
      file: jpeg(), scope: 'organizations', scopeId: PUBLIC_ID, kind: 'logo', commit,
      publicMirror: mirror(previousPublic), onCleanupWarning: warning,
    })).resolves.toMatch(/\.png$/);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe('publicMirrorPathFromUrl', () => {
  const ORG_ID = '22222222-2222-4222-8222-222222222222';
  it.each([
    // Current mechanism, and main's pre-UAT-14 fixed-name objects.
    [`https://x.supabase.co/storage/v1/object/public/org-logos/${ORG_ID}/logo-abc.png`, `${ORG_ID}/logo-abc.png`],
    [`https://x.supabase.co/storage/v1/object/public/org-logos/${ORG_ID}/logo.png`, `${ORG_ID}/logo.png`],
    // Never hand back a path this caller does not own, or one from elsewhere.
    ['https://x.supabase.co/storage/v1/object/public/org-logos/99999999-9999-4999-8999-999999999999/logo.png', undefined],
    ['https://cdn.example/logos/other.png', undefined],
    [null, undefined],
    ['', undefined],
  ])('derives an owned mirror path from %s', (input, expected) => {
    expect(publicMirrorPathFromUrl(input, 'org-logos', `${ORG_ID}/`)).toBe(expected);
  });
});
