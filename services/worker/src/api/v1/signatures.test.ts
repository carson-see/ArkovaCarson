import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('POST /api/v1/sign attestation lookup', () => {
  it('scopes attestation public_id lookup to the signer org', () => {
    const source = readFileSync(new URL('./signatures.ts', import.meta.url), 'utf8');
    const attestationLookup = source.slice(
      source.indexOf('if (body.attestation_id)'),
      source.indexOf('// Generate public ID'),
    );

    expect(attestationLookup).toContain(".from('attestations')");
    expect(attestationLookup).toContain(".eq('public_id', body.attestation_id)");
    expect(attestationLookup).toContain(".eq('attester_org_id', orgId)");
    expect(attestationLookup).not.toContain('public verification endpoint');
  });
});
