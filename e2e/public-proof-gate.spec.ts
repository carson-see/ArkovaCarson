/**
 * Public Proof Gate E2E Tests — FE-PROOF-GATE (SCRUM-2501)
 *
 * Round-trip-style coverage of the full proof-availability state machine on
 * the public verification page, per docs/reference/FE_PROOF_GATE_CONTRACT.md:
 *
 *   - state 1  (200 + verified:true + proof_bundle)      -> live download,
 *              downloaded artifact === proof_bundle verbatim
 *   - state 1b (200 + proof_bundle: null)                 -> honest empty-state
 *   - state 2  (404 "No Merkle proof available…")         -> honest empty-state,
 *              THE MOST IMPORTANT STATE — no download control, no error toast
 *   - state 3  (record not yet SECURED)                    -> securing-in-progress
 *   - "Record not found" 404                                -> real error state
 *   - 5xx                                                   -> retryable affordance
 *
 * A live production-grade proof_bundle (real Merkle branch + block header +
 * OP_RETURN commitment) cannot be manufactured against a throwaway E2E test
 * anchor without a full batch-anchoring run, so this spec follows the existing
 * `e2e/provenance-timeline.spec.ts` pattern: a real SECURED/PENDING test
 * anchor drives the page, and `page.route()` intercepts the worker's
 * `/api/v1/verify/:publicId/proof` call to deterministically produce each of
 * the 6 contract states. This is the thorough, deterministic substitute for
 * a live staging round-trip in this environment (every response body here is
 * copied verbatim from the contract / verify-proof.ts, not invented).
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

const PROOF_ROUTE_RE = /\/api\/v1\/verify\/[^/]+\/proof(\?.*)?$/;

const PROOF_BUNDLE = {
  fingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  merkle_root: 'a'.repeat(64),
  merkle_proof: [{ hash: 'b'.repeat(64), position: 'left' }],
  merkle_index: 2,
  leaf_count: 8,
  tx_id: 'c'.repeat(64),
  block_height: 900123,
  block_hash: 'd'.repeat(64),
  block_header: 'e'.repeat(160),
  op_return_payload: `41524b56${'a'.repeat(64)}`,
  block_timestamp: '2026-07-01T00:00:00Z',
  proof_schema_version: 1,
  signature: null,
};

test.describe('Public Proof Gate (FE-PROOF-GATE / SCRUM-2501)', () => {
  const serviceClient = getServiceClient();
  let securedAnchorId: string;
  let securedPublicId: string;
  let pendingAnchorId: string;
  let pendingPublicId: string;

  test.beforeAll(async () => {
    const secured = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'e2e_proof_gate_secured.pdf',
    });
    if (!secured?.id || !secured?.public_id) {
      throw new Error('beforeAll: failed to create SECURED test anchor for proof gate tests');
    }
    securedAnchorId = secured.id;
    securedPublicId = secured.public_id;

    const pending = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'PENDING',
      filename: 'e2e_proof_gate_pending.pdf',
    });
    if (!pending?.id || !pending?.public_id) {
      throw new Error('beforeAll: failed to create PENDING test anchor for proof gate tests');
    }
    pendingAnchorId = pending.id;
    pendingPublicId = pending.public_id;
  });

  test.afterAll(async () => {
    if (securedAnchorId) await deleteTestAnchor(serviceClient, securedAnchorId);
    if (pendingAnchorId) await deleteTestAnchor(serviceClient, pendingAnchorId);
  });

  test('state 1: 200 + verified + proof_bundle renders a live download control; downloaded file matches proof_bundle verbatim', async ({ page }) => {
    await page.route(PROOF_ROUTE_RE, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          public_id: securedPublicId,
          fingerprint: PROOF_BUNDLE.fingerprint,
          merkle_root: PROOF_BUNDLE.merkle_root,
          merkle_proof: PROOF_BUNDLE.merkle_proof,
          tx_id: PROOF_BUNDLE.tx_id,
          block_height: PROOF_BUNDLE.block_height,
          block_timestamp: PROOF_BUNDLE.block_timestamp,
          batch_id: 'batch-e2e-1',
          verified: true,
          proof_bundle: PROOF_BUNDLE,
        }),
      });
    });

    await page.goto(`/verify/${securedPublicId}`);
    await expect(page.getByText('JSON Proof Package')).toBeVisible({ timeout: 10000 });

    // No honest-empty-state or error copy should render alongside a live download.
    await expect(page.getByText(/Secured & Anchored/i)).not.toBeVisible();
    await expect(page.getByTestId('proof-retry')).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.getByText('JSON Proof Package').click();
    const download = await downloadPromise;

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const downloaded = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

    // The downloaded artifact must be the proof_bundle object VERBATIM.
    expect(downloaded).toEqual(PROOF_BUNDLE);
  });

  test('state 1b: 200 with proof_bundle null renders the honest empty-state, no download control', async ({ page }) => {
    await page.route(PROOF_ROUTE_RE, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          public_id: securedPublicId,
          fingerprint: PROOF_BUNDLE.fingerprint,
          merkle_root: PROOF_BUNDLE.merkle_root,
          merkle_proof: [],
          tx_id: null,
          block_height: null,
          block_timestamp: null,
          batch_id: null,
          verified: true,
          proof_bundle: null,
        }),
      });
    });

    await page.goto(`/verify/${securedPublicId}`);
    await expect(page.getByText(/Secured & Anchored/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('JSON Proof Package')).not.toBeVisible();
  });

  test('state 2 (THE MOST IMPORTANT STATE): 404 "No Merkle proof available…" renders the honest empty-state — no download control, no error toast', async ({ page }) => {
    await page.route(PROOF_ROUTE_RE, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'No Merkle proof available for this record. It may not have been batch-anchored.',
        }),
      });
    });

    await page.goto(`/verify/${securedPublicId}`);
    await expect(page.getByText(/Secured & Anchored/i)).toBeVisible({ timeout: 10000 });

    // No download control at all.
    await expect(page.getByText('JSON Proof Package')).not.toBeVisible();
    await expect(page.getByRole('button', { name: /download/i })).not.toBeVisible();

    // No error toast / alert.
    await expect(page.getByRole('alert')).not.toBeVisible();

    // The copy affirms Secured/anchored standing, points at Fingerprint + Network Receipt
    // already on the page, and does not promise a date or say "generating".
    await expect(page.getByText('Fingerprint (SHA-256)', { exact: true })).toBeVisible();
    const sectionText = await page.getByTestId('proof-not-yet-available').textContent();
    expect(sectionText?.toLowerCase()).not.toContain('generating');
  });

  test('state 3: record not yet SECURED shows a securing-in-progress presentation, no proof-download section at all', async ({ page }) => {
    // No route mock needed — PublicVerification never mounts VerifierProofDownload
    // for a non-SECURED record (hasProof gate), so /proof is not even called.
    await page.goto(`/verify/${pendingPublicId}`);

    await expect(page.getByText(/Submitting to Network/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('JSON Proof Package')).not.toBeVisible();
    await expect(page.getByText(/Secured & Anchored/i)).not.toBeVisible();
  });

  test('"Record not found" 404 renders a distinct real error state, not the honest empty-state', async ({ page }) => {
    await page.route(PROOF_ROUTE_RE, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Record not found' }),
      });
    });

    await page.goto(`/verify/${securedPublicId}`);
    await expect(page.getByTestId('proof-record-missing')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('proof-not-yet-available')).not.toBeVisible();
  });

  test('5xx renders a retryable "could not load" affordance, never the state-2 empty-state copy', async ({ page }) => {
    await page.route(PROOF_ROUTE_RE, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal server error' }),
      });
    });

    await page.goto(`/verify/${securedPublicId}`);
    await expect(page.getByTestId('proof-retry')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('proof-not-yet-available')).not.toBeVisible();
    await expect(page.getByRole('button', { name: /retry/i })).toBeVisible();
  });
});
