/**
 * Scans jurisdiction_rules for stale entries (last_checked > 24h or null)
 * and creates audit_events alerts for rules whose backing regulation may have changed.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

export interface RegulatoryChangeScanResult {
  scanned: number;
  alertsCreated: number;
}

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export async function runRegulatoryChangeScan(): Promise<RegulatoryChangeScanResult> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  // Fetch rules that haven't been checked in 24h or have never been checked
  const { data: staleRules, error } = await dbAny
    .from('jurisdiction_rules')
    .select('id, jurisdiction_code, rule_name, regulatory_reference, updated_at')
    .or(`updated_at.lt.${cutoff},updated_at.is.null`)
    .limit(500);

  if (error) {
    logger.error({ error }, 'Failed to query stale jurisdiction rules');
    throw new Error('Regulatory change scan query failed');
  }

  const rules = (staleRules ?? []) as Array<{
    id: string;
    jurisdiction_code: string;
    rule_name: string;
    regulatory_reference: string | null;
    updated_at: string | null;
  }>;

  if (rules.length === 0) {
    logger.info('No stale jurisdiction rules found');
    return { scanned: 0, alertsCreated: 0 };
  }

  const now = new Date().toISOString();
  const results = await Promise.all(
    rules.map((rule) =>
      dbAny
        .from('audit_events')
        .insert({
          event_type: 'regulatory.rule_stale',
          event_category: 'COMPLIANCE',
          details: JSON.stringify({
            rule_id: rule.id,
            jurisdiction_code: rule.jurisdiction_code,
            rule_name: rule.rule_name,
            regulatory_reference: rule.regulatory_reference,
            last_checked: rule.updated_at,
            flagged_at: now,
          }),
        })
        .then(() => true)
        .catch((err: unknown) => {
          logger.warn({ error: err, ruleId: rule.id }, 'Failed to create stale-rule alert');
          return false;
        }),
    ),
  );
  const alertsCreated = results.filter(Boolean).length;

  logger.info({ scanned: rules.length, alertsCreated }, 'Regulatory change scan complete');
  return { scanned: rules.length, alertsCreated };
}
