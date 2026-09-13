// cto-train-b-0912 fixture setup — run ONCE before the clock starts (rule 2:
// cycle 1 is the coverage gate). Creates the shared fixtures (org A/B, users,
// one org-A API key) and then calls every probes/*.mjs module's optional
// `seed(admin, state, ctx)` export; each returns the rows it created and they
// are persisted under state[pr]. Idempotent: every row is `cto-train-b-0912-`
// prefixed and looked up before insert.
import { createClient } from '@supabase/supabase-js';
import { randomUUID, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SUPABASE_URL, PREFIX, hashApiKey, probe, workerFetch, restFetch, TAG_URL } from './common.mjs';

const SERVICE_KEY = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.STAGING_SUPABASE_ANON_KEY;
const API_KEY_HMAC_SECRET = process.env.API_KEY_HMAC_SECRET;
const STATE_PATH = process.env.FIXTURE_STATE ?? '/Volumes/Extreme/offload/cto-soak-2026-09-12/train-b/state/fixtures.json';
if (!SERVICE_KEY || !ANON_KEY || !API_KEY_HMAC_SECRET) throw new Error('STAGING_SUPABASE_SERVICE_ROLE_KEY, STAGING_SUPABASE_ANON_KEY, API_KEY_HMAC_SECRET required');
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
let state = {};
try { state = JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { /* fresh */ }
const PASSWORD = state.password ?? `Soak-${randomUUID()}-Aa1!`;

async function ensureOrg(name) {
  const { data: existing } = await admin.from('organizations').select('id').eq('display_name', name).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await admin.from('organizations').insert({ display_name: name, legal_name: name, tier: 'ENTERPRISE', org_prefix: `Z${randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase()}` }).select('id').single();
  if (error) throw new Error(`org ${name}: ${error.message}`);
  return data.id;
}
async function ensureUser({ local, role, orgId, isPlatformAdmin = false }) {
  const email = `${local}@staging.invalid.test`;
  const { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
  let userId = prof?.id;
  if (userId) {
    // Idempotence: a re-run after a crashed first run holds a new random PASSWORD; make the
    // existing auth user match state.password so every probe's GoTrue sign-in works.
    const { error: pwErr } = await admin.auth.admin.updateUserById(userId, { password: PASSWORD });
    if (pwErr) throw new Error(`password reset ${email}: ${pwErr.message}`);
  }
  if (!userId) {
    const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: local } });
    if (error || !created.user) throw new Error(`user ${email}: ${error?.message}`);
    userId = created.user.id;
  }
  const { error: pe } = await admin.from('profiles').upsert({ id: userId, email, full_name: local, role, org_id: orgId ?? null, is_public_profile: false, is_platform_admin: isPlatformAdmin, disclaimer_accepted_at: new Date().toISOString() });
  if (pe) throw new Error(`profile ${email}: ${pe.message}`);
  if (orgId) {
    const memberRole = role === 'ORG_ADMIN' ? 'admin' : 'member';
    const { error: me } = await admin.from('org_members').upsert({ user_id: userId, org_id: orgId, role: memberRole }, { onConflict: 'user_id,org_id' });
    if (me) console.warn(`[setup] org_members upsert ${email}: ${me.message} (continuing)`);
  }
  return { userId, email, password: PASSWORD, orgId: orgId ?? null, role };
}
async function ensureApiKey(orgId, createdBy) {
  if (state.apiKey?.raw) return state.apiKey;
  const raw = `ak_test_${randomBytes(32).toString('hex')}`;
  const { data, error } = await admin.from('api_keys').insert({ org_id: orgId, key_prefix: raw.slice(0, 12), key_hash: hashApiKey(raw, API_KEY_HMAC_SECRET), name: `${PREFIX}-machine-key`, scopes: ['read:search', 'anchor:write', 'anchor:read', 'keys:read', 'webhooks:manage', 'verify', 'verify:batch'], created_by: createdBy }).select('id').single();
  if (error) throw new Error(`api key: ${error.message}`);
  return { id: data.id, raw, orgId };
}

async function main() {
  console.log('[setup] shared fixtures');
  state.prefix = PREFIX; state.password = PASSWORD; state.createdAt = state.createdAt ?? new Date().toISOString();
  state.orgA = await ensureOrg(`${PREFIX}-org-a`);
  state.orgB = await ensureOrg(`${PREFIX}-org-b`);
  state.adminA = await ensureUser({ local: `${PREFIX}-admin-a`, role: 'ORG_ADMIN', orgId: state.orgA });
  state.memberA = await ensureUser({ local: `${PREFIX}-member-a`, role: 'ORG_MEMBER', orgId: state.orgA });
  state.adminB = await ensureUser({ local: `${PREFIX}-admin-b`, role: 'ORG_ADMIN', orgId: state.orgB });
  state.individual = await ensureUser({ local: `${PREFIX}-individual`, role: 'INDIVIDUAL', orgId: null });
  // #2911 (webhook DLQ admin drain): a platform-admin fixture, org-less like a
  // real Arkova staff account. isPlatformAdmin is the ONLY gate handleWebhookDlqList
  // / handleWebhookDlqResolve check (utils/platformAdmin.ts's is_platform_admin
  // column) — org membership is irrelevant to this surface.
  state.platformAdmin = await ensureUser({ local: `${PREFIX}-platform-admin`, role: 'INDIVIDUAL', orgId: null, isPlatformAdmin: true });
  state.apiKey = await ensureApiKey(state.orgA, state.adminA.userId);
  const ctx = { admin, state, ANON_KEY, SERVICE_KEY, API_KEY_HMAC_SECRET, hashApiKey, probe, workerFetch, restFetch, SUPABASE_URL, TAG_URL, PREFIX, env: process.env };
  for (const f of readdirSync(new URL('./probes/', import.meta.url)).filter((x) => x.endsWith('.mjs')).sort()) {
    const mod = await import(new URL(`./probes/${f}`, import.meta.url));
    if (typeof mod.seed !== 'function') { console.log(`[setup] ${mod.pr}: no seed()`); continue; }
    console.log(`[setup] seeding ${mod.pr}`);
    state[mod.pr] = await mod.seed(admin, state, ctx);
  }
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`[setup] state written ${STATE_PATH}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
