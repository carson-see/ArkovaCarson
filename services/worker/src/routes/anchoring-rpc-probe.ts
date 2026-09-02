/**
 * Anchoring RPC credential liveness probe (SCRUM-3374).
 *
 * ─── The defect this closes ───
 * Verified in production on 2026-08-30: the stored `bitcoin-rpc-url` GetBlock
 * access token had been REVOKED and returned `HTTP 401 "Unknown token"`, yet
 * prod `/health` kept serving
 *   {"status":"healthy","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}
 *
 * That is not a rounding error in a heuristic — `anchoring.status` was a
 * hardcoded literal. In compact mode (`/health` with no `?detailed=true`, i.e.
 * what every monitor, uptime check and deploy gate actually reads)
 * `buildHealthResponse` skipped all enrichment and emitted `'ok'`
 * unconditionally. Nothing in the process had ever contacted the RPC provider.
 * A dead anchoring credential was therefore invisible to every monitor, alert
 * and soak that trusts /health — and because soak evidence across this repo
 * cites /health as proof of anchoring liveness, the blast radius included
 * evidence integrity, not just paging.
 *
 * `batch-drain-deadman.ts` already closed the adjacent hole (a backlog aging
 * without being drained) and its header explicitly names the remaining one:
 * "/health hardcodes anchoring.status='ok'". This module closes that one, for
 * the credential itself.
 *
 * ─── Why this is safe to run on a public, high-frequency endpoint ───
 * /health is polled by the Cloudflare LB monitor (30s), the GCP uptime check
 * (60s), deploy verification and the soak harnesses. Adding an unbounded
 * external call per request would turn a GetBlock outage into a health-check
 * failure and could rate-limit the provider. So:
 *
 *   1. TTL cache (60s). At `--min-instances 2` this is ~2 probes/minute
 *      against the provider, per-instance caches included. Trivial load.
 *   2. Hard 2.5s timeout on the request AND a separate bound on the body read
 *      (an `AbortSignal` does NOT cover a provider that sends headers then
 *      stalls — the same F-D0-5 lesson already learned in utxo-provider.ts).
 *      The bound comes from the sanctioned `utils/body-read-timeout.ts`
 *      primitive, not a local re-implementation: it is a zero-dependency leaf
 *      module, so importing it pulls nothing into the /health path, and it
 *      additionally cancels the abandoned stream (a local race leaks a
 *      half-open socket on every 60s refresh while a provider stays wedged).
 *   3. The read path NEVER awaits the network. `read()` is synchronous: it
 *      returns the cached snapshot and schedules a refresh when stale. A
 *      wedged provider therefore adds exactly 0ms to /health latency, so this
 *      cannot create a restart loop or trip a monitor timeout.
 *   4. Failure is a STATE, never an exception. `probeAnchoringRpcOnce` and
 *      `read()` do not throw.
 *
 * ─── §1.4: the URL is itself a secret ───
 * Prod `BITCOIN_RPC_URL` carries the access token in the URL PATH
 * (`https://go.getblock.io/<ACCESS_TOKEN>`), and /health is public and
 * unauthenticated. Nothing here may emit the full URL: only the sanitized
 * ORIGIN ever leaves this module, and the origin itself is confined to the
 * `?detailed=true` view (SCRUM-2653) by the caller.
 *
 * Constitution refs:
 *   - 1.4: no secrets in responses or logs; treasury credentials never logged.
 *   - 1.5: states what is MEASURED (a live authenticated call) vs merely
 *     asserted (config presence). `unknown` is reported as unknown, never ok.
 *   - 1.9: /health always available — this can only enrich, never fail, it.
 */

import { BodyReadTimeoutError, readJsonBounded } from '../utils/body-read-timeout.js';

/** Hard timeout for a single probe. Well under any monitor's own timeout. */
export const ANCHORING_RPC_TIMEOUT_MS = 2_500;

/** Cache lifetime of a probe verdict. See "why this is safe" above. */
export const ANCHORING_RPC_TTL_MS = 60_000;

/**
 * Cheapest read-only JSON-RPC method that still exercises AUTHENTICATION.
 * `getblockcount` takes no params, returns a single integer, and is rejected
 * with 401 by GetBlock when the access token is revoked — which is precisely
 * the condition that went undetected in production.
 */
const PROBE_METHOD = 'getblockcount';

/**
 * Honest state taxonomy. The whole point of this module is that `ok` is
 * reserved for a state we actually VERIFIED — everything else is named for
 * what we know, and `unknown` is a first-class answer rather than a silent
 * `ok`.
 */
export type AnchoringRpcState =
  /** A live authenticated call succeeded. Measured, not assumed. */
  | 'ok'
  /** HTTP 401/403 — the credential is dead. Definitive and actionable. */
  | 'unauthenticated'
  /** Network error or provider fault (5xx). Transient, not a credential verdict. */
  | 'unreachable'
  /** Timed out, or not probed yet (cold cache). We do not know. */
  | 'unknown'
  /** No RPC URL configured (local dev / preview). Nothing to probe. */
  | 'not_configured';

export interface AnchoringRpcProbeResult {
  state: AnchoringRpcState;
  /** Sanitized ORIGIN only — never the full URL, which carries the token. */
  endpoint: string | null;
  /** Wall-clock ms of the probe, or null when never probed. */
  checkedAtMs: number | null;
  /** HTTP status, when a response was actually received. */
  httpStatus?: number;
  /** Chain tip height when state === 'ok'. Proof the call really executed. */
  blockHeight?: number | null;
  /** Short, bounded, secret-free reason. */
  message?: string;
}

export interface AnchoringRpcProbeConfig {
  rpcUrl: string | undefined;
  rpcAuth?: string;
}

export interface AnchoringRpcProbeDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * §1.4: reduce the credential-bearing URL to its origin. Mirrors
 * `sanitizeRpcUrlForError` in chain/utxo-provider.ts; duplicated deliberately
 * so this monitoring module has no runtime import of the chain/ graph (which
 * pulls config, bitcoinjs-lib and the signing providers into the /health path).
 */
export function sanitizeRpcEndpoint(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin;
  } catch {
    return 'bitcoin-rpc';
  }
}

function isTimeoutLike(err: unknown): boolean {
  if (err instanceof BodyReadTimeoutError) return true;
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}

/**
 * Perform ONE probe. Never throws — every failure mode is classified into a
 * state so the caller (a public health endpoint) cannot be made to 500.
 */
export async function probeAnchoringRpcOnce(
  config: AnchoringRpcProbeConfig,
  deps: AnchoringRpcProbeDeps = {},
): Promise<AnchoringRpcProbeResult> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { rpcUrl, rpcAuth } = config;

  if (!rpcUrl || rpcUrl.trim().length === 0) {
    return {
      state: 'not_configured',
      endpoint: null,
      checkedAtMs: now(),
      message: 'BITCOIN_RPC_URL not configured',
    };
  }

  const endpoint = sanitizeRpcEndpoint(rpcUrl);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (rpcAuth) {
    headers.Authorization = `Basic ${Buffer.from(rpcAuth).toString('base64')}`;
  }

  try {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'health-probe', method: PROBE_METHOD, params: [] }),
      signal: AbortSignal.timeout(ANCHORING_RPC_TIMEOUT_MS),
    });

    // ─── The regression that hid the 2026-08-30 outage ───
    // A revoked GetBlock token answers 401 "Unknown token". This is a
    // DEFINITIVE verdict on the credential, not a transient blip, which is
    // why it is the only state allowed to degrade the reported health.
    if (response.status === 401 || response.status === 403) {
      // Nothing reads this body; release the socket back to the pool instead of
      // waiting for GC. While a credential is dead this path repeats every TTL.
      void response.body?.cancel?.();
      return {
        state: 'unauthenticated',
        endpoint,
        checkedAtMs: now(),
        httpStatus: response.status,
        message: 'RPC credential rejected by provider',
      };
    }

    if (!response.ok) {
      void response.body?.cancel?.();
      return {
        state: 'unreachable',
        endpoint,
        checkedAtMs: now(),
        httpStatus: response.status,
        message: `RPC provider returned HTTP ${response.status}`,
      };
    }

    // §1.4 caller contract of readJsonBounded: `url` is embedded verbatim in
    // BodyReadTimeoutError.message. `rpcUrl` carries the GetBlock access token
    // in its PATH, so the SANITIZED origin is passed — never the raw URL.
    const parsed = (await readJsonBounded(response, endpoint, ANCHORING_RPC_TIMEOUT_MS)) as {
      result?: unknown;
      error?: { message?: unknown; code?: unknown } | null;
    } | null;

    // Some providers answer 200 with a JSON-RPC error envelope. Never treat
    // that as a verified-healthy credential.
    //
    // Bitcoin Core-compatible nodes and several hosted providers signal a dead
    // or unauthorized credential this way instead of with a 401 — so an
    // auth-shaped envelope must degrade exactly like a 401 does, or this module
    // re-opens the very defect it exists to close for that provider style.
    // Non-auth envelopes (a bad method, a node-side error) stay `unreachable`:
    // they are not credential evidence and must not flap the deploy gates.
    if (parsed && typeof parsed === 'object' && parsed.error != null) {
      const authShaped = isAuthShapedRpcError(parsed.error);
      return {
        state: authShaped ? 'unauthenticated' : 'unreachable',
        endpoint,
        checkedAtMs: now(),
        httpStatus: response.status,
        message: authShaped
          ? 'RPC credential rejected by provider (JSON-RPC error envelope)'
          : 'RPC provider returned a JSON-RPC error',
      };
    }

    // `ok` is the one state that asserts a call was VERIFIED, so it requires the
    // height the call asked for. An empty object, `{"result":null}` or a proxy
    // interstitial is not proof of a live credential — report it as unreachable
    // (which does not degrade) rather than manufacturing a verified `ok`.
    if (typeof parsed?.result !== 'number') {
      return {
        state: 'unreachable',
        endpoint,
        checkedAtMs: now(),
        httpStatus: response.status,
        message: 'RPC provider returned no block height',
      };
    }

    return {
      state: 'ok',
      endpoint,
      checkedAtMs: now(),
      httpStatus: response.status,
      blockHeight: parsed.result,
    };
  } catch (err) {
    // §1.4: `err` may embed the full request URL (and therefore the token) in
    // its message — never propagate it. Only our own fixed strings escape.
    if (isTimeoutLike(err)) {
      return {
        state: 'unknown',
        endpoint,
        checkedAtMs: now(),
        message: `RPC probe timed out after ${ANCHORING_RPC_TIMEOUT_MS}ms`,
      };
    }
    return {
      state: 'unreachable',
      endpoint,
      checkedAtMs: now(),
      message: 'RPC probe failed to reach provider',
    };
  }
}

/**
 * Is a JSON-RPC error envelope an AUTH failure rather than a node-side error?
 *
 * Deliberately conservative: only unambiguous credential signals qualify, because
 * a false positive degrades `anchoring` and blocks deploys. JSON-RPC reserves
 * -32000..-32099 for implementation-defined server errors, which is where hosted
 * providers put "unauthorized"/"unknown token"; Bitcoin Core uses -32601 for an
 * unknown method, which is NOT an auth signal and must stay `unreachable`.
 */
export function isAuthShapedRpcError(err: { message?: unknown; code?: unknown } | null): boolean {
  if (!err) return false;
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  return /unauthor|unauthenticated|forbidden|access denied|invalid (?:api[- ]?key|token|credential)|unknown token|bad credential/.test(
    message,
  );
}

export interface AnchoringRpcVerdict {
  /** Constrained to the EXISTING `anchoring.status` union — see below. */
  status: 'ok' | 'warning';
  /** True only when a live authenticated call actually succeeded. */
  credentialVerified: boolean;
  state: AnchoringRpcState;
}

/**
 * Map a probe result onto the health verdict.
 *
 * Two deliberate constraints:
 *
 * 1. The output status stays inside the EXISTING `'ok' | 'warning'` union.
 *    `scripts/staging/targeted/health-batch-drain-deadman.ts` hard-validates
 *    `checks.anchoring.status` against exactly that set and throws on anything
 *    else, so introducing a third value would break a targeted soak validator.
 *    The new detail lives in an additive `rpc` sub-object instead (no consumer
 *    in the repo rejects unknown keys — verified).
 *
 * 2. ONLY `unauthenticated` degrades. `unreachable` / `unknown` are transient
 *    or unproven, and `verify-worker-runtime.yml` + `deploy-staging.yml` assert
 *    `anchoring == "ok"`, so degrading on them would let a brief GetBlock blip
 *    block deploys and flap the gates. A 401/403 is definitive, non-transient
 *    and actionable — exactly the signal that was missing — so it, and only it,
 *    is allowed to go loud.
 */
export interface AnchoringRpcVerdictOptions {
  /**
   * `cfg.enableProdNetworkAnchoring`. When anchoring is ON, a MISSING RPC URL is
   * a definitive, non-transient misconfiguration — the worker intends to anchor
   * and cannot. Reporting `ok` there is the same manufactured-ok this module
   * exists to remove: `config.ts` maps an unset OR literally `"placeholder"`
   * BITCOIN_RPC_URL to undefined, so a dropped secret would otherwise be
   * indistinguishable from a verified-live credential. Off-prod an unset URL is
   * expected and stays `ok`.
   */
  prodAnchoringEnabled?: boolean;
}

export function evaluateAnchoringRpcHealth(
  probe: AnchoringRpcProbeResult,
  opts: AnchoringRpcVerdictOptions = {},
): AnchoringRpcVerdict {
  const degraded =
    probe.state === 'unauthenticated' ||
    (probe.state === 'not_configured' && opts.prodAnchoringEnabled === true);
  return {
    status: degraded ? 'warning' : 'ok',
    credentialVerified: probe.state === 'ok',
    state: probe.state,
  };
}

export interface AnchoringRpcMonitor {
  /**
   * Current snapshot. Synchronous, never blocks on the network, never throws.
   * Schedules a background refresh when the cached value is older than the TTL.
   */
  read(): AnchoringRpcProbeResult;
  /** Resolves when any in-flight refresh has settled (tests / shutdown). */
  settled(): Promise<void>;
}

export interface AnchoringRpcMonitorOptions {
  probe: () => Promise<AnchoringRpcProbeResult>;
  ttlMs?: number;
  now?: () => number;
}

/**
 * TTL-cached, non-blocking wrapper around a probe.
 *
 * The cache is per-instance and per-process. At `--min-instances 2` that is at
 * most two independent probes per TTL window, which is the intended cost: a
 * shared cache would need external state on the one path that must keep working
 * when external state is down.
 */
export function createAnchoringRpcMonitor(opts: AnchoringRpcMonitorOptions): AnchoringRpcMonitor {
  const ttlMs = opts.ttlMs ?? ANCHORING_RPC_TTL_MS;
  const now = opts.now ?? Date.now;

  const COLD: AnchoringRpcProbeResult = {
    state: 'unknown',
    endpoint: null,
    checkedAtMs: null,
    message: 'RPC not probed yet',
  };

  let snapshot: AnchoringRpcProbeResult = COLD;
  let inFlight: Promise<void> | null = null;

  function refresh(): void {
    // Collapse concurrent refreshes — a burst of health checks must produce
    // one provider call, not one per request.
    if (inFlight) return;

    inFlight = opts
      .probe()
      .then((result) => {
        snapshot = result;
      })
      .catch(() => {
        // A probe that rejects outright must not poison /health, and must not
        // silently look healthy. Keep a definitive dead-credential verdict;
        // otherwise report honest ignorance.
        //
        // Either way STAMP `checkedAtMs`: leaving it null would make `age`
        // Infinity on every subsequent read, so a persistently failing probe
        // would fire one provider call PER health check instead of one per
        // TTL — a hot loop against the provider on the exact endpoint the
        // Cloudflare LB (30s) and GCP uptime check (60s) poll constantly.
        snapshot =
          snapshot.state === 'unauthenticated'
            ? { ...snapshot, checkedAtMs: now() }
            : { ...COLD, checkedAtMs: now(), message: 'RPC probe failed' };
      })
      .finally(() => {
        inFlight = null;
      });
  }

  // HIGH (review 2026-08-31): probe at CONSTRUCTION, not on first read.
  //
  // `deploy-staging.yml` and `verify-worker-runtime.yml` each issue exactly one
  // health curl against a freshly deployed revision — always inside the cold
  // window. If the first probe only fires on first read(), those gates evaluate
  // the COLD snapshot (`unknown` -> compact `ok`) and a revoked credential reads
  // healthy at precisely the moment the gate checks it. Starting the probe when
  // the process starts moves it off the request path entirely and gives it the
  // whole container start-up to resolve. Fire-and-forget: refresh() already
  // swallows rejection and collapses concurrent calls.
  refresh();

  return {
    read(): AnchoringRpcProbeResult {
      const age = snapshot.checkedAtMs === null ? Infinity : now() - snapshot.checkedAtMs;
      if (age >= ttlMs) refresh();
      // Always the CURRENT snapshot: a stale-but-known verdict beats blocking,
      // and a pending refresh never upgrades a dead credential back to 'ok'.
      return snapshot;
    },
    async settled(): Promise<void> {
      while (inFlight) {
        await inFlight;
      }
    },
  };
}
