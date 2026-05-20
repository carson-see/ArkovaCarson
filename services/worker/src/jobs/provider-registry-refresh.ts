import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const DEFAULT_PROVIDER_REFRESH_OVERDUE_DAYS = 95;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ProviderRegistryKind = 'CPE' | 'CLE';

export interface ProviderRegistryRefreshRow {
  kind: ProviderRegistryKind;
  providerName: string;
  providerDomain: string | null;
  status: string;
  lastVerifiedDate: string | null;
}

export interface ProviderRegistryRefreshOverdueItem extends ProviderRegistryRefreshRow {
  ageDays: number | null;
}

export interface ProviderRegistryRefreshStatus {
  checked: number;
  active: number;
  inactive: number;
  healthy: number;
  thresholdDays: number;
  overdue: ProviderRegistryRefreshOverdueItem[];
}

export interface ProviderRegistryRefreshRunResult extends ProviderRegistryRefreshStatus {
  slackAlertSent: boolean;
}

interface DbError {
  message: string;
}

interface ProviderRegistryDbClient {
  from(table: string): {
    select(columns: string): PromiseLike<{ data: unknown[] | null; error: DbError | null }>;
  };
}

interface RawCpeProviderRow {
  provider_name?: string | null;
  provider_domain?: string | null;
  nasba_status?: string | null;
  last_verified_date?: string | null;
}

interface RawCleProviderRow {
  provider_name?: string | null;
  provider_domain?: string | null;
  approval_status?: string | null;
  last_verified_date?: string | null;
}

export function parseProviderRefreshOverdueDays(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PROVIDER_REFRESH_OVERDUE_DAYS;
  return parsed;
}

function dateOnlyToUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function ageInDays(lastVerifiedDate: string | null, now: Date): number | null {
  if (!lastVerifiedDate) return null;
  const verifiedAt = dateOnlyToUtc(lastVerifiedDate);
  if (Number.isNaN(verifiedAt.getTime())) return null;
  return Math.floor((now.getTime() - verifiedAt.getTime()) / MS_PER_DAY);
}

function isActiveProvider(row: ProviderRegistryRefreshRow): boolean {
  if (row.kind === 'CPE') return row.status !== 'not_found';
  return row.status !== 'not_approved';
}

function isOverdue(row: ProviderRegistryRefreshRow, now: Date, thresholdDays: number): ProviderRegistryRefreshOverdueItem | null {
  const ageDays = ageInDays(row.lastVerifiedDate, now);
  if (ageDays === null || ageDays > thresholdDays) {
    return { ...row, ageDays };
  }
  return null;
}

export function checkProviderRegistryRefreshStatus(
  rows: ProviderRegistryRefreshRow[],
  now = new Date(),
  thresholdDays = DEFAULT_PROVIDER_REFRESH_OVERDUE_DAYS,
): ProviderRegistryRefreshStatus {
  const overdue: ProviderRegistryRefreshOverdueItem[] = [];
  let active = 0;
  let inactive = 0;
  let healthy = 0;

  for (const row of rows) {
    if (!isActiveProvider(row)) {
      inactive += 1;
      continue;
    }

    active += 1;
    const overdueItem = isOverdue(row, now, thresholdDays);
    if (overdueItem) {
      overdue.push(overdueItem);
    } else {
      healthy += 1;
    }
  }

  return {
    checked: rows.length,
    active,
    inactive,
    healthy,
    thresholdDays,
    overdue,
  };
}

export function formatProviderRegistryRefreshSlackMessage(result: ProviderRegistryRefreshStatus): string {
  const lines = [
    '*Provider registry refresh overdue*',
    `Checked ${result.checked} provider registry rows; ${result.overdue.length} active provider(s) exceed ${result.thresholdDays} days.`,
  ];

  for (const provider of result.overdue) {
    const lastVerified = provider.lastVerifiedDate ?? 'not recorded';
    const age = provider.ageDays === null ? 'unknown age' : `${provider.ageDays} days old`;
    lines.push(
      `Provider registry refresh overdue for ${provider.providerName} - last verified ${lastVerified}. (${provider.kind}, ${age})`,
    );
  }

  return lines.join('\n');
}

export async function postProviderRegistryRefreshSlackAlert(
  webhookUrl: string,
  result: ProviderRegistryRefreshStatus,
): Promise<boolean> {
  if (result.overdue.length === 0) {
    logger.info('Provider registry refresh check found no overdue active providers');
    return false;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: formatProviderRegistryRefreshSlackMessage(result) }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    if (!res.ok) {
      logger.error({ status: res.status }, 'Provider registry refresh Slack alert failed');
      return false;
    }

    logger.info({ overdue: result.overdue.length }, 'Provider registry refresh Slack alert sent');
    return true;
  } catch (error) {
    logger.error({ error }, 'Provider registry refresh Slack alert threw');
    return false;
  }
}

function normalizeCpeProvider(row: RawCpeProviderRow): ProviderRegistryRefreshRow {
  return {
    kind: 'CPE',
    providerName: row.provider_name ?? 'Unknown CPE provider',
    providerDomain: row.provider_domain ?? null,
    status: row.nasba_status ?? 'unknown',
    lastVerifiedDate: row.last_verified_date ?? null,
  };
}

function normalizeCleProvider(row: RawCleProviderRow): ProviderRegistryRefreshRow {
  return {
    kind: 'CLE',
    providerName: row.provider_name ?? 'Unknown CLE provider',
    providerDomain: row.provider_domain ?? null,
    status: row.approval_status ?? 'unknown',
    lastVerifiedDate: row.last_verified_date ?? null,
  };
}

export async function fetchProviderRegistryRefreshRows(
  client: ProviderRegistryDbClient = db as unknown as ProviderRegistryDbClient,
): Promise<ProviderRegistryRefreshRow[]> {
  const [cpeResult, cleResult] = await Promise.all([
    client.from('cpe_provider_registry')
      .select('provider_name, provider_domain, nasba_status, last_verified_date'),
    client.from('cle_provider_registry')
      .select('provider_name, provider_domain, approval_status, last_verified_date'),
  ]);

  if (cpeResult.error) {
    throw new Error(`failed to fetch cpe_provider_registry: ${cpeResult.error.message}`);
  }
  if (cleResult.error) {
    throw new Error(`failed to fetch cle_provider_registry: ${cleResult.error.message}`);
  }

  return [
    ...(cpeResult.data ?? []).map((row) => normalizeCpeProvider(row as RawCpeProviderRow)),
    ...(cleResult.data ?? []).map((row) => normalizeCleProvider(row as RawCleProviderRow)),
  ];
}

export async function runProviderRegistryRefreshOverdueCheck(
  client: ProviderRegistryDbClient = db as unknown as ProviderRegistryDbClient,
): Promise<ProviderRegistryRefreshRunResult> {
  const thresholdDays = parseProviderRefreshOverdueDays(process.env.PROVIDER_REFRESH_OVERDUE_DAYS);
  const rows = await fetchProviderRegistryRefreshRows(client);
  const status = checkProviderRegistryRefreshStatus(rows, new Date(), thresholdDays);
  const webhookUrl = process.env.SLACK_OPS_WEBHOOK_URL;
  let slackAlertSent = false;

  if (webhookUrl) {
    slackAlertSent = await postProviderRegistryRefreshSlackAlert(webhookUrl, status);
  } else if (status.overdue.length > 0) {
    logger.warn(
      { overdue: status.overdue.length },
      'SLACK_OPS_WEBHOOK_URL not set - provider registry refresh overdue alert skipped',
    );
  }

  return {
    ...status,
    slackAlertSent,
  };
}
