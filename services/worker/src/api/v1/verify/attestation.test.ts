/**
 * Tests for GET /api/v1/verify/attestation/:attestationId (SCRUM-1873)
 *
 * Verification endpoint for legally binding attestations. Public, anonymous
 * access — verification is a public good (Constitution 1.10: 100 req/min anon).
 *
 * Tests follow TDD red-green-refactor per CLAUDE.md rule 1.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { beforeEach, describe, it, expect, vi } from 'vitest';

// Mock db and logger to avoid config validation at import time.
// `from()` must return a usable chain: the route's fire-and-forget audit insert
// calls `db.from('audit_events').insert(...).then(...).catch(...)` synchronously,
// so a bare `vi.fn()` would throw inside the handler and turn every 200 into a 500.
const mockAuditInsert = vi.hoisted(() =>
  vi.fn((_row: Record<string, unknown>) => Promise.resolve({ error: null })),
);
const mockFrom = vi.hoisted(() => vi.fn(() => ({ insert: mockAuditInsert })));

vi.mock('../../../utils/db.js', () => ({
  db: { from: mockFrom },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../config.js', () => ({
  config: {
    bitcoinNetwork: 'signet',
    frontendUrl: 'https://app.arkova.ai',
  },
}));

import {
  attestationVerifyRouter,
  handleAttestationVerify,
  buildAttestationVerificationResult,
  defaultLookup,
  isPubliclyDisclosable,
  PUBLICLY_DISCLOSABLE_ATTESTATION_STATUSES,
  type AttestationLookup,
  type AttestationVerificationResult,
  type LegallyBindingAttestationRow,
} from './attestation.js';

// ── Factory ─────────────────────────────────────────────────

function createLba(
  overrides: Partial<LegallyBindingAttestationRow> = {},
): LegallyBindingAttestationRow {
  return {
    attestation_id: 'ARK-ATT-ABC123',
    attestation_type: 'notarized',
    attesting_org_name: 'Acme Legal Inc.',
    org_verified: true,
    subject_name: 'Jane Doe',
    // attestation_statement intentionally omitted (never selected per privacy policy)
    status: 'anchored',
    notary_name: 'John Notary',
    notary_commission_state: 'CA',
    notary_commission_number: 'N-12345',
    notarization_completed_at: '2026-05-20T15:00:00Z',
    anchor_public_id: 'ARK-2026-ANC-001',
    anchor_status: 'SECURED',
    anchor_fingerprint: 'a'.repeat(64),
    anchor_chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    anchor_chain_block_height: 204567,
    anchor_chain_timestamp: '2026-05-21T10:30:00Z',
    anchor_timestamp: '2026-05-21T10:30:00Z',
    created_at: '2026-05-19T08:00:00Z',
    updated_at: '2026-05-21T11:00:00Z',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('buildAttestationVerificationResult', () => {
  it('returns verified=true for a fully anchored notarized attestation', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(true);
    expect(result.attestation.public_id).toBe('ARK-ATT-ABC123');
    expect(result.attestation.type).toBe('notarized');
    expect(result.attestation.status).toBe('anchored');
    expect(result.attestation.attesting_org.name).toBe('Acme Legal Inc.');
    expect(result.attestation.attesting_org.verified).toBe(true);
    expect(result.attestation.subject.name).toBe('Jane Doe');
    expect(result.attestation.created_at).toBe('2026-05-19T08:00:00Z');
  });

  it('includes notarization details for notarized attestations', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    expect(result.attestation.notarization).toBeDefined();
    expect(result.attestation.notarization!.status).toBe('completed');
    expect(result.attestation.notarization!.notary_name).toBe('John Notary');
    expect(result.attestation.notarization!.commission_state).toBe('CA');
    expect(result.attestation.notarization!.commission_number).toBe('N-12345');
    expect(result.attestation.notarization!.completed_at).toBe('2026-05-20T15:00:00Z');
  });

  it('includes anchor proof for anchored attestations', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    expect(result.anchor).toBeDefined();
    expect(result.anchor!.status).toBe('SECURED');
    expect(result.anchor!.fingerprint).toBe('a'.repeat(64));
    expect(result.anchor!.network_receipt).toBe(
      'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    );
    expect(result.anchor!.anchored_at).toBe('2026-05-21T10:30:00Z');
    expect(result.anchor!.block_height).toBe(204567);
    expect(result.anchor!.explorer_url).toMatch(/mempool\.space.*\/tx\//);
  });

  it('returns verified=false for a draft attestation', () => {
    const lba = createLba({ status: 'draft', anchor_public_id: null, anchor_status: null });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(false);
    expect(result.attestation.status).toBe('draft');
    expect(result.anchor).toBeNull();
  });

  it('returns verified=false for pending_notarization attestation', () => {
    const lba = createLba({
      status: 'pending_notarization',
      notary_name: null,
      notarization_completed_at: null,
      anchor_public_id: null,
      anchor_status: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(false);
    expect(result.attestation.status).toBe('pending_notarization');
    expect(result.attestation.notarization).toBeDefined();
    expect(result.attestation.notarization!.status).toBe('pending');
  });

  it('returns verified=false for notarized but not-yet-anchored attestation', () => {
    const lba = createLba({
      status: 'notarized',
      anchor_public_id: null,
      anchor_status: null,
      anchor_fingerprint: null,
      anchor_chain_tx_id: null,
      anchor_chain_block_height: null,
      anchor_chain_timestamp: null,
      anchor_timestamp: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(false);
    expect(result.attestation.status).toBe('notarized');
    expect(result.anchor).toBeNull();
  });

  it('returns verified=false for requires_review attestation', () => {
    const lba = createLba({ status: 'requires_review' });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(false);
    expect(result.attestation.status).toBe('requires_review');
  });

  it('omits notarization block for standard (non-notarized) attestation types', () => {
    const lba = createLba({
      attestation_type: 'standard',
      notary_name: null,
      notary_commission_state: null,
      notary_commission_number: null,
      notarization_completed_at: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.attestation.notarization).toBeUndefined();
  });

  it('omits notarization block for witnessed attestation types', () => {
    const lba = createLba({
      attestation_type: 'witnessed',
      notary_name: null,
      notary_commission_state: null,
      notary_commission_number: null,
      notarization_completed_at: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.attestation.notarization).toBeUndefined();
  });

  it('includes anchor proof with null chain fields for PENDING anchor', () => {
    const lba = createLba({
      anchor_status: 'PENDING',
      anchor_chain_tx_id: null,
      anchor_chain_block_height: null,
      anchor_chain_timestamp: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(true); // attestation is anchored (DB status), even if chain is pending
    expect(result.anchor).toBeDefined();
    expect(result.anchor!.status).toBe('PENDING');
    expect(result.anchor!.network_receipt).toBeNull();
    expect(result.anchor!.block_height).toBeNull();
  });

  it('omits explorer_url when chain_tx_id is null', () => {
    const lba = createLba({
      anchor_chain_tx_id: null,
    });
    const result = buildAttestationVerificationResult(lba);

    if (result.anchor) {
      expect(result.anchor.explorer_url).toBeUndefined();
    }
  });

  it('does not leak internal UUIDs in any field', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);
    const serialized = JSON.stringify(result);

    // UUID v4 pattern: 8-4-4-4-12 hex chars
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('does not include attestation_statement in the response (privacy guard)', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);
    const serialized = JSON.stringify(result);

    // attestation_statement is marked as private in the migration comment
    expect(serialized).not.toContain('attestation_statement');
    expect(serialized).not.toContain('I attest that the credential is authentic.');
  });

  it('uses compliant terminology — no banned words in response', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    // Per CLAUDE.md 1.3: no "transaction", "hash", "blockchain", "bitcoin"
    // in user-visible API response keys
    const keys = extractAllKeys(result);
    const bannedKeyWords = ['transaction', 'hash', 'blockchain', 'bitcoin', 'wallet', 'crypto'];
    for (const key of keys) {
      const lower = key.toLowerCase();
      for (const banned of bannedKeyWords) {
        expect(lower).not.toContain(banned);
      }
    }
  });

  it('includes verify_url pointing to the attestation verification page', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    expect(result.verify_url).toBe('https://app.arkova.ai/verify/attestation/ARK-ATT-ABC123');
  });
});

// ── Public-disclosure gate (SCRUM-1873 / migration 0314 redaction contract) ──

describe('isPubliclyDisclosable', () => {
  it('discloses exactly the two published states', () => {
    expect(PUBLICLY_DISCLOSABLE_ATTESTATION_STATUSES).toEqual(['notarized', 'anchored']);
    expect(isPubliclyDisclosable('notarized')).toBe(true);
    expect(isPubliclyDisclosable('anchored')).toBe(true);
  });

  it('withholds in-flight and flagged states', () => {
    // draft = never submitted, pending_notarization = in flight at the notary,
    // requires_review = flagged. None of these are published by the org, and all
    // three carry subject_name + notary commission detail.
    expect(isPubliclyDisclosable('draft')).toBe(false);
    expect(isPubliclyDisclosable('pending_notarization')).toBe(false);
    expect(isPubliclyDisclosable('requires_review')).toBe(false);
  });

  it('fails closed on unknown, empty, null and undefined status', () => {
    expect(isPubliclyDisclosable('some_future_status')).toBe(false);
    expect(isPubliclyDisclosable('')).toBe(false);
    expect(isPubliclyDisclosable(null)).toBe(false);
    expect(isPubliclyDisclosable(undefined)).toBe(false);
    // case-sensitive, matching the 0314 CHECK constraint
    expect(isPubliclyDisclosable('ANCHORED')).toBe(false);
  });
});

// ── Route behaviour ─────────────────────────────────────────

interface RouteResponse {
  status: number;
  body: Record<string, never> | Record<string, unknown>;
}

/**
 * Mount the verification handler behind an ephemeral HTTP server and issue a
 * real request, so status codes and JSON bodies are exercised end-to-end.
 *
 * This mounts `handleAttestationVerify` DIRECTLY rather than
 * `attestationVerifyRouter`, because the router carries the parked-feature
 * gate that 501s every request (see the module header). The disclosure rules
 * proven below are what the endpoint must do the moment rows exist, so the
 * proof is kept running against the handler instead of being deleted for the
 * duration of the park. The gate itself is proven separately, over the real
 * router, in the parked-gate suite at the end of this file.
 *
 * `supertest` is a worker-only devDependency and does not resolve from a git
 * worktree (no per-worktree node_modules), so this uses `express` + node's
 * built-in `fetch` instead of adding a dependency.
 */
async function callRoute(lookup: AttestationLookup, path: string): Promise<RouteResponse> {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { _testLookup?: AttestationLookup })._testLookup = lookup;
    next();
  });
  app.get('/api/v1/verify/attestation/:attestationId', handleAttestationVerify);

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

function lookupReturning(row: LegallyBindingAttestationRow | null): AttestationLookup {
  return { lookupByPublicId: () => Promise.resolve(row) };
}

describe('GET /api/v1/verify/attestation/:attestationId', () => {
  beforeEach(() => {
    mockAuditInsert.mockClear();
    mockFrom.mockClear();
  });

  it('200s and discloses an anchored attestation', async () => {
    const res = await callRoute(
      lookupReturning(createLba({ status: 'anchored' })),
      '/api/v1/verify/attestation/ARK-ATT-ABC123',
    );

    expect(res.status).toBe(200);
    const result = res.body as unknown as AttestationVerificationResult;
    expect(result.verified).toBe(true);
    expect(result.attestation.public_id).toBe('ARK-ATT-ABC123');
    expect(result.attestation.subject.name).toBe('Jane Doe');
  });

  it('200s and discloses a notarized (not yet anchored) attestation', async () => {
    const res = await callRoute(
      lookupReturning(createLba({ status: 'notarized' })),
      '/api/v1/verify/attestation/ARK-ATT-ABC123',
    );

    expect(res.status).toBe(200);
    const result = res.body as unknown as AttestationVerificationResult;
    // Honest: the notarization is complete but nothing is on chain yet.
    expect(result.verified).toBe(false);
    expect(result.attestation.status).toBe('notarized');
  });

  // ── The leak this endpoint shipped with ────────────────────
  // Migration 0314 grants NO anon SELECT and ships no `select_public_anchored`
  // policy (both absences pinned by src/tests/legal-attestations-migration.test.ts),
  // and its table COMMENT requires public verification to be "API-mediated and
  // redacted". These cases are the redaction half of that contract.

  it.each(['draft', 'pending_notarization', 'requires_review'])(
    '404s an unpublished %s attestation and leaks none of its detail',
    async (status) => {
      const res = await callRoute(
        lookupReturning(createLba({ status })),
        '/api/v1/verify/attestation/ARK-ATT-ABC123',
      );

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ verified: false, error: 'Attestation not found' });

      // No subject PII, no notary commission detail, no status oracle.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('Jane Doe');
      expect(body).not.toContain('John Notary');
      expect(body).not.toContain('N-12345');
      expect(body).not.toContain('Acme Legal Inc.');
      expect(body).not.toContain(status);
    },
  );

  it('404s a row whose status is outside the CHECK constraint (fails closed)', async () => {
    const res = await callRoute(
      lookupReturning(createLba({ status: 'some_future_status' })),
      '/api/v1/verify/attestation/ARK-ATT-ABC123',
    );
    expect(res.status).toBe(404);
  });

  it('404s when no row exists', async () => {
    const res = await callRoute(
      lookupReturning(null),
      '/api/v1/verify/attestation/ARK-ATT-ABC123',
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ verified: false, error: 'Attestation not found' });
  });

  // ── Hollow-404 regression guard ────────────────────────────
  // A failed query must not be reported as "not found". See
  // memory/project_hollow_200_statement_timeout_swallow.md for the class.

  it('500s (not 404s) when the lookup itself fails', async () => {
    const res = await callRoute(
      { lookupByPublicId: () => Promise.reject(new Error('statement timeout')) },
      '/api/v1/verify/attestation/ARK-ATT-ABC123',
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ verified: false, error: 'Internal server error' });
    // and the underlying cause is never echoed to an anonymous caller
    expect(JSON.stringify(res.body)).not.toContain('statement timeout');
  });

  // ── ID namespace guard (K2) ────────────────────────────────
  // `attestations` public_ids are `ARK-{org_prefix}-{type_code}-{unique}`
  // (services/worker/src/api/v1/attestations.ts:404). They are valid IDs for a
  // DIFFERENT resource, served by GET /api/v1/attestations/:publicId. This
  // endpoint must keep rejecting them at the door rather than widening its
  // pattern and turning a precise 400 into an unresolvable 404.

  it.each([
    'ARK-ARK-VER-196485',
    'ARK-ARKOVA-VER-A1B2C3',
    'ARK-IND-END-9F2C1A',
  ])('400s %s — an attestations-table id, not an ARK-ATT id', async (foreignId) => {
    const res = await callRoute(
      lookupReturning(createLba()),
      `/api/v1/verify/attestation/${foreignId}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ARK-ATT-');
  });

  it('400s ids with characters outside the accepted alphabet', async () => {
    const spaced = await callRoute(
      lookupReturning(createLba()),
      '/api/v1/verify/attestation/ARK-ATT-abc%20def',
    );
    expect(spaced.status).toBe(400);

    const dotted = await callRoute(
      lookupReturning(createLba()),
      '/api/v1/verify/attestation/ARK-ATT-a.b',
    );
    expect(dotted.status).toBe(400);
  });

  // ── Audit behaviour (K4) ───────────────────────────────────

  it('writes exactly one audit row for a disclosed attestation', async () => {
    const res = await callRoute(
      lookupReturning(createLba({ status: 'anchored' })),
      '/api/v1/verify/attestation/ARK-ATT-ABC123',
    );
    expect(res.status).toBe(200);

    expect(mockFrom).toHaveBeenCalledWith('audit_events');
    expect(mockAuditInsert).toHaveBeenCalledTimes(1);
    const row = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.event_type).toBe('ATTESTATION_VERIFICATION_QUERIED');
    expect(row.target_id).toBe('ARK-ATT-ABC123');
    // details is a `text` column (audit_events.details: string | null) — stringified
    expect(typeof row.details).toBe('string');
    // the withheld/private fields never reach the audit trail either
    expect(row.details as string).not.toContain('Jane Doe');
    expect(row.details as string).not.toContain('attestation_statement');
  });

  it.each([
    ['a withheld draft', 'ARK-ATT-ABC123', 'draft', 404],
    ['an invalid id', 'ARK-ARK-VER-196485', 'anchored', 400],
  ])('writes no audit row for %s', async (_label, id, status, expected) => {
    const res = await callRoute(
      lookupReturning(createLba({ status: status as string })),
      `/api/v1/verify/attestation/${id as string}`,
    );
    expect(res.status).toBe(expected as number);
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('writes no audit row when the row does not exist', async () => {
    const res = await callRoute(
      lookupReturning(null),
      '/api/v1/verify/attestation/ARK-ATT-ABC123',
    );
    expect(res.status).toBe(404);
    // An anonymous caller must not be able to append an unbounded number of
    // audit_events rows by hammering ids that do not resolve.
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });
});

// ── Default DB-backed lookup ────────────────────────────────

describe('defaultLookup', () => {
  /** Minimal PostgREST-shaped chain recorder. */
  function chainFor(result: { data: unknown; error: unknown }) {
    const calls: { eq: unknown[][]; in: unknown[][] } = { eq: [], in: [] };
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((...args: unknown[]) => {
      calls.eq.push(args);
      return chain;
    });
    chain.in = vi.fn((...args: unknown[]) => {
      calls.in.push(args);
      return chain;
    });
    chain.maybeSingle = vi.fn(() => Promise.resolve(result));
    return { chain, calls };
  }

  beforeEach(() => {
    mockFrom.mockReset();
  });

  it('constrains the query to publicly disclosable statuses (defence in depth)', async () => {
    const { chain, calls } = chainFor({ data: null, error: null });
    mockFrom.mockReturnValue(chain as never);

    await defaultLookup.lookupByPublicId('ARK-ATT-ABC123');

    expect(mockFrom).toHaveBeenCalledWith('legally_binding_attestations');
    expect(calls.eq[0]).toEqual(['attestation_id', 'ARK-ATT-ABC123']);
    // The withheld rows must never be loaded into worker memory at all.
    expect(calls.in[0]).toEqual(['status', ['notarized', 'anchored']]);
  });

  it('never selects attestation_statement (migration 0314 marks it private)', async () => {
    const { chain } = chainFor({ data: null, error: null });
    mockFrom.mockReturnValue(chain as never);

    await defaultLookup.lookupByPublicId('ARK-ATT-ABC123');

    const selected = (chain.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(selected).not.toContain('attestation_statement');
  });

  it('throws on a query error instead of masquerading as not-found', async () => {
    const { chain } = chainFor({
      data: null,
      error: { message: 'canceling statement due to statement timeout' },
    });
    mockFrom.mockReturnValue(chain as never);

    await expect(defaultLookup.lookupByPublicId('ARK-ATT-ABC123')).rejects.toThrow();
  });

  it('returns null (a real 404) when the query succeeds with no row', async () => {
    const { chain } = chainFor({ data: null, error: null });
    mockFrom.mockReturnValue(chain as never);

    await expect(defaultLookup.lookupByPublicId('ARK-ATT-ABC123')).resolves.toBeNull();
  });
});

// ── Parked-feature gate (2026-08-31) ────────────────────────────────
//
// `legally_binding_attestations` has no INSERT path anywhere in the tree, so
// before this gate the endpoint could only ever answer 404 "Attestation not
// found" — a lie of implicature, since 404 asserts a populated corpus. Verified
// against prod `vzwyaatejekddvltxyye` on 2026-08-31: 0 table rows, and 0
// `docusign.notarization_completed` jobs ever enqueued against 25 real
// `docusign.envelope_completed` jobs.
//
// These run over the REAL `attestationVerifyRouter`, i.e. the shape prod
// serves. The suite above proves what the handler behind this gate does.

async function callRouter(path: string): Promise<RouteResponse> {
  const app = express();
  app.use('/api/v1/verify/attestation', attestationVerifyRouter);

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

describe('parked-feature gate', () => {
  beforeEach(() => {
    mockFrom.mockClear();
  });

  it('501s a well-formed attestation id', async () => {
    const res = await callRouter('/api/v1/verify/attestation/ARK-ATT-ABC123');

    expect(res.status).toBe(501);
    expect(res.body.verified).toBe(false);
    expect(res.body.error).toBe('not_implemented');
  });

  it('501s a malformed id too, so no lookup is implied', async () => {
    const res = await callRouter('/api/v1/verify/attestation/not-a-valid-id');

    expect(res.status).toBe(501);
    expect(res.body.error).toBe('not_implemented');
  });

  it('never claims the attestation was "not found"', async () => {
    const res = await callRouter('/api/v1/verify/attestation/ARK-ATT-ABC123');

    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('not found');
  });

  it('touches no table — not even the audit log', async () => {
    await callRouter('/api/v1/verify/attestation/ARK-ATT-ABC123');

    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// ── Helpers ─────────────────────────────────────────────────

function extractAllKeys(obj: unknown, prefix = ''): string[] {
  const keys: string[] = [];
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      keys.push(prefix ? `${prefix}.${key}` : key);
      keys.push(...extractAllKeys(value, prefix ? `${prefix}.${key}` : key));
    }
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      keys.push(...extractAllKeys(item, prefix));
    }
  }
  return keys;
}
