import { workerFetch } from '@/lib/workerClient';
import { CONNECTIONS_LABELS } from '@/lib/copy';

/**
 * POST a connector disconnect and translate a refusal into user copy.
 *
 * Every connector disconnects the same way — `{ org_id }` to a provider path,
 * with the worker's `error` string preferred over the generic fallback — so the
 * request lives here once. What each card does *after* a successful teardown
 * still differs (Adobe has to report a webhook Adobe kept, DocuSign just
 * toasts), so the parsed body is returned rather than swallowed.
 *
 * A non-JSON body is treated as an empty one: a disconnect that returns HTML
 * from a proxy must still produce readable copy, not a parse crash.
 */
export async function requestConnectorDisconnect<T extends object = Record<string, never>>(
  path: string,
  orgId: string,
): Promise<{ error: string | null; body: T & { error?: string } }> {
  const response = await workerFetch(path, {
    method: 'POST',
    body: JSON.stringify({ org_id: orgId }),
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };

  if (!response.ok) {
    return { error: body.error ?? CONNECTIONS_LABELS.DISCONNECT_FAILED, body };
  }
  return { error: null, body };
}
