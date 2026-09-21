import { PROFILE_MEDIA_LABELS } from './copy';
import { supabase } from './supabase';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * A failure this module raised deliberately, whose message is already
 * user-facing copy from `PROFILE_MEDIA_LABELS`. Anything else that escapes an
 * upload (a Storage/PostgREST rejection, most often an RLS denial on an AAL1
 * session) is NOT safe to show: callers map it to the generic failure label.
 */
export class ProfileMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileMediaError';
  }
}

// Accepted input formats. Every accepted input is re-encoded to PNG, so a
// per-format output extension would be dead weight — the only extension any
// caller ever sees is `.png` (enforced by the 0481 CHECK constraints).
const FORMATS = {
  'image/png': { matches: (b: Uint8Array) => b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
  'image/jpeg': { matches: (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { matches: (b: Uint8Array) => b.length >= 12 && new TextDecoder().decode(b.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(b.slice(8, 12)) === 'WEBP' },
} as const;

export async function validateProfileImage(file: File): Promise<{ blob: Blob; contentType: 'image/png' }> {
  if (file.size > MAX_IMAGE_BYTES) throw new ProfileMediaError(PROFILE_MEDIA_LABELS.TOO_LARGE);
  const format = FORMATS[file.type as keyof typeof FORMATS];
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!format || !format.matches(header)) throw new ProfileMediaError(PROFILE_MEDIA_LABELS.TYPE_MISMATCH);
  if (typeof createImageBitmap !== 'function') throw new ProfileMediaError(PROFILE_MEDIA_LABELS.UNSUPPORTED_BROWSER);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new ProfileMediaError(PROFILE_MEDIA_LABELS.DECODE_FAILED); }
  if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 16_000_000) {
    bitmap.close();
    throw new ProfileMediaError(PROFILE_MEDIA_LABELS.DIMENSIONS_INVALID);
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new ProfileMediaError(PROFILE_MEDIA_LABELS.SANITIZE_FAILED);
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new ProfileMediaError(PROFILE_MEDIA_LABELS.SANITIZED_TOO_LARGE);
    return { blob, contentType: 'image/png' };
  } finally { bitmap.close(); }
}

export function profileMediaPath(
  scope: 'users' | 'organizations',
  scopeId: string,
  kind: 'avatar' | 'banner' | 'logo',
  objectId = crypto.randomUUID(),
) {
  return `${scope}/${scopeId}/${kind}/${objectId}.png`;
}

/**
 * Object path inside the PUBLIC mirror bucket.
 *
 * The first folder must be the organization's internal id: the `org-logos`
 * INSERT/UPDATE/DELETE policies (migration 0108) compare
 * `(storage.foldername(name))[1]` against `org_members.org_id::text`, so a
 * `public_id`-keyed path would be denied. That id is already public on this
 * surface — `/issuer/<org uuid>` is the page the mirror exists to serve.
 *
 * Unlike main's fixed `<org>/logo.<ext>`, the object id makes each upload a new
 * object: a failed commit rolls back by deleting only what this upload created,
 * never the logo that is still current.
 */
export function publicMirrorObjectPath(
  ownerId: string,
  kind: 'banner' | 'logo',
  objectId = crypto.randomUUID(),
) {
  return `${ownerId}/${kind}-${objectId}.png`;
}

/**
 * Recover the mirror object path a stored public URL points at, so the previous
 * public copy can be cleaned up after a successful replacement. Returns
 * undefined for anything outside `ownerPrefix` in `bucket` — an unrecognised or
 * foreign URL simply means "nothing of ours to delete", never a delete attempt.
 */
export function publicMirrorPathFromUrl(
  url: string | null | undefined,
  bucket: string,
  ownerPrefix: string,
): string | undefined {
  if (!url) return undefined;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const at = url.indexOf(marker);
  if (at === -1) return undefined;
  const path = url.slice(at + marker.length).split(/[?#]/)[0];
  if (!path.startsWith(ownerPrefix) || path.includes('..')) return undefined;
  return decodeURIComponent(path);
}

/** Best-effort object removal. A cleanup failure never masks the real outcome. */
async function removeQuietly(
  bucket: { remove: (paths: string[]) => Promise<{ error: unknown }> },
  path: string,
  onCleanupWarning?: () => void,
) {
  try {
    const { error } = await bucket.remove([path]);
    if (error) onCleanupWarning?.();
  } catch {
    onCleanupWarning?.();
  }
}

export interface PublicMirror {
  /** Public bucket the crawler-visible copy lives in (today: `org-logos`). */
  bucket: string;
  /** Path prefix this caller owns — nothing outside it is ever deleted. */
  ownerPrefix: string;
  /** Public object the row currently points at, if any. */
  previousPath?: string | null;
}

export async function replaceProfileMedia(options: {
  file: File;
  scope: 'users' | 'organizations';
  scopeId: string;
  kind: 'avatar' | 'banner' | 'logo';
  previousPath?: string | null;
  /**
   * Receives the private CAS path and, when a public mirror was requested, the
   * stable public URL of the mirrored object. Both belong in ONE row update so
   * in-app rendering and the OpenGraph/schema.org surface can never disagree.
   */
  commit: (path: string, publicUrl?: string) => Promise<boolean>;
  onCleanupWarning?: () => void;
  publicMirror?: PublicMirror;
}): Promise<string> {
  const validated = await validateProfileImage(options.file);
  const path = profileMediaPath(options.scope, options.scopeId, options.kind);
  const bucket = supabase.storage.from('profile-media');
  const { error } = await bucket.upload(path, validated.blob, { contentType: validated.contentType, upsert: false });
  if (error) throw error;

  // Public mirror, when requested, is part of the SAME atomic-ish unit: if it
  // cannot be written the upload fails as a whole, so there is no state where
  // the app shows a new logo that crawlers cannot fetch.
  let mirrorBucket: ReturnType<typeof supabase.storage.from> | undefined;
  let mirrorPath: string | undefined;
  let mirrorUrl: string | undefined;
  if (options.publicMirror) {
    mirrorBucket = supabase.storage.from(options.publicMirror.bucket);
    mirrorPath = publicMirrorObjectPath(
      options.publicMirror.ownerPrefix.replace(/\/$/, ''),
      options.kind === 'avatar' ? 'logo' : options.kind,
    );
    const { error: mirrorError } = await mirrorBucket.upload(mirrorPath, validated.blob, {
      contentType: validated.contentType, upsert: false,
    });
    if (mirrorError) {
      await removeQuietly(bucket, path, options.onCleanupWarning);
      throw mirrorError;
    }
    mirrorUrl = mirrorBucket.getPublicUrl(mirrorPath).data.publicUrl;
  }

  try {
    if (!await options.commit(path, mirrorUrl)) throw new ProfileMediaError(PROFILE_MEDIA_LABELS.METADATA_UPDATE_FAILED);
  } catch (error) {
    await removeQuietly(bucket, path, options.onCleanupWarning);
    if (mirrorBucket && mirrorPath) await removeQuietly(mirrorBucket, mirrorPath, options.onCleanupWarning);
    throw error;
  }

  const ownedPrefix = `${options.scope}/${options.scopeId}/${options.kind}/`;
  if (options.previousPath?.startsWith(ownedPrefix) && options.previousPath !== path) {
    await removeQuietly(bucket, options.previousPath, options.onCleanupWarning);
  }
  const previousMirror = options.publicMirror?.previousPath;
  if (mirrorBucket && previousMirror
    && previousMirror.startsWith(options.publicMirror!.ownerPrefix) && previousMirror !== mirrorPath) {
    await removeQuietly(mirrorBucket, previousMirror, options.onCleanupWarning);
  }
  return path;
}
