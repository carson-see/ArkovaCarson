import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../utils/db.js';
import { processRevokedAnchors } from './revocation.js';
import { rebroadcastDroppedTransactions } from './chain-maintenance.js';
import { REBROADCAST_RUN_LEASE, REVOCATION_RUN_LEASE, withRunLease } from './run-lease.js';

export async function runLeasedRevocationSweep(
  client: SupabaseClient = db,
  body = processRevokedAnchors,
): Promise<{ processed: number; failed: number; skipped?: 'run-lease-held' }> {
  const outcome = await withRunLease({ ...REVOCATION_RUN_LEASE, client }, body);
  return outcome.acquired ? outcome.result : { processed: 0, failed: 0, skipped: 'run-lease-held' };
}

export async function runLeasedRebroadcastSweep(
  client: SupabaseClient = db,
  body = rebroadcastDroppedTransactions,
): Promise<Awaited<ReturnType<typeof rebroadcastDroppedTransactions>> & { skipped?: 'run-lease-held' }> {
  const outcome = await withRunLease({ ...REBROADCAST_RUN_LEASE, client }, body);
  return outcome.acquired
    ? outcome.result
    : { checked: 0, rebroadcast: 0, failed: 0, completed: true, skipped: 'run-lease-held' };
}
