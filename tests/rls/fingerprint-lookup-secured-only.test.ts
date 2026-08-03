/**
 * LIVE proof that `get_public_anchor_by_fingerprint` is not a fingerprint
 * EXISTENCE ORACLE (migration 0386).
 *
 * ── WHY THIS FILE EXISTS, AND WHY THE EXISTING TEST WAS NOT ENOUGH ──────────
 *
 * `services/edge/src/mcp-tools.test.ts` ALREADY contains
 *   it('PENDING fingerprint filtered by RPC → UNKNOWN, not an existence leak')
 *   it('SUBMITTED fingerprint filtered by RPC → UNKNOWN until secured')
 * and they have been passing in CI the whole time production was violating the
 * invariant they name.
 *
 * They pass because they MOCK the RPC: they stub the HTTP response and assert
 * that the EDGE LAYER maps `{error:'Record not found'}` to a `status:'UNKNOWN'`
 * envelope. That is a real and useful assertion about `handleVerifyDocument`,
 * but the premise it rests on — "the RPC filters PENDING/SUBMITTED" — is
 * supplied by the fixture. Nothing anywhere asserted it against the function
 * that actually runs. So prod drifted from migration 0339 to
 * `status IN ('SECURED','SUBMITTED','PENDING')`, and 48,152 in-flight anchors
 * became confirmable by an anonymous caller, with a green suite the entire time.
 *
 * The rule this file encodes: a mock may stand in for a COLLABORATOR, never for
 * the INVARIANT under test. When the thing being asserted is "the database
 * refuses to answer", the database has to be the one refusing.
 *
 * These assertions run as a real ANON client against a real Postgres, so they
 * fail if the SQL predicate is ever widened again — by a migration, by a
 * hotfix, or by an out-of-band prod change that a later `db reset` reproduces.
 *
 * Prerequisites: local Supabase running + seeded (see tests/rls/agents.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServiceClient, createAnonClient } from '../../src/tests/rls/helpers';

const RUN_STARTED = Date.now();
const RUN_ID = RUN_STARTED.toString(36);
const RUN_HEX = RUN_STARTED.toString(16).padStart(12, '0').slice(-12);
const ORG_ID = 'f19e2400-0000-4000-8000-00000000c001';

/** Statuses the RPC must refuse to resolve, and the reason each one matters. */
const IN_FLIGHT_STATUSES = [
  { status: 'PENDING', why: 'queued but not yet broadcast — owner has published nothing' },
  { status: 'SUBMITTED', why: 'broadcast but unconfirmed — 48,149 such rows existed in prod' },
] as const;

let fpSeed = 0;
function nextFingerprint(): string {
  fpSeed += 1;
  return (RUN_HEX + fpSeed.toString(16).padStart(4, '0')).repeat(4).slice(0, 64);
}

describe('0386 — fingerprint lookup resolves SECURED anchors only (no existence oracle)', () => {
  const service = createServiceClient();
  const anon = createAnonClient();
  let userId: string;

  async function seedAnchor(status: string): Promise<{ fingerprint: string; publicId: string }> {
    const fingerprint = nextFingerprint();
    const secured = status === 'SECURED';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (service as any)
      .from('anchors')
      .insert({
        user_id: userId,
        org_id: ORG_ID,
        fingerprint,
        filename: `fingerprint-oracle-${RUN_ID}-${fpSeed}.pdf`,
        file_size: 1024,
        status,
        credential_type: 'OTHER',
        metadata: {},
        // 0357 refuses a transition INTO SECURED without a chain receipt when
        // its GUC is on; set both so this suite is independent of that flag.
        chain_tx_id: secured ? `tx-${RUN_ID}-${fpSeed}` : null,
        chain_timestamp: secured ? new Date().toISOString() : null,
      })
      .select('public_id')
      .single();
    if (error) throw new Error(`anchor seed failed (${status}): ${error.message}`);
    return { fingerprint, publicId: data.public_id as string };
  }

  /** Call the RPC exactly as an unauthenticated caller does. */
  async function lookupAsAnon(fingerprint: string): Promise<Record<string, unknown>> {
    const { data, error } = await anon.rpc('get_public_anchor_by_fingerprint' as never, {
      p_fingerprint: fingerprint,
    } as never);
    // A permission error would be a different bug — this RPC is deliberately
    // anon-callable and 0364's suite pins that. Fail loudly rather than let a
    // 403 masquerade as "filtered".
    expect(error, `anon rpc errored: ${error?.message}`).toBeNull();
    return data as unknown as Record<string, unknown>;
  }

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    const orgName = `Fingerprint Oracle Org ${RUN_ID}`;
    const { error: orgErr } = await svc
      .from('organizations')
      .upsert({ id: ORG_ID, legal_name: orgName, display_name: orgName }, { onConflict: 'id' });
    if (orgErr) throw new Error(`org upsert failed: ${orgErr.message}`);

    const email = `fingerprint-oracle-${RUN_ID}@rls.arkova.local`;
    const { data: created, error: createErr } = await svc.auth.admin.createUser({
      email,
      password: process.env.RLS_TEST_PASSWORD as string,
      email_confirm: true,
    });
    if (createErr) throw new Error(`createUser failed: ${createErr.message}`);
    userId = created.user.id as string;

    const { error: profErr } = await svc.from('profiles').upsert(
      { id: userId, email, full_name: 'Fingerprint Oracle Seed', role: 'ORG_ADMIN', org_id: ORG_ID, is_public_profile: false },
      { onConflict: 'id' },
    );
    if (profErr) throw new Error(`profile upsert failed: ${profErr.message}`);
  }, 60_000);

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    await svc.from('anchors').delete().eq('org_id', ORG_ID);
    if (userId) await svc.auth.admin.deleteUser(userId);
    await svc.from('organizations').delete().eq('id', ORG_ID);
  }, 60_000);

  // ───────────────────────────────────────────────────────────────────────────
  // The oracle itself.
  // ───────────────────────────────────────────────────────────────────────────

  it.each(IN_FLIGHT_STATUSES)(
    'refuses to confirm a $status anchor exists ($why)',
    async ({ status }) => {
      const { fingerprint } = await seedAnchor(status);
      const body = await lookupAsAnon(fingerprint);
      expect(body.error).toBe('Record not found');
      // No partial disclosure: the envelope must carry nothing about the row.
      expect(body.public_id).toBeUndefined();
      expect(body.status).toBeUndefined();
      expect(body.fingerprint).toBeUndefined();
    },
  );

  it('POSITIVE CONTROL: a SECURED anchor with the same shape DOES resolve', async () => {
    // Without this, the two assertions above would pass vacuously if the RPC
    // were broken, renamed, or returning "not found" for everything — which
    // would look like a fix and be an outage.
    const { fingerprint, publicId } = await seedAnchor('SECURED');
    const body = await lookupAsAnon(fingerprint);
    expect(body.error).toBeUndefined();
    expect(body.public_id).toBe(publicId);
    expect(body.verified).toBe(true);
  });

  it('an in-flight record is INDISTINGUISHABLE from a fingerprint we have never seen', async () => {
    // The disclosure is the DIFFERENCE between the two answers, so equality of
    // the response bodies is the property that actually closes the oracle —
    // asserting only "not found" would still permit a distinguishing envelope.
    const { fingerprint: submitted } = await seedAnchor('SUBMITTED');
    const neverSeen = nextFingerprint();

    const submittedBody = await lookupAsAnon(submitted);
    const unknownBody = await lookupAsAnon(neverSeen);
    expect(submittedBody).toEqual(unknownBody);
  });

  it('stays anon-callable — the fix must not become an access regression', async () => {
    // 0339 GRANTed this to anon on purpose and 0364's suite pins it. Tightening
    // WHICH ROWS resolve must never turn into revoking WHO may ask.
    const { error } = await anon.rpc('get_public_anchor_by_fingerprint' as never, {
      p_fingerprint: 'deadbeef',
    } as never);
    expect(error).toBeNull();
  });

  it('a securing transition flips the same fingerprint from hidden to resolvable', async () => {
    // Proves the filter tracks live status rather than anything captured at
    // insert time, and that the tightening delays disclosure rather than
    // permanently withholding it.
    const { fingerprint, publicId } = await seedAnchor('SUBMITTED');
    expect((await lookupAsAnon(fingerprint)).error).toBe('Record not found');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updErr } = await (service as any)
      .from('anchors')
      .update({
        status: 'SECURED',
        chain_tx_id: `tx-${RUN_ID}-promote`,
        chain_timestamp: new Date().toISOString(),
      })
      .eq('public_id', publicId);
    expect(updErr, `promotion to SECURED failed: ${updErr?.message}`).toBeNull();

    const after = await lookupAsAnon(fingerprint);
    expect(after.error).toBeUndefined();
    expect(after.public_id).toBe(publicId);
  });
});
