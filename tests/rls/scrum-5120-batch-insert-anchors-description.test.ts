/**
 * SCRUM-5120 — `batch_insert_anchors` was silently dropping the caller's
 * `description` field.
 *
 * Migration 0458 threads `elem->>'description'` through the RPC's input CTE
 * and the INSERT column list/matching SELECT. Before this fix, every element
 * of `p_anchors` that carried a `description` (the shape
 * `services/worker/src/jobs/publicRecordAnchor.ts`'s `buildPipelineAnchorInsert`
 * has always sent) had it silently discarded — the RPC still returned a
 * normal `{id, fingerprint}` per row, so nothing signaled the loss. 40,059
 * openalex/federal_register pipeline anchors created since 2026-08-17 have
 * `description IS NULL` as a result (backfilled out of band by
 * `scripts/ops/repair-pipeline-anchor-descriptions.ts`, not by this suite).
 *
 * This is a live-Postgres RPC test, not a mocked one, on purpose: the
 * property under test ("the RPC persists what it was given") is enforced by
 * the SQL body itself, and `tests/rls/agents.md`'s own rule is that a mock
 * may stand in for a collaborator, never for the invariant under test. A unit
 * test mocking `client.rpc(...)` would only prove the JS call SHAPE is right
 * (see `services/worker/src/jobs/__tests__/publicRecordAnchor-description-rpc-argument.test.ts`
 * for that half) — it cannot prove the function actually stores the value,
 * which is exactly the bug here.
 *
 * `batch_insert_anchors` is service_role-only since 0377
 * (`REVOKE ALL ... FROM PUBLIC, anon, authenticated`), so this suite calls it
 * via `createServiceClient()`, matching the worker's real caller identity.
 *
 * Prerequisites: local Supabase running + migrated to at least 0458 (see
 * tests/rls/agents.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServiceClient } from '../../src/tests/rls/helpers';

const RUN_STARTED = Date.now();
const RUN_ID = RUN_STARTED.toString(36);
const RUN_HEX = RUN_STARTED.toString(16).padStart(12, '0').slice(-12);
const ORG_ID = 'f19e2400-0000-4000-8000-0000000005120';

let fpSeed = 0;
function nextFingerprint(): string {
  fpSeed += 1;
  return (RUN_HEX + fpSeed.toString(16).padStart(4, '0')).repeat(4).slice(0, 64);
}

type BatchInsertResult = { id: string; fingerprint: string };

describe('SCRUM-5120 — batch_insert_anchors persists description (migration 0458)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = createServiceClient() as any;
  let userId: string;

  beforeAll(async () => {
    const orgName = `SCRUM-5120 Description Round-Trip Org ${RUN_ID}`;
    const { error: orgErr } = await service
      .from('organizations')
      .upsert({ id: ORG_ID, legal_name: orgName, display_name: orgName }, { onConflict: 'id' });
    if (orgErr) throw new Error(`org upsert failed: ${orgErr.message}`);

    const email = `scrum-5120-description-${RUN_ID}@rls.arkova.local`;
    const { data: created, error: createErr } = await service.auth.admin.createUser({
      email,
      password: process.env.RLS_TEST_PASSWORD as string,
      email_confirm: true,
    });
    if (createErr) throw new Error(`createUser failed: ${createErr.message}`);
    userId = created.user.id as string;

    const { error: profErr } = await service.from('profiles').upsert(
      { id: userId, email, full_name: 'SCRUM-5120 Seed', role: 'ORG_ADMIN', org_id: ORG_ID, is_public_profile: false },
      { onConflict: 'id' },
    );
    if (profErr) throw new Error(`profile upsert failed: ${profErr.message}`);
  }, 60_000);

  afterAll(async () => {
    await service.from('anchors').delete().eq('org_id', ORG_ID);
    if (userId) await service.auth.admin.deleteUser(userId);
    await service.from('organizations').delete().eq('id', ORG_ID);
  }, 60_000);

  it('persists description for an element that carries one, and leaves it NULL for an element that does not', async () => {
    const withDescriptionFingerprint = nextFingerprint();
    const withoutDescriptionFingerprint = nextFingerprint();
    const descriptionText = `SCRUM-5120 round-trip description ${RUN_ID}`;

    // Mirrors buildPipelineAnchorInsert's real shape exactly: the element
    // WITHOUT a description omits the key entirely (conditional spread,
    // `...(description ? { description } : {})`), it is not sent as
    // `description: null`.
    const { data, error } = await service.rpc('batch_insert_anchors', {
      p_anchors: [
        {
          user_id: userId,
          org_id: ORG_ID,
          fingerprint: withDescriptionFingerprint,
          filename: `scrum-5120-with-description-${RUN_ID}.pdf`,
          credential_type: 'OTHER',
          status: 'PENDING',
          description: descriptionText,
          metadata: { pipeline_source: 'openalex', source_id: `${RUN_ID}-1`, source_url: null, record_type: 'article' },
        },
        {
          user_id: userId,
          org_id: ORG_ID,
          fingerprint: withoutDescriptionFingerprint,
          filename: `scrum-5120-without-description-${RUN_ID}.pdf`,
          credential_type: 'OTHER',
          status: 'PENDING',
          metadata: { pipeline_source: 'federal_register', source_id: `${RUN_ID}-2`, source_url: null, record_type: 'notice' },
        },
      ],
    });

    expect(error, `batch_insert_anchors errored: ${error?.message}`).toBeNull();
    const rows = data as BatchInsertResult[];
    expect(rows).toHaveLength(2);

    const { data: readBack, error: readErr } = await service
      .from('anchors')
      .select('fingerprint, description')
      .in('fingerprint', [withDescriptionFingerprint, withoutDescriptionFingerprint]);
    expect(readErr, `read-back failed: ${readErr?.message}`).toBeNull();
    expect(readBack).toHaveLength(2);

    const byFingerprint = new Map(
      (readBack as Array<{ fingerprint: string; description: string | null }>).map((r) => [r.fingerprint.trim(), r.description]),
    );

    // POSITIVE: the element that carried a description must have it persisted
    // verbatim — this is the SCRUM-5120 defect. Before migration 0458 this
    // assertion fails: the RPC silently dropped it and this reads back NULL.
    expect(byFingerprint.get(withDescriptionFingerprint)).toBe(descriptionText);

    // NEGATIVE CONTROL: an element that never carried a description must
    // stay NULL, not '' or some default — proves the fix reads the caller's
    // value rather than always writing a fixed string.
    expect(byFingerprint.get(withoutDescriptionFingerprint)).toBeNull();
  });

  it('the dedup path (ON CONFLICT DO NOTHING) is unaffected by the description column', async () => {
    // Regression guard for the SCRUM-3031 (0370) wedge fix this migration
    // touches the same function body as: re-submitting the SAME fingerprint
    // for the SAME user must still resolve via the `existing` CTE, not error
    // or create a duplicate row, regardless of whether description is present.
    const fingerprint = nextFingerprint();
    const firstDescription = `first-call-${RUN_ID}`;
    const secondDescription = `second-call-should-not-apply-${RUN_ID}`;

    const first = await service.rpc('batch_insert_anchors', {
      p_anchors: [
        {
          user_id: userId,
          org_id: ORG_ID,
          fingerprint,
          filename: `scrum-5120-dedup-${RUN_ID}.pdf`,
          credential_type: 'OTHER',
          status: 'PENDING',
          description: firstDescription,
          metadata: { pipeline_source: 'openalex', source_id: `${RUN_ID}-dedup`, source_url: null, record_type: 'article' },
        },
      ],
    });
    expect(first.error, `first call errored: ${first.error?.message}`).toBeNull();
    const firstRows = first.data as BatchInsertResult[];
    expect(firstRows).toHaveLength(1);

    const second = await service.rpc('batch_insert_anchors', {
      p_anchors: [
        {
          user_id: userId,
          org_id: ORG_ID,
          fingerprint,
          filename: `scrum-5120-dedup-${RUN_ID}.pdf`,
          credential_type: 'OTHER',
          status: 'PENDING',
          description: secondDescription,
          metadata: { pipeline_source: 'openalex', source_id: `${RUN_ID}-dedup`, source_url: null, record_type: 'article' },
        },
      ],
    });
    expect(second.error, `second call errored: ${second.error?.message}`).toBeNull();
    const secondRows = second.data as BatchInsertResult[];
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].id).toBe(firstRows[0].id);

    const { data: readBack, error: readErr } = await service
      .from('anchors')
      .select('description')
      .eq('id', firstRows[0].id)
      .single();
    expect(readErr, `read-back failed: ${readErr?.message}`).toBeNull();
    // ON CONFLICT DO NOTHING means the SECOND call's description never lands —
    // the row keeps whatever the first (winning) insert wrote.
    expect((readBack as { description: string | null }).description).toBe(firstDescription);
  });
});
