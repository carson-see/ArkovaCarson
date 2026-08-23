/**
 * Bounded response-body reads (F-D0-5, fullsoak 2026-08-12).
 *
 * WHY THIS EXISTS. `AbortSignal.timeout(...)` passed to `fetch()` bounds the
 * REQUEST, but the subsequent `await response.json()` / `.text()` is its own
 * await with no deadline of its own. A provider that sends headers and then
 * stalls the body leaves that await parked indefinitely — undici's default
 * `bodyTimeout` only fires on total silence, so a trickling or wedged socket
 * can hold it open far longer than any request timeout.
 *
 * Observed consequence (day0-bl2-secured-e2e-evidence.md §2.6a): one parked
 * body read inside `check-confirmations` suspended the whole run inside
 * `withRunLease`. The run-lease heartbeat — a healthy `setInterval` on the
 * same event loop — kept renewing the lease on schedule, so the hang could
 * not self-heal: SUBMITTED→SECURED promotion was disabled for every tenant
 * for 35+ minutes with zero warn/error logs.
 *
 * THE GUARANTEE. `readJsonBounded` / `readTextBounded` ALWAYS settle by their
 * deadline. The race is what guarantees it — deliberately independent of
 * whether the runtime's fetch implementation honors an abort mid-body-read,
 * because that is precisely the property the incident called into question.
 * Stream cancellation is attempted as best-effort socket hygiene only; a
 * stream locked by the pending read rejects its `cancel()` per WHATWG, which
 * is swallowed — undici's own `bodyTimeout` remains the socket backstop.
 *
 * The run-lease `maxRunMs` body deadline (jobs/run-lease.ts) is the
 * defense-in-depth layer above this one: even a park these readers do not
 * cover can no longer pin a lease forever.
 */

/**
 * CALLER CONTRACT (§1.4): `url` is embedded verbatim in `.message`, which
 * flows to retry warn logs, Sentry breadcrumbs, and propagated error text —
 * so it must be safe to log. Public API URLs (mempool.space, blockstream)
 * pass the full URL: the path is the correlation value. Credential-bearing
 * URLs — e.g. a token-in-path RPC endpoint like
 * `https://go.getblock.io/<ACCESS_TOKEN>` — must pass a sanitized label
 * instead (see `sanitizeRpcUrlForError` in chain/utxo-provider.ts).
 */
export class BodyReadTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`Body read for ${url} did not complete within ${timeoutMs}ms`);
    this.name = 'BodyReadTimeoutError';
  }
}

/**
 * The minimal structural slice of a fetch `Response` these readers need.
 * Structural on purpose: test doubles across the worker mock responses as
 * plain `{ ok, json }` objects, and the readers must accept those unchanged.
 */
interface JsonBodySource {
  json(): Promise<unknown>;
  body?: { cancel?: (reason?: unknown) => Promise<unknown> } | null;
}

interface TextBodySource {
  text(): Promise<string>;
  body?: { cancel?: (reason?: unknown) => Promise<unknown> } | null;
}

/**
 * `await response.json()` with a deadline. Rejects with
 * {@link BodyReadTimeoutError} if the body has not fully arrived and parsed
 * within `timeoutMs`; any genuine read/parse error propagates unchanged.
 */
export function readJsonBounded(
  response: JsonBodySource,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  return raceBodyRead(response.json(), response, url, timeoutMs);
}

/** `await response.text()` with a deadline — same contract as the JSON form. */
export function readTextBounded(
  response: TextBodySource,
  url: string,
  timeoutMs: number,
): Promise<string> {
  return raceBodyRead(response.text(), response, url, timeoutMs);
}

async function raceBodyRead<T>(
  reading: Promise<T>,
  response: { body?: { cancel?: (reason?: unknown) => Promise<unknown> } | null },
  url: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reading,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new BodyReadTimeoutError(url, timeoutMs);
          // The abandoned read may still settle later (e.g. the socket finally
          // dies). Observe it now so it can never surface as an unhandled
          // rejection after we have already answered with the timeout.
          void reading.then(
            () => undefined,
            () => undefined,
          );
          // Best-effort socket hygiene. A stream locked by the pending read
          // rejects its cancel() per WHATWG — swallow either shape; the race
          // above is what unblocks the caller regardless.
          try {
            void Promise.resolve(response.body?.cancel?.(error)).catch(() => undefined);
          } catch {
            // cancel() threw synchronously (locked stream on some runtimes)
          }
          reject(error);
        }, timeoutMs);
        // A pending body deadline must never keep the process alive.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
