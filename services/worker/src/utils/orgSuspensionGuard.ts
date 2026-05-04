/**
 * Sub-org suspension guard (SCRUM-1652 ORG-HIER-02 / ORG-08).
 *
 * Worker-side helper that checks whether an org is suspended before the
 * caller dispatches a privileged action (anchor create, queue run,
 * integration-trigger consumption). Wraps `is_org_suspended()` from
 * migration 0288.
 *
 * Usage:
 *   const guard = await ensureOrgNotSuspended(orgId);
 *   if (!guard.ok) {
 *     return res.status(403).json({ error: { code: guard.code, message: guard.message } });
 *   }
 *
 * Do NOT use this for read paths — suspended orgs retain read access to
 * existing evidence per PRD §PRD 6 ORG-08. Reads should rely on RLS only.
 */
import { db } from './db.js';
import { logger } from './logger.js';

export type OrgSuspensionGuardResult =
  | { ok: true }
  | { ok: false; code: 'org_suspended'; message: string }
  | { ok: false; code: 'guard_lookup_failed'; message: string };

/**
 * Returns ok=true if the org is active. ok=false with code='org_suspended'
 * if the parent admin has flipped the suspension flag. ok=false with
 * code='guard_lookup_failed' on ANY lookup anomaly — RPC error, RPC throw,
 * or null/undefined response. Caller decides whether to fail-closed
 * (recommended for write paths) or fail-open.
 *
 * Hardening per CodeRabbit (PR #689): a `db.rpc()` rejection used to bubble
 * out as an unhandled promise, and `{ data: null, error: null }` was treated
 * as ok=true, which would let a write proceed against a half-broken DB.
 * Both are now treated as guard_lookup_failed.
 */
export async function ensureOrgNotSuspended(orgId: string): Promise<OrgSuspensionGuardResult> {
  let data: unknown;
  let error: { message?: string } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (db.rpc as any)('is_org_suspended', { p_org_id: orgId });
    data = result.data;
    error = result.error;
  } catch (err) {
    logger.error({ err, orgId }, 'orgSuspensionGuard: is_org_suspended RPC threw');
    return {
      ok: false,
      code: 'guard_lookup_failed',
      message: err instanceof Error ? err.message : 'guard rpc threw',
    };
  }
  if (error) {
    logger.error({ err: error, orgId }, 'orgSuspensionGuard: is_org_suspended RPC failed');
    return { ok: false, code: 'guard_lookup_failed', message: error.message ?? 'guard lookup failed' };
  }
  if (data === true) {
    return {
      ok: false,
      code: 'org_suspended',
      message: 'This organization is currently suspended by its parent admin. Contact your parent organization to restore access.',
    };
  }
  if (data === false) return { ok: true };
  // null/undefined/non-boolean — treat as lookup anomaly per CodeRabbit fail-closed guidance.
  logger.error({ orgId, data }, 'orgSuspensionGuard: is_org_suspended returned non-boolean response');
  return { ok: false, code: 'guard_lookup_failed', message: 'guard rpc returned non-boolean response' };
}
