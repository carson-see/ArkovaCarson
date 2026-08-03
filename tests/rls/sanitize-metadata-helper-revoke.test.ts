/**
 * SEC-RECON / migration 0388 — `public.sanitize_metadata_for_public(jsonb)` must
 * not be directly callable by `anon` or `authenticated`.
 *
 * THE HOLE THIS PINS (confirmed live on prod vzwyaatejekddvltxyye before the
 * fix — unauthenticated POST /rest/v1/rpc/sanitize_metadata_for_public with the
 * publishable anon key returned HTTP 200 and echoed back exactly which keys
 * survived redaction):
 *
 *   The helper is internal redaction machinery for get_public_anchor's public
 *   projection, not a user-facing RPC. Direct anon access turns the redaction
 *   DENYLIST into a queryable oracle: submit arbitrary jsonb, read back what
 *   survives, and you have enumerated both the named-PII key set and 0334's
 *   `_`-prefixed reserved namespace rule — i.e. precisely which metadata key
 *   names are safe to hide data under. It is also a jsonb rebuild
 *   (jsonb_each -> jsonb_object_agg) driven by attacker-sized input on an
 *   endpoint that needs no account.
 *
 * THE REGRESSION THIS MUST NOT CAUSE (the whole point of the live suite):
 *   `get_public_anchor` is the helper's ONLY caller and is SECURITY DEFINER, so
 *   it executes the nested call as the owner and needs no caller grant. The
 *   public verification page MUST keep working end to end for anon after the
 *   revoke. Mirrors the "anon CAN still execute the deliberately-public
 *   verification RPC" assertion in
 *   src/tests/scrum-2905-security-advisor-revokes.test.ts.
 *
 * Prerequisites: local Supabase running + seeded, with 0388 applied
 * (see tests/rls/agents.md). Runs under `npm run test:rls`, not default CI —
 * the content-guard half lives in
 * src/tests/sec-0388-sanitize-metadata-helper-revoke.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createAnonClient,
  createServiceClient,
  withIndividualUser,
  cleanupClient,
  type TypedClient,
} from '../../src/tests/rls/helpers';

/**
 * A permission denial, and ONLY a permission denial.
 *
 * Deliberately narrower than the 0364 suite's helper, which also treated
 * PGRST202 ("function not found in schema cache") as a pass. That is too loose
 * here: a typo'd RPC name would make the denial assertions pass vacuously
 * against a DB where the grant is still wide open. PostgREST surfaces a real
 * revoke as SQLSTATE 42501 / "permission denied for function", so match that.
 */
function isPermissionDenied(
  error: { code?: string; message?: string } | null,
): boolean {
  if (!error) return false;
  return (
    error.code === '42501' ||
    /permission denied for function/i.test(error.message ?? '')
  );
}

/** Distinguish "function is missing" from "function is forbidden". */
function isMissingFromSchemaCache(
  error: { code?: string; message?: string } | null,
): boolean {
  if (!error) return false;
  return (
    error.code === 'PGRST202' ||
    /could not find the function/i.test(error.message ?? '')
  );
}

// Probe payload: one key from the named-PII denylist, one from 0334's `_`
// reserved namespace, and two that survive. If a caller can see this response
// at all, they have read the redaction policy off the server.
const ORACLE_PROBE = {
  _raw_tx_hex: 'deadbeef',
  dob: '1990-01-01',
  passport_number: 'X1',
  course_name: 'Ethics 101',
  nickname: 'kept',
};

describe('0388 — sanitize_metadata_for_public is not anon/authenticated callable', () => {
  let anon: TypedClient;
  let authed: TypedClient;
  let service: TypedClient;

  beforeAll(async () => {
    anon = createAnonClient();
    authed = await withIndividualUser();
    service = createServiceClient();
  });

  afterAll(async () => {
    if (authed) await cleanupClient(authed);
  });

  it('anon CANNOT execute the redaction helper directly', async () => {
    const { error } = await anon.rpc(
      'sanitize_metadata_for_public' as never,
      { p_metadata: ORACLE_PROBE } as never,
    );

    // Fail loudly on the vacuous-pass mode: if PostgREST says the function does
    // not exist, this suite is not testing what it claims to test.
    expect(isMissingFromSchemaCache(error)).toBe(false);
    expect(isPermissionDenied(error)).toBe(true);
    // NB: deliberately no `expect(data).toBeFalsy()` here. supabase-js always
    // returns data:null alongside an error, so such an assertion can never fail
    // independently of the one above — it reads as extra protection and is not.
  });

  it('authenticated CANNOT execute the redaction helper directly', async () => {
    const { error } = await authed.rpc(
      'sanitize_metadata_for_public' as never,
      { p_metadata: ORACLE_PROBE } as never,
    );

    expect(isMissingFromSchemaCache(error)).toBe(false);
    expect(isPermissionDenied(error)).toBe(true);
  });

  it('service_role CAN still execute it (worker/operator path retained)', async () => {
    const { data, error } = await service.rpc(
      'sanitize_metadata_for_public' as never,
      { p_metadata: ORACLE_PROBE } as never,
    );

    expect(isPermissionDenied(error)).toBe(false);
    expect(error).toBeNull();
    // Proves the GRANT is real (not just "no permission error" on a no-op) and
    // that the revoke did not disturb the redaction contract itself.
    expect(data).toEqual({ course_name: 'Ethics 101', nickname: 'kept' });
  });
});

describe('0388 — the deliberately-public verification surface still works for anon', () => {
  let anon: TypedClient;
  let service: TypedClient;

  // A record the public projection can actually return, so the end-to-end
  // assertion is a real projection and not just "no permission error".
  const PUBLIC_ID = `sec0388-${Date.now().toString(36)}`;
  const FINGERPRINT = `0388${'a'.repeat(60)}`;
  let anchorId: string | null = null;

  beforeAll(async () => {
    anon = createAnonClient();
    service = createServiceClient();

    const { data: org, error: orgErr } = await service
      .from('organizations')
      .select('id')
      .limit(1)
      .single();

    const { data: profile, error: profileErr } = await service
      .from('profiles')
      .select('id')
      .limit(1)
      .single();

    // Fail LOUDLY on a bad fixture. An earlier cut of this suite omitted the
    // NOT NULL `anchors.filename` and swallowed the insert error; the anchor
    // was never created, get_public_anchor returned its "Record not found"
    // stub, and the end-to-end assertion would have passed vacuously against a
    // projection that never reached the nested helper call at all. The whole
    // point of this file is that nested call, so the fixture is load-bearing.
    if (orgErr) throw new Error(`fixture: no organization — ${orgErr.message}`);
    if (profileErr) throw new Error(`fixture: no profile — ${profileErr.message}`);
    if (!org?.id || !profile?.id) {
      throw new Error('fixture: seed data missing (need one org + one profile)');
    }

    const { data: inserted, error: insertErr } = await service
      .from('anchors')
      .insert({
        public_id: PUBLIC_ID,
        fingerprint: FINGERPRINT,
        filename: 'sec-0388-fixture.pdf',
        status: 'SECURED',
        org_id: org.id,
        user_id: profile.id,
        // 0390 (SCRUM-3102) made `credential_type IS NULL` FAIL CLOSED on the
        // academic-record suppression gate — an absent type now suppresses
        // `metadata.title` and replaces `filename` with the generic
        // "Secured Document" label, same as a real academic record. This
        // fixture's whole point is proving `metadata.title` SURVIVES the
        // projection for an ordinary record, so it must pick a concrete
        // non-academic, non-suppressed type. Leaving this column unset (as
        // it was before 0390 existed) silently flips the anchor into the
        // suppressed branch and the assertion below fails — that is exactly
        // the "stale fixture vs already-shipped fix" class, not a leak; see
        // tests/rls/public-anchor-pii-projection.test.ts's own
        // 'SCRUM-3102 — an anchor with NULL credential_type FAILS CLOSED'
        // case for the behavior this fixture must NOT trigger.
        credential_type: 'OTHER',
        // 0357's "SECURED => on-chain receipt present" trigger is GUC-gated and
        // inert by default, but supply both anyway so this fixture keeps
        // working if/when that GUC is flipped on.
        chain_tx_id: `0388${'b'.repeat(60)}`,
        chain_timestamp: new Date().toISOString(),
        // One allow-listed public field plus two the helper strips — so the
        // redaction assertion below proves sanitization still runs.
        metadata: {
          title: 'SEC-0388 fixture',
          email: 'leak@example.test',
          _raw_tx_hex: 'deadbeef',
        },
      } as never)
      .select('id')
      .single();

    if (insertErr) {
      throw new Error(`fixture: anchor insert failed — ${insertErr.message}`);
    }

    anchorId = (inserted as { id?: string } | null)?.id ?? null;
    if (!anchorId) throw new Error('fixture: anchor insert returned no id');
  });

  afterAll(async () => {
    if (anchorId) {
      await service.from('anchors').delete().eq('id', anchorId);
    }
  });

  it('anon CAN still call get_public_anchor — the helper is reached via SECURITY DEFINER', async () => {
    const { data, error } = await anon.rpc('get_public_anchor' as never, {
      p_public_id: PUBLIC_ID,
    } as never);

    // The revoke must not surface as a permission error on the public endpoint.
    expect(isPermissionDenied(error)).toBe(false);
    expect(error).toBeNull();

    const payload = data as Record<string, unknown> | null;
    expect(payload).toBeTruthy();
    // A real projection, not a "Record not found" stub — proves the nested
    // sanitize_metadata_for_public call executed as the definer.
    expect(payload).not.toHaveProperty('error');
  });

  it('the projection still redacts — anon sees no PII and no `_` internals', async () => {
    const { data } = await anon.rpc('get_public_anchor' as never, {
      p_public_id: PUBLIC_ID,
    } as never);

    const serialized = JSON.stringify(data ?? {});

    // POSITIVE assertion FIRST. Without it every check below is satisfied by an
    // empty or collapsed projection — "nothing leaked" is trivially true when
    // nothing at all came back, so the absence checks alone would go green
    // while the public verification page renders a blank record. `title` is
    // allow-listed by 0355/0376 and verified to survive the projection.
    expect(serialized).toContain('SEC-0388 fixture');

    // Whole-payload check: the stripped keys must not appear ANYWHERE in the
    // response, at any nesting depth, not merely under `metadata`.
    expect(serialized).not.toContain('leak@example.test');
    expect(serialized).not.toContain('_raw_tx_hex');
    expect(serialized).not.toContain('deadbeef');
  });

  // NOTE on both tests below: assert `error === null`, NOT merely "not a
  // permission denial". isPermissionDenied() is false for EVERY non-42501
  // error, so the weaker form passes on a 500 or a statement timeout. That is
  // not hypothetical — probing prod during this work,
  // get_public_anchor_by_fingerprint returned 57014 "canceling statement due to
  // statement timeout". The weaker assertion would have called a dead endpoint
  // healthy, which is exactly the regression this suite exists to catch.
  it('anon CAN still call get_public_anchor_by_fingerprint', async () => {
    const { error } = await anon.rpc(
      'get_public_anchor_by_fingerprint' as never,
      { p_fingerprint: FINGERPRINT } as never,
    );
    expect(isPermissionDenied(error)).toBe(false);
    expect(error).toBeNull();
  });

  it('anon CAN still call search_public_credentials', async () => {
    const { error } = await anon.rpc('search_public_credentials' as never, {
      p_query: 'SEC-0388',
    } as never);
    expect(isPermissionDenied(error)).toBe(false);
    expect(error).toBeNull();
  });
});
