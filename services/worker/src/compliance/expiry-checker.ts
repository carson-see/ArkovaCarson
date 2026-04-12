/**
 * Expiry Checker (NCE-09)
 *
 * Categorizes anchored documents approaching expiration into urgency windows.
 * Used by the daily cron job to send email alerts and dispatch webhooks.
 *
 * Jira: SCRUM-600
 */

export interface ExpiryAnchor {
  id: string;
  org_id: string;
  credential_type: string;
  title: string | null;
  expiry_date: string;
}

export type ExpiryCategory = '7_day' | '30_day' | '60_day' | '90_day';

const WINDOWS: Array<{ category: ExpiryCategory; maxDays: number }> = [
  { category: '7_day', maxDays: 7 },
  { category: '30_day', maxDays: 30 },
  { category: '60_day', maxDays: 60 },
  { category: '90_day', maxDays: 90 },
];

/**
 * Categorize expiring documents into urgency windows.
 * Each document goes into exactly one window (the tightest that applies).
 * Already-expired documents (days <= 0) are excluded.
 */
export function categorizeExpiringDocuments(
  anchors: ExpiryAnchor[],
): Map<ExpiryCategory, ExpiryAnchor[]> {
  const result = new Map<ExpiryCategory, ExpiryAnchor[]>();
  for (const w of WINDOWS) {
    result.set(w.category, []);
  }

  const now = Date.now();

  for (const anchor of anchors) {
    const expiryTime = new Date(anchor.expiry_date).getTime();
    const daysRemaining = Math.ceil((expiryTime - now) / 86_400_000);

    if (daysRemaining <= 0) continue; // Already expired

    // Find the tightest window
    for (const w of WINDOWS) {
      if (daysRemaining <= w.maxDays) {
        result.get(w.category)!.push(anchor);
        break;
      }
    }
  }

  return result;
}

/**
 * Group expiring anchors by org_id for batched notifications.
 */
export function groupByOrg(
  anchors: ExpiryAnchor[],
): Map<string, ExpiryAnchor[]> {
  const groups = new Map<string, ExpiryAnchor[]>();
  for (const anchor of anchors) {
    const existing = groups.get(anchor.org_id);
    if (existing) {
      existing.push(anchor);
    } else {
      groups.set(anchor.org_id, [anchor]);
    }
  }
  return groups;
}
