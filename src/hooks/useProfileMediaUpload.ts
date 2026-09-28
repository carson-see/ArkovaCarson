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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const ownerToken = useMemo(() => Symbol(`profile-media-owner:${options.ownerId ?? 'none'}`), [options.ownerId]);
  const [uploadState, setUploadState] = useState<{ kind: ProfileMediaKind; ownerToken: symbol } | null>(null);
  // Identity at the time a late result comes back. Written in an effect, not
  // during render (react-hooks/refs).
  const ownerRef = useRef<{ id: typeof options.ownerId; token: symbol } | null>({ id: options.ownerId, token: ownerToken });
  useEffect(() => {
    ownerRef.current = { id: options.ownerId, token: ownerToken };
    return () => { ownerRef.current = null; };
  }, [options.ownerId, ownerToken]);

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
        const requestOwnerToken = ownerToken;
        setUploadState({ kind, ownerToken: requestOwnerToken });
        const previousPath = previousPathFor(kind);
        try {
          await replaceProfileMedia({
            file,
            scope,
            scopeId,
            kind,
            previousPath,
            commit: (path, publicUrl) => ownerRef.current?.id === requestOwner
              && ownerRef.current.token === requestOwnerToken
              ? commit(kind, path, previousPath, publicUrl)
              : Promise.resolve(false),
            onCleanupWarning: () => {
              if (ownerRef.current?.id === requestOwner && ownerRef.current.token === requestOwnerToken) {
                toast.warning(PROFILE_MEDIA_LABELS.CLEANUP_WARNING);
              }
            },
            publicMirror: publicMirrorFor?.(kind),
          });
          if (ownerRef.current?.id === requestOwner && ownerRef.current.token === requestOwnerToken) toast.success(successMessage(kind));
        } catch (uploadError) {
          // Only this module's own errors carry copy.ts text. A Storage /
          // PostgREST rejection (an RLS denial, most often) is neither
          // actionable nor allowed in user-visible copy (§1.3), so it is
          // logged and reported generically. No PII or token is in the value.
          if (!(uploadError instanceof ProfileMediaError)) console.error('[profile-media] upload failed', uploadError);
          if (ownerRef.current?.id === requestOwner && ownerRef.current.token === requestOwnerToken) {
            toast.error(uploadError instanceof ProfileMediaError ? uploadError.message : PROFILE_MEDIA_LABELS.UPLOAD_FAILED);
          }
        } finally {
          if (ownerRef.current?.id === requestOwner && ownerRef.current.token === requestOwnerToken) setUploadState(null);
        }
      } finally {
        // Always: re-selecting the same file must fire onChange again, including
        // after an early return.
        input.value = '';
      }
    }, [scope, scopeId, ownerId, ownerToken, canUpload, commit, successMessage, publicMirrorFor, previousPathFor]);

  const blocked = canUpload === false;
  const uploading = uploadState?.ownerToken === ownerToken ? uploadState.kind : null;
  return { uploading, blocked, busy: blocked || uploading !== null || !!options.externallyBusy, onInputChange };
}
