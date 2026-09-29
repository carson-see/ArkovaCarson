/**
 * Migration 0490 — `(SELECT auth.uid())` initplan wrap for the UAT-14 profile
 * media policy helpers (SCRUM-1278 follow-up to 0481 / PR #3033).
 *
 * 0481 shipped five bare `auth.uid()` calls. They are not in the three
 * `storage.objects` policies (`profile_media_read` / `profile_media_owner_insert`
 * / `profile_media_owner_delete`) — those only call the two SECURITY DEFINER
 * helpers `can_read_profile_media(name)` and `can_write_profile_media(name)`,
 * and the bare calls sit inside those helper bodies. 0490 CREATE OR REPLACEs
 * both helpers with every call wrapped and changes nothing else.
 *
 * What this suite proves, against the REAL call path (supabase-js storage
 * client → storage-api → Postgres RLS → the helpers), not a mock:
 *
 *   1. The catalog actually carries the wrapped bodies: 2 + 3 wrapped
 *      occurrences and 0 bare ones (a suite that only exercised behaviour
 *      would pass equally well against the pre-0490 bodies).
 *   2. Grant/deny is IDENTICAL to 0481 for the three identities the wrap
 *      touches — OWNER (the `p.id = auth.uid()` / `om.user_id = auth.uid()`
 *      branches), OTHER-ORG MEMBER (a signed-in AAL2 admin of a different
 *      organization) and ANON — across INSERT, SELECT and DELETE, on both the
 *      `users/<public_id>/...` and `organizations/<public_id>/...` shapes.
 *   3. POSITIVE CONTROLS on the branch the wrap does NOT touch: once the owner
 *      publishes an object by writing it to `profiles.avatar_storage_path` /
 *      `organizations.logo_storage_path`, anon and other-org readers CAN read
 *      it. A wrap that accidentally disturbed the surrounding `OR` would fail
 *      here rather than passing vacuously on denials.
 *
 * Fixture ownership: every object path carries a fresh UUID and lives under
 * the seed identities' own public_ids; the published-path columns are set in
 * one test and reset to NULL in afterAll. Requires the local DB migrated to
 * at least 0490 and the storage-api container running (`supabase start`).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_CREDENTIALS,
  ORG_IDS,
  cleanupClient,
  createAnonClient,
  createServiceClient,
  withArkovaAdmin,
  withBetaAdmin,
  withIndividualUser,
  type TypedClient,
} from '../../src/tests/rls/helpers';

const BUCKET = 'profile-media';

// A valid 1x1 PNG. The bucket restricts `allowed_mime_types` to image/png and
// storage-api checks the declared content type, so the bytes just need to be
// a real file.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// ── catalog read: the helpers really are the 0490 bodies ────────────────────

const dbUrl = process.env.RLS_DATABASE_URL
  ?? process.env.UAT03_DATABASE_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const dbHost = new URL(dbUrl);
if (!['postgres:', 'postgresql:'].includes(dbHost.protocol)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(dbHost.hostname)) {
  throw new Error('profile-media auth.uid wrap suite requires an owned loopback PostgreSQL fixture');
}

function sql(query: string): string {
  return execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', query], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

const CATALOG_COUNTS = `
  SELECT p.proname
    || ':' || ((length(pg_get_functiondef(p.oid)) - length(replace(pg_get_functiondef(p.oid), 'auth.uid()', ''))) / length('auth.uid()'))::text
    || ':' || ((length(pg_get_functiondef(p.oid)) - length(replace(pg_get_functiondef(p.oid), '(SELECT auth.uid())', ''))) / length('(SELECT auth.uid())'))::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('can_read_profile_media', 'can_write_profile_media')
  ORDER BY p.proname`;

// ── clients + fixture paths ─────────────────────────────────────────────────

let owner: TypedClient;        // demo-user: INDIVIDUAL, no org, is_public_profile
let acmeOwner: TypedClient;    // demo-admin: owner of Acme (ORG_IDS.betaCorp)
let otherOrgOwner: TypedClient; // carson: owner of Arkova — an ORG member of a DIFFERENT org
let anon: TypedClient;
let service: TypedClient;

let userAvatarPath: string;
let orgLogoPath: string;

async function expectDenied(result: { error: unknown; data: unknown }, label: string) {
  expect(result.error, `${label}: expected an RLS denial, got success`).not.toBeNull();
  expect(result.data, `${label}: denial must not return data`).toBeNull();
}

async function expectAllowed(result: { error: { message?: string } | null; data: unknown }, label: string) {
  expect(result.error, `${label}: ${result.error?.message ?? ''}`).toBeNull();
  expect(result.data, `${label}: success must return data`).not.toBeNull();
}

/** Ground truth about whether an object exists, read with RLS bypassed. */
async function existsAsService(path: string): Promise<boolean> {
  const { error } = await service.storage.from(BUCKET).download(path);
  return error === null;
}

beforeAll(async () => {
  service = createServiceClient();
  owner = await withIndividualUser();
  acmeOwner = await withBetaAdmin();
  otherOrgOwner = await withArkovaAdmin();
  anon = createAnonClient();

  const { data: profile, error: profileError } = await service
    .from('profiles')
    .select('public_id, is_public_profile, status')
    .eq('id', DEMO_CREDENTIALS.userId)
    .single();
  if (profileError || !profile?.public_id) throw new Error(`seed profile lookup failed: ${profileError?.message}`);
  // The published-path positive control below relies on these seed facts.
  expect(profile.is_public_profile).toBe(true);
  expect(profile.status).toBe('ACTIVE');

  const { data: org, error: orgError } = await service
    .from('organizations')
    .select('public_id, suspended')
    .eq('id', ORG_IDS.betaCorp)
    .single();
  if (orgError || !org?.public_id) throw new Error(`seed org lookup failed: ${orgError?.message}`);
  expect(org.suspended).toBe(false);

  userAvatarPath = `users/${profile.public_id}/avatar/${randomUUID()}.png`;
  orgLogoPath = `organizations/${org.public_id}/logo/${randomUUID()}.png`;
});

afterAll(async () => {
  // Reset the published-path columns first (their CHECK constraints reference
  // the path shape, so NULL is always valid), then drop any leftover objects.
  await service.from('profiles').update({ avatar_storage_path: null }).eq('id', DEMO_CREDENTIALS.userId);
  await service.from('organizations').update({ logo_storage_path: null }).eq('id', ORG_IDS.betaCorp);
  await service.storage.from(BUCKET).remove([userAvatarPath, orgLogoPath]);
  await Promise.all([owner, acmeOwner, otherOrgOwner].map((c) => cleanupClient(c)));
});

describe('0490 — catalog carries the wrapped helper bodies', () => {
  it('can_read_profile_media has 2 wrapped calls and can_write_profile_media has 3, none bare', () => {
    // Format is proname:total:wrapped. A bare call counts in `total` but not
    // in `wrapped`, so total === wrapped means zero bare occurrences.
    expect(sql(CATALOG_COUNTS).split('\n')).toEqual([
      'can_read_profile_media:2:2',
      'can_write_profile_media:3:3',
    ]);
  });
});

describe('0490 — INSERT (profile_media_owner_insert → can_write_profile_media)', () => {
  it('OWNER can upload into their own users/<public_id>/ path', async () => {
    await expectAllowed(
      await owner.storage.from(BUCKET).upload(userAvatarPath, PNG, { contentType: 'image/png' }),
      'owner upload own avatar',
    );
    expect(await existsAsService(userAvatarPath)).toBe(true);
  });

  it('OTHER-ORG MEMBER cannot upload into someone else\'s users/ path', async () => {
    const path = `users/${userAvatarPath.split('/')[1]}/banner/${randomUUID()}.png`;
    await expectDenied(
      await otherOrgOwner.storage.from(BUCKET).upload(path, PNG, { contentType: 'image/png' }),
      'other user upload into demo-user path',
    );
    expect(await existsAsService(path)).toBe(false);
  });

  it('ANON cannot upload at all', async () => {
    const path = `users/${userAvatarPath.split('/')[1]}/banner/${randomUUID()}.png`;
    await expectDenied(
      await anon.storage.from(BUCKET).upload(path, PNG, { contentType: 'image/png' }),
      'anon upload',
    );
    expect(await existsAsService(path)).toBe(false);
  });

  it('ORG OWNER can upload into their own organizations/<public_id>/ path', async () => {
    await expectAllowed(
      await acmeOwner.storage.from(BUCKET).upload(orgLogoPath, PNG, { contentType: 'image/png' }),
      'acme owner upload org logo',
    );
    expect(await existsAsService(orgLogoPath)).toBe(true);
  });

  it('OTHER-ORG OWNER cannot upload into a different organization\'s path', async () => {
    const path = `organizations/${orgLogoPath.split('/')[1]}/banner/${randomUUID()}.png`;
    await expectDenied(
      await otherOrgOwner.storage.from(BUCKET).upload(path, PNG, { contentType: 'image/png' }),
      'arkova owner upload into acme path',
    );
    expect(await existsAsService(path)).toBe(false);
  });

  it('a user with no org membership cannot upload into an organization path', async () => {
    const path = `organizations/${orgLogoPath.split('/')[1]}/banner/${randomUUID()}.png`;
    await expectDenied(
      await owner.storage.from(BUCKET).upload(path, PNG, { contentType: 'image/png' }),
      'individual upload into acme path',
    );
    expect(await existsAsService(path)).toBe(false);
  });
});

describe('0490 — SELECT (profile_media_read → can_read_profile_media), unpublished objects', () => {
  it('OWNER can read their own unpublished avatar (the p.id = auth.uid() branch)', async () => {
    await expectAllowed(await owner.storage.from(BUCKET).download(userAvatarPath), 'owner read own avatar');
  });

  it('OTHER-ORG MEMBER cannot read an unpublished avatar of another user', async () => {
    await expectDenied(await otherOrgOwner.storage.from(BUCKET).download(userAvatarPath), 'other user read avatar');
  });

  it('ANON cannot read an unpublished avatar', async () => {
    await expectDenied(await anon.storage.from(BUCKET).download(userAvatarPath), 'anon read avatar');
  });

  it('ORG OWNER can read their own unpublished org logo (the om.user_id = auth.uid() branch)', async () => {
    await expectAllowed(await acmeOwner.storage.from(BUCKET).download(orgLogoPath), 'acme owner read logo');
  });

  it('OTHER-ORG OWNER cannot read an unpublished logo of a different organization', async () => {
    await expectDenied(await otherOrgOwner.storage.from(BUCKET).download(orgLogoPath), 'arkova owner read acme logo');
  });

  it('ANON cannot read an unpublished org logo', async () => {
    await expectDenied(await anon.storage.from(BUCKET).download(orgLogoPath), 'anon read acme logo');
  });
});

describe('0490 — SELECT positive control: PUBLISHED objects stay readable by everyone', () => {
  // This is the branch of the helper that does NOT contain auth.uid(). If the
  // wrap had disturbed the surrounding OR, these would fail instead of the
  // denials above passing vacuously.
  it('publishing the paths on the profile / organization rows succeeds', async () => {
    const p = await service.from('profiles').update({ avatar_storage_path: userAvatarPath }).eq('id', DEMO_CREDENTIALS.userId);
    expect(p.error, p.error?.message).toBeNull();
    const o = await service.from('organizations').update({ logo_storage_path: orgLogoPath }).eq('id', ORG_IDS.betaCorp);
    expect(o.error, o.error?.message).toBeNull();
  });

  it('ANON can read a published avatar and a published org logo', async () => {
    await expectAllowed(await anon.storage.from(BUCKET).download(userAvatarPath), 'anon read published avatar');
    await expectAllowed(await anon.storage.from(BUCKET).download(orgLogoPath), 'anon read published logo');
  });

  it('OTHER-ORG MEMBER can read a published avatar and a published org logo', async () => {
    await expectAllowed(await otherOrgOwner.storage.from(BUCKET).download(userAvatarPath), 'other user read published avatar');
    await expectAllowed(await otherOrgOwner.storage.from(BUCKET).download(orgLogoPath), 'other org read published logo');
  });

  it('publishing does not widen WRITE: other-org member and anon still cannot delete a published object', async () => {
    // storage-api reports a filtered-out DELETE as success with an empty list,
    // so existence is asserted with RLS bypassed rather than via the error.
    await otherOrgOwner.storage.from(BUCKET).remove([userAvatarPath, orgLogoPath]);
    await anon.storage.from(BUCKET).remove([userAvatarPath, orgLogoPath]);
    expect(await existsAsService(userAvatarPath)).toBe(true);
    expect(await existsAsService(orgLogoPath)).toBe(true);
  });
});

describe('0490 — DELETE (profile_media_owner_delete → can_write_profile_media)', () => {
  it('OWNER can delete their own avatar', async () => {
    const { error } = await owner.storage.from(BUCKET).remove([userAvatarPath]);
    expect(error, error?.message).toBeNull();
    expect(await existsAsService(userAvatarPath)).toBe(false);
  });

  it('ORG OWNER can delete their own org logo', async () => {
    const { error } = await acmeOwner.storage.from(BUCKET).remove([orgLogoPath]);
    expect(error, error?.message).toBeNull();
    expect(await existsAsService(orgLogoPath)).toBe(false);
  });
});
