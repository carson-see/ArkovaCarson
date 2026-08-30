/**
 * scripts/staging/targeted/cft-contract-surface-driver.ts
 *
 * Targeted soak driver for the `contract-frontend-tooling` batch
 * (PRs #2274, #2433, #2473, #2481, #2484, #2490, #2491, #2493, #2500).
 *
 * WHAT THIS DRIVER EXERCISES (and what it deliberately does NOT):
 *
 *   * #2274 — the PUBLISHED-SHAPE `arkova` SDK artifact. The driver imports the
 *     package from a `npm pack`-produced tarball installed into a throwaway
 *     consumer project, NOT from `packages/sdk/src`. Every contract call below
 *     goes through that installed artifact, so a broken `exports` map, a missing
 *     `dist/`, or a bad `files` allow-list fails the cycle rather than passing
 *     because the repo source happened to be on disk.
 *
 *   * #2433 — `anchor.superseded` registration drift. Two halves:
 *       (a) REGISTRATION: `webhooks.create({ events: ['anchor.superseded'] })`
 *           through the installed SDK, proving the worker's subscription
 *           allow-list accepts the event the client surfaces now list.
 *       (b) DELIVERY: `POST /api/anchor/:id/supersede` on a real SECURED anchor,
 *           then a poll of `webhook_delivery_logs` for an `anchor.superseded`
 *           row whose response status is 2xx against the sink. Registration
 *           drift is only a defect if the event is genuinely deliverable — the
 *           delivery is what makes the drift load-bearing.
 *
 *   * Supporting worker health for the whole batch (`GET /health`).
 *
 *   * It does NOT exercise #2481 / #2484 / #2500 changed behaviour — those are
 *     CI/hook/test-infra substance with no runtime surface on a worker. Their
 *     evidence is the targeted local checks recorded in the stand-up doc, plus
 *     CI. This driver's counts must never be presented as covering them.
 *
 * TRANSPORT NOTE (honest disclosure): the rig's Cloud Run service is deployed
 * `--no-allow-unauthenticated`, so every request additionally carries a Google
 * identity token. It is sent in `X-Serverless-Authorization` — Cloud Run's own
 * header for exactly this case — so the app-level `Authorization` (org-admin
 * JWT) and `X-API-Key` both reach the worker untouched. `globalThis.fetch` is
 * wrapped to add that one header for the rig origin only; nothing about the
 * SDK's own request shaping is altered.
 *
 * Usage:
 *   STAGING_API_BASE=https://<rig-service>.run.app \
 *   RIG_SUPABASE_URL=https://<ref>.supabase.co \
 *   RIG_SERVICE_ROLE_KEY=... \
 *   ARKOVA_API_KEY=ak_... \
 *   WEBHOOK_SINK_URL=https://<sink>.run.app/sink \
 *   SDK_MODULE=/abs/path/to/consumer/node_modules/arkova/dist/index.mjs \
 *   EVIDENCE_OUT=docs/staging/contract-frontend-tooling/evidence \
 *   npx tsx scripts/staging/targeted/cft-contract-surface-driver.ts --cycles 1
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface CycleCounts {
  ok: number;
  fail: number;
  detail: Record<string, { ok: number; fail: number; last?: string }>;
}

const API_BASE = requireEnv('STAGING_API_BASE').replace(/\/+$/, '');
const SUPABASE_URL = requireEnv('RIG_SUPABASE_URL').replace(/\/+$/, '');
const SERVICE_ROLE_KEY = requireEnv('RIG_SERVICE_ROLE_KEY');
const API_KEY = requireEnv('ARKOVA_API_KEY');
const SINK_URL = requireEnv('WEBHOOK_SINK_URL');
const SDK_MODULE = requireEnv('SDK_MODULE');
const SINK_READBACK = process.env.SINK_READBACK ?? '';
const EVIDENCE_OUT = process.env.EVIDENCE_OUT ?? 'docs/staging/contract-frontend-tooling/evidence';
const SEED_PUBLIC_ID = process.env.SEED_PUBLIC_ID ?? '';
const SEED_FINGERPRINT = process.env.SEED_FINGERPRINT ?? '';
const RIG_ANON_KEY = process.env.RIG_ANON_KEY ?? '';
const CALLER_EMAIL = process.env.CALLER_EMAIL ?? '';
const CALLER_USER_ID = process.env.CALLER_USER_ID ?? '';
const CALLER_ORG_ID = process.env.CALLER_ORG_ID ?? '';
const CALLER_PASSWORD = process.env.CALLER_PASSWORD ?? '';

const cyclesArgIndex = process.argv.indexOf('--cycles');
const CYCLES = cyclesArgIndex >= 0 ? Number(process.argv[cyclesArgIndex + 1]) : 1;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} is required`);
    process.exit(2);
  }
  return v;
}

/** Refresh the Cloud Run identity token each cycle — they expire in ~1h. */
function identityToken(): string {
  return execFileSync('gcloud', ['auth', 'print-identity-token'], { encoding: 'utf8' }).trim();
}

/**
 * Wrap globalThis.fetch so requests to the rig origin carry the Cloud Run
 * identity token. The SDK uses X-API-Key for app auth, so there is no clash.
 */
function installFetchShim(idToken: string): void {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(API_BASE)) {
      const headers = new Headers(init?.headers ?? {});
      // Cloud Run validates X-Serverless-Authorization for IAM and passes
      // Authorization through to the container untouched — so the SDK's
      // X-API-Key and the org-admin JWT both reach the worker unmodified.
      headers.set('x-serverless-authorization', `Bearer ${idToken}`);
      return original(input, { ...init, headers });
    }
    return original(input, init);
  }) as typeof globalThis.fetch;
}

async function sbRest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * Sign in as the rig's seeded ORG_ADMIN through GoTrue every cycle. A soak
 * outlives a single access token (~1h), so a token captured at stand-up would
 * silently 401 the supersede path for most of the window and the driver would
 * look green on the SDK half while the delivery half quietly stopped running.
 */
async function callerJwt(): Promise<string | null> {
  if (!RIG_ANON_KEY || !CALLER_EMAIL || !CALLER_PASSWORD) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: RIG_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: CALLER_EMAIL, password: CALLER_PASSWORD }),
  });
  if (!r.ok) return null;
  const body = (await r.json()) as { access_token?: string };
  return body.access_token ?? null;
}

function record(c: CycleCounts, name: string, ok: boolean, note?: string): void {
  c.detail[name] ??= { ok: 0, fail: 0 };
  if (ok) {
    c.detail[name].ok += 1;
    c.ok += 1;
  } else {
    c.detail[name].fail += 1;
    c.fail += 1;
  }
  if (note) c.detail[name].last = note;
}

async function runCycle(cycleId: string): Promise<CycleCounts> {
  const counts: CycleCounts = { ok: 0, fail: 0, detail: {} };
  const idToken = identityToken();
  installFetchShim(idToken);

  // ── worker health (supporting evidence for the whole batch) ────────────
  try {
    const r = await fetch(`${API_BASE}/health`);
    const body = (await r.json()) as { status?: string; git_sha?: string };
    record(counts, 'health', r.ok && body.status === 'healthy', `http ${r.status} git_sha=${body.git_sha ?? '?'}`);
  } catch (e) {
    record(counts, 'health', false, String(e));
  }

  // ── #2274: published-shape SDK artifact contract round-trip ────────────
  const mod = (await import(SDK_MODULE)) as { Arkova: new (cfg: Record<string, unknown>) => Record<string, any> };
  const arkova = new mod.Arkova({ apiKey: API_KEY, baseUrl: API_BASE, retry: { retries: 1 } });

  try {
    const fp = await arkova.fingerprint('cft-soak-' + cycleId);
    record(counts, 'sdk.fingerprint', typeof fp === 'string' && fp.length === 64, fp?.slice(0, 16));
  } catch (e) {
    record(counts, 'sdk.fingerprint', false, String(e));
  }

  if (SEED_PUBLIC_ID) {
    try {
      const v = await arkova.verify(SEED_PUBLIC_ID);
      record(counts, 'sdk.verify', Boolean(v), JSON.stringify(v).slice(0, 120));
    } catch (e) {
      record(counts, 'sdk.verify', false, String(e));
    }
    try {
      const a = await arkova.getAnchor(SEED_PUBLIC_ID);
      record(counts, 'sdk.getAnchor', Boolean(a), JSON.stringify(a).slice(0, 120));
    } catch (e) {
      record(counts, 'sdk.getAnchor', false, String(e));
    }
  }

  if (SEED_FINGERPRINT) {
    try {
      const f = await arkova.verifyFingerprint(SEED_FINGERPRINT);
      record(counts, 'sdk.verifyFingerprint', Boolean(f), JSON.stringify(f).slice(0, 120));
    } catch (e) {
      record(counts, 'sdk.verifyFingerprint', false, String(e));
    }
  }

  // ── #2433 (a): registration of anchor.superseded through the SDK ───────
  let webhookId: string | undefined;
  try {
    const created = await arkova.webhooks.create({
      url: SINK_URL,
      events: ['anchor.superseded'],
      description: `cft-soak ${cycleId}`,
    });
    webhookId = created?.id;
    record(counts, 'sdk.webhooks.create[anchor.superseded]', Boolean(webhookId), `id=${webhookId ?? 'none'}`);
  } catch (e) {
    record(counts, 'sdk.webhooks.create[anchor.superseded]', false, String(e));
  }

  try {
    const list = await arkova.webhooks.list({ limit: 50 });
    const items = (list?.webhooks ?? []) as Array<{ events?: string[] }>;
    const hit = items.some((w) => (w.events ?? []).includes('anchor.superseded'));
    record(counts, 'sdk.webhooks.list[anchor.superseded]', hit, `n=${items.length} total=${list?.total ?? '?'}`);
  } catch (e) {
    record(counts, 'sdk.webhooks.list[anchor.superseded]', false, String(e));
  }

  // ── #2433 (b): real anchor.superseded delivery ─────────────────────────
  const jwt = await callerJwt();
  record(counts, 'auth.orgAdminSignIn', Boolean(jwt), jwt ? `token len=${jwt.length}` : 'sign-in failed');
  if (jwt) {
    try {
      // Mint a fresh SECURED target per cycle: the seeded org anchor carries
      // legal_hold=true (409 'Cannot supersede anchor under legal hold'), and
      // reusing one target would make the second cycle a no-op anyway — a
      // superseded anchor cannot be superseded again.
      const hex = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
      const mk = await sbRest('anchors', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({
          user_id: CALLER_USER_ID,
          org_id: CALLER_ORG_ID,
          filename: `cft_soak_supersede_${cycleId}.pdf`,
          fingerprint: hex(),
          status: 'SECURED',
          file_size: 2048,
          file_mime: 'application/pdf',
          legal_hold: false,
          chain_tx_id: hex(),
          chain_block_height: 210_000,
          chain_timestamp: new Date().toISOString(),
        }),
      });
      const rows = (await mk.json()) as Array<{ id: string; public_id: string }>;
      if (!Array.isArray(rows) || !rows.length) {
        record(counts, 'supersede.target', false, `mint failed http ${mk.status} ${JSON.stringify(rows).slice(0, 160)}`);
      } else {
        record(counts, 'supersede.target', true, `minted ${rows[0].public_id}`);
        const target = rows[0];
        const newFp = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
        const r = await fetch(`${API_BASE}/api/anchor/${target.id}/supersede`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
            'x-cloud-run-id-token': idToken,
          },
          body: JSON.stringify({ new_fingerprint: newFp, reason: `cft-soak ${cycleId}` }),
        });
        const txt = (await r.text()).slice(0, 200);
        record(counts, 'supersede.dispatch', r.ok, `http ${r.status} ${txt}`);

        if (r.ok) {
          // Give the async dispatcher a moment, then read the delivery log.
          await new Promise((res) => setTimeout(res, 4000));
          const dl = await sbRest(
            `webhook_delivery_logs?event_type=eq.anchor.superseded&select=id,event_type,response_status,created_at&order=created_at.desc&limit=5`,
          );
          const logs = (await dl.json()) as Array<{ response_status?: number | null; created_at?: string }>;
          const delivered = logs.find((l) => typeof l.response_status === 'number' && l.response_status >= 200 && l.response_status < 300);
          record(
            counts,
            'webhook.delivery[anchor.superseded]',
            Boolean(delivered),
            delivered
              ? `status=${delivered.response_status} at=${delivered.created_at}`
              : `rows=${logs.length} statuses=${logs.map((l) => l.response_status).join(',')}`,
          );

          // Independent confirmation from the receiving end: the worker's own
          // delivery log is its claim about the POST; the sink's read-back is
          // the endpoint saying it actually arrived.
          if (SINK_READBACK) {
            try {
              const sk = await fetch(SINK_READBACK);
              const got = (await sk.json()) as Array<{ at: string; body: string }>;
              const superseded = got.filter((g) => (g.body ?? '').includes('anchor.superseded'));
              record(
                counts,
                'sink.received[anchor.superseded]',
                superseded.length > 0,
                `sink rows=${got.length} superseded=${superseded.length} newest=${superseded.at(-1)?.at ?? 'none'}`,
              );
            } catch (e) {
              record(counts, 'sink.received[anchor.superseded]', false, String(e));
            }
          }
        }
      }
    } catch (e) {
      record(counts, 'supersede.dispatch', false, String(e));
    }
  }

  // ── cleanup: drop the per-cycle subscription so the rig does not grow ──
  if (webhookId) {
    try {
      await arkova.webhooks.delete(webhookId);
    } catch {
      /* non-fatal */
    }
  }

  return counts;
}

async function main(): Promise<void> {
  mkdirSync(resolve(EVIDENCE_OUT), { recursive: true });
  for (let i = 0; i < CYCLES; i += 1) {
    const cycleId = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const counts = await runCycle(cycleId);
    const artifact = {
      driver: 'cft-contract-surface-driver',
      batch: 'contract-frontend-tooling',
      cycle_id: cycleId,
      captured_at: new Date().toISOString(),
      api_base: API_BASE,
      supabase_ref: SUPABASE_URL,
      ok: counts.ok,
      fail: counts.fail,
      detail: counts.detail,
    };
    const out = resolve(EVIDENCE_OUT, `load-${cycleId}.json`);
    writeFileSync(out, JSON.stringify(artifact, null, 2));
    console.log(`[${cycleId}] ok=${counts.ok} fail=${counts.fail} -> ${out}`);
    for (const [k, v] of Object.entries(counts.detail)) {
      console.log(`    ${k}: ok=${v.ok} fail=${v.fail}${v.last ? ` last=${v.last}` : ''}`);
    }
  }
}

main().catch((e) => {
  console.error('driver fatal', e);
  process.exit(1);
});
