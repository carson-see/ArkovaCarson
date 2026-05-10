/**
 * Shared test helper: build an `AnchorByPublicId` fixture for the
 * credential.verified emit-test files. Lifts the 33-field stub out of
 * the individual *.test.ts files so SonarCloud doesn't flag the natural
 * test-fixture duplication as a code-quality regression (SCRUM-1801 /
 * sonar.cpd.exclusions does not appear to honor `**\/*.test.ts` for the
 * new-code metric, so the dedup happens here at the source).
 */

import type { AnchorByPublicId } from '../verify.js';

export function buildTestAnchor(overrides: Partial<AnchorByPublicId> = {}): AnchorByPublicId {
  return {
    public_id: 'ARK-2026-TST-001',
    fingerprint: 'a'.repeat(64),
    status: 'SECURED',
    org_id: 'org-1',
    chain_tx_id: 'tx-abc',
    chain_block_height: 200100,
    chain_timestamp: '2026-04-01T00:00:00Z',
    created_at: '2026-03-30T00:00:00Z',
    credential_type: 'DEGREE',
    org_name: 'Test University',
    recipient_hash: null,
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: null,
    jurisdiction: null,
    merkle_root: null,
    description: null,
    directory_info_opt_out: false,
    compliance_controls: null,
    chain_confirmations: null,
    parent_public_id: null,
    version_number: null,
    revocation_tx_id: null,
    revocation_block_height: null,
    file_mime: null,
    file_size: null,
    confidence_scores: null,
    sub_type: null,
    ...overrides,
  };
}
