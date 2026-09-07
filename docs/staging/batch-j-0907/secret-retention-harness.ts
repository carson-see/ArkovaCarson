/**
 * Batch-J targeted soak harness — PR #2667 DocuSign refresh-token version retention.
 *
 * Drives the PR's OWN store module (`createGcpSecretManagerRefreshTokenStore`)
 * against the REAL Google Secret Manager API, on rig-only secrets, so the soak
 * exercises the changed behaviour rather than a re-implementation of it.
 *
 * NOT ASSERTED, and deliberately so: the DocuSign OAuth refresh that supplies the
 * rotated token. `integrations/oauth/docusign.ts` hardcodes account-d/account
 * .docusign.com with no env override, so a stub token endpoint is unreachable
 * without modifying the image — which would mean soaking code that is not the
 * code under review. This PR does not change that refresh, only what `put` does
 * with the value afterwards.
 *
 * Every subcommand prints ONE json object to stdout. Secret payloads are never
 * printed: values are reported as a sha256 prefix.
 */
import { createHash } from 'node:crypto';

import {
  createGcpSecretManagerRefreshTokenStore,
  selectSupersededVersions,
  type DocusignRefreshTokenStoreLogger,
} from '../../../services/worker/src/integrations/connectors/docusign-token-store.js';

const PROJECT = process.env.BATCH_J_PROJECT ?? 'arkova1';
const TOKEN = process.env.GCP_ACCESS_TOKEN;
if (!TOKEN) throw new Error('GCP_ACCESS_TOKEN is required');
const getAccessToken = async (): Promise<string> => TOKEN;

const sm = (path: string) => `https://secretmanager.googleapis.com/v1/${path}`;
const authHeaders = () => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });

function fp(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

interface LogEntry { level: string; obj: Record<string, unknown>; msg: string }
function captureLogger(entries: LogEntry[]): DocusignRefreshTokenStoreLogger {
  return {
    debug: (obj, msg) => entries.push({ level: 'debug', obj, msg }),
    info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
  };
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(sm(path), { ...init, headers: authHeaders() });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

/** Every ENABLED/DISABLED version, newest first, as {version,state}. */
async function listVersions(secretId: string): Promise<Array<{ version: number; state: string }>> {
  const out: Array<{ version: number; state: string }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 40; page++) {
    const qs = new URLSearchParams({ pageSize: '500' });
    if (pageToken) qs.set('pageToken', pageToken);
    const { status, body } = await api(`projects/${PROJECT}/secrets/${secretId}/versions?${qs}`);
    if (status !== 200) throw new Error(`list versions ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    for (const v of body.versions ?? []) {
      const n = Number(/\/versions\/(\d+)$/.exec(v.name)?.[1]);
      if (Number.isSafeInteger(n)) out.push({ version: n, state: v.state });
    }
    pageToken = body.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out.sort((a, b) => b.version - a.version);
}

const enabled = (vs: Array<{ version: number; state: string }>) =>
  vs.filter((v) => v.state === 'ENABLED').map((v) => v.version);

async function ensureSecret(secretId: string): Promise<void> {
  const got = await api(`projects/${PROJECT}/secrets/${secretId}`);
  if (got.status === 200) return;
  const made = await api(`projects/${PROJECT}/secrets?secretId=${encodeURIComponent(secretId)}`, {
    method: 'POST',
    body: JSON.stringify({ replication: { automatic: {} }, labels: { arkova_rig: 'batch-j-0907', arkova_purpose: 'soak' } }),
  });
  if (made.status !== 200 && made.status !== 409) {
    throw new Error(`create secret ${made.status}: ${JSON.stringify(made.body).slice(0, 200)}`);
  }
}

/** Append `count` versions directly (bypassing the store) to build a backlog. */
async function seedVersions(secretId: string, count: number, prefix: string): Promise<number[]> {
  const added: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = `${prefix}-seed-${i}-${Date.now()}`;
    const res = await api(`projects/${PROJECT}/secrets/${secretId}:addVersion`, {
      method: 'POST',
      body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
    });
    if (res.status !== 200) throw new Error(`addVersion ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    added.push(Number(/\/versions\/(\d+)$/.exec(res.body.name)?.[1]));
  }
  return added;
}

function makeStore(retention?: Record<string, number>, entries: LogEntry[] = []) {
  return createGcpSecretManagerRefreshTokenStore({
    env: { GCP_SECRET_MANAGER_PROJECT_ID: PROJECT },
    getAccessToken,
    logger: captureLogger(entries),
    ...(retention ? { retention } : {}),
  });
}

const name = (secretId: string) => `projects/${PROJECT}/secrets/${secretId}`;

async function main(): Promise<void> {
  const [cmd, secretId, ...rest] = process.argv.slice(2);
  if (!secretId || !/^arkova-docusign-[A-Za-z0-9_-]+-[0-9a-f]{32}-refresh-token$/.test(secretId)) {
    throw new Error(`refusing: "${secretId}" is not a DocuSign refresh-token secret id`);
  }
  if (!secretId.includes('batchj')) {
    throw new Error(`refusing: "${secretId}" is not a batch-j rig-only secret`);
  }

  if (cmd === 'seed') {
    await ensureSecret(secretId);
    const count = Number(rest[0] ?? '6');
    const seeded = await seedVersions(secretId, count, rest[1] ?? 'rig');
    const after = await listVersions(secretId);
    console.log(JSON.stringify({ cmd, secretId, seeded, enabled: enabled(after), total: after.length }));
    return;
  }

  if (cmd === 'put') {
    const value = rest[0];
    if (!value) throw new Error('put requires a value');
    const before = await listVersions(secretId);
    const entries: LogEntry[] = [];
    const store = makeStore(undefined, entries);
    const t0 = Date.now();
    await store.put({ name: name(secretId), value });
    const ms = Date.now() - t0;
    const after = await listVersions(secretId);
    const latest = await api(`projects/${PROJECT}/secrets/${secretId}/versions/latest:access`);
    const latestValue = latest.status === 200
      ? Buffer.from(latest.body.payload.data, 'base64').toString('utf8')
      : null;
    const serialized = JSON.stringify(entries);
    console.log(JSON.stringify({
      cmd, secretId, ms,
      value_fp: fp(value),
      enabled_before: enabled(before),
      enabled_after: enabled(after),
      destroyed: after.filter((v) => v.state === 'DESTROYED').map((v) => v.version),
      latest_access_status: latest.status,
      latest_matches_written_value: latestValue === value,
      latest_value_fp: latestValue === null ? null : fp(latestValue),
      log_levels: entries.map((e) => e.level),
      log_summaries: entries.map((e) => ({ msg: e.msg, ...e.obj })),
      // The soak must prove the token never reaches the log line.
      log_contains_payload: serialized.includes(value),
    }));
    return;
  }

  if (cmd === 'put-keep-zero') {
    // F1 regression probe: a misconfigured retention must REFUSE, never destroy
    // the version `versions/latest` resolves to.
    const value = rest[0];
    if (!value) throw new Error('put-keep-zero requires a value');
    const before = await listVersions(secretId);
    const entries: LogEntry[] = [];
    const store = makeStore({ keepVersions: 0 }, entries);
    let threw: string | null = null;
    try {
      await store.put({ name: name(secretId), value });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    const after = await listVersions(secretId);
    const latest = await api(`projects/${PROJECT}/secrets/${secretId}/versions/latest:access`);
    const latestValue = latest.status === 200
      ? Buffer.from(latest.body.payload.data, 'base64').toString('utf8')
      : null;
    console.log(JSON.stringify({
      cmd, secretId, threw,
      enabled_before: enabled(before),
      enabled_after: enabled(after),
      newest_before: before.length ? Math.max(...enabled(before)) : null,
      latest_access_status: latest.status,
      latest_matches_written_value: latestValue === value,
      log_summaries: entries.map((e) => ({ level: e.level, msg: e.msg, ...e.obj })),
    }));
    return;
  }

  if (cmd === 'inspect') {
    const vs = await listVersions(secretId);
    console.log(JSON.stringify({
      cmd, secretId, enabled: enabled(vs), total: vs.length,
      destroyed: vs.filter((v) => v.state === 'DESTROYED').length,
      disabled: vs.filter((v) => v.state === 'DISABLED').length,
    }));
    return;
  }

  if (cmd === 'selector-unit') {
    // Pure-selector invariant, re-checked against the deployed candidate source
    // every cycle: no keepVersions a caller can supply ever yields the newest.
    const versions = [1, 2, 3, 4, 5].map((n) => ({ name: `projects/p/secrets/s/versions/${n}`, state: 'ENABLED' }));
    const results: Record<string, unknown> = {};
    for (const keepVersions of [0, -1, Number.NaN, 1, 2]) {
      const sel = selectSupersededVersions(versions, { keepVersions, maxDestroyPerPut: 10 });
      results[String(keepVersions)] = { destroy: sel.destroy, remaining: sel.remaining, includes_newest: sel.destroy.includes(5) };
    }
    console.log(JSON.stringify({ cmd, results }));
    return;
  }

  throw new Error(`unknown command "${cmd}"`);
}

main().catch((e) => {
  console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
