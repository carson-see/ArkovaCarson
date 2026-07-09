import { describe, expect, it } from 'vitest';

import {
  planProofRequests,
  interpretProofOutcome,
  PROOF_DRIVER,
} from './verify-proof-driver';

const BASE = 'https://pr-1439---arkova-worker-staging-x-uc.a.run.app';

describe('verify-proof-driver: request plan hits BOTH 404 branches', () => {
  const plan = planProofRequests(BASE, { unbatchedPublicId: 'TSOAK-ANC-abc123' });

  it('drives the RECORD_NOT_FOUND branch with an unknown public_id', () => {
    const notFound = plan.find((p) => p.label === 'record-not-found');
    expect(notFound).toBeDefined();
    expect(notFound!.method).toBe('GET');
    expect(notFound!.endpoint).toMatch(/\/api\/v1\/verify\/.+\/proof$/);
    // Unknown id must NOT collide with the seeded unbatched id.
    expect(notFound!.endpoint).not.toContain('TSOAK-ANC-abc123');
    // 404 is EXPECTED evidence, not a failure.
    expect(notFound!.allowedStatuses).toContain(404);
    expect(notFound!.url.startsWith(BASE)).toBe(true);
  });

  it('drives the NO_BATCH_PROOF branch against the seeded SECURED-but-unbatched id', () => {
    const noBatch = plan.find((p) => p.label === 'no-batch-proof');
    expect(noBatch).toBeDefined();
    expect(noBatch!.endpoint).toBe('/api/v1/verify/TSOAK-ANC-abc123/proof');
    expect(noBatch!.allowedStatuses).toContain(404);
  });

  it('includes a 400 short-id guard case', () => {
    const shortId = plan.find((p) => p.label === 'invalid-public-id');
    expect(shortId).toBeDefined();
    expect(shortId!.allowedStatuses).toContain(400);
  });

  it('every request is a GET on the proof path with capture enabled', () => {
    for (const p of plan) {
      expect(p.method).toBe('GET');
      expect(p.endpoint).toContain('/proof');
      expect(p.capture).toBe(true);
    }
  });
});

describe('verify-proof-driver: interpretProofOutcome captures proof_error_code', () => {
  it('reads RECORD_NOT_FOUND from the #1439 body shape', () => {
    const code = interpretProofOutcome({
      error: 'Record not found',
      proof_error_code: 'RECORD_NOT_FOUND',
    });
    expect(code).toBe('RECORD_NOT_FOUND');
  });

  it('reads NO_BATCH_PROOF from the #1439 body shape', () => {
    const code = interpretProofOutcome({
      error: 'No Merkle proof available for this record. It may not have been batch-anchored.',
      proof_error_code: 'NO_BATCH_PROOF',
    });
    expect(code).toBe('NO_BATCH_PROOF');
  });

  it('returns null on the main-branch (pre-#1439) body that lacks the code', () => {
    expect(interpretProofOutcome({ error: 'Record not found' })).toBeNull();
  });
});

describe('verify-proof-driver: metadata', () => {
  it('names PR #1439 and the driver', () => {
    expect(PROOF_DRIVER.pr).toBe('#1439');
    expect(PROOF_DRIVER.driver).toBe('verify-proof');
  });
});
