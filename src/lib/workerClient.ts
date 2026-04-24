/**
 * Worker API Client
 *
 * Shared fetch wrapper for all frontend → worker API calls.
 * Handles auth token injection, network error detection, timeouts,
 * and user-friendly error messages when the worker is unreachable.
 *
 * @see UAT2-14
 */

import { supabase } from './supabase';

/** Default request timeout in milliseconds (60 seconds). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Production worker URL. In prod, VITE_WORKER_URL must be set in Vercel env vars
 * to the Cloud Run URL. Falls back to Cloud Run URL if not set.
 */
const CLOUD_RUN_URL = 'https://arkova-worker-270018525501.us-central1.run.app';
export const WORKER_URL = import.meta.env.VITE_WORKER_URL
  ?? (import.meta.env.PROD ? CLOUD_RUN_URL : 'http://localhost:3001');

/** Full public URL for display in docs, curl examples, etc. Always shows production URL — never localhost. */
export const PUBLIC_API_URL = import.meta.env.VITE_WORKER_URL || CLOUD_RUN_URL;

const WORKER_UNAVAILABLE_MESSAGE =
  'Unable to connect to the server. Please check your connection and try again.';

/**
 * Fetch with auth token, timeout, and graceful network error handling.
 * Throws a user-friendly Error on network failure (worker down, offline, etc).
 *
 * @param endpoint - API path (e.g., '/api/v1/ai/extract-batch')
 * @param options - Standard RequestInit options
 * @param timeoutMs - Request timeout in ms (default: 60s)
 */
export async function workerFetch(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('No active session — please sign in again');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${WORKER_URL}${endpoint}`, {
      ...options,
      signal: options.signal ?? controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        ...options.headers,
      },
    });
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Request timed out. The server may be busy — please try again.');
    }
    // TypeError from fetch() = network error (worker down, CORS, offline)
    if (error instanceof TypeError) {
      throw new Error(WORKER_UNAVAILABLE_MESSAGE);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
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
    const errorValue = (parsed as { error?: string | { message?: string } }).error;
    const errorMessage = typeof errorValue === 'string'
      ? errorValue
      : errorValue?.message;
    throw new Error(
      errorMessage ?? `Request failed (${response.status})`,
    );
  }

  const data = await response.json().catch(() => {
    throw new Error('Invalid server response');
  });
  const url = (data as Record<string, string>).url;
  if (!url) throw new Error('No redirect URL returned');
  return url;
}
