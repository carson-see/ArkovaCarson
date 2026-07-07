/**
 * useProofAvailability — FE-PROOF-GATE (SCRUM-2501)
 *
 * Fetches `GET /api/v1/verify/:publicId/proof` (public, anonymous, no auth —
 * see docs/reference/FE_PROOF_GATE_CONTRACT.md §1.2) and classifies the
 * result via `classifyProofAvailability`. Only call this once the caller has
 * already confirmed the record's normalized status is SECURED — this hook
 * does not itself branch on status (that's the contract's belt-and-braces
 * check, owned by the component that mounts it, e.g. VerifierProofDownload).
 *
 * 429 is treated as transient: the hook does not retry automatically (no
 * retry storms against the public, rate-limited endpoint), it just reports
 * `transient` so the caller renders nothing rather than an error.
 */

import { useCallback, useEffect, useState } from 'react';
import { WORKER_URL } from '@/lib/workerClient';
import {
  classifyProofAvailability,
  type ProofAvailability,
  type ProofBundleLike,
  type ProofEndpointResult,
} from '@/lib/proofAvailability';

export interface UseProofAvailabilityResult extends ProofAvailability {
  loading: boolean;
  /** Re-run the fetch — used by the retry affordance on 5xx / data-fault. */
  retry: () => void;
}

const LOADING_RESULT: ProofAvailability = { state: 'empty', proofBundle: null };

export function useProofAvailability(
  publicId: string | null | undefined,
  enabled: boolean,
): UseProofAvailabilityResult {
  const shouldFetch = enabled && !!publicId;

  // Initialize loading from the mount-time fetch condition so a gate-open
  // component never flashes the state-2 empty copy on its first paint
  // (before the fetch effect has run).
  const [loading, setLoading] = useState(shouldFetch);
  const [availability, setAvailability] = useState<ProofAvailability>(LOADING_RESULT);
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    if (!shouldFetch || !publicId) {
      return;
    }

    const controller = new AbortController();

    (async () => {
      // setLoading lives inside the async closure (not the effect body) so it
      // is not a synchronous setState-in-effect (react-hooks lint) — behaviour
      // is unchanged: loading flips true before the fetch resolves.
      setLoading(true);
      let result: ProofEndpointResult | null = null;
      try {
        const response = await fetch(
          `${WORKER_URL}/api/v1/verify/${encodeURIComponent(publicId)}/proof`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        let body: unknown = undefined;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }

        if (response.status === 200) {
          const parsed = body as { verified?: unknown; proof_bundle?: unknown } | undefined;
          result = {
            ok: true,
            status: 200,
            body: {
              verified: parsed?.verified === true,
              proof_bundle: (parsed?.proof_bundle ?? null) as ProofBundleLike | null,
            },
          };
        } else {
          result = { ok: false, status: response.status, body };
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Network failure (worker unreachable, offline, etc.) — same bucket as 5xx: retryable.
        result = { ok: false, status: 0, body: undefined };
      }

      if (!controller.signal.aborted) {
        setAvailability(classifyProofAvailability(result));
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [publicId, shouldFetch, nonce]);

  if (!shouldFetch) {
    return { ...LOADING_RESULT, loading: false, retry };
  }

  return { ...availability, loading, retry };
}
