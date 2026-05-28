/**
 * SCRUM-2040 — Webhook nonce sweep (SOC 2 CC7.4).
 *
 * Deletes replay-protection nonces older than the retention window (14 days)
 * from all webhook nonce tables. Each table's comment already documents
 * the 14-day sweep expectation; this job fulfills it.
 */

import { logger } from '../utils/logger.js';

const NONCE_TABLES = [
  'docusign_webhook_nonces',
  'drive_webhook_nonces',
  'ats_webhook_nonces',
  'microsoft_graph_webhook_nonces',
] as const;

type NonceTable = (typeof NONCE_TABLES)[number];

export interface NonceSweepDb {
  deleteOlderThan(
    table: string,
    retentionDays: number,
  ): Promise<{ table: string; deleted: number; error: string | null }>;
}

interface SweepResult {
  ok: boolean;
  swept: Record<NonceTable, number>;
  totalDeleted: number;
  errors: Array<{ table: string; error: string }>;
}

export async function sweepExpiredNonces(
  db: NonceSweepDb,
  retentionDays = 14,
): Promise<SweepResult> {
  const swept = {} as Record<NonceTable, number>;
  const errors: Array<{ table: string; error: string }> = [];
  let totalDeleted = 0;

  for (const table of NONCE_TABLES) {
    const result = await db.deleteOlderThan(table, retentionDays);
    if (result.error) {
      logger.error({ table, error: result.error }, 'Nonce sweep failed for table');
      errors.push({ table, error: result.error });
      swept[table] = 0;
    } else {
      swept[table] = result.deleted;
      totalDeleted += result.deleted;
      if (result.deleted > 0) {
        logger.info({ table, deleted: result.deleted }, 'Nonce sweep completed');
      }
    }
  }

  return { ok: errors.length === 0, swept, totalDeleted, errors };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- sweep_webhook_nonces RPC not in generated types until migration 0316 lands + gen:types
export function makeNonceSweepDb(supabaseDb: { rpc: (...args: any[]) => PromiseLike<{ data: any; error: any }> }): NonceSweepDb {
  return {
    async deleteOlderThan(table: string, retentionDays: number) {
      const { data, error } = await supabaseDb.rpc('sweep_webhook_nonces', {
        target_table: table,
        retention_days: retentionDays,
      });
      if (error) {
        const msg = typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: string }).message)
          : String(error);
        return { table, deleted: 0, error: msg };
      }
      return { table, deleted: typeof data === 'number' ? data : 0, error: null };
    },
  };
}
