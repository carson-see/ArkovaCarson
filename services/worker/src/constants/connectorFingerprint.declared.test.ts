import { describe, it, expect } from 'vitest';
import { connectorFingerprintRederivabilityFieldsFor } from './connectorFingerprint.js';
describe('combined declared-hash and inbound evidence gate', () => {
 it('never treats an inbound artifact stamp as evidence of document measurement', () => {
  const fields = connectorFingerprintRederivabilityFieldsFor({ connector_source: 'docusign', connector_artifact_id: '11111111-1111-4111-8111-111111111111' }, 'issuer_record_attestation');
  expect(fields.fingerprint_rederivability).toBe('declared_unverified');
 });
 it('keeps an unmeasured rules marker silent even when it claims document_bytes', () => {
  expect(connectorFingerprintRederivabilityFieldsFor({ connector_source: 'docusign' }, 'document_bytes')).toEqual({});
 });
 it('does not label a client-uploaded attestation as connector evidence', () => {
  expect(connectorFingerprintRederivabilityFieldsFor({ connector_source: 'manual_upload' }, 'issuer_record_attestation')).toEqual({});
 });
});
