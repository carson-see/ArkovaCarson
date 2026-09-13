/**
 * Record Detail E2E Tests (Tier 1)
 *
 * Tests for record detail page: metadata display, fingerprint, status,
 * lifecycle timeline, proof downloads, and QR code.
 *
 * @created 2026-03-10 11:00 PM EST
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

test.describe('Record Detail', () => {
  const serviceClient = getServiceClient();
  let securedAnchor: { id: string; public_id: string; fingerprint: string };
  let pendingAnchor: { id: string; fingerprint: string };

  test.beforeAll(async () => {
    // Create a SECURED anchor for detail tests
    const secured = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'e2e_record_detail_secured.pdf',
    });

    // Fail loudly if test data setup didn't work — never silently skip
    if (!secured?.id || !secured?.public_id) {
      throw new Error('beforeAll: failed to create SECURED test anchor — cannot run record detail tests');
    }

    securedAnchor = {
      id: secured.id,
      public_id: secured.public_id,
      fingerprint: secured.fingerprint,
    };

    // Create a PENDING anchor for pending state tests
    const pending = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'PENDING',
      filename: 'e2e_record_detail_pending.pdf',
    });

    if (!pending?.id) {
      throw new Error('beforeAll: failed to create PENDING test anchor — cannot run record detail tests');
    }

    pendingAnchor = { id: pending.id, fingerprint: pending.fingerprint };
  });

  test.afterAll(async () => {
    if (securedAnchor?.id) await deleteTestAnchor(serviceClient, securedAnchor.id);
    if (pendingAnchor?.id) await deleteTestAnchor(serviceClient, pendingAnchor.id);
  });

  test.describe('SECURED Record', () => {
    test('shows record details page with all sections', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);

      // Page title
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Subtitle
      await expect(individualPage.getByText(/View and verify/i)).toBeVisible();

      // Status badge should show Secured
      await expect(individualPage.getByText('Secured', { exact: true }).first()).toBeVisible();
    });

    test('shows document fingerprint with copy button', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Fingerprint section
      await expect(individualPage.getByText(/Document Fingerprint/).first()).toBeVisible();

      // Copy button
      const copyBtn = individualPage.getByRole('button', { name: /Copy document fingerprint/i });
      await expect(copyBtn).toBeVisible();
    });

    test('shows filename and file metadata', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Filename
      await expect(individualPage.getByText('e2e_record_detail_secured.pdf')).toBeVisible();
    });

    test('shows QR code for SECURED records', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // QR Code section should be visible for SECURED records
      await expect(individualPage.getByText('Verification QR Code')).toBeVisible();
    });

    test('shows download proof package buttons', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Download proof section
      await expect(individualPage.getByText(/Download Proof Package/i)).toBeVisible();

      // PDF and JSON buttons
      await expect(individualPage.getByRole('button', { name: /PDF/i })).toBeVisible();
      await expect(individualPage.getByRole('button', { name: /JSON/i })).toBeVisible();
    });

    test('shows lifecycle timeline', async ({ individualPage }) => {

      await individualPage.goto(`/records/${securedAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Lifecycle section
      await expect(individualPage.getByText('Record Lifecycle')).toBeVisible();
    });
  });

  test.describe('PENDING Record', () => {
    test('shows Pending status badge', async ({ individualPage }) => {

      await individualPage.goto(`/records/${pendingAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // Status should show Pending
      await expect(individualPage.getByText('Pending', { exact: true }).first()).toBeVisible();
    });

    test('does not show QR code for PENDING records', async ({ individualPage }) => {

      await individualPage.goto(`/records/${pendingAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      // QR Code should NOT be visible for PENDING
      await expect(individualPage.getByText('Verification QR Code')).not.toBeVisible();
    });
  });

  test.describe('Error States', () => {
    test('shows error for non-existent record', async ({ individualPage }) => {
      await individualPage.goto('/records/00000000-0000-0000-0000-000000000000');

      // Should show error state
      await expect(
        individualPage.getByText(/Record Not Found/i)
          .or(individualPage.getByText(/does not exist/i))
          .first()
      ).toBeVisible({ timeout: 10000 });
    });
  });

  // DocuSign record deep links (bilateral rollout, frontend-targeted T2).
  // Authenticated record-detail METADATA section only — the public
  // verification page is untouched by this rollout. Component-level
  // validation/injection coverage lives in
  // src/lib/docusignLinks.test.ts + AssetDetailView.test.tsx; this spec
  // proves the end-to-end wire-up against a real page load: the anchor's
  // metadata (written directly via the service client — createTestAnchor
  // has no metadata override, and this test intentionally avoids widening
  // that shared fixture's strict update schema for one spec's fixture data)
  // reaches AssetDetailView unmodified and renders real hrefs + signer rows.
  test.describe('DocuSign Record (bilateral rollout, frontend-targeted T2)', () => {
    const DOCUSIGN_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
    const DOCUSIGN_ENVELOPE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const DOCUSIGN_SIGNER_GUID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    let docusignAnchor: { id: string; public_id: string };

    test.beforeAll(async () => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.individual.id,
        status: 'SECURED',
        filename: 'e2e_record_detail_docusign.pdf',
      });

      if (!anchor?.id || !anchor?.public_id) {
        throw new Error('beforeAll: failed to create DocuSign test anchor — cannot run DocuSign record detail tests');
      }

      // Direct service-client update (not createTestAnchor's AnchorUpdateSchema,
      // which is .strict() and has no metadata field) so this spec's fixture
      // data stays local instead of widening a shared, heavily-reused schema.
      const { error: metadataError } = await serviceClient
        .from('anchors')
        .update({
          metadata: {
            connector_source: 'docusign',
            account_id: DOCUSIGN_ACCOUNT_ID,
            envelope_id: DOCUSIGN_ENVELOPE_ID,
            _signers: [
              { recipient_id_guid: DOCUSIGN_SIGNER_GUID, status: 'completed', signed_at: '2026-08-20T12:00:00Z' },
            ],
          },
        })
        .eq('id', anchor.id);

      if (metadataError) {
        throw new Error(`beforeAll: failed to set DocuSign metadata on test anchor — ${metadataError.message}`);
      }

      docusignAnchor = { id: anchor.id, public_id: anchor.public_id };
    });

    test.afterAll(async () => {
      if (docusignAnchor?.id) await deleteTestAnchor(serviceClient, docusignAnchor.id);
    });

    test('shows linked account/envelope metadata and at least one signer row', async ({ individualPage }) => {
      await individualPage.goto(`/records/${docusignAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      const accountLink = individualPage.getByTestId('docusign-account-link');
      await expect(accountLink).toBeVisible();
      await expect(accountLink).toHaveAttribute(
        'href',
        `https://apps.docusign.com/send/home?account=${DOCUSIGN_ACCOUNT_ID}`,
      );
      await expect(accountLink).toHaveAttribute('target', '_blank');
      await expect(accountLink).toHaveAttribute('rel', 'noopener noreferrer');

      const envelopeLink = individualPage.getByTestId('docusign-envelope-link');
      await expect(envelopeLink).toBeVisible();
      await expect(envelopeLink).toHaveAttribute(
        'href',
        `https://apps.docusign.com/send/documents/details/${DOCUSIGN_ENVELOPE_ID}`,
      );

      const signerRows = individualPage.getByTestId('docusign-signer-row');
      await expect(signerRows).toHaveCount(1);
      await expect(individualPage.getByText(/Signer 1 · Verified via DocuSign/)).toBeVisible();

      const signerLink = individualPage.getByTestId('docusign-signer-link-0');
      await expect(signerLink).toBeVisible();
      await expect(signerLink).toHaveAttribute(
        'href',
        `https://apps.docusign.com/send/documents/details/${DOCUSIGN_SIGNER_GUID}`,
      );
    });
  });

  /**
   * Google Drive source link-back (SCRUM-4507, frontend-targeted T2).
   *
   * Same shape and same rationale as the DocuSign block above: component-level
   * validation/injection coverage lives in src/lib/driveLinks.test.ts +
   * AssetDetailView.test.tsx, and this spec proves the end-to-end wire-up
   * against a real page load — the anchor's metadata reaches AssetDetailView
   * unmodified and renders real hrefs.
   *
   * The metadata is written with the SERVICE client on purpose, and that is
   * load-bearing rather than incidental: migration 0423's trigger strips
   * `connector_source` from any write by a non-service_role caller, so a
   * fixture written as the user would produce a record with no marker and no
   * chips — i.e. the forgery gate would silently make this spec test nothing.
   */
  test.describe('Google Drive Record source link-back (SCRUM-4507)', () => {
    const DRIVE_FILE_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
    const DRIVE_FOLDER_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const DRIVE_SHARED_DRIVE_ID = '0AOaBcDeFgHiJkLmNoP';
    let driveAnchor: { id: string; public_id: string };

    test.beforeAll(async () => {
      const anchor = await createTestAnchor(serviceClient, {
        userId: SEED_USERS.individual.id,
        status: 'SECURED',
        filename: 'e2e_record_detail_drive.pdf',
      });

      if (!anchor?.id || !anchor?.public_id) {
        throw new Error('beforeAll: failed to create Drive test anchor — cannot run Drive record detail tests');
      }

      const { error: metadataError } = await serviceClient
        .from('anchors')
        .update({
          metadata: {
            connector_source: 'google_drive',
            file_id: DRIVE_FILE_ID,
            revision_id: 'rev-head-0001',
            _drive_folder_id: DRIVE_FOLDER_ID,
            _drive_folder_path: '/Legal/Contracts',
            _drive_shared_drive_id: DRIVE_SHARED_DRIVE_ID,
            _drive_revision_kind: 'head_revision',
          },
        })
        .eq('id', anchor.id);

      if (metadataError) {
        throw new Error(`beforeAll: failed to set Drive metadata on test anchor — ${metadataError.message}`);
      }

      driveAnchor = { id: anchor.id, public_id: anchor.public_id };
    });

    test.afterAll(async () => {
      if (driveAnchor?.id) await deleteTestAnchor(serviceClient, driveAnchor.id);
    });

    test('shows file, folder and shared drive links plus a plain-text revision', async ({ individualPage }) => {
      await individualPage.goto(`/records/${driveAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      const fileLink = individualPage.getByTestId('drive-file-link');
      await expect(fileLink).toBeVisible();
      await expect(fileLink).toHaveAttribute(
        'href',
        `https://drive.google.com/file/d/${DRIVE_FILE_ID}/view`,
      );
      await expect(fileLink).toHaveAttribute('target', '_blank');
      await expect(fileLink).toHaveAttribute('rel', 'noopener noreferrer');

      const folderLink = individualPage.getByTestId('drive-folder-link');
      await expect(folderLink).toBeVisible();
      await expect(folderLink).toHaveAttribute(
        'href',
        `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`,
      );
      // Labelled by the resolved human path, not the opaque id.
      await expect(folderLink).toHaveText('/Legal/Contracts');

      const sharedDriveLink = individualPage.getByTestId('drive-shared-drive-link');
      await expect(sharedDriveLink).toBeVisible();
      await expect(sharedDriveLink).toHaveAttribute(
        'href',
        `https://drive.google.com/drive/folders/${DRIVE_SHARED_DRIVE_ID}`,
      );

      // The revision renders, and renders as TEXT — never wrapped in a link.
      const revision = individualPage.getByTestId('drive-revision-plain');
      await expect(revision).toHaveText('rev-head-0001');
      await expect(revision.locator('a')).toHaveCount(0);

      // §1.5 note is on screen alongside the links it qualifies.
      await expect(individualPage.getByTestId('drive-source-note')).toBeVisible();
      await expect(individualPage.getByTestId('drive-source-note')).toContainText('Not asserted');
    });

    test('renders no DocuSign rows on a Drive record', async ({ individualPage }) => {
      await individualPage.goto(`/records/${driveAnchor.id}`);
      await expect(individualPage.getByRole('heading', { name: 'Record Details' })).toBeVisible({ timeout: 10000 });

      await expect(individualPage.getByTestId('docusign-account-link')).toHaveCount(0);
      await expect(individualPage.getByTestId('docusign-envelope-link')).toHaveCount(0);
      await expect(individualPage.getByTestId('docusign-signer-row')).toHaveCount(0);
    });
  });
});
