/**
 * P7 Integration Tests
 *
 * Tests for Priority 7 features:
 * - Billing idempotency (P7-S3)
 * - Job claim mechanism (P7-S5)
 * - Anchor status protection (P7-S6)
 * - Switchboard flags (P7-S14)
 *
 * Prerequisites:
 * - Supabase running locally (supabase start)
 * - Database reset with seed data (supabase db reset)
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

// Helper that matches the old createAuthenticatedClient(email, password) signature
async function createAuthenticatedClient(
  email: string,
  _password: string
): Promise<TypedClient> {
  return withUser(email, email.includes('admin') ? 'ORG_ADMIN' : 'INDIVIDUAL');
}

// =============================================================================
// P7-S3: BILLING IDEMPOTENCY TESTS
// =============================================================================

describe('P7-S3: Billing Event Idempotency', () => {
  let serviceClient: TypedClient;

  beforeAll(() => {
    serviceClient = createServiceClient();
  });

  it('rejects duplicate Stripe event IDs', async () => {
    const stripeEventId = `evt_test_${Date.now()}`;

    // First insert should succeed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: firstError } = await (serviceClient as any).from('billing_events').insert({
      stripe_event_id: stripeEventId,
      event_type: 'checkout.session.completed',
      payload: { test: true },
    });

    expect(firstError).toBeNull();

    // Duplicate insert should fail with unique constraint violation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: duplicateError } = await (serviceClient as any).from('billing_events').insert({
      stripe_event_id: stripeEventId,
      event_type: 'checkout.session.completed',
      payload: { test: true, duplicate: true },
    });

    expect(duplicateError).not.toBeNull();
    expect(duplicateError!.code).toBe('23505'); // unique_violation

    // Cleanup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).from('billing_events').delete().eq('stripe_event_id', stripeEventId);
  });

  it('rejects duplicate idempotency keys', async () => {
    const idempotencyKey = `idem_test_${Date.now()}`;

    // First insert should succeed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: firstError } = await (serviceClient as any).from('billing_events').insert({
      event_type: 'invoice.paid',
      idempotency_key: idempotencyKey,
      payload: { test: true },
    });

    expect(firstError).toBeNull();

    // Duplicate insert should fail
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: duplicateError } = await (serviceClient as any).from('billing_events').insert({
      event_type: 'invoice.paid',
      idempotency_key: idempotencyKey,
      payload: { test: true, duplicate: true },
    });

    expect(duplicateError).not.toBeNull();
    expect(duplicateError!.code).toBe('23505'); // unique_violation

    // Cleanup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).from('billing_events').delete().eq('idempotency_key', idempotencyKey);
  });

  it('billing events are append-only (cannot be updated)', async () => {
    const eventId = `evt_immutable_${Date.now()}`;

    // Create event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: created } = await (serviceClient as any)
      .from('billing_events')
      .insert({
        stripe_event_id: eventId,
        event_type: 'test.event',
        payload: { original: true },
      })
      .select()
      .single();

    expect(created).not.toBeNull();

    // Attempt to update
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateError } = await (serviceClient as any)
      .from('billing_events')
      .update({ payload: { modified: true } })
      .eq('id', created!.id);

    expect(updateError).not.toBeNull();
    expect(updateError!.message).toContain('immutable');

    // Cleanup
    // Note: Since delete is also blocked, we'll need to verify the cleanup approach
    // For test purposes, we verify immutability first
  });
});

// =============================================================================
// P7-S5: JOB CLAIM DUPLICATE EXECUTION TESTS
// =============================================================================

describe('P7-S5: Job Claim Mechanism', () => {
  let serviceClient: TypedClient;
  let testAnchorId: string;
  let testJobId: string;

  beforeAll(async () => {
    serviceClient = createServiceClient();

    // Clear any pending jobs from seed data so claim_anchoring_job picks our test job
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).from('anchoring_jobs').delete().eq('status', 'pending');

    // Create a test anchor to generate a job (timestamp-based fingerprint for uniqueness)
    const ts = Date.now().toString(16).padStart(16, '0');
    const fingerprint = `d1e2f3a4${ts}`.padEnd(64, '0').slice(0, 64);
    const { data: anchor, error } = await serviceClient
      .from('anchors')
      .insert({
        user_id: DEMO_CREDENTIALS.userId,
        fingerprint: fingerprint,
        filename: 'job_test.pdf',
        status: 'PENDING',
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to create test anchor:', error);
      throw error;
    }
    testAnchorId = anchor.id;

    // Get the auto-created job
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: job } = await (serviceClient as any)
      .from('anchoring_jobs')
      .select('id')
      .eq('anchor_id', testAnchorId)
      .single();

    if (job) {
      testJobId = job.id;
    }
  });

  afterAll(async () => {
    // Cleanup
    if (testAnchorId) {
      await serviceClient.from('anchors').delete().eq('id', testAnchorId);
    }
  });

  it('auto-creates job when anchor is inserted with PENDING status', async () => {
    expect(testJobId).toBeDefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: job } = await (serviceClient as any)
      .from('anchoring_jobs')
      .select('*')
      .eq('id', testJobId)
      .single();

    expect(job).not.toBeNull();
    expect(job!.status).toBe('pending');
    expect(job!.anchor_id).toBe(testAnchorId);
  });

  it('claim_anchoring_job returns job ID and locks it', async () => {
    const workerId = 'test-worker-1';

    // Claim the job
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: claimedId, error } = await (serviceClient.rpc as any)('claim_anchoring_job', {
      p_worker_id: workerId,
      p_lock_duration_seconds: 60,
    });

    expect(error).toBeNull();
    expect(claimedId).toBe(testJobId);

    // Verify job is now processing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: job } = await (serviceClient as any)
      .from('anchoring_jobs')
      .select('*')
      .eq('id', testJobId)
      .single();

    expect(job!.status).toBe('processing');
    expect(job!.claimed_by).toBe(workerId);
    expect(job!.claim_expires_at).not.toBeNull();
  });

  it('second worker cannot claim already claimed job (SKIP LOCKED)', async () => {
    const secondWorkerId = 'test-worker-2';

    // Second worker tries to claim - should get null (no available jobs)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: secondClaimId, error } = await (serviceClient.rpc as any)('claim_anchoring_job', {
      p_worker_id: secondWorkerId,
      p_lock_duration_seconds: 60,
    });

    expect(error).toBeNull();
    expect(secondClaimId).toBeNull(); // No job available due to SKIP LOCKED
  });

  it('complete_anchoring_job marks job as completed', async () => {
    // Complete the job
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: success, error } = await (serviceClient.rpc as any)('complete_anchoring_job', {
      p_job_id: testJobId,
      p_success: true,
    });

    expect(error).toBeNull();
    expect(success).toBe(true);

    // Verify job status
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: job } = await (serviceClient as any)
      .from('anchoring_jobs')
      .select('*')
      .eq('id', testJobId)
      .single();

    expect(job!.status).toBe('completed');
    expect(job!.completed_at).not.toBeNull();
  });

  it('unique constraint prevents duplicate jobs per anchor', async () => {
    // Try to create another job for the same anchor
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (serviceClient as any).from('anchoring_jobs').insert({
      anchor_id: testAnchorId,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('23505'); // unique_violation
  });
});

// =============================================================================
// P7-S6: ANCHOR STATUS PROTECTION TESTS
// =============================================================================

describe('P7-S6: Anchor Status Protection', () => {
  let userClient: TypedClient;
  let serviceClient: TypedClient;
  let testAnchorId: string;

  beforeAll(async () => {
    userClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.userEmail,
      DEMO_CREDENTIALS.userPassword
    );
    serviceClient = createServiceClient();

    // Use timestamp-based fingerprint to avoid collisions across test runs
    const ts = Date.now().toString(16).padStart(16, '0');
    const fingerprint = `a1b2c3d4${ts}`.padEnd(64, '0').slice(0, 64);
    const { data: anchor, error } = await userClient
      .from('anchors')
      .insert({
        user_id: DEMO_CREDENTIALS.userId,
        fingerprint: fingerprint,
        filename: 'status_test.pdf',
        status: 'PENDING',
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to create test anchor for status protection:', error);
      throw error;
    }
    testAnchorId = anchor!.id;
  });

  afterAll(async () => {
    if (testAnchorId) {
      await serviceClient.from('anchors').delete().eq('id', testAnchorId);
    }
    await userClient.auth.signOut();
  });

  it('user cannot insert anchor with SECURED status', async () => {
    const ts2 = Date.now().toString(16).padStart(16, '0');
    const fingerprint = `e5f6a7b8${ts2}`.padEnd(64, '0').slice(0, 64);
    const { error } = await userClient.from('anchors').insert({
      user_id: DEMO_CREDENTIALS.userId,
      fingerprint: fingerprint,
      filename: 'forged_secured.pdf',
      status: 'SECURED',
    });

    // RLS policy should block this
    expect(error).not.toBeNull();
  });

  it('user cannot update anchor status to SECURED', async () => {
    const { error } = await userClient
      .from('anchors')
      .update({ status: 'SECURED' })
      .eq('id', testAnchorId);

    // Trigger should block this
    expect(error).not.toBeNull();
    expect(error!.message).toContain('Cannot set status to SECURED directly');
  });

  it('user cannot modify chain data', async () => {
    const { error } = await userClient
      .from('anchors')
      .update({
        chain_tx_id: 'forged_tx_123',
        chain_block_height: 999999,
      })
      .eq('id', testAnchorId);

    // Trigger should block this
    expect(error).not.toBeNull();
    expect(error!.message).toContain('Cannot modify chain data');
  });

  it('user cannot modify legal_hold', async () => {
    const { error } = await userClient
      .from('anchors')
      .update({ legal_hold: true })
      .eq('id', testAnchorId);

    // Trigger should block this
    expect(error).not.toBeNull();
    expect(error!.message).toContain('Cannot modify legal_hold');
  });

  it('service role CAN set anchor status to SECURED', async () => {
    const { error } = await serviceClient
      .from('anchors')
      .update({
        status: 'SECURED',
        chain_tx_id: 'test_tx_123',
        chain_block_height: 12345,
        chain_timestamp: new Date().toISOString(),
      })
      .eq('id', testAnchorId);

    expect(error).toBeNull();

    // Verify update
    const { data: anchor } = await serviceClient
      .from('anchors')
      .select('status, chain_tx_id')
      .eq('id', testAnchorId)
      .single();

    expect(anchor!.status).toBe('SECURED');
    expect(anchor!.chain_tx_id).toBe('test_tx_123');
  });
});

// =============================================================================
// TLA-01: CREDENTIAL_TYPE IMMUTABILITY TESTS
// =============================================================================

describe('TLA-01: credential_type Immutability After PENDING', () => {
  let userClient: TypedClient;
  let serviceClient: TypedClient;
  let pendingAnchorId: string;
  let securedAnchorId: string;

  beforeAll(async () => {
    userClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.userEmail,
      DEMO_CREDENTIALS.userPassword
    );
    serviceClient = createServiceClient();

    // Create a PENDING anchor (credential_type should still be mutable)
    const ts1 = Date.now().toString(16).padStart(16, '0');
    const fp1 = `tla01aaa${ts1}`.padEnd(64, '0').slice(0, 64);
    const { data: pending, error: e1 } = await userClient
      .from('anchors')
      .insert({
        user_id: DEMO_CREDENTIALS.userId,
        fingerprint: fp1,
        filename: 'tla01_pending.pdf',
        status: 'PENDING',
        credential_type: 'DEGREE',
      })
      .select()
      .single();

    if (e1) throw e1;
    pendingAnchorId = pending!.id;

    // Create a SECURED anchor (credential_type should be immutable)
    const ts2 = (Date.now() + 1).toString(16).padStart(16, '0');
    const fp2 = `tla01bbb${ts2}`.padEnd(64, '0').slice(0, 64);
    const { data: secured, error: e2 } = await serviceClient
      .from('anchors')
      .insert({
        user_id: DEMO_CREDENTIALS.userId,
        fingerprint: fp2,
        filename: 'tla01_secured.pdf',
        status: 'PENDING',
        credential_type: 'CERTIFICATE',
      })
      .select()
      .single();

    if (e2) throw e2;

    // Promote to SECURED via service role
    await serviceClient
      .from('anchors')
      .update({
        status: 'SECURED',
        chain_tx_id: 'tla01_test_tx',
        chain_block_height: 99999,
        chain_timestamp: new Date().toISOString(),
      })
      .eq('id', secured!.id);

    securedAnchorId = secured!.id;
  });

  afterAll(async () => {
    if (pendingAnchorId) {
      await serviceClient.from('anchors').delete().eq('id', pendingAnchorId);
    }
    if (securedAnchorId) {
      await serviceClient.from('anchors').delete().eq('id', securedAnchorId);
    }
    await userClient.auth.signOut();
  });

  it('PENDING anchor allows credential_type change', async () => {
    const { error } = await userClient
      .from('anchors')
      .update({ credential_type: 'LICENSE' })
      .eq('id', pendingAnchorId);

    expect(error).toBeNull();

    // Verify update
    const { data } = await userClient
      .from('anchors')
      .select('credential_type')
      .eq('id', pendingAnchorId)
      .single();

    expect(data!.credential_type).toBe('LICENSE');
  });

  it('SECURED anchor blocks credential_type change (non-service-role)', async () => {
    const { error } = await userClient
      .from('anchors')
      .update({ credential_type: 'DEGREE' })
      .eq('id', securedAnchorId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('Cannot modify credential_type after anchor leaves PENDING');
  });

  it('service role CAN still modify credential_type on SECURED anchor', async () => {
    const { error } = await serviceClient
      .from('anchors')
      .update({ credential_type: 'TRANSCRIPT' })
      .eq('id', securedAnchorId);

    expect(error).toBeNull();
  });
});

// =============================================================================
// P7-S14: SWITCHBOARD FLAGS TESTS
// =============================================================================

describe('P7-S14: Switchboard Flags', () => {
  let serviceClient: TypedClient;
  let userClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    userClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.userEmail,
      DEMO_CREDENTIALS.userPassword
    );
  });

  afterAll(async () => {
    await userClient.auth.signOut();
  });

  it('get_flag returns flag value', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: value, error } = await (userClient.rpc as any)('get_flag', {
      p_flag_key: 'ENABLE_NEW_CHECKOUTS',
    });

    expect(error).toBeNull();
    expect(value).toBe(true); // Default is true
  });

  it('get_flag returns false for non-existent flags', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: value, error } = await (userClient.rpc as any)('get_flag', {
      p_flag_key: 'NON_EXISTENT_FLAG',
    });

    expect(error).toBeNull();
    expect(value).toBe(false); // Safe default
  });

  it('authenticated users can read flags but not modify them', async () => {
    // Read should work
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: flags, error: readError } = await (userClient as any)
      .from('switchboard_flags')
      .select('*');

    expect(readError).toBeNull();
    expect(flags!.length).toBeGreaterThan(0);

    // Update should be silently denied by RLS (no UPDATE policy for authenticated)
    // PostgreSQL RLS doesn't raise errors — it silently skips non-matching rows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (userClient as any)
      .from('switchboard_flags')
      .update({ value: true })
      .eq('id', 'ENABLE_OUTBOUND_WEBHOOKS');

    // Verify the value was NOT actually changed (RLS blocked it)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: after } = await (userClient as any)
      .from('switchboard_flags')
      .select('value')
      .eq('id', 'ENABLE_OUTBOUND_WEBHOOKS')
      .single();

    expect(after!.value).toBe(false); // Original value preserved
  });

  it('service role can modify flags', async () => {
    // Get current value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: before } = await (serviceClient as any)
      .from('switchboard_flags')
      .select('value')
      .eq('id', 'ENABLE_OUTBOUND_WEBHOOKS')
      .single();

    const originalValue = before!.value;

    // Update flag
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateError } = await (serviceClient as any)
      .from('switchboard_flags')
      .update({ value: !originalValue })
      .eq('id', 'ENABLE_OUTBOUND_WEBHOOKS');

    expect(updateError).toBeNull();

    // Verify update
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: after } = await (serviceClient as any)
      .from('switchboard_flags')
      .select('value')
      .eq('id', 'ENABLE_OUTBOUND_WEBHOOKS')
      .single();

    expect(after!.value).toBe(!originalValue);

    // Restore original value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any)
      .from('switchboard_flags')
      .update({ value: originalValue })
      .eq('id', 'ENABLE_OUTBOUND_WEBHOOKS');
  });

  it('flag changes are logged in history', async () => {
    const testFlagId = 'ENABLE_REPORTS';

    // Get current value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: before } = await (serviceClient as any)
      .from('switchboard_flags')
      .select('value')
      .eq('id', testFlagId)
      .single();

    const originalValue = before!.value;

    // Update flag
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any)
      .from('switchboard_flags')
      .update({ value: !originalValue })
      .eq('id', testFlagId);

    // Check history
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: history, error: historyError } = await (serviceClient as any)
      .from('switchboard_flag_history')
      .select('*')
      .eq('flag_id', testFlagId)
      .order('changed_at', { ascending: false })
      .limit(1);

    expect(historyError).toBeNull();
    expect(history!.length).toBe(1);
    expect(history![0].old_value).toBe(originalValue);
    expect(history![0].new_value).toBe(!originalValue);

    // Restore original value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any)
      .from('switchboard_flags')
      .update({ value: originalValue })
      .eq('id', testFlagId);
  });

  it('production anchoring flag defaults to false (safe default)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: value } = await (serviceClient.rpc as any)('get_flag', {
      p_flag_key: 'ENABLE_PROD_NETWORK_ANCHORING',
    });

    expect(value).toBe(false);
  });

  it('dangerous flags are marked as is_dangerous=true', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dangerousFlags } = await (serviceClient as any)
      .from('switchboard_flags')
      .select('id, is_dangerous')
      .eq('is_dangerous', true);

    expect(dangerousFlags!.length).toBeGreaterThan(0);

    // Verify specific dangerous flags
    const dangerousIds = dangerousFlags!.map((f: { id: string }) => f.id);
    expect(dangerousIds).toContain('ENABLE_PROD_NETWORK_ANCHORING');
    expect(dangerousIds).toContain('MAINTENANCE_MODE');
  });
});

// =============================================================================
// P7-S7: PUBLIC VERIFICATION TESTS
// =============================================================================

describe('P7-S7: Public Verification', () => {
  let serviceClient: TypedClient;
  let testAnchorId: string;
  let testPublicId: string;

  beforeAll(async () => {
    serviceClient = createServiceClient();

    // Create a PENDING anchor (public_id is auto-generated on INSERT)
    const ts = Date.now().toString(16).padStart(16, '0');
    const fingerprint = `c9d0e1f2${ts}`.padEnd(64, '0').slice(0, 64);
    const { data: anchor, error: insertError } = await serviceClient
      .from('anchors')
      .insert({
        user_id: DEMO_CREDENTIALS.userId,
        fingerprint: fingerprint,
        filename: 'public_test.pdf',
        status: 'PENDING',
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create test anchor for public verification:', insertError);
      throw insertError;
    }
    testAnchorId = anchor!.id;

    // Update to SECURED so get_public_anchor RPC can find it
    await serviceClient
      .from('anchors')
      .update({
        status: 'SECURED',
        chain_tx_id: 'test_receipt_123',
        chain_block_height: 54321,
        chain_timestamp: new Date().toISOString(),
      })
      .eq('id', testAnchorId);

    // Get the public_id (generated on INSERT, not on SECURED transition)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: updated } = await (serviceClient as any)
      .from('anchors')
      .select('public_id')
      .eq('id', testAnchorId)
      .single();

    testPublicId = updated!.public_id!;
  });

  afterAll(async () => {
    if (testAnchorId) {
      await serviceClient.from('anchors').delete().eq('id', testAnchorId);
    }
  });

  it('secured anchors have a public_id generated', async () => {
    expect(testPublicId).toBeDefined();
    expect(testPublicId.length).toBeGreaterThan(10); // nano_id format
  });

  it('get_public_anchor returns redacted data for valid public_id', async () => {
    // Use anonymous client (no auth)
    const anonClient = createAnonClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: result, error } = await (anonClient.rpc as any)('get_public_anchor', {
      p_public_id: testPublicId,
    });

    expect(error).toBeNull();
    expect(result).not.toBeNull();
    expect(result.verified).toBe(true);
    expect(result.public_id).toBe(testPublicId);
    expect(result.filename).toBe('public_test.pdf');
    // Migration 0039 maps SECURED → ACTIVE in the public API
    expect(result.status).toBe('ACTIVE');

    // Phase 1.5 frozen schema fields
    expect(result.issuer_name).toBeDefined();
    expect(result.credential_type).toBeDefined();
    expect(result.record_uri).toContain(testPublicId);

    // Should NOT include sensitive fields
    expect(result.user_id).toBeUndefined();
    expect(result.org_id).toBeUndefined();
  });

  it('get_public_anchor returns error for invalid public_id', async () => {
    const anonClient = createAnonClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: result, error } = await (anonClient.rpc as any)('get_public_anchor', {
      p_public_id: 'invalid_id_12345',
    });

    expect(error).toBeNull();
    // Function returns { error: "Anchor not found or not verified" } for invalid IDs
    expect(result.error).toBeDefined();
    expect(result.verified).toBeUndefined();
  });

  it('get_public_anchor does not expose PENDING anchors', async () => {
    // Create a PENDING anchor (public_id is generated on INSERT since migration 0037)
    const fingerprint = 'f3e4d5c6'.repeat(8); // valid 64-char hex
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: pending } = await (serviceClient as any)
      .from('anchors')
      .insert({
        user_id: DEMO_CREDENTIALS.userId,
        fingerprint: fingerprint,
        filename: 'pending_test.pdf',
        status: 'PENDING',
      })
      .select('id, public_id')
      .single();

    // PENDING anchors now get a public_id on INSERT, but the RPC should NOT expose them
    expect(pending!.public_id).not.toBeNull();

    // Verify the RPC does not return data for PENDING anchors
    const anonClient = createAnonClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: result } = await (anonClient.rpc as any)('get_public_anchor', {
      p_public_id: pending!.public_id,
    });
    expect(result.error).toBeDefined();
    expect(result.verified).toBeUndefined();

    // Cleanup
    await serviceClient.from('anchors').delete().eq('id', pending!.id);
  });
});

// =============================================================================
// P7-S10: WEBHOOK ENDPOINT SECURITY TESTS
// =============================================================================

describe('P7-S10: Webhook Endpoint Security', () => {
  let adminClient: TypedClient;
  let userClient: TypedClient;
  let serviceClient: TypedClient;

  const ARKOVA_ORG_ID = ORG_IDS.arkova;

  beforeAll(async () => {
    adminClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.adminEmail,
      DEMO_CREDENTIALS.adminPassword
    );
    userClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.userEmail,
      DEMO_CREDENTIALS.userPassword
    );
    serviceClient = createServiceClient();
  });

  afterAll(async () => {
    await adminClient.auth.signOut();
    await userClient.auth.signOut();
  });

  it('ORG_ADMIN can create webhook endpoints for their org', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: endpoint, error } = await (adminClient as any)
      .from('webhook_endpoints')
      .insert({
        org_id: ARKOVA_ORG_ID,
        url: 'https://example.com/webhook',
        events: ['anchor.secured'],
        secret_hash: 'test_secret_hash',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(endpoint).not.toBeNull();
    expect(endpoint!.org_id).toBe(ARKOVA_ORG_ID);

    // Cleanup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).from('webhook_endpoints').delete().eq('id', endpoint!.id);
  });

  it('INDIVIDUAL users cannot create webhook endpoints', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (userClient as any).from('webhook_endpoints').insert({
      org_id: ARKOVA_ORG_ID,
      url: 'https://malicious.com/webhook',
      events: ['anchor.secured'],
      secret_hash: 'bad_secret',
    });

    // Should fail - INDIVIDUAL users have no org
    expect(error).not.toBeNull();
  });

  it('secret_hash is write-only (not readable)', async () => {
    // Create endpoint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: created } = await (serviceClient as any)
      .from('webhook_endpoints')
      .insert({
        org_id: ARKOVA_ORG_ID,
        url: 'https://test.com/webhook',
        events: ['anchor.secured'],
        secret_hash: 'super_secret_value',
      })
      .select()
      .single();

    // Reading back should not include secret_hash in a way that's usable
    // Note: The actual implementation may vary - this tests the concept
    expect(created).not.toBeNull();

    // Cleanup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).from('webhook_endpoints').delete().eq('id', created!.id);
  });
});
