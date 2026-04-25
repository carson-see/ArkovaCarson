/**
 * Webhook ingress paths (SCRUM-1209)
 *
 * Single source of truth for the public path third-party providers POST to.
 * Drift between the path we register with the provider (Google Drive
 * `changes.watch` address, DocuSign Connect URL, etc.) and the path the
 * worker actually mounts produces 404s on every delivery — events are lost
 * silently because the provider keeps a 200/404 history but the worker never
 * sees the body.
 *
 * Each entry is the **full public path** including the API-version prefix.
 * The corresponding express router mounts use {@link relativeTo} to derive
 * the suffix that comes after the version prefix it's already mounted under.
 */
export const API_V1_PREFIX = '/api/v1' as const;

export const WEBHOOK_PATHS = {
  /** Google Drive `changes.watch` push notifications. */
  GOOGLE_DRIVE: `${API_V1_PREFIX}/webhooks/drive`,
} as const;

export type WebhookPath = (typeof WEBHOOK_PATHS)[keyof typeof WEBHOOK_PATHS];

/**
 * Strip a known prefix off a path. Used by routers that are themselves mounted
 * at a prefix (e.g. the v1 router lives at `/api/v1`, so it mounts the Drive
 * webhook child router at `/webhooks/drive`).
 *
 * Returns the suffix with a leading slash. Throws if the path does not start
 * with the prefix — that's a programming error and would silently produce a
 * 404 if not caught.
 */
export function relativeTo(path: WebhookPath, prefix: string): string {
  if (!path.startsWith(prefix)) {
    throw new Error(`Path "${path}" does not start with prefix "${prefix}"`);
  }
  const suffix = path.slice(prefix.length);
  return suffix.startsWith('/') ? suffix : `/${suffix}`;
}
