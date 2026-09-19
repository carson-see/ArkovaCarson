import { PROFILE_MEDIA_LABELS } from './copy';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const FORMATS = {
  'image/png': { extension: 'png', matches: (b: Uint8Array) => b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
  'image/jpeg': { extension: 'jpg', matches: (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { extension: 'webp', matches: (b: Uint8Array) => b.length >= 12 && new TextDecoder().decode(b.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(b.slice(8, 12)) === 'WEBP' },
} as const;

export async function validateProfileImage(file: File): Promise<{ blob: Blob; extension: 'png'; contentType: 'image/png' }> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error(PROFILE_MEDIA_LABELS.TOO_LARGE);
  const format = FORMATS[file.type as keyof typeof FORMATS];
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!format || !format.matches(header)) throw new Error(PROFILE_MEDIA_LABELS.TYPE_MISMATCH);
  if (typeof createImageBitmap !== 'function') throw new Error(PROFILE_MEDIA_LABELS.UNSUPPORTED_BROWSER);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error(PROFILE_MEDIA_LABELS.DECODE_FAILED); }
  if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 16_000_000) {
    bitmap.close();
    throw new Error(PROFILE_MEDIA_LABELS.DIMENSIONS_INVALID);
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error(PROFILE_MEDIA_LABELS.SANITIZE_FAILED);
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error(PROFILE_MEDIA_LABELS.SANITIZED_TOO_LARGE);
    return { blob, extension: 'png', contentType: 'image/png' };
  } finally { bitmap.close(); }
}

export function profileMediaPath(
  scope: 'users' | 'organizations',
  scopeId: string,
  kind: 'avatar' | 'banner' | 'logo',
  extension: 'png' | 'jpg' | 'webp',
  objectId = crypto.randomUUID(),
) {
  return `${scope}/${scopeId}/${kind}/${objectId}.${extension}`;
}

export async function replaceProfileMedia(options: {
  file: File;
  scope: 'users' | 'organizations';
  scopeId: string;
  kind: 'avatar' | 'banner' | 'logo';
  previousPath?: string | null;
  commit: (path: string) => Promise<boolean>;
}): Promise<string> {
  const validated = await validateProfileImage(options.file);
  const path = profileMediaPath(options.scope, options.scopeId, options.kind, validated.extension);
  const bucket = supabase.storage.from('profile-media');
  const { error } = await bucket.upload(path, validated.blob, { contentType: validated.contentType, upsert: false });
  if (error) throw error;
  try {
    if (!await options.commit(path)) throw new Error(PROFILE_MEDIA_LABELS.METADATA_UPDATE_FAILED);
  } catch (error) {
    await bucket.remove([path]).catch(() => undefined);
    throw error;
  }
  const ownedPrefix = `${options.scope}/${options.scopeId}/${options.kind}/`;
  if (options.previousPath?.startsWith(ownedPrefix) && options.previousPath !== path) {
    void bucket.remove([options.previousPath]).catch(() => undefined);
  }
  return path;
}
import { supabase } from './supabase';
