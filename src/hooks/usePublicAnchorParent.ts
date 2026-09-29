/**
 * usePublicAnchorParent — public verification page, version honesty
 * (PR #3190 review finding 2)
 *
 * The public verification page (`PublicVerification.tsx`) fetches a record's
 * data via the `get_public_anchor` Supabase RPC. Confirmed against
 * PRODUCTION: that RPC's response carries neither `parent_public_id` nor
 * `version_number`. `get_anchor_lineage` carries both, but it is SECURITY
 * DEFINER with EXECUTE granted to neither `anon` nor `authenticated` — the
 * browser cannot call it directly, and this PR makes no SQL/schema change to
 * either RPC.
 *
 * `GET /api/v1/verify/:publicId` (`services/worker/src/api/v1/verify.ts`) is
 * a genuinely public, anonymous-GET-allowed endpoint (Constitution 1.10,
 * 100 req/min) that ALREADY surfaces `parent_public_id` as an additive
 * nullable field (API-RICH-01) — no backend change needed. This is the same
 * router family `useProofAvailability` already calls from this exact page
 * (its sibling `/proof` sub-path); this hook calls the base route instead,
 * for just this one field. It never blocks the page and never surfaces a
 * page-level error: on any non-200, malformed body, or network failure it
 * silently reports `parentPublicId: null` — the caller simply omits the
 * "view previous version" link when this is unknown, the same as it already
 * does for a record with no parent at all.
 *
 * NOTE (documented, not silently accepted): this endpoint's handler also
 * writes a `VERIFICATION_QUERIED` audit-log row (and, when
 * `ENABLE_CREDENTIAL_VERIFIED_WEBHOOK` is on, may dispatch a
 * `credential.verified` webhook) on every call — a real side effect of
 * calling it, not introduced by this hook. Gate this hook's `enabled` input
 * on the narrow case that actually needs the field (a SUPERSEDED record)
 * rather than firing it for every public page view.
 */

import { useEffect, useState } from 'react';
import { WORKER_URL } from '@/lib/workerClient';

export interface UsePublicAnchorParentResult {
  parentPublicId: string | null;
  loading: boolean;
}

export function usePublicAnchorParent(
  publicId: string | null | undefined,
  enabled: boolean,
): UsePublicAnchorParentResult {
  const shouldFetch = enabled && !!publicId;

  const [loading, setLoading] = useState(shouldFetch);
  const [parentPublicId, setParentPublicId] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldFetch || !publicId) {
      return;
    }

    const controller = new AbortController();

    (async () => {
      // setLoading lives inside the async closure, not the effect body
      // (react-hooks/set-state-in-effect) — same pattern as
      // useProofAvailability.
      setLoading(true);
      let value: string | null = null;
      try {
        const response = await fetch(
          `${WORKER_URL}/api/v1/verify/${encodeURIComponent(publicId)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        if (response.status === 200) {
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            body = undefined;
          }
          const parsed = body as { parent_public_id?: unknown } | undefined;
          value = typeof parsed?.parent_public_id === 'string' ? parsed.parent_public_id : null;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Network failure — this is a supplementary, non-blocking fetch;
        // degrade to "unknown parent" rather than surfacing a page error.
        value = null;
      }

      if (!controller.signal.aborted) {
        setParentPublicId(value);
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [publicId, shouldFetch]);

  if (!shouldFetch) {
    return { parentPublicId: null, loading: false };
  }

  return { parentPublicId, loading };
}
