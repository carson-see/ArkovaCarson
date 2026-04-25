/**
 * Single source of truth for public webhook paths. Both the path we register
 * with the provider (Google Drive `changes.watch` address, etc.) and the path
 * the worker mounts must derive from the same constant — drift here produces
 * silent 404s because the provider keeps retrying a path nothing serves.
 */
export const API_V1_PREFIX = '/api/v1' as const;

export const WEBHOOK_PATHS = {
  /** Google Drive `changes.watch` push notifications. */
  GOOGLE_DRIVE: `${API_V1_PREFIX}/webhooks/drive`,
} as const;

export type WebhookPath = (typeof WEBHOOK_PATHS)[keyof typeof WEBHOOK_PATHS];

/**
 * Strip a known prefix off a `WebhookPath`. Used by routers mounted at a
 * version prefix (e.g. the v1 router lives at `/api/v1`, so it mounts the
 * Drive webhook child router at `/webhooks/drive`). Throws on mismatch — a
 * silent slice would produce a 404, defeating the point of the constant.
 */
export function relativeTo(path: WebhookPath, prefix: string): string {
  if (!path.startsWith(prefix)) {
    throw new Error(`Path "${path}" does not start with prefix "${prefix}"`);
  }
  return path.slice(prefix.length);
}
