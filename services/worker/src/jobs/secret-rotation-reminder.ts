import { logger } from '../utils/logger.js';

const ROTATION_PERIOD_DAYS = 90;
const WARNING_DAYS_BEFORE = 7;
const ROTATION_WARNING_AGE_DAYS = ROTATION_PERIOD_DAYS - WARNING_DAYS_BEFORE;

export interface SecretInventoryItem {
  name: string;
  lastRotatedAt: Date;
  category: 'api-key' | 'webhook-secret' | 'database' | 'signing' | 'token';
}

export interface RotationCheckResult {
  checked: number;
  expiringSoon: SecretInventoryItem[];
  overdue: SecretInventoryItem[];
  healthy: number;
}

export function getSecretInventory(): SecretInventoryItem[] {
  return [
    { name: 'STRIPE_SECRET_KEY', lastRotatedAt: new Date(), category: 'api-key' },
    { name: 'STRIPE_WEBHOOK_SECRET', lastRotatedAt: new Date(), category: 'webhook-secret' },
    { name: 'SUPABASE_SERVICE_ROLE_KEY', lastRotatedAt: new Date(), category: 'database' },
    { name: 'API_KEY_HMAC_SECRET', lastRotatedAt: new Date(), category: 'signing' },
    { name: 'GEMINI_API_KEY', lastRotatedAt: new Date(), category: 'api-key' },
    { name: 'TOGETHER_API_KEY', lastRotatedAt: new Date(), category: 'api-key' },
    { name: 'ANTHROPIC_API_KEY', lastRotatedAt: new Date(), category: 'api-key' },
    { name: 'COURTLISTENER_API_TOKEN', lastRotatedAt: new Date(), category: 'token' },
    { name: 'OPENSTATES_API_KEY', lastRotatedAt: new Date(), category: 'api-key' },
    { name: 'SAM_GOV_API_KEY', lastRotatedAt: new Date(), category: 'api-key' },
    { name: 'RESEND_API_KEY', lastRotatedAt: new Date(), category: 'api-key' },
    { name: 'UPSTASH_REDIS_REST_TOKEN', lastRotatedAt: new Date(), category: 'token' },
    { name: 'CLOUDFLARE_API_TOKEN', lastRotatedAt: new Date(), category: 'token' },
    { name: 'CLOUDFLARE_TUNNEL_TOKEN', lastRotatedAt: new Date(), category: 'token' },
    { name: 'CRON_SECRET', lastRotatedAt: new Date(), category: 'signing' },
  ];
}

export function checkRotationStatus(
  inventory: SecretInventoryItem[],
  now: Date = new Date(),
): RotationCheckResult {
  const expiringSoon: SecretInventoryItem[] = [];
  const overdue: SecretInventoryItem[] = [];

  for (const item of inventory) {
    const ageDays = Math.floor(
      (now.getTime() - item.lastRotatedAt.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (ageDays >= ROTATION_PERIOD_DAYS) {
      overdue.push(item);
    } else if (ageDays >= ROTATION_WARNING_AGE_DAYS) {
      expiringSoon.push(item);
    }
  }

  return {
    checked: inventory.length,
    expiringSoon,
    overdue,
    healthy: inventory.length - expiringSoon.length - overdue.length,
  };
}

export function formatSlackMessage(result: RotationCheckResult): string {
  const lines: string[] = [];

  if (result.overdue.length > 0) {
    lines.push(':rotating_light: *OVERDUE secrets (> 90 days):*');
    for (const s of result.overdue) {
      lines.push(`  • \`${s.name}\` (${s.category})`);
    }
  }

  if (result.expiringSoon.length > 0) {
    lines.push(':warning: *Expiring soon (83–90 days):*');
    for (const s of result.expiringSoon) {
      lines.push(`  • \`${s.name}\` (${s.category})`);
    }
  }

  if (result.overdue.length === 0 && result.expiringSoon.length === 0) {
    lines.push(':white_check_mark: All secrets are within rotation window.');
  }

  lines.push(`\n_Checked ${result.checked} secrets. ${result.healthy} healthy._`);
  return lines.join('\n');
}

export async function postSlackRotationAlert(
  webhookUrl: string,
  result: RotationCheckResult,
): Promise<boolean> {
  if (result.overdue.length === 0 && result.expiringSoon.length === 0) {
    logger.info('All secrets within rotation window — no Slack alert needed');
    return false;
  }

  const text = formatSlackMessage(result);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    if (!res.ok) {
      logger.error({ status: res.status }, 'Slack rotation alert failed');
      return false;
    }

    logger.info({ overdue: result.overdue.length, expiring: result.expiringSoon.length },
      'Slack rotation alert sent');
    return true;
  } catch (err) {
    logger.error({ error: err }, 'Slack rotation alert threw');
    return false;
  }
}

export async function runSecretRotationCheck(): Promise<RotationCheckResult> {
  const inventory = getSecretInventory();
  const result = checkRotationStatus(inventory);

  const slackUrl = process.env.SLACK_OPS_WEBHOOK_URL;
  if (slackUrl) {
    await postSlackRotationAlert(slackUrl, result);
  } else {
    logger.warn('SLACK_OPS_WEBHOOK_URL not set — skipping rotation Slack alert');
  }

  return result;
}
