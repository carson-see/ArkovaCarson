/**
 * scripts/soak/loadgen.ts — durable synthetic load generator for the
 * 2026-08 72h soak pair (launch-72h-2026-08 / legacy-soak-2026-08).
 *
 * SCRUM-2980. Deployed standalone (own Dockerfile, no dependency on the
 * services/worker build) as a small always-on Cloud Run service, one
 * instance per rig (min-instances=1), so it survives this laptop sleeping
 * and runs for the full 72h window. See scripts/soak/agents.md for the
 * deploy commands and rig config.
 *
 * Design (docs/release/72h-soak-runbook-2026-08.md §0.6):
 *   - Read:write ratio ~10:1 (A4). Reads dominate: lifecycle/proof lookups,
 *     usage checks. Writes: single anchor creates + small bulk batches.
 *   - Sustained + periodic burst window (A3): every BURST_EVERY_MIN minutes,
 *     run a BURST_DURATION_MIN-minute window at BURST_RPS instead of
 *     SUSTAINED_RPS.
 *   - Malformed/edge-case slice for the EDGE CASES evidence pillar (§5):
 *     bad fingerprint, no-auth request, over-cap bulk batch (expects 400
 *     from Zod, not a crash).
 *   - Does NOT force real broadcasts. Anchor creates land as PENDING/QUEUED
 *     rows; the rig's own Cloud Scheduler cron (batch-anchors, every 5 min) decides
 *     when to actually broadcast, per the existing Trigger A/B/D batching
 *     logic already deployed to the rig. This keeps treasury spend bounded
 *     to the cron's natural cadence (a handful of broadcasts/day) instead
 *     of one broadcast per synthetic anchor create — see the loadgen
 *     provenance note in docs/staging/*-2026-08/loadgen-*.json for the
 *     sats-per-day math this assumes.
 *
 * No external dependencies — built-in fetch + crypto only, so this can be
 * built into a ~20-line Dockerfile independent of the worker's own image.
 */

import { randomBytes } from 'node:crypto';

interface Config {
  label: string;
  baseUrl: string;
  apiKey: string;
  seedPublicIds: string[];
  sustainedRps: number;
  burstRps: number;
  burstEveryMin: number;
  burstDurationMin: number;
  tickMs: number;
  maxInFlight: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

/** Strips trailing slashes without a regex — SonarCloud typescript:S8786
 *  flagged `/\/+$/` as super-linear (a single quantifier immediately before
 *  an anchor is a shape its regex-complexity heuristic treats as risky,
 *  though this particular pattern is provably linear: no alternation or
 *  nested quantifiers to create backtracking ambiguity). A loop sidesteps
 *  the question entirely and is exactly as correct. */
function stripTrailingSlashes(url: string): string {
  let result = url;
  while (result.endsWith('/')) result = result.slice(0, -1);
  return result;
}

function loadConfig(): Config {
  return {
    label: requireEnv('RIG_LABEL'),
    baseUrl: stripTrailingSlashes(requireEnv('RIG_BASE_URL')),
    apiKey: requireEnv('RIG_API_KEY'),
    seedPublicIds: (process.env.RIG_SEED_PUBLIC_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    sustainedRps: Number(process.env.SUSTAINED_RPS ?? '3'),
    burstRps: Number(process.env.BURST_RPS ?? '9'),
    burstEveryMin: Number(process.env.BURST_EVERY_MIN ?? '30'),
    burstDurationMin: Number(process.env.BURST_DURATION_MIN ?? '5'),
    tickMs: Number(process.env.TICK_MS ?? '500'),
    maxInFlight: Number(process.env.MAX_IN_FLIGHT ?? '60'),
  };
}

// ─── GCP identity token (metadata server; no google-auth-library dep) ───

const idTokenCache = new Map<string, { token: string; expiresAtMs: number }>();

async function getIdentityToken(audience: string): Promise<string> {
  const cached = idTokenCache.get(audience);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now + 60_000) return cached.token;

  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`;
  const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata identity token fetch failed: ${res.status} ${await res.text()}`);
  const token = await res.text();
  // Cloud Run identity tokens are ~1h; refresh proactively at 50m.
  idTokenCache.set(audience, { token, expiresAtMs: now + 50 * 60_000 });
  return token;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function randomFingerprint(): string {
  return randomHex(32); // 64 hex chars
}

/** Crypto-backed drop-in for Math.random() — same [0, 1) contract, built on
 *  the `randomBytes` already imported for fingerprint generation above.
 *  None of this file's random picks (which target to hit, how big a batch,
 *  which weighted action to fire) are security-sensitive on their own, but
 *  SonarCloud typescript:S2245 flags Math.random() categorically, and since
 *  a real CSPRNG is already one call away here, there's no reason to keep
 *  Math.random() around to litigate case by case. */
function secureRandomFloat(): number {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

// ─── metrics ───

const metrics = {
  byAction: new Map<string, { count: number; status2xx: number; status4xx: number; status5xx: number; errors: number }>(),
  windowStart: Date.now(),
};

function record(action: string, status: number | null, err?: unknown) {
  let m = metrics.byAction.get(action);
  if (!m) {
    m = { count: 0, status2xx: 0, status4xx: 0, status5xx: 0, errors: 0 };
    metrics.byAction.set(action, m);
  }
  m.count += 1;
  if (err) m.errors += 1;
  else if (status && status >= 500) m.status5xx += 1;
  else if (status && status >= 400) m.status4xx += 1;
  else if (status && status >= 200) m.status2xx += 1;
}

function logSummary(cfg: Config) {
  const elapsedS = (Date.now() - metrics.windowStart) / 1000;
  let total = 0;
  const rows: string[] = [];
  for (const [action, m] of metrics.byAction) {
    total += m.count;
    rows.push(`${action}=${m.count}(2xx:${m.status2xx} 4xx:${m.status4xx} 5xx:${m.status5xx} err:${m.errors})`);
  }
  const rps = (total / elapsedS).toFixed(2);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      rig: cfg.label,
      window_s: Math.round(elapsedS),
      total_requests: total,
      achieved_rps: rps,
      actions: rows,
    }),
  );
}

// ─── request helpers ───

async function authedFetch(cfg: Config, path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${cfg.baseUrl}${path}`;
  const idToken = await getIdentityToken(cfg.baseUrl);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${idToken}`); // Cloud Run IAM (private ingress)
  headers.set('X-API-Key', cfg.apiKey); // app-level org auth
  if (init.body) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}

async function noAuthFetch(cfg: Config, path: string): Promise<Response> {
  // still needs the Cloud Run IAM token (private ingress) — this exercises
  // the APP-level auth-missing 401/403 path, not the infra ingress gate.
  const idToken = await getIdentityToken(cfg.baseUrl);
  return fetch(`${cfg.baseUrl}${path}`, { headers: { Authorization: `Bearer ${idToken}` } });
}

// ─── weighted action pool ───

let knownPublicIds: string[] = [];

type Action = (cfg: Config) => Promise<void>;

function pickPublicId(): string | null {
  if (knownPublicIds.length === 0) return null;
  return knownPublicIds[Math.floor(secureRandomFloat() * knownPublicIds.length)];
}

async function actLifecycleRead(cfg: Config) {
  const id = pickPublicId();
  if (!id) return record('lifecycle_read', null, 'no_seed_ids');
  try {
    const res = await authedFetch(cfg, `/api/v1/anchor/${id}/lifecycle`);
    record('lifecycle_read', res.status);
  } catch (e) {
    record('lifecycle_read', null, e);
  }
}

async function actProofRead(cfg: Config) {
  const id = pickPublicId();
  if (!id) return record('proof_read', null, 'no_seed_ids');
  try {
    const res = await authedFetch(cfg, `/api/v1/verify/${id}/proof`);
    record('proof_read', res.status);
  } catch (e) {
    record('proof_read', null, e);
  }
}

async function actUsageRead(cfg: Config) {
  try {
    const res = await authedFetch(cfg, `/api/v1/usage`);
    record('usage_read', res.status);
  } catch (e) {
    record('usage_read', null, e);
  }
}

async function actHealthRead(cfg: Config) {
  try {
    const res = await authedFetch(cfg, `/health`);
    record('health_read', res.status);
  } catch (e) {
    record('health_read', null, e);
  }
}

async function actSingleCreate(cfg: Config) {
  try {
    const res = await authedFetch(cfg, `/api/v1/anchor`, {
      method: 'POST',
      body: JSON.stringify({
        fingerprint: randomFingerprint(),
        credential_type: 'OTHER',
        description: `soak-loadgen ${cfg.label} single-create`,
      }),
    });
    record('anchor_create_single', res.status);
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { public_id?: string } | null;
      if (body?.public_id) {
        knownPublicIds.push(body.public_id);
        if (knownPublicIds.length > 500) knownPublicIds = knownPublicIds.slice(-500);
      }
    }
  } catch (e) {
    record('anchor_create_single', null, e);
  }
}

async function actBulkCreate(cfg: Config) {
  const rows = Array.from({ length: 5 + Math.floor(secureRandomFloat() * 10) }, () => ({
    fingerprint: randomFingerprint(),
    credential_type: 'OTHER' as const,
    description: `soak-loadgen ${cfg.label} bulk-create`,
  }));
  try {
    const res = await authedFetch(cfg, `/api/v1/anchor/bulk`, {
      method: 'POST',
      body: JSON.stringify({ anchors: rows, duplicate_strategy: 'skip' }),
    });
    record('anchor_create_bulk', res.status);
  } catch (e) {
    record('anchor_create_bulk', null, e);
  }
}

async function actMalformedFingerprint(cfg: Config) {
  try {
    const res = await authedFetch(cfg, `/api/v1/anchor`, {
      method: 'POST',
      body: JSON.stringify({ fingerprint: 'not-a-valid-fingerprint' }),
    });
    // expect 400 — record status either way, this is the edge-case pillar
    record('edge_malformed_fingerprint', res.status);
  } catch (e) {
    record('edge_malformed_fingerprint', null, e);
  }
}

async function actOverCapBulk(cfg: Config) {
  const rows = Array.from({ length: 1001 }, () => ({ fingerprint: randomFingerprint() }));
  try {
    const res = await authedFetch(cfg, `/api/v1/anchor/bulk`, {
      method: 'POST',
      body: JSON.stringify({ anchors: rows }),
    });
    // expect 400 (Zod .max(1000)) — no worker crash
    record('edge_overcap_bulk', res.status);
  } catch (e) {
    record('edge_overcap_bulk', null, e);
  }
}

async function actNoAuth(cfg: Config) {
  try {
    const res = await noAuthFetch(cfg, `/api/v1/anchor/${pickPublicId() ?? 'ARK-DOC-NOPE00'}/lifecycle`);
    record('edge_no_apikey', res.status);
  } catch (e) {
    record('edge_no_apikey', null, e);
  }
}

async function actDuplicateFingerprint(cfg: Config) {
  // idempotency check: reuse a known fingerprint twice in quick succession
  // via the bulk endpoint's own dedup path (skip strategy → 200, no double
  // charge) — exercises AC4 of anchor-bulk.ts.
  const fp = randomFingerprint();
  const row = { anchors: [{ fingerprint: fp }], duplicate_strategy: 'skip' as const };
  try {
    await authedFetch(cfg, `/api/v1/anchor/bulk`, { method: 'POST', body: JSON.stringify(row) });
    const res2 = await authedFetch(cfg, `/api/v1/anchor/bulk`, { method: 'POST', body: JSON.stringify(row) });
    record('edge_duplicate_fingerprint', res2.status);
  } catch (e) {
    record('edge_duplicate_fingerprint', null, e);
  }
}

// weights sum doesn't need to be 100; relative weight only.
const WEIGHTED_ACTIONS: Array<{ weight: number; run: Action }> = [
  { weight: 45, run: actLifecycleRead },
  { weight: 20, run: actProofRead },
  { weight: 15, run: actUsageRead },
  { weight: 8, run: actHealthRead },
  { weight: 5, run: actSingleCreate },
  { weight: 3, run: actBulkCreate },
  { weight: 2, run: actMalformedFingerprint },
  { weight: 1, run: actOverCapBulk },
  { weight: 1, run: actNoAuth },
];

const TOTAL_WEIGHT = WEIGHTED_ACTIONS.reduce((s, a) => s + a.weight, 0);

function pickAction() {
  let r = secureRandomFloat() * TOTAL_WEIGHT;
  for (const a of WEIGHTED_ACTIONS) {
    r -= a.weight;
    if (r <= 0) return a.run;
  }
  return WEIGHTED_ACTIONS[0].run;
}

// ─── main loop ───

let inFlight = 0;

function currentTargetRps(cfg: Config, tSinceStartMs: number): number {
  const cycleMs = cfg.burstEveryMin * 60_000;
  const posInCycle = cycleMs > 0 ? tSinceStartMs % cycleMs : 0;
  const burstMs = cfg.burstDurationMin * 60_000;
  return posInCycle < burstMs ? cfg.burstRps : cfg.sustainedRps;
}

async function main() {
  const cfg = loadConfig();
  knownPublicIds = [...cfg.seedPublicIds];
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'loadgen_start', config: { ...cfg, apiKey: '[redacted]' } }));

  // Periodic duplicate-fingerprint edge case, low frequency (every ~2 min),
  // run out-of-band from the main weighted pool so it doesn't crowd out
  // the volume/concurrency exercise.
  setInterval(() => {
    void actDuplicateFingerprint(cfg);
  }, 120_000);

  setInterval(() => logSummary(cfg), 60_000);

  const startedAtMs = Date.now();
  const tick = async () => {
    const targetRps = currentTargetRps(cfg, Date.now() - startedAtMs);
    const nPerTick = Math.max(0, Math.round((targetRps * cfg.tickMs) / 1000));
    for (let i = 0; i < nPerTick; i++) {
      if (inFlight >= cfg.maxInFlight) break;
      inFlight++;
      const run = pickAction();
      run(cfg)
        .catch(() => {})
        .finally(() => {
          inFlight--;
        });
    }
  };

  setInterval(() => {
    void tick();
  }, cfg.tickMs);
}

// Top-level await (not `main().catch(...)`) — SonarCloud typescript:S7785.
// Node 20+ ESM (this file's package.json is `"type": "module"`, tsconfig
// targets ES2022/NodeNext) supports this natively; it's equivalent to the
// promise-chain form but keeps a real stack/control-flow shape instead of a
// detached, unreturned promise floating at module scope.
try {
  await main();
} catch (e) {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'loadgen_fatal', error: String(e) }));
  process.exit(1);
}
