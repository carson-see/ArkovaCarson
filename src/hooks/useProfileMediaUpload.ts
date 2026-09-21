/**
 * Shared profile/brand media upload handler.
 *
 * One implementation for both upload surfaces — SettingsPage (user avatar and
 * banner) and OrgProfilePage (organization logo and banner). Before this hook
 * the two handlers had drifted: the org one skipped the file-input reset on an
 * early return, fired two success toasts, and disabled its two inputs on
 * different conditions. Everything a caller still varies is a parameter.
 *
 * @see PR #3033 independent review, pass 4 (Simplify)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PROFILE_MEDIA_LABELS } from '@/lib/copy';
import { ProfileMediaError, replaceProfileMedia, type PublicMirror } from '@/lib/profileMedia';

export type ProfileMediaKind = 'avatar' | 'banner' | 'logo';

export interface UseProfileMediaUploadOptions {
  scope: 'users' | 'organizations';
  /** Public identifier that forms the storage prefix (`profiles/organizations.public_id`). */
  scopeId?: string | null;
  /** Row identity; a change mid-flight discards the outcome instead of toasting into a new context. */
  ownerId?: string | null;
  /** Object the row points at today — the compare-and-set expectation and the cleanup target. */
  previousPathFor: (kind: ProfileMediaKind) => string | null;
  /** Persists the new pointer(s). Resolves false when the write was rejected or lost a race. */
  commit: (kind: ProfileMediaKind, path: string, previousPath: string | null, publicUrl?: string) => Promise<boolean>;
  successMessage: (kind: ProfileMediaKind) => string;
  /** Public mirror for kinds that must stay crawler-addressable (org logo). */
  publicMirrorFor?: (kind: ProfileMediaKind) => PublicMirror | undefined;
  /** A row update owned by the caller is in flight — inputs stay disabled. */
  externallyBusy?: boolean;
  /**
   * Whether this session may write media at all. The storage policies require
   * an AAL2 (`private.is_human_mfa_verified()`) session, so at AAL1 the inputs
   * are disabled up front rather than letting the write fail with an RLS
   * rejection the user cannot act on. Defaults to true.
   */
  canUpload?: boolean;
}

export interface UseProfileMediaUploadResult {
  /** The kind currently uploading, or null. */
  uploading: ProfileMediaKind | null;
  /** Single disabled condition for every input on the surface. */
  busy: boolean;
  /** Uploading is unavailable for this session (AAL1) — show the MFA notice. */
  blocked: boolean;
  onInputChange: (kind: ProfileMediaKind) => (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
}

export function useProfileMediaUpload(options: UseProfileMediaUploadOptions): UseProfileMediaUploadResult {
  const [uploading, setUploading] = useState<ProfileMediaKind | null>(null);
  // Identity at the time a late result comes back. Written in an effect, not
  // during render (react-hooks/refs).
  const ownerRef = useRef(options.ownerId);
  useEffect(() => { ownerRef.current = options.ownerId; }, [options.ownerId]);

  const { scope, scopeId, ownerId, canUpload, commit, successMessage, publicMirrorFor, previousPathFor } = options;

  const onInputChange = useCallback((kind: ProfileMediaKind) =>
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      // Captured synchronously: `event.target` outlives the handler, the
      // element's own reference does not survive React's event cleanup.
      const input = event.target;
      try {
        const file = input.files?.[0];
        if (!file || !scopeId || !ownerId || canUpload === false) return;
        const requestOwner = ownerId;
        setUploading(kind);
        const previousPath = previousPathFor(kind);
        try {
          await replaceProfileMedia({
            file,
            scope,
            scopeId,
            kind,
            previousPath,
            commit: (path, publicUrl) => commit(kind, path, previousPath, publicUrl),
            onCleanupWarning: () => toast.warning(PROFILE_MEDIA_LABELS.CLEANUP_WARNING),
            publicMirror: publicMirrorFor?.(kind),
          });
          if (ownerRef.current === requestOwner) toast.success(successMessage(kind));
        } catch (uploadError) {
          // Only this module's own errors carry copy.ts text. A Storage /
          // PostgREST rejection (an RLS denial, most often) is neither
          // actionable nor allowed in user-visible copy (§1.3), so it is
          // logged and reported generically. No PII or token is in the value.
          if (!(uploadError instanceof ProfileMediaError)) console.error('[profile-media] upload failed', uploadError);
          if (ownerRef.current === requestOwner) {
            toast.error(uploadError instanceof ProfileMediaError ? uploadError.message : PROFILE_MEDIA_LABELS.UPLOAD_FAILED);
          }
        } finally {
          if (ownerRef.current === requestOwner) setUploading(null);
        }
      } finally {
        // Always: re-selecting the same file must fire onChange again, including
        // after an early return.
        input.value = '';
      }
    }, [scope, scopeId, ownerId, canUpload, commit, successMessage, publicMirrorFor, previousPathFor]);

  const blocked = canUpload === false;
  return { uploading, blocked, busy: blocked || uploading !== null || !!options.externallyBusy, onInputChange };
}
