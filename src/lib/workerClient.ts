/**
 * Worker API Client
 *
 * Shared fetch wrapper for all frontend → worker API calls.
 * Handles auth token injection, network error detection, and
 * user-friendly error messages when the worker is unreachable.
 *
 * @see UAT2-14
 */

import { supabase } from './supabase';

export const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:3001';

const WORKER_UNAVAILABLE_MESSAGE =
  'Unable to connect to the server. Please check your connection and try again.';

/**
 * Fetch with auth token and graceful network error handling.
 * Throws a user-friendly Error on network failure (worker down, offline, etc).
 */
export async function workerFetch(
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('No active session — please sign in again');
  }

  try {
    return await fetch(`${WORKER_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        ...options.headers,
      },
    });
  } catch (error) {
    // TypeError from fetch() = network error (worker down, CORS, offline)
    // Check error type rather than message content for cross-browser reliability
    if (error instanceof TypeError) {
      throw new Error(WORKER_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

/**
 * POST to worker endpoint, parse JSON response, and return the `url` field.
 * Used by billing checkout and portal flows.
 */
export async function workerPostForUrl(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await workerFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const parsed = await response.json().catch(() => ({}));
    throw new Error(
      (parsed as Record<string, string>).error ?? `Request failed (${response.status})`,
    );
  }

  const data = await response.json().catch(() => {
    throw new Error('Invalid server response');
  });
  const url = (data as Record<string, string>).url;
  if (!url) throw new Error('No redirect URL returned');
  return url;
}
