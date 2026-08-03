/**
 * Curated error type for worker HTTP response bodies.
 *
 * `WorkerResponseError`'s `.message` is the ONLY thrown-error message these
 * call sites are allowed to render verbatim to the user. It must be
 * constructed EXCLUSIVELY from a worker HTTP response body (the `!res.ok`
 * branch, after `res.json()`) — never from an arbitrary caught exception.
 *
 * Why this exists: a prior version of this fix (see `src/lib/agents.md`,
 * invite-email VITE_WORKER_URL incident) made these catch blocks show a
 * curated generic label for EVERY thrown error, to stop
 * `resolveWorkerBaseUrl`'s internal, engineer-facing misconfiguration text
 * (naming `VITE_WORKER_URL` / Vercel project settings) from reaching the DOM.
 * That over-corrected: it also discarded legitimate, safe-to-show,
 * server-supplied business messages (e.g. "Nessie query endpoint is not
 * enabled", a 422 sampling-population message) that users previously saw and
 * could self-diagnose from — a tier-gate, a rate limit, a network blip, and a
 * genuine bug all rendered identically, and support lost its one triage
 * signal.
 *
 * The fix: only a message that genuinely came from the worker's own response
 * body is safe to show — the worker already curates what it puts in that
 * body. Anything else (network errors, `resolveWorkerBaseUrl`'s internal
 * config text, any other unauthored JS exception) must fall back to a
 * curated, generic label. Mirrors the `ActionableInviteError` /
 * `InviteAcceptError` pattern already used by `useInviteMember.ts` /
 * `useAcceptInvite.ts` in this same codebase — same idea, promoted to a
 * shared module because this exact shape recurs across multiple components.
 */
export class WorkerResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerResponseError';
  }
}

export function isWorkerResponseError(err: unknown): err is WorkerResponseError {
  return err instanceof WorkerResponseError;
}
