/**
 * Migration 0423 — DocuSign metadata key write authority, EXECUTABLE coverage.
 *
 * WHY THIS FILE EXISTS
 *   `src/tests/sec-docusign-metadata-key-write-authority.test.ts` asserts the
 *   migration's SQL *text* (readFileSync + toContain). Those assertions prove
 *   the file says the right words; they cannot prove the trigger behaves. Two
 *   concrete gaps that a text test cannot close:
 *
 *     1. The UPDATE-revert branch is pinned only by /jsonb_set\(/. Swapping
 *        `OLD.metadata -> v_key` for `NEW.metadata -> v_key` keeps every
 *        asserted string intact and the suite green, while revert silently
 *        becomes a no-op that writes the attacker's own value back.
 *     2. A later migration issuing CREATE OR REPLACE from a stale copy leaves
 *        0423's file text untouched. That is not hypothetical — it is the 0383
 *        incident in scripts/ci/snapshots/ledger-numeric-exemptions.json, where
 *        0376's CREATE OR REPLACE silently reverted 0356's keyed HMAC and
 *        0362's allow-list.
 *
 *   These tests run against the live DB the RLS job resets from
 *   supabase/migrations, so they fail if the trigger is missing, reverted, or
 *   semantically wrong — regardless of what the migration file says.
 *
 * ROLE MODEL
 *   `get_caller_role()` reads the request JWT. `withUser()` authenticates as a
 *   real seed user (role `authenticated`) — the forgery path. `createServiceClient()`
 *   uses the service-role key — the only attesting writer (§1.4).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  withUser,
  createServiceClient,
  cleanupClient,
  DEMO_CREDENTIALS,
  ORG_IDS,
  type TypedClient,
} from '@/tests/rls/helpers';

const TAG = `0423-guard-${randomBytes(6).toString('hex')}`;
const fp = () => randomBytes(32).toString('hex');

/** Every key 0423 guards. */
const GUARDED = [
  'connector_source',
  'connector_artifact_id',
  'account_id',
  'envelope_id',
  '_signers',
  '_docusign_env',
  '_direction',
  '_sending_account_id',
] as const;

/** A full forged DocuSign provenance blob, plus one key the guard must not touch. */
const forgedDocusignMetadata = () => ({
  connector_source: 'docusign',
  connector_artifact_id: 'FORGED',
  account_id: 'FORGED-ACCOUNT',
  envelope_id: 'FORGED-ENVELOPE',
  _signers: [{ recipient_id_guid: '00000000-0000-4000-8000-000000000001' }],
  _docusign_env: 'prod',
  _direction: 'inbound',
  _sending_account_id: 'FORGED-SENDER',
  benign_key: 'KEEP_ME',
});

describe('0423 DocuSign metadata key write authority (live trigger)', () => {
  let authed: TypedClient;
  let service: TypedClient;
  const created: string[] = [];

  const insertAsUser = async (filename: string, metadata: unknown) =>
    authed
      .from('anchors')
      .insert({
        user_id: DEMO_CREDENTIALS.adminId,
        org_id: ORG_IDS.arkova,
        fingerprint: fp(),
        filename,
        status: 'PENDING',
        metadata,
      } as never)
      .select('id, metadata')
      .single();

  const insertAsService = async (filename: string, metadata: unknown) =>
    service
      .from('anchors')
      .insert({
        user_id: DEMO_CREDENTIALS.adminId,
        org_id: ORG_IDS.arkova,
        fingerprint: fp(),
        filename,
        status: 'PENDING',
        metadata,
      } as never)
      .select('id, metadata')
      .single();

  const readMetadata = async (id: string) => {
    const { data } = await service.from('anchors').select('metadata').eq('id', id).single();
    return (data as { metadata: Record<string, unknown> | null } | null)?.metadata ?? null;
  };

  beforeAll(async () => {
    authed = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    service = createServiceClient();
  });

  afterAll(async () => {
    if (created.length) await service.from('anchors').delete().in('id', created);
    await cleanupClient(authed);
  });

  it('strips the whole guarded family from an authenticated INSERT, keeping unrelated keys', async () => {
    const { data, error } = await insertAsUser(`${TAG}-A.pdf`, forgedDocusignMetadata());
    // Strip, never raise — the anchor is still written (file header contract).
    expect(error).toBeNull();
    const row = data as { id: string } | null;
    expect(row).not.toBeNull();
    created.push(row!.id);

    const md = (await readMetadata(row!.id)) ?? {};
    for (const key of GUARDED) {
      expect(md, `guarded key "${key}" survived an authenticated INSERT`).not.toHaveProperty(key);
    }
    expect(md.benign_key).toBe('KEEP_ME');
  });

  it('preserves account_id/envelope_id when the row never claims DocuSign provenance', async () => {
    // The conditional branch: these are generic names that AI extraction and
    // org templates legitimately produce. Unconditional guarding would delete
    // real user data with no error.
    const { data, error } = await insertAsUser(`${TAG}-B.pdf`, {
      account_id: 'LEGIT-EXTRACTED-ACCOUNT',
      envelope_id: 'LEGIT-EXTRACTED-ENVELOPE',
      benign_key: 'KEEP_ME',
    });
    expect(error).toBeNull();
    const row = data as { id: string } | null;
    created.push(row!.id);

    const md = (await readMetadata(row!.id)) ?? {};
    expect(md.account_id).toBe('LEGIT-EXTRACTED-ACCOUNT');
    expect(md.envelope_id).toBe('LEGIT-EXTRACTED-ENVELOPE');
  });

  it('lets service_role — the only attesting writer — stamp the family', async () => {
    const { data, error } = await insertAsService(`${TAG}-C.pdf`, {
      connector_source: 'docusign',
      account_id: 'REAL-ACCOUNT',
      envelope_id: 'REAL-ENVELOPE',
    });
    expect(error).toBeNull();
    const row = data as { id: string } | null;
    created.push(row!.id);

    const md = (await readMetadata(row!.id)) ?? {};
    expect(md.connector_source).toBe('docusign');
    expect(md.account_id).toBe('REAL-ACCOUNT');
    expect(md.envelope_id).toBe('REAL-ENVELOPE');
  });

  it('reverts an authenticated UPDATE that tampers with service-stamped values', async () => {
    // Directly covers the gap the text test leaves: it pins only /jsonb_set\(/,
    // so reverting from NEW instead of OLD would keep that suite green while
    // handing the attacker their own value back.
    const { data, error } = await insertAsService(`${TAG}-D.pdf`, {
      connector_source: 'docusign',
      account_id: 'REAL-ACCOUNT',
      envelope_id: 'REAL-ENVELOPE',
    });
    expect(error).toBeNull();
    const row = data as { id: string } | null;
    created.push(row!.id);

    await authed
      .from('anchors')
      .update({
        metadata: {
          connector_source: 'docusign',
          account_id: 'HIJACKED',
          envelope_id: 'HIJACKED',
        },
      } as never)
      .eq('id', row!.id);

    const md = (await readMetadata(row!.id)) ?? {};
    expect(md.account_id, 'tampered account_id was not reverted to the service value').toBe(
      'REAL-ACCOUNT',
    );
    expect(md.envelope_id).toBe('REAL-ENVELOPE');
    expect(md.connector_source).toBe('docusign');
  });

  it('cannot launder account_id by dropping connector_source from the UPDATE payload', async () => {
    // v_claims_docusign consults OLD as well as NEW precisely so omitting
    // connector_source cannot walk account_id/envelope_id past the guard.
    const { data, error } = await insertAsService(`${TAG}-E.pdf`, {
      connector_source: 'docusign',
      account_id: 'REAL-ACCOUNT',
      envelope_id: 'REAL-ENVELOPE',
    });
    expect(error).toBeNull();
    const row = data as { id: string } | null;
    created.push(row!.id);

    await authed
      .from('anchors')
      .update({ metadata: { account_id: 'LAUNDERED', envelope_id: 'LAUNDERED' } } as never)
      .eq('id', row!.id);

    const md = (await readMetadata(row!.id)) ?? {};
    expect(md.account_id, 'account_id was laundered past the guard').toBe('REAL-ACCOUNT');
    expect(md.envelope_id).toBe('REAL-ENVELOPE');
    // Deletion of a guarded key is undone too, not just tampering.
    expect(md.connector_source).toBe('docusign');
  });

  it('keeps the trigger installed and enabled on anchors', async () => {
    // Fails loudly if a later CREATE OR REPLACE / DROP removes the guard — the
    // 0383 failure mode a text assertion cannot see. Proven behaviourally
    // rather than by catalog introspection, since no arbitrary-SQL RPC is
    // exposed to the test client: an authenticated forgery must still strip.
    const { data: probe, error: probeErr } = await insertAsUser(`${TAG}-F.pdf`, {
      connector_source: 'docusign',
      benign_key: 'KEEP_ME',
    });
    expect(probeErr).toBeNull();
    const row = probe as { id: string } | null;
    created.push(row!.id);
    const md = (await readMetadata(row!.id)) ?? {};
    expect(md, 'trigger is not enforcing — 0423 may have been reverted').not.toHaveProperty(
      'connector_source',
    );
    expect(md.benign_key).toBe('KEEP_ME');
  });
});
