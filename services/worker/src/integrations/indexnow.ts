/**
 * IndexNow Integration (GEO-10 / SCRUM-220)
 *
 * Pings Bing/Yandex via the IndexNow protocol when new public content is created.
 * This tells search engines to re-crawl specific URLs immediately rather than
 * waiting for their normal crawl schedule.
 *
 * Used for: new public credentials, new attestations, new issuer profiles.
 *
 * @see https://www.indexnow.org/documentation
 */

import { logger } from '../utils/logger.js';

const INDEXNOW_KEY = process.env.INDEXNOW_KEY || '';
const SITE_URL = process.env.FRONTEND_URL || 'https://app.arkova.io';

const INDEXNOW_ENDPOINTS = [
  'https://api.indexnow.org/indexnow',
  'https://www.bing.com/indexnow',
];

/**
 * Notify search engines of new or updated URLs via IndexNow.
 * Fails silently — this is best-effort SEO, not critical path.
 */
export async function submitToIndexNow(urls: string[]): Promise<void> {
  if (!INDEXNOW_KEY) {
    logger.debug('IndexNow key not configured, skipping');
    return;
  }

  if (urls.length === 0) return;

  const host = new URL(SITE_URL).host;
  const body = {
    host,
    key: INDEXNOW_KEY,
    keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
    urlList: urls.slice(0, 10000), // IndexNow max 10,000 per request
  };

  for (const endpoint of INDEXNOW_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok || res.status === 202) {
        logger.info('IndexNow submitted', { endpoint, urlCount: urls.length });
      } else {
        logger.warn('IndexNow rejected', { endpoint, status: res.status });
      }
    } catch (err) {
      logger.debug('IndexNow ping failed (non-critical)', {
        endpoint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Build IndexNow URLs for newly secured credentials.
 */
export function buildCredentialUrls(publicIds: string[]): string[] {
  return publicIds.map(id => `${SITE_URL}/verify/${id}`);
}

/**
 * Build IndexNow URL for a new issuer profile.
 */
export function buildIssuerUrl(orgId: string): string {
  return `${SITE_URL}/issuer/${orgId}`;
}
