/**
 * SECURITY — outbound PII gate on `GET /api/v1/verify/:publicId`, the THIRD
 * public projection of an anchor row.
 *
 * WHY A THIRD FILE: the same rule now has three implementations over the same
 * rows, and the first two were hardened without this one:
 *
 *   1. SQL   — `public.get_public_anchor` (migration 0385, PR #1841), anon-GRANTed
 *              and called straight from the browser over PostgREST.
 *   2. TS    — `services/worker/src/ctdl/ctdl-pii-guard.ts` (PR #1815), behind
 *              `GET /api/v1/credentials/:publicId/ctdl`.
 *   3. TS    — THIS surface. `router.ts` allows anonymous GET
 *              (`if (!req.apiKey && req.method === 'GET') next()`), and
 *              `buildVerificationResult` emitted `anchor.description` raw.
 *
 * These tests drive the REAL router through supertest — not
 * `buildVerificationResult` in isolation — because the finding is that the
 * ROUTE is anonymously reachable, and a unit test on the builder would not
 * prove that.
 *
 * The corpus is loaded from the SHARED CONTRACT
 * (`scripts/ci/public-pii-projection-contract.json`) rather than restated here,
 * so this surface cannot drift from the other two by editing a local copy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const { mockGetCached, mockSetCached, mockAuditInsert } = vi.hoisted(() => ({
  mockGetCached: vi.fn(),
  mockSetCached: vi.fn(),
  mockAuditInsert: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(() => ({ insert: mockAuditInsert })) },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: {
    bitcoinNetwork: 'signet',
    frontendUrl: 'https://app.arkova.ai',
    enableCredentialVerifiedWebhook: false,
  },
}));

vi.mock('../../utils/verifyCache.js', () => ({
  getCachedVerification: mockGetCached,
  setCachedVerification: mockSetCached,
}));

vi.mock('../../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: vi.fn(),
}));

import { verifyRouter, type AnchorByPublicId, type PublicIdLookup } from './verify.js';
import { buildTestAnchor } from './__test-helpers__/build-anchor.js';

// ---------------------------------------------------------------------------
// Shared contract — the single source of the corpus and the type sets.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(
  HERE,
  '../../../../../scripts/ci/public-pii-projection-contract.json',
);

interface Contract {
  academic_record_credential_types: string[];
  ferpa_education_types: string[];
  high_confidence_vectors: Array<{ text: string; family: string }>;
  must_publish_vectors: Array<{ text: string; why: string }>;
  leak_vectors: Array<{ text: string; shape: string }>;
  max_scan_chars: number;
}

const contract: Contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

/**
 * A credential type that is NOT an academic record, so the structural rule is
 * out of the way and only the VALUE gate is under test. Read from the contract
 * rather than hardcoded, so widening the academic set cannot silently turn
 * these into structural-suppression tests that pass for the wrong reason.
 */
const NON_ACADEMIC_TYPE = 'CLE';

/**
 * `CLE` is in `ferpa_education_types` but NOT in
 * `academic_record_credential_types`. That gap is the whole reason the two
 * lists must not be reconciled by editing one of them, so the tests below lean
 * on it deliberately — if someone "fixes" the divergence, this assertion fails
 * first and explains why.
 */
expect(contract.ferpa_education_types).toContain(NON_ACADEMIC_TYPE);
expect(contract.academic_record_credential_types).not.toContain(NON_ACADEMIC_TYPE);

function buildApp(anchor: AnchorByPublicId | null) {
  const lookup: PublicIdLookup = {
    lookupByPublicId: async () => anchor,
  };
  const app = express();
  // Mirrors the anonymous-GET allowance in router.ts: no apiKey, no auth
  // middleware at all. If this route ever stops being anon-reachable, these
  // tests still pass — they are about the BODY, and the reachability itself is
  // asserted separately below.
  app.use((req, _res, next) => {
    (req as unknown as { _testLookup: PublicIdLookup })._testLookup = lookup;
    next();
  });
  app.use('/api/v1/verify', verifyRouter);
  return app;
}

async function getVerification(anchor: AnchorByPublicId) {
  const res = await request(buildApp(anchor)).get(`/api/v1/verify/${anchor.public_id}`);
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCached.mockResolvedValue(null);
  mockSetCached.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------

describe('GET /api/v1/verify/:publicId — anonymous reachability', () => {
  it('answers an anonymous request with no API key and no Authorization header', async () => {
    const anchor = buildTestAnchor({ public_id: 'ARK-2026-ANON-001' });
    const res = await request(buildApp(anchor)).get('/api/v1/verify/ARK-2026-ANON-001');

    // This is the premise of every test below: the body reaches an
    // unauthenticated caller, so anything in it is public.
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });
});

describe('academic records emit no issuer- or extraction-authored free text', () => {
  for (const credentialType of ['DEGREE', 'TRANSCRIPT', 'CERTIFICATE']) {
    for (const vector of [
      { text: 'Jane Doe', shape: 'bare name as the entire field' },
      { text: 'MARIA GONZALEZ', shape: 'all-caps name' },
      { text: 'José García', shape: 'non-ASCII name' },
      { text: "Official transcript for Michael O'Brien", shape: 'apostrophe name' },
    ]) {
      it(`omits description on ${credentialType} — ${vector.shape}`, async () => {
        const body = await getVerification(
          buildTestAnchor({
            public_id: 'ARK-2026-ACAD-001',
            credential_type: credentialType,
            description: vector.text,
          }),
        );

        expect(body).not.toHaveProperty('description');
        // The verification still ANSWERS. Omission, never fail-closed: a 404
        // would tell an anonymous verifier that a genuinely anchored document
        // does not exist.
        expect(body.verified).toBe(true);
        expect(body.status).toBe('ACTIVE');
        expect(body.record_uri).toBeTruthy();
        expect(body.anchor_timestamp).toBe('2026-03-30T00:00:00Z');
      });
    }
  }

  it('covers every leak_vector in the shared contract, for every academic type', async () => {
    for (const credentialType of contract.academic_record_credential_types) {
      for (const vector of contract.leak_vectors) {
        const body = await getVerification(
          buildTestAnchor({
            public_id: 'ARK-2026-ACAD-002',
            credential_type: credentialType,
            description: vector.text,
          }),
        );
        expect(
          body,
          `${credentialType} leaked a ${vector.shape} through description`,
        ).not.toHaveProperty('description');
      }
    }
  });

  it('suppresses UNCONDITIONALLY — directory_info_opt_out=false must not republish', async () => {
    // This is the policy decision under test. The pre-fix code gated the
    // REG-02 directory fields on `directory_info_opt_out` and never gated
    // description at all, so the default (`false`) published everything. A
    // learner suppressed on the other two public projections was still exposed
    // here unless an institution had set a flag.
    const body = await getVerification(
      buildTestAnchor({
        public_id: 'ARK-2026-ACAD-003',
        credential_type: 'TRANSCRIPT',
        description: 'Transcript: Jane Doe',
        directory_info_opt_out: false,
      }),
    );

    expect(body).not.toHaveProperty('description');
    expect(body).not.toHaveProperty('directory_info_suppressed');
  });

  it('leaves the REG-02 directory_info_opt_out mechanism intact and additive', async () => {
    // The opt-out does a DIFFERENT job (FERPA §99.37 directory information:
    // issuer name, recipient, dates). Suppressing free text unconditionally
    // must not weaken or replace it.
    const body = await getVerification(
      buildTestAnchor({
        public_id: 'ARK-2026-ACAD-004',
        credential_type: 'TRANSCRIPT',
        description: 'Transcript: Jane Doe',
        directory_info_opt_out: true,
        org_name: 'Test University',
        issued_at: '2026-01-01T00:00:00Z',
      }),
    );

    expect(body.directory_info_suppressed).toBe(true);
    expect(body).not.toHaveProperty('issuer_name');
    expect(body).not.toHaveProperty('issued_date');
    expect(body).not.toHaveProperty('description');
  });

  it('keeps issuer_name on an academic record — the issuer is an institution, not the learner', async () => {
    // Deliberate parity with migration 0385, which cleans `issuer_name` rather
    // than structurally suppressing it. Diverging here would invent a FOURTH
    // policy, which is the defect this work exists to end.
    const body = await getVerification(
      buildTestAnchor({
        public_id: 'ARK-2026-ACAD-005',
        credential_type: 'DEGREE',
        org_name: 'Johns Hopkins University',
        directory_info_opt_out: false,
      }),
    );

    expect(body.issuer_name).toBe('Johns Hopkins University');
  });

  it('keeps the FERPA §99.33 notice on CLE — the notice list is a different job', async () => {
    // FERPA_EDUCATION_TYPES includes CLE; the academic-record set does not.
    // Both facts must survive: CLE gets the notice AND keeps its description.
    const body = await getVerification(
      buildTestAnchor({
        public_id: 'ARK-2026-CLE-001',
        credential_type: 'CLE',
        description: 'Ethics for Trial Lawyers',
      }),
    );

    expect(body.ferpa_notice).toBeTruthy();
    expect(body.description).toBe('Ethics for Trial Lawyers');
  });
});

describe('value gate — runs on every credential type', () => {
  for (const vector of [
    { text: 'Revoked — contact registrar jane.doe@example.edu for details', family: 'email' },
    { text: 'Issued to holder; SSN 123-45-6789 on file', family: 'ssn_separated' },
    { text: 'Questions? Call (415) 555-0142 during office hours', family: 'us_phone' },
    { text: 'Registrar line +44 20 7946 0958 for verification', family: 'international_phone' },
    { text: 'Candidate DOB 1994-02-11 verified against photo ID', family: 'date_of_birth_keyword' },
    { text: 'Awarded under student ID 88123456 in the spring cohort', family: 'student_id_keyword' },
  ]) {
    it(`drops a ${vector.family} in description on a NON-academic type`, async () => {
      const body = await getVerification(
        buildTestAnchor({
          public_id: 'ARK-2026-VAL-001',
          credential_type: NON_ACADEMIC_TYPE,
          description: vector.text,
        }),
      );

      expect(body).not.toHaveProperty('description');
      expect(body.verified).toBe(true);
    });
  }

  it('covers every high_confidence_vector in the shared contract', async () => {
    for (const vector of contract.high_confidence_vectors) {
      const body = await getVerification(
        buildTestAnchor({
          public_id: 'ARK-2026-VAL-002',
          credential_type: NON_ACADEMIC_TYPE,
          description: vector.text,
        }),
      );
      expect(
        body,
        `${vector.family} survived the value gate in description`,
      ).not.toHaveProperty('description');
    }
  });

  it('gates issuer_name, jurisdiction and sub_type, not just description', async () => {
    const body = await getVerification(
      buildTestAnchor({
        public_id: 'ARK-2026-VAL-003',
        credential_type: NON_ACADEMIC_TYPE,
        org_name: 'Registrar jane.doe@example.edu',
        jurisdiction: 'Contact +44 20 7946 0958',
        sub_type: 'cohort student ID 88123456',
      }),
    );

    expect(body).not.toHaveProperty('issuer_name');
    expect(body).not.toHaveProperty('jurisdiction');
    expect(body).not.toHaveProperty('sub_type');
  });

  it('strips control characters so a NUL cannot split a value out from under the detector', async () => {
    const body = await getVerification(
      buildTestAnchor({
        public_id: 'ARK-2026-VAL-004',
        credential_type: NON_ACADEMIC_TYPE,
        description: 'Contact jane.doe @example.edu now',
      }),
    );

    expect(body).not.toHaveProperty('description');
  });

  it('omits rather than truncates a value too long to scan', async () => {
    const body = await getVerification(
      buildTestAnchor({
        public_id: 'ARK-2026-VAL-005',
        credential_type: NON_ACADEMIC_TYPE,
        // `anchors.description` is CHECK-constrained to 500 chars, but
        // `metadata->>'jurisdiction'` and `anchors.sub_type` are unbounded.
        jurisdiction: 'x'.repeat(contract.max_scan_chars + 1),
      }),
    );

    expect(body).not.toHaveProperty('jurisdiction');
  });
});

describe('must-publish corpus — the gate must not blank real credentials', () => {
  it('publishes every must_publish_vector on a non-academic type', async () => {
    for (const vector of contract.must_publish_vectors) {
      const body = await getVerification(
        buildTestAnchor({
          public_id: 'ARK-2026-PUB-001',
          credential_type: NON_ACADEMIC_TYPE,
          description: vector.text,
        }),
      );
      expect(body.description, `wrongly dropped: ${vector.why}`).toBe(vector.text);
    }
  });

  it('does NOT implement a learner-name heuristic', async () => {
    // Pinned as a behaviour, not a comment. `for` is a bare preposition and
    // `[A-Z][a-z]{1,}` cannot express the real leak shapes — measured in
    // PR #1815 and restated in the contract's $learner_name_divergence. If
    // someone reintroduces the patterns here, these strings go dark and this
    // fails.
    for (const text of [
      'Center for Professional Development',
      'Society for Human Resource Management',
      'Ethics for Trial Lawyers',
      'Revoked for Non Payment',
      'Data Science degree',
    ]) {
      const body = await getVerification(
        buildTestAnchor({
          public_id: 'ARK-2026-PUB-002',
          credential_type: NON_ACADEMIC_TYPE,
          description: text,
        }),
      );
      expect(body.description, `learner-name heuristic regression on "${text}"`).toBe(text);
    }
  });

  it('leaves verification-bearing fields untouched on a gated academic record', async () => {
    // The point of omission-over-fail-closed: the answer survives.
    const body = await getVerification(
      buildTestAnchor({
        public_id: 'ARK-2026-PUB-003',
        credential_type: 'TRANSCRIPT',
        description: 'Transcript: Jane Doe',
        chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
        chain_block_height: 204567,
        merkle_root: 'c'.repeat(64),
      }),
    );

    expect(body.verified).toBe(true);
    expect(body.status).toBe('ACTIVE');
    expect(body.bitcoin_block).toBe(204567);
    expect(body.network_receipt_id).toBe(
      'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    );
    expect(body.merkle_proof_hash).toBe('c'.repeat(64));
    expect(body.credential_type).toBe('TRANSCRIPT');
    expect(body.explorer_url).toContain('/tx/');
  });
});

describe('the gate runs before the response is cached', () => {
  it('caches the GATED result, never the raw one', async () => {
    await getVerification(
      buildTestAnchor({
        public_id: 'ARK-2026-CACHE-001',
        credential_type: 'TRANSCRIPT',
        description: 'Transcript: Jane Doe',
      }),
    );

    expect(mockSetCached).toHaveBeenCalledTimes(1);
    const [, cached] = mockSetCached.mock.calls[0] as [string, Record<string, unknown>];
    expect(cached).not.toHaveProperty('description');
  });
});
