/**
 * useSecuringCapability
 *
 * QUEUE-01 / SCRUM-2894 (L2-A1) — client-side snapshot of the
 * `SecuringCapability` contract (src/lib/queueContract.ts) that gates whether
 * the "Secure Instantly" control renders in SecureDocumentDialog.
 *
 * DARK THIS SPRINT (CTO ruling R5, ratified 2026-07-28): `canSecureInstantly`
 * is hardcoded `false` here. The trusted server capability (a field on
 * `GET /api/billing/status`) does not exist yet — wiring it is L2-A2's scope
 * ("Instant-Secure ships dark, flag off"). Per queueContract's own contract
 * note, the client MUST treat `canSecureInstantly` as authoritative and MUST
 * NOT infer it from a client-side default — so until the server field lands,
 * this hook is the fail-closed default, not a placeholder. Flipping this to a
 * real server-sourced value is a follow-up; no flag flip happens in this PR.
 *
 * `creditBalance` is sourced from the user-scoped `credits` table via
 * useCredits() — R4 (ratified 2026-07-28): `credits` is canonical for
 * individual/user-scoped money, `org_credits` for org-scoped. The
 * Secure-Document dialog is a personal action, so user-scoped credits is the
 * correct source here (org-wide admin credit adjustment is a separate
 * surface, A5).
 */
import { useCredits } from './useCredits';
import type { SecuringCapability } from '@/lib/queueContract';

/** Credits consumed per instant-secure (queueContract: "contract assumes 1"). */
const INSTANT_SECURE_COST = 1;

interface UseSecuringCapabilityReturn {
  capability: SecuringCapability;
  loading: boolean;
}

export function useSecuringCapability(): UseSecuringCapabilityReturn {
  const { credits, loading } = useCredits();

  const capability: SecuringCapability = {
    // DARK per R5 — see file header. Never derive this from local/client
    // state; it must come from a trusted server field once A2 wires it.
    canSecureInstantly: false,
    creditBalance: credits?.balance ?? 0,
    instantSecureCost: INSTANT_SECURE_COST,
  };

  return { capability, loading };
}
