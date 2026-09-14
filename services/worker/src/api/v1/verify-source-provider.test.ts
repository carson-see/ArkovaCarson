/**
 * SCRUM-4507 — `source.provider` on the anonymous verification response.
 *
 * WHAT THIS FIELD IS. A closed-vocabulary label saying WHICH connected system
 * a record's document was retrieved from. Nothing more:
 *
 *   - No identifiers. The Drive file id, folder id, shared drive id and
 *     revision stay OFF this surface entirely. `GET /api/v1/verify/:publicId`
 *     is anonymous (router.ts lets an unauthenticated GET through), so a Drive
 *     file id here would let anyone holding a public record id probe whether a
 *     given Drive object is reachable — and, for a link-shared file, open the
 *     document itself. That is a content-disclosure channel the record owner
 *     never opted into.
 *   - No deep link, for the same reason.
 *   - Never derived from raw `metadata.connector_source`. The value is routed
 *     through `isConnectorFetchSource` — the same closed marker set the
 *     re-derivability class uses — so free text on a legacy row can never
 *     become part of a public response.
 *
 * RESIDUAL, stated rather than hidden: `connector_source` is server-stamped
 * and, since migration 0423, stripped from any non-`service_role` write. On
 * rows written BEFORE 0423 the marker could have been org-authored. The
 * provider label therefore carries the same trust as the marker itself — which
 * is why it stays a bare vocabulary word with no identifier attached to it,
 * and why it never keys a "Measured:" claim.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({
  config: { bitcoinNetwork: 'signet', frontendUrl: 'https://app.arkova.ai' },
}));

import { buildVerificationResult, VERIFICATION_SOURCE_PROVIDERS } from './verify.js';
import { buildTestAnchor } from './__test-helpers__/build-anchor.js';
import { CONNECTOR_FETCH_SOURCE_MARKERS } from '../../constants/connectorFingerprint.js';

describe('source.provider — emitted for a recognised connector marker', () => {
  it('emits google_drive for a Drive-sourced record', () => {
    const result = buildVerificationResult(
      buildTestAnchor({
        connector_source: 'google_drive',
        server_fetched_connector_source: 'google_drive',
      }),
    );

    expect(result.source).toEqual({ provider: 'google_drive' });
  });

  it('emits docusign for a DocuSign-sourced record', () => {
    const result = buildVerificationResult(
      buildTestAnchor({
        connector_source: 'docusign',
        server_fetched_connector_source: 'docusign',
      }),
    );

    expect(result.source).toEqual({ provider: 'docusign' });
  });

  it('emits the provider for a declared (never-fetched) record too', () => {
    // The provider says WHERE the record came from; the re-derivability class
    // says HOW STRONG the fingerprint evidence is. A declared-hash inbound
    // DocuSign record still originates from DocuSign, so suppressing the
    // provider there would lose true provenance to protect a claim that the
    // separate, weaker `fingerprint_rederivability` class already makes.
    const result = buildVerificationResult(
      buildTestAnchor({
        connector_source: 'docusign',
        server_fetched_connector_source: null,
        fingerprint_source: 'issuer_record_attestation',
      }),
    );

    expect(result.source).toEqual({ provider: 'docusign' });
    expect(result.fingerprint_rederivability).toBe('declared_unverified');
  });
});

describe('source.provider — OMITTED when unknown', () => {
  it('is omitted entirely (never null, never an empty object) for a client-uploaded record', () => {
    const result = buildVerificationResult(buildTestAnchor());

    expect(result).not.toHaveProperty('source');
  });

  it('is omitted when the marker is absent', () => {
    const result = buildVerificationResult(buildTestAnchor({ connector_source: null }));
    expect(result).not.toHaveProperty('source');
  });

  it('is omitted for free text that is not in the closed marker set', () => {
    for (const forged of ['google drive', 'GOOGLE_DRIVE', 'dropbox', 'upload', '', ' ']) {
      const result = buildVerificationResult(
        buildTestAnchor({ connector_source: forged }),
      );
      expect(result, `"${forged}" must not reach the public surface`).not.toHaveProperty('source');
    }
  });

  it('is omitted on a path that never loaded metadata (field absent, not null)', () => {
    // EMPTY_API_RICH_FIELDS-shaped callers (batch, oracle) measure nothing
    // here. Absence must mean "not measured", never "not connector-sourced".
    const anchor = buildTestAnchor();
    delete (anchor as { connector_source?: unknown }).connector_source;

    expect(buildVerificationResult(anchor)).not.toHaveProperty('source');
  });
});

describe('source.provider — vocabulary is closed and single-sourced', () => {
  it('exposes exactly the recognised connector-fetch markers', () => {
    expect([...VERIFICATION_SOURCE_PROVIDERS].sort()).toEqual(
      [...CONNECTOR_FETCH_SOURCE_MARKERS].sort(),
    );
  });

  it('emits no value outside that vocabulary', () => {
    for (const marker of CONNECTOR_FETCH_SOURCE_MARKERS) {
      const result = buildVerificationResult(buildTestAnchor({ connector_source: marker }));
      expect(result.source).toBeDefined();
      expect(VERIFICATION_SOURCE_PROVIDERS).toContain(result.source!.provider);
    }
  });
});

describe('source carries NO identifier of any kind', () => {
  it('has exactly one key: provider', () => {
    const result = buildVerificationResult(
      buildTestAnchor({
        connector_source: 'google_drive',
        server_fetched_connector_source: 'google_drive',
      }),
    );

    expect(Object.keys(result.source!)).toEqual(['provider']);
  });

  it('never carries a Drive file id, folder id, revision or deep link', () => {
    // The anchor row the builder sees does not even have these fields — this
    // asserts the SHAPE so a future "just add the file id, it's harmless"
    // change has to delete a test that explains why it is not harmless.
    const result = buildVerificationResult(
      buildTestAnchor({
        connector_source: 'google_drive',
        server_fetched_connector_source: 'google_drive',
      }),
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('drive.google.com');
    expect(serialized).not.toContain('file_id');
    expect(serialized).not.toContain('folder_id');
    expect(serialized).not.toContain('revision_id');
    expect(serialized).not.toContain('_drive_');
  });
});
