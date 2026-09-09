import { OAUTH_EMAIL_CONFIRMATION_LABELS } from './copy';
import { workerFetch, WORKER_URL } from './workerClient';
import { resolveSafeWorkerEndpoint } from './workerUrlSafety';

export interface ConfirmationStatus {
  required: boolean;
  email?: string;
  sent?: boolean;
  retryAfterSeconds?: number;
}
export interface ConfirmationComplete {
  complete: boolean;
  session: { access_token: string; refresh_token: string } | null;
}
export class ConfirmationError extends Error {
  constructor(message: string, readonly retryAfterSeconds = 0) { super(message); }
}
const BASE = '/api/auth/email-confirmation';
async function readResponse<T>(responsePromise: Promise<Response>): Promise<T> {
  let response: Response;
  let body;
  try {
    response = await responsePromise;
    body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(OAUTH_EMAIL_CONFIRMATION_LABELS.RETRY);
  } catch { throw new ConfirmationError(OAUTH_EMAIL_CONFIRMATION_LABELS.RETRY); }
  if (!response.ok) throw new ConfirmationError(
    typeof body.error === 'string' ? body.error : OAUTH_EMAIL_CONFIRMATION_LABELS.RETRY,
    typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : 0,
  );
  return body as T;
}
export async function getConfirmationStatus(): Promise<ConfirmationStatus> {
  return readResponse(workerFetch(BASE, {}, 15_000));
}
export async function sendConfirmationEmail(): Promise<ConfirmationStatus> {
  return readResponse(workerFetch(`${BASE}/send`, { method: 'POST' }, 15_000));
}
export async function completeEmailConfirmation(mailboxProof: string): Promise<ConfirmationComplete> {
  // Link possession is the credential; the browser may have no session or a different account.
  return readResponse(fetch(resolveSafeWorkerEndpoint(WORKER_URL, `${BASE}/complete`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'token': mailboxProof }), signal: AbortSignal.timeout(15_000), credentials: 'omit',
  }));
}
