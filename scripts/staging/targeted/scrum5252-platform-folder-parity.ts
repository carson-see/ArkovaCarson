#!/usr/bin/env npx tsx
/** SCRUM-5252 read-parity verifier for the retired, explicitly authorized B4 rig. */
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { totp } from '../../../e2e/helpers/totp';
import { runWithVerifiedCleanup } from './uat24-folder-feature-lifecycle';

const EXPECTED_REF = 'dlfcwhljvkomeouykcwk';
const EXPECTED_WORKER_HOST =
  'arkova-worker-cto-train-b4-0913-staging-270018525501.us-central1.run.app';
const VERIFIED_WORKER_ORIGIN = `https://${EXPECTED_WORKER_HOST}`;
const GCLOUD_USER_TOKEN_AUDIENCE = '32555940559.apps.googleusercontent.com';
const IDS = {
  platform: '52520000-0000-4000-8000-00000000a001',
  target: '52520000-0000-4000-8000-00000000a002',
  peer: '52520000-0000-4000-8000-00000000a003',
  orgA: '52520000-0000-4000-8000-00000000b001',
  orgB: '52520000-0000-4000-8000-00000000b002',
  contextual: '52520000-0000-4000-8000-00000000f001',
  global: '52520000-0000-4000-8000-00000000f002',
  orgAFolder: '52520000-0000-4000-8000-00000000f003',
  orgBFolder: '52520000-0000-4000-8000-00000000f004',
} as const;
const EMAILS = {
  platform: 'scrum5252-platform@seed-fixture.invalid',
  target: 'scrum5252-target@seed-fixture.invalid',
  peer: 'scrum5252-peer@seed-fixture.invalid',
} as const;

type Phase = 'diagnostic' | 'qualifying';
type Json = Record<string, unknown>;
type Session = { client: SupabaseClient; token: string; userId: string; factorId: string };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function validateTargets(supabaseUrl: string, workerUrl: string): void {
  const supabase = new URL(supabaseUrl);
  const worker = new URL(workerUrl);
  assert(supabase.origin === `https://${EXPECTED_REF}.supabase.co` && supabase.pathname === '/'
    && !supabase.username && !supabase.password && !supabase.search && !supabase.hash,
  'refusing non-B4 Supabase target');
  assert(worker.origin === `https://${EXPECTED_WORKER_HOST}` && worker.pathname === '/'
    && !worker.username && !worker.password && !worker.search && !worker.hash,
  'refusing non-B4 worker target');
}

export function assertAal2Token(token: string, expectedUserId: string): void {
  const segment = token.split('.')[1];
  assert(segment, 'AAL2 session returned a malformed token');
  const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as { sub?: string; aal?: string };
  assert(claims.sub === expectedUserId && claims.aal === 'aal2', 'session is not the expected AAL2 actor');
}

export function assertWorkerIamToken(token: string, workerUrl: string): void {
  const segment = token.split('.')[1];
  assert(segment, 'B4 worker IAM token is malformed');
  const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
    aud?: string; exp?: number; iss?: string;
  };
  assert(claims.iss === 'https://accounts.google.com', 'B4 worker IAM token has the wrong issuer');
  assert(claims.aud === workerUrl || claims.aud === GCLOUD_USER_TOKEN_AUDIENCE,
    'B4 worker IAM token has an unauthorized audience');
  assert(typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() + 60_000,
    'B4 worker IAM token is expired or too close to expiry');
}

function safeError(body: unknown): string {
  if (!body || typeof body !== 'object') return 'unknown_error';
  return String((body as { error?: unknown }).error ?? 'unknown_error').slice(0, 80);
}

export async function workerRequest(
  workerUrl: string, iamToken: string, path: string, auth: { jwt?: string; apiKey?: string },
  init: RequestInit = {},
): Promise<{ status: number; body: Json }> {
  assert(workerUrl === VERIFIED_WORKER_ORIGIN, 'refusing unverified worker request target');
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('x-serverless-authorization', `Bearer ${iamToken}`);
  if (auth.jwt) headers.set('authorization', `Bearer ${auth.jwt}`);
  if (auth.apiKey) headers.set('x-api-key', auth.apiKey);
  // Resolve against the pinned origin and re-check it: a path such as
  // `//host` or `@host` must never retarget the request.
  const target = new URL(path, VERIFIED_WORKER_ORIGIN);
  assert(target.origin === VERIFIED_WORKER_ORIGIN, 'refusing request outside the verified worker origin');
  const response = await fetch(target, { ...init, headers, redirect: 'error' });
  const body = await response.json().catch(() => ({})) as Json;
  return { status: response.status, body };
}

function expectStatus(result: { status: number; body: Json }, status: number, label: string): void {
  assert(result.status === status, `${label}: expected ${status}, got ${result.status} (${safeError(result.body)})`);
}

async function clearOwnedFactors(service: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await service.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error('owned factor listing failed');
  for (const factor of [...(data?.factors ?? [])]) {
    const deleted = await service.auth.admin.mfa.deleteFactor({ userId, id: factor.id });
    if (deleted.error) throw new Error('owned factor cleanup failed');
  }
}

async function createAal2Session(
  service: SupabaseClient, supabaseUrl: string, anonKey: string, userId: string, email: string,
): Promise<Session> {
  const owned = await service.auth.admin.getUserById(userId);
  if (owned.error || owned.data.user?.email !== email) {
    throw new Error('refusing to mutate a fixture identity without exact id/email ownership');
  }
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  let factorId: string | undefined;
  try {
    await clearOwnedFactors(service, userId);
    const password = `${randomBytes(24).toString('base64url')}aA1!`;
    const updated = await service.auth.admin.updateUserById(userId, { password });
    if (updated.error) throw new Error('owned fixture password rotation failed');
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) throw new Error('owned fixture sign-in failed');
    const enrolled = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'SCRUM-5252 soak' });
    if (enrolled.error || !enrolled.data) throw new Error('owned fixture MFA enrollment failed');
    factorId = enrolled.data.id;
    const verified = await client.auth.mfa.challengeAndVerify({
      factorId, code: totp(enrolled.data.totp.secret),
    });
    if (verified.error) throw new Error('owned fixture MFA verification failed');
    // challengeAndVerify upgrades the client's stored session; its response
    // does not itself carry a session in every supported supabase-js version.
    const current = await client.auth.getSession();
    if (current.error || !current.data.session) throw new Error('owned fixture AAL2 session read failed');
    assertAal2Token(current.data.session.access_token, userId);
    return { client, token: current.data.session.access_token, userId, factorId };
  } catch (error) {
    let factorCleanupFailed = false;
    if (factorId) {
      const removed = await service.auth.admin.mfa.deleteFactor({ userId, id: factorId })
        .catch(() => ({ error: new Error('factor cleanup request failed') }));
      factorCleanupFailed = !!removed.error;
    }
    await client.auth.signOut().catch(() => undefined);
    if (factorCleanupFailed) throw new Error('partial AAL2 session cleanup failed');
    throw error;
  }
}

async function diagnostic(
  service: SupabaseClient, workerUrl: string, iamToken: string, expectedWorkerSha: string,
): Promise<Record<string, unknown>> {
  const health = await workerRequest(workerUrl, iamToken, '/health', {});
  expectStatus(health, 200, 'worker health');
  assert(health.body.git_sha === expectedWorkerSha, 'worker SHA does not match the declared candidate');

  const { data: profiles, error: profileError } = await service.from('profiles')
    .select('id,is_platform_admin,org_id,role').in('id', [IDS.platform, IDS.target, IDS.peer]);
  if (profileError || profiles?.length !== 3) throw new Error('base profile fixture mismatch');
  const platform = profiles.find((row) => row.id === IDS.platform);
  const target = profiles.find((row) => row.id === IDS.target);
  const peer = profiles.find((row) => row.id === IDS.peer);
  assert(platform?.is_platform_admin === true && platform.org_id === IDS.orgB
    && platform.role === 'ORG_ADMIN',
    'platform fixture is not an active exact actor');
  assert(target?.is_platform_admin === false && target.org_id === IDS.orgA
    && target.role === 'ORG_MEMBER', 'target profile fixture mismatch');
  assert(peer?.is_platform_admin === false && peer.org_id === IDS.orgA
    && peer.role === 'ORG_MEMBER', 'peer profile fixture mismatch');

  const { data: folders, error: folderError } = await service.from('folders')
    .select('id,user_id,org_id,context_org_id,name')
    .in('id', [IDS.contextual, IDS.global, IDS.orgAFolder, IDS.orgBFolder]);
  if (folderError || folders?.length !== 4) throw new Error('base folder fixture mismatch');
  const contextual = folders.find((row) => row.id === IDS.contextual);
  const global = folders.find((row) => row.id === IDS.global);
  const orgA = folders.find((row) => row.id === IDS.orgAFolder);
  const orgB = folders.find((row) => row.id === IDS.orgBFolder);
  assert(contextual?.user_id === IDS.target && contextual.context_org_id === IDS.orgA
    && contextual.org_id === null && contextual.name === 'SCRUM-5252 contextual',
  'contextual folder fixture mismatch');
  assert(global?.user_id === IDS.target && global.context_org_id === null && global.org_id === null,
    'global folder fixture mismatch');
  assert(orgA?.user_id === null && orgA.org_id === IDS.orgA && orgA.context_org_id === null,
    'Org A folder fixture mismatch');
  assert(orgB?.user_id === null && orgB.org_id === IDS.orgB && orgB.context_org_id === null,
    'Org B folder fixture mismatch');

  const direct = await service.rpc('folder_api_list', {
    p_actor_user_id: IDS.platform, p_api_org_id: null, p_owner_scope: 'USER',
    p_owner_user_id: IDS.target, p_org_id: null, p_context_org_id: IDS.orgA,
  });
  if (direct.error || direct.data?.length !== 1 || direct.data[0]?.id !== IDS.contextual) {
    throw new Error('0464 service RPC behavior is absent');
  }
  return { result: 'scrum5252-diagnostic-ok', projectRef: EXPECTED_REF, workerSha: expectedWorkerSha };
}

async function qualifyingCycle(
  service: SupabaseClient, supabaseUrl: string, anonKey: string, workerUrl: string,
  iamToken: string,
): Promise<Record<string, unknown>> {
  const sessions: Session[] = [];
  let platform: Session | undefined;
  let rawApiKey: string | undefined;
  let apiKeyId: string | undefined;
  const originalContextName = 'SCRUM-5252 contextual';

  const work = async () => {
    platform = await createAal2Session(service, supabaseUrl, anonKey, IDS.platform, EMAILS.platform);
    sessions.push(platform);
    const target = await createAal2Session(service, supabaseUrl, anonKey, IDS.target, EMAILS.target);
    sessions.push(target);
    const peer = await createAal2Session(service, supabaseUrl, anonKey, IDS.peer, EMAILS.peer);
    sessions.push(peer);

    const contextPath = `/api/v1/folders?owner_scope=USER&owner_user_id=${IDS.target}&context_org_id=${IDS.orgA}`;
    const platformContext = await workerRequest(workerUrl, iamToken, contextPath, { jwt: platform.token });
    expectStatus(platformContext, 200, 'platform contextual read');
    assert((platformContext.body.folders as Array<{ id: string }>).some((folder) => folder.id === IDS.contextual),
      'platform contextual read omitted the fixture');
    expectStatus(await workerRequest(workerUrl, iamToken,
      `/api/v1/folders?owner_scope=ORG&org_id=${IDS.orgA}`, { jwt: platform.token }), 200,
    'platform organization read');
    expectStatus(await workerRequest(workerUrl, iamToken,
      `/api/v1/folders?owner_scope=USER&owner_user_id=${IDS.target}`, { jwt: platform.token }), 403,
    'platform global personal denial');

    expectStatus(await workerRequest(workerUrl, iamToken, contextPath, { jwt: peer.token }), 403,
      'ordinary peer contextual denial');
    expectStatus(await workerRequest(workerUrl, iamToken,
      `/api/v1/folders?owner_scope=ORG&org_id=${IDS.orgA}`, { jwt: peer.token }), 200,
    'ordinary member organization read baseline');
    expectStatus(await workerRequest(workerUrl, iamToken, contextPath, { jwt: target.token }), 200,
      'owner contextual read baseline');

    expectStatus(await workerRequest(workerUrl, iamToken, `/api/v1/folders/${IDS.contextual}`, { jwt: platform.token }, {
      method: 'PATCH', body: JSON.stringify({ name: 'Forbidden platform rename' }),
    }), 404, 'platform personal write denial');
    expectStatus(await workerRequest(workerUrl, iamToken, '/api/v1/folders', { jwt: platform.token }, {
      method: 'POST', body: JSON.stringify({ name: 'Forbidden platform org write', owner_scope: 'ORG', org_id: IDS.orgA }),
    }), 403, 'platform exact-org write denial');

    const keyName = `scrum5252-${randomUUID()}`;
    const created = await workerRequest(workerUrl, iamToken, '/api/v1/keys', { jwt: platform.token }, {
      method: 'POST', body: JSON.stringify({ name: keyName, scopes: ['anchor:read', 'anchor:write'] }),
    });
    expectStatus(created, 201, 'owned API key creation');
    rawApiKey = String(created.body.key ?? '');
    apiKeyId = String(created.body.id ?? '');
    assert(rawApiKey.startsWith('ak_') && apiKeyId, 'API key creation returned an invalid contract');

    expectStatus(await workerRequest(workerUrl, iamToken,
      `/api/v1/folders?owner_scope=ORG&org_id=${IDS.orgB}`, { apiKey: rawApiKey }), 200,
    'API key own-org positive control');
    expectStatus(await workerRequest(workerUrl, iamToken,
      `/api/v1/folders?owner_scope=ORG&org_id=${IDS.orgA}`, { apiKey: rawApiKey }), 403,
    'API key foreign-org read denial');
    expectStatus(await workerRequest(workerUrl, iamToken, contextPath, { apiKey: rawApiKey }), 403,
      'API key platform-principal personal denial');
    expectStatus(await workerRequest(workerUrl, iamToken, '/api/v1/folders', { apiKey: rawApiKey }, {
      method: 'POST', body: JSON.stringify({ name: 'Forbidden key write', owner_scope: 'ORG', org_id: IDS.orgA }),
    }), 403, 'API key foreign-org write denial');

    return { result: 'scrum5252-qualifying-cycle-ok', projectRef: EXPECTED_REF,
      platformContextRead: true, platformOrgRead: true, nonAdminDenied: true,
      ownerBaseline: true, writesDenied: true, apiKeyUpperBound: true };
  };

  const cleanup = async () => {
    const failures: string[] = [];
    if (apiKeyId && platform) {
      const deleted = await workerRequest(workerUrl, iamToken, `/api/v1/keys/${encodeURIComponent(apiKeyId)}`,
        { jwt: platform.token }, { method: 'DELETE' });
      if (deleted.status !== 204) failures.push(`api_key_delete_${deleted.status}`);
    }
    for (const session of sessions) {
      const deleted = await service.auth.admin.mfa.deleteFactor({ userId: session.userId, id: session.factorId });
      if (deleted.error) failures.push('factor_delete_failed');
      await session.client.auth.signOut().catch(() => undefined);
    }
    if (failures.length) throw new Error(`cleanup failed (${failures.join(',')})`);
  };

  const verifyCleanup = async () => {
    if (rawApiKey) {
      const revoked = await workerRequest(workerUrl, iamToken,
        `/api/v1/folders?owner_scope=ORG&org_id=${IDS.orgB}`, { apiKey: rawApiKey });
      assert(revoked.status === 401, `cleanup verification: deleted API key returned ${revoked.status}`);
    }
    for (const userId of [IDS.platform, IDS.target, IDS.peer]) {
      const factors = await service.auth.admin.mfa.listFactors({ userId });
      if (factors.error || (factors.data?.factors.length ?? 0) !== 0) {
        throw new Error('cleanup verification: owned MFA factor remains');
      }
    }
    const folder = await service.from('folders').select('name').eq('id', IDS.contextual).single();
    if (folder.error || folder.data.name !== originalContextName) {
      throw new Error('cleanup verification: stable folder fixture changed');
    }
  };

  return runWithVerifiedCleanup(work, cleanup, verifyCleanup);
}

export async function main(): Promise<Record<string, unknown>> {
  const phase = required('SCRUM5252_PHASE') as Phase;
  assert(phase === 'diagnostic' || phase === 'qualifying', 'SCRUM5252_PHASE must be diagnostic or qualifying');
  const supabaseUrl = required('STAGING_SUPABASE_URL').replace(/\/$/, '');
  const workerUrl = required('STAGING_WORKER_URL').replace(/\/$/, '');
  const serviceKey = required('STAGING_SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = required('STAGING_SUPABASE_ANON_KEY');
  const expectedWorkerSha = required('SCRUM5252_EXPECTED_WORKER_SHA');
  assert(/^[a-f0-9]{40}$/.test(expectedWorkerSha), 'SCRUM5252_EXPECTED_WORKER_SHA must be a full commit SHA');
  const iamToken = required('B4_WORKER_ID_TOKEN');
  validateTargets(supabaseUrl, workerUrl);
  assertWorkerIamToken(iamToken, workerUrl);
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const checked = await diagnostic(service, workerUrl, iamToken, expectedWorkerSha);
  if (phase === 'diagnostic') return checked;
  return qualifyingCycle(service, supabaseUrl, anonKey, workerUrl, iamToken);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error instanceof Error ? error.message : 'SCRUM-5252 driver failed');
    process.exitCode = 1;
  });
}
