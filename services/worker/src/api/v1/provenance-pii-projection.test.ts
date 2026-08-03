/**
 * SECURITY — outbound PII gate on `GET /api/v1/verify/:publicId/provenance`,
 * the FOURTH public projection of an anchor row.
 *
 * The route is mounted `router.use('/verify', provenanceRouter)` in `router.ts`
 * with NO `requireScope` and NO auth middleware, and `provenance.ts` carries no
 * auth check of its own — so an anonymous caller reaches it.
 *
 * TWO leaks, both proved here before they were fixed:
 *
 *   1. `revocation_reason` — issuer-authored free text, emitted verbatim inside
 *      the `credential_revoked` detail. Exactly the field migration 0385 calls
 *      out ("revoked - contact jane@example.edu") and suppresses outright on
 *      academic records.
 *   2. `signatures.signer_name` — emitted verbatim inside the
 *      `signature_created` detail. NOT in the original report; found while
 *      reading the file. It is populated from `cert.subject_cn`
 *      (`signatures.ts:248`), so it IS a person's name by construction rather
 *      than free text that might contain one. A value detector cannot help
 *      here — that is the whole measured lesson — so it is handled
 *      structurally.
 *
 * Same discipline as the sibling suite `verify-pii-projection.test.ts`: drive
 * the REAL router through supertest, because the finding is that the ROUTE is
 * anonymously reachable, and load the corpus from the SHARED CONTRACT so this
 * surface cannot drift by editing a local copy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

interface AnchorRow extends Record<string, unknown> {
  id: string;
  public_id: string;
  fingerprint: string;
  status: string;
  created_at: string;
  credential_type: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

interface SignatureRow {
  public_id: string;
  format: string;
  level: string;
  status: string;
  signed_at: string | null;
  signer_name: string | null;
  timestamp_token_id: string | null;
  created_at: string;
}

/** Mutable fixtures the mocked `db.from()` serves, set per test. */
const state: { anchor: AnchorRow | null; signatures: SignatureRow[] } = {
  anchor: null,
  signatures: [],
};

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock('../../utils/db.js', () => ({ db: { from: mockFrom } }));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { provenanceRouter } from './provenance.js';

// ---------------------------------------------------------------------------
// Shared contract
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(
  HERE,
  '../../../../../scripts/ci/public-pii-projection-contract.json',
);

interface Contract {
  academic_record_credential_types: string[];
  high_confidence_vectors: Array<{ text: string; family: string }>;
  must_publish_vectors: Array<{ text: string; why: string }>;
  leak_vectors: Array<{ text: string; shape: string }>;
}

const contract: Contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

/** Not in `academic_record_credential_types`, so only the VALUE gate applies. */
const NON_ACADEMIC_TYPE = 'CLE';

/**
 * Minimal chainable PostgREST stub. `anchors` resolves via `.single()`;
 * `signatures` and `audit_events` are awaited directly after `.order()` /
 * `.limit()`, so the builder is thenable.
 */
function buildDbStub() {
  return (table: string) => {
    const rows =
      table === 'signatures' ? state.signatures
      : table === 'audit_events' ? []
      : [];

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      single: async () =>
        state.anchor
          ? { data: state.anchor, error: null }
          : { data: null, error: { message: 'not found' } },
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return builder;
  };
}

function buildApp() {
  const app = express();
  // No auth middleware at all — mirrors router.ts's `router.use('/verify',
  // provenanceRouter)`, which is the premise of every assertion below.
  app.use('/api/v1/verify', provenanceRouter);
  return app;
}

function baseAnchor(overrides: Partial<AnchorRow> = {}): AnchorRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    public_id: 'ARK-2026-PROV-001',
    fingerprint: 'a'.repeat(64),
    status: 'REVOKED',
    created_at: '2026-03-01T10:00:00Z',
    credential_type: NON_ACADEMIC_TYPE,
    revoked_at: '2026-03-02T08:00:00Z',
    revocation_reason: null,
    org_id: 'org-1',
    chain_timestamp: null,
    chain_tx_id: null,
    ...overrides,
  };
}

async function getTimeline(): Promise<{
  events: Array<{ event_type: string; detail: string; timestamp: string }>;
  raw: string;
}> {
  const res = await request(buildApp()).get(
    `/api/v1/verify/${state.anchor?.public_id ?? 'x'}/provenance`,
  );
  expect(res.status).toBe(200);
  return { events: res.body.events, raw: JSON.stringify(res.body) };
}

function revocationEvent(
  events: Array<{ event_type: string; detail: string; timestamp: string }>,
) {
  return events.find((e) => e.event_type === 'credential_revoked');
}

beforeEach(() => {
  vi.clearAllMocks();
  state.anchor = null;
  state.signatures = [];
  mockFrom.mockImplementation(buildDbStub());
});

// ---------------------------------------------------------------------------

describe('anonymous reachability', () => {
  it('answers with no API key and no Authorization header', async () => {
    state.anchor = baseAnchor({ revoked_at: null, status: 'SECURED' });
    const res = await request(buildApp()).get('/api/v1/verify/ARK-2026-PROV-001/provenance');

    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
  });
});

describe('revocation_reason — academic records emit none at all', () => {
  for (const credentialType of ['DEGREE', 'TRANSCRIPT', 'CERTIFICATE']) {
    it(`omits the reason on ${credentialType} but keeps the revocation event`, async () => {
      state.anchor = baseAnchor({
        credential_type: credentialType,
        revocation_reason: 'Revoked at request of Jane Doe, registrar',
      });
      const { events, raw } = await getTimeline();

      expect(raw).not.toContain('Jane Doe');
      // Omission, not fail-closed: the timeline still answers, and the fact +
      // timestamp of revocation survive — only the free text goes.
      const rev = revocationEvent(events);
      expect(rev).toBeDefined();
      expect(rev!.timestamp).toBe('2026-03-02T08:00:00Z');
    });
  }

  it('covers every leak_vector in the shared contract, for every academic type', async () => {
    for (const credentialType of contract.academic_record_credential_types) {
      for (const vector of contract.leak_vectors) {
        state.anchor = baseAnchor({
          credential_type: credentialType,
          revocation_reason: vector.text,
        });
        const { raw } = await getTimeline();
        expect(raw, `${credentialType} leaked a ${vector.shape}`).not.toContain(vector.text);
      }
    }
  });

  it('never claims "no reason provided" when a reason exists but was suppressed', async () => {
    // §1.5 / §1.13 R-7: state what is measured vs asserted vs NOT asserted.
    // A stored-but-suppressed reason is not the same fact as no reason, and
    // the projection must not assert the second when the first is true.
    state.anchor = baseAnchor({
      credential_type: 'TRANSCRIPT',
      revocation_reason: 'Jane Doe withdrew',
    });
    const { events } = await getTimeline();

    expect(revocationEvent(events)!.detail).not.toContain('no reason provided');
  });

  it('still says "no reason provided" when there genuinely is none', async () => {
    state.anchor = baseAnchor({ credential_type: 'TRANSCRIPT', revocation_reason: null });
    const { events } = await getTimeline();

    expect(revocationEvent(events)!.detail).toContain('no reason provided');
  });
});

describe('revocation_reason — value gate on every other credential type', () => {
  it('covers every high_confidence_vector in the shared contract', async () => {
    for (const vector of contract.high_confidence_vectors) {
      state.anchor = baseAnchor({ revocation_reason: vector.text });
      const { raw } = await getTimeline();
      expect(raw, `${vector.family} survived the value gate`).not.toContain(vector.text);
    }
  });

  it('publishes every must_publish_vector — the gate must not blank real reasons', async () => {
    for (const vector of contract.must_publish_vectors) {
      state.anchor = baseAnchor({ revocation_reason: vector.text });
      const { events } = await getTimeline();
      expect(revocationEvent(events)!.detail, `wrongly dropped: ${vector.why}`).toContain(
        vector.text,
      );
    }
  });

  it('does NOT implement a learner-name heuristic', async () => {
    // "Revoked for Non Payment" is pinned in must_publish_vectors precisely
    // because `for` as a bare preposition made the old heuristic drop it.
    for (const text of ['Revoked for Non Payment', 'Credit for Prior Learning']) {
      state.anchor = baseAnchor({ revocation_reason: text });
      const { events } = await getTimeline();
      expect(revocationEvent(events)!.detail).toContain(text);
    }
  });
});

describe('signer_name — never published on the anonymous projection', () => {
  const signature: SignatureRow = {
    public_id: 'SIG-2026-001',
    format: 'PAdES',
    level: 'B-LT',
    status: 'VALID',
    signed_at: '2026-03-01T12:00:00Z',
    signer_name: 'Maria Gonzalez',
    timestamp_token_id: null,
    created_at: '2026-03-01T12:00:00Z',
  };

  it('omits the signer name from the signature_created detail', async () => {
    // `signer_name` is `cert.subject_cn` (signatures.ts:248) — a person's name
    // BY CONSTRUCTION, not free text that might contain one. No value detector
    // can catch a bare name, so this is structural: the name is never emitted.
    state.anchor = baseAnchor({ revoked_at: null, status: 'SECURED' });
    state.signatures = [signature];
    const { events, raw } = await getTimeline();

    expect(raw).not.toContain('Maria Gonzalez');
    // The verification-bearing content survives: a signature exists, at a
    // time, with its format, level, and a resolvable evidence_ref.
    const sig = events.find((e) => e.event_type === 'signature_created');
    expect(sig).toBeDefined();
    expect(sig!.detail).toContain('PAdES');
    expect(sig!.detail).toContain('B-LT');
    expect(sig!.timestamp).toBe('2026-03-01T12:00:00Z');
    expect((sig as unknown as { evidence_ref: string }).evidence_ref).toBe('SIG-2026-001');
  });

  it('omits every name shape, including the ones a detector cannot see', async () => {
    for (const vector of contract.leak_vectors) {
      state.anchor = baseAnchor({ revoked_at: null, status: 'SECURED' });
      state.signatures = [{ ...signature, signer_name: vector.text }];
      const { raw } = await getTimeline();
      expect(raw, `signer_name leaked a ${vector.shape}`).not.toContain(vector.text);
    }
  });

  it('does not emit a bare "by" dangling where the name was removed', async () => {
    state.anchor = baseAnchor({ revoked_at: null, status: 'SECURED' });
    state.signatures = [signature];
    const { events } = await getTimeline();

    const sig = events.find((e) => e.event_type === 'signature_created');
    expect(sig!.detail).not.toMatch(/\bby\s*$/);
    expect(sig!.detail).not.toContain('unknown');
  });
});

describe('structural fields are untouched', () => {
  it('keeps public_id, fingerprint prefix, status and event ordering', async () => {
    state.anchor = baseAnchor({
      credential_type: 'TRANSCRIPT',
      revocation_reason: 'Jane Doe withdrew',
    });
    const res = await request(buildApp()).get('/api/v1/verify/ARK-2026-PROV-001/provenance');

    expect(res.status).toBe(200);
    expect(res.body.public_id).toBe('ARK-2026-PROV-001');
    expect(res.body.status).toBe('REVOKED');
    expect(res.body.event_count).toBe(res.body.events.length);
    const created = res.body.events.find(
      (e: { event_type: string }) => e.event_type === 'credential_created',
    );
    expect(created.detail).toContain('ARK-2026-PROV-001');
  });
});
