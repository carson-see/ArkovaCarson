/**
 * QUEUE-02 / SCRUM-2348 — connector_artifact RLS + enqueue idempotency.
 *
 * Behavioural proof against a live Supabase instance for migration 0343:
 *   1. service_role can INSERT a connector_artifact row.
 *   2. An org-A member can SELECT only org-A artifacts.
 *   3. An org-A member can NEVER SELECT an org-B artifact (cross-tenant denial).
 *   4. An org-B admin can NEVER SELECT an org-A artifact (reverse direction).
 *   5. An anonymous client reads zero rows.
 *   6. enqueue_connector_artifact is idempotent: two calls with the same
 *      (org_id, source, external_ref, external_revision) insert ONE row and
 *      return the same id — including the NULL-external_revision case.
 *   7. enqueue_connector_artifact is NOT executable by anon / authenticated.
 *
 * Prerequisites:
 *   - Supabase running locally (supabase start)
 *   - Database reset with seed data (supabase db reset)
 *   - Migration 0343 applied
 *
 * Pattern mirrored from tests/rls/credential-source-providers.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  withUser,
  createServiceClient,
  createAnonClient,
  DEMO_CREDENTIALS,
  ORG_IDS,
  type TypedClient,
} from '../../src/tests/rls/helpers';

const ARKOVA_ORG_ID = ORG_IDS.arkova;
const BETA_ORG_ID = ORG_IDS.betaCorp;

const REF_PREFIX = 'rls-test-queue02-';
// 64 lowercase-hex chars, satisfies the fingerprint_sha256 CHECK.
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

describe('SCRUM-2348 — connector_artifact RLS + enqueue idempotency', () => {
  let serviceClient: TypedClient;
  let arkovaAdminClient: TypedClient;
  let betaAdminClient: TypedClient;
  let anonClient: TypedClient;

  let arkovaArtifactId: string;
  let betaArtifactId: string;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    arkovaAdminClient = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    betaAdminClient = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
    anonClient = createAnonClient();

    // Seed one artifact per org via service_role.
    const { data: arkovaRow, error: arkovaErr } = await serviceClient
      .from('connector_artifact')
      .insert({
        org_id: ARKOVA_ORG_ID,
        source: 'google_drive',
        external_ref: `${REF_PREFIX}arkova-file`,
        external_revision: 'rev-1',
        fingerprint_sha256: FP_A,
      })
      .select('id')
      .single();
    expect(arkovaErr).toBeNull();
    arkovaArtifactId = arkovaRow!.id;

    const { data: betaRow, error: betaErr } = await serviceClient
      .from('connector_artifact')
      .insert({
        org_id: BETA_ORG_ID,
        source: 'docusign',
        external_ref: `${REF_PREFIX}beta-file`,
        external_revision: 'rev-1',
        fingerprint_sha256: FP_B,
      })
      .select('id')
      .single();
    expect(betaErr).toBeNull();
    betaArtifactId = betaRow!.id;
  });

  afterAll(async () => {
    await serviceClient
      .from('connector_artifact')
      .delete()
      .like('external_ref', `${REF_PREFIX}%`);

    await arkovaAdminClient.auth.signOut();
    await betaAdminClient.auth.signOut();
  });

  describe('service_role writes', () => {
    it('service_role successfully inserted both seed rows', () => {
      expect(arkovaArtifactId).toBeTruthy();
      expect(betaArtifactId).toBeTruthy();
    });
  });

  describe('tenant isolation (SELECT)', () => {
    it('org-A member sees the org-A artifact', async () => {
      const { data, error } = await arkovaAdminClient
        .from('connector_artifact')
        .select('id, org_id')
        .eq('id', arkovaArtifactId);
      expect(error).toBeNull();
      expect(data?.length).toBe(1);
      expect(data?.[0]?.org_id).toBe(ARKOVA_ORG_ID);
    });

    it('org-A member CANNOT see the org-B artifact (cross-tenant denial)', async () => {
      const { data, error } = await arkovaAdminClient
        .from('connector_artifact')
        .select('id')
        .eq('id', betaArtifactId);
      expect(error).toBeNull();
      expect(data?.length).toBe(0);
    });

    it('org-B admin CANNOT see the org-A artifact (reverse direction)', async () => {
      const { data, error } = await betaAdminClient
        .from('connector_artifact')
        .select('id')
        .eq('id', arkovaArtifactId);
      expect(error).toBeNull();
      expect(data?.length).toBe(0);
    });

    it('anonymous client reads zero connector_artifact rows', async () => {
      const { data } = await anonClient
        .from('connector_artifact')
        .select('id')
        .like('external_ref', `${REF_PREFIX}%`);
      expect(data?.length ?? 0).toBe(0);
    });
  });

  describe('authenticated cannot write directly', () => {
    it('org admin INSERT is rejected by RLS (service-role-only writes)', async () => {
      const { data, error } = await arkovaAdminClient
        .from('connector_artifact')
        .insert({
          org_id: ARKOVA_ORG_ID,
          source: 'google_drive',
          external_ref: `${REF_PREFIX}should-not-insert`,
          fingerprint_sha256: FP_A,
        })
        .select('id');
      // RLS denies; either an error or zero rows returned.
      expect(error !== null || (data?.length ?? 0) === 0).toBe(true);
    });
  });

  describe('enqueue_connector_artifact idempotency', () => {
    it('two calls with identical key insert ONE row and return the same id', async () => {
      const args = {
        p_org_id: ARKOVA_ORG_ID,
        p_source: 'google_drive',
        p_external_ref: `${REF_PREFIX}idem`,
        p_external_revision: 'rev-7',
        p_fingerprint_sha256: FP_A,
      };

      const { data: id1, error: e1 } = await serviceClient.rpc(
        'enqueue_connector_artifact',
        args,
      );
      expect(e1).toBeNull();
      expect(id1).toBeTruthy();

      const { data: id2, error: e2 } = await serviceClient.rpc(
        'enqueue_connector_artifact',
        args,
      );
      expect(e2).toBeNull();
      expect(id2).toBe(id1);

      const { count } = await serviceClient
        .from('connector_artifact')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', ARKOVA_ORG_ID)
        .eq('source', 'google_drive')
        .eq('external_ref', `${REF_PREFIX}idem`);
      expect(count).toBe(1);
    });

    it('NULL external_revision dedupes correctly (no double-insert)', async () => {
      // Omitting p_external_revision leaves it at its DEFAULT NULL, exercising
      // the COALESCE(external_revision,'') dedupe branch. (The generated RPC
      // arg type is `string | undefined`, so we omit rather than pass literal
      // null — undefined maps to the SQL DEFAULT NULL.)
      const args = {
        p_org_id: ARKOVA_ORG_ID,
        p_source: 'manual_upload',
        p_external_ref: `${REF_PREFIX}idem-null-rev`,
        p_fingerprint_sha256: FP_A,
      };

      const { data: id1, error: e1 } = await serviceClient.rpc(
        'enqueue_connector_artifact',
        args,
      );
      expect(e1).toBeNull();
      expect(id1).toBeTruthy();

      const { data: id2, error: e2 } = await serviceClient.rpc(
        'enqueue_connector_artifact',
        args,
      );
      expect(e2).toBeNull();
      expect(id2).toBe(id1);

      const { count } = await serviceClient
        .from('connector_artifact')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', ARKOVA_ORG_ID)
        .eq('source', 'manual_upload')
        .eq('external_ref', `${REF_PREFIX}idem-null-rev`);
      expect(count).toBe(1);
    });

    it('the enqueue does NOT debit credits (org_credit_deductions unchanged)', async () => {
      const { count: before } = await serviceClient
        .from('org_credit_deductions')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', ARKOVA_ORG_ID);

      await serviceClient.rpc('enqueue_connector_artifact', {
        p_org_id: ARKOVA_ORG_ID,
        p_source: 'batch_upload',
        p_external_ref: `${REF_PREFIX}no-debit`,
        p_external_revision: 'rev-1',
        p_fingerprint_sha256: FP_A,
      });

      const { count: after } = await serviceClient
        .from('org_credit_deductions')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', ARKOVA_ORG_ID);

      expect(after).toBe(before);
    });
  });

  describe('RPC execute grants', () => {
    it('anon cannot execute enqueue_connector_artifact', async () => {
      const { error } = await anonClient.rpc('enqueue_connector_artifact', {
        p_org_id: ARKOVA_ORG_ID,
        p_source: 'google_drive',
        p_external_ref: `${REF_PREFIX}anon-denied`,
        p_external_revision: 'rev-1',
        p_fingerprint_sha256: FP_A,
      });
      // PostgREST returns a permission-denied / function-not-found style error.
      expect(error).not.toBeNull();
    });

    it('authenticated cannot execute enqueue_connector_artifact', async () => {
      const { error } = await arkovaAdminClient.rpc('enqueue_connector_artifact', {
        p_org_id: ARKOVA_ORG_ID,
        p_source: 'google_drive',
        p_external_ref: `${REF_PREFIX}authn-denied`,
        p_external_revision: 'rev-1',
        p_fingerprint_sha256: FP_A,
      });
      expect(error).not.toBeNull();
    });
  });
});
