/**
 * FD-FERPA-1 — LIVE proof that `anchors.directory_info_opt_out` actually
 * suppresses directory information on the anon-reachable SQL projections.
 *
 * ── WHY A LIVE SUITE, NOT A MOCKED ONE ──────────────────────────────────────
 *
 * The property under test is enforced by SQL: a predicate inside a SECURITY
 * DEFINER function that `anon` calls over PostgREST. `tests/rls/agents.md`
 * records what happens when that kind of invariant is asserted against a
 * fixture instead — `services/edge/src/mcp-tools.test.ts` certified an
 * existence-oracle fix for months while production served the leak, because it
 * mocked the RPC and supplied the premise itself. A mock may stand in for a
 * COLLABORATOR, never for the INVARIANT under test.
 *
 * ── THE SHAPE THESE ASSERTIONS TAKE ─────────────────────────────────────────
 *
 * Every leak assertion runs on the SERIALIZED body, not on named fields, so a
 * value cannot survive by moving to a key nobody thought to check. Every
 * suppression assertion is paired with a POSITIVE CONTROL: an identical anchor
 * with the flag OFF must still publish, and the opted-out record must still
 * VERIFY. "Suppresses everything" and "the RPC is broken" look identical from a
 * single negative assertion, and one of those is an outage.
 *
 * ── THE FIXTURE IS THE FINDING ──────────────────────────────────────────────
 *
 * The `credential_type: null` case is not an edge case invented for coverage.
 * All three production anchors carrying the opt-out (measured on
 * vzwyaatejekddvltxyye, 2026-08-21) have a NULL credential type, so a
 * suppression rule written as `type IN (education types)` suppresses NOTHING
 * for every record the finding is actually about.
 *
 * Prerequisites: local Supabase running + seeded, migrated to at least 0415
 * (see tests/rls/agents.md).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createServiceClient, createAnonClient } from '../../src/tests/rls/helpers';

const RUN_STARTED = Date.now();
const RUN_ID = RUN_STARTED.toString(36);
const RUN_HEX = RUN_STARTED.toString(16).padStart(12, '0').slice(-12);
const ORG_ID = 'f19e2400-0000-4000-8000-00000000c001';

/**
 * The directory-level values seeded into every fixture. Each is a distinctive
 * literal so a substring search over the whole response body is decisive: if
 * any of these appears, that field was published.
 */
const ISSUER_NAME = `Northfield Polytechnic ${RUN_ID}`;
const FIELD_OF_STUDY = `Hydrographic Surveying ${RUN_ID}`;
const ISSUED_AT = '2024-05-17T00:00:00.000Z';
const EXPIRES_AT = '2034-05-17T00:00:00.000Z';

let fpSeed = 0;
function nextFingerprint(): string {
  fpSeed += 1;
  return (RUN_HEX + fpSeed.toString(16).padStart(4, '0')).repeat(4).slice(0, 64);
}

interface Seeded {
  publicId: string;
  fingerprint: string;
  filename: string;
}

describe('FD-FERPA-1 — directory_info_opt_out suppresses directory information', () => {
  const service = createServiceClient();
  const anon = createAnonClient();
  let userId: string;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (service as any)
      .from('profiles')
      .select('id')
      .eq('org_id', ORG_ID)
      .limit(1)
      .single();
    if (error) throw new Error(`could not resolve a seed profile for ${ORG_ID}: ${error.message}`);
    userId = data.id as string;
  });

  /**
   * Seeds a SECURED anchor carrying every directory-level field the projection
   * can emit. Throws on failure rather than returning: a missing anchor makes
   * `get_public_anchor` answer "Record not found", which would make every leak
   * assertion below pass VACUOUSLY — the exact bug that was caught while
   * authoring the 0388 suite.
   */
  async function seedAnchor(opts: {
    optOut: boolean;
    credentialType: string | null;
  }): Promise<Seeded> {
    const fingerprint = nextFingerprint();
    const filename = `${ISSUER_NAME} record ${fpSeed}.pdf`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (service as any)
      .from('anchors')
      .insert({
        user_id: userId,
        org_id: ORG_ID,
        fingerprint,
        filename,
        file_size: 2048,
        status: 'SECURED',
        credential_type: opts.credentialType,
        directory_info_opt_out: opts.optOut,
        issued_at: ISSUED_AT,
        expires_at: EXPIRES_AT,
        metadata: { issuer: ISSUER_NAME, title: `${ISSUER_NAME} title` },
        cpe_metadata: { credit_hours: 8, field_of_study: FIELD_OF_STUDY },
        // 0357 refuses a transition INTO SECURED without a chain receipt when
        // its GUC is on; set both so this suite is independent of that flag.
        chain_tx_id: `tx-ferpa-${RUN_ID}-${fpSeed}`,
        chain_timestamp: new Date().toISOString(),
      })
      .select('public_id')
      .single();
    if (error) throw new Error(`anchor seed failed: ${error.message}`);
    return { publicId: data.public_id as string, fingerprint, filename };
  }

  /** Call the projection exactly as an unauthenticated caller does. */
  async function projectAsAnon(publicId: string): Promise<Record<string, unknown>> {
    const { data, error } = await anon.rpc('get_public_anchor' as never, {
      p_public_id: publicId,
    } as never);
    // A permission error is a DIFFERENT bug: this RPC is deliberately
    // anon-callable and 0364's suite pins that. Fail loudly rather than let a
    // 42501 masquerade as "suppressed".
    if (error) throw new Error(`get_public_anchor as anon failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  async function projectByFingerprintAsAnon(fp: string): Promise<Record<string, unknown>> {
    const { data, error } = await anon.rpc('get_public_anchor_by_fingerprint' as never, {
      p_fingerprint: fp,
    } as never);
    if (error) throw new Error(`get_public_anchor_by_fingerprint as anon failed: ${error.message}`);
    return data as Record<string, unknown>;
  }

  /** Every directory value, checked against the SERIALIZED body. */
  function expectNoDirectoryValues(body: Record<string, unknown>, context: string): void {
    const serialized = JSON.stringify(body);
    for (const [label, value] of [
      ['issuer name', ISSUER_NAME],
      ['field of study', FIELD_OF_STUDY],
      ['issue date', ISSUED_AT.slice(0, 10)],
      ['expiry date', EXPIRES_AT.slice(0, 10)],
    ] as const) {
      expect(
        serialized,
        `${context}: the ${label} is published for a record whose subject exercised the FERPA ` +
          '§99.37 directory-information opt-out. Asserted on the whole body, so a value cannot ' +
          'hide in a field this test does not name.',
      ).not.toContain(value);
    }
  }

  describe('get_public_anchor', () => {
    it('suppresses directory fields on an opted-out EDUCATION record', async () => {
      const { publicId } = await seedAnchor({ optOut: true, credentialType: 'DEGREE' });
      const body = await projectAsAnon(publicId);

      expectNoDirectoryValues(body, 'get_public_anchor / DEGREE');
      expect(body.directory_info_suppressed).toBe(true);
      expect(body).not.toHaveProperty('recipient_identifier');
    });

    it('suppresses directory fields on an opted-out record with NO credential type', async () => {
      // THE RECORDS THE FINDING IS ABOUT. All three prod anchors carrying the
      // opt-out have credential_type IS NULL, so a rule keyed on the education
      // set alone leaves every real case untouched. This is the fail-closed
      // assertion; without it a green suite would certify a fix that fixes
      // nothing in production.
      const { publicId } = await seedAnchor({ optOut: true, credentialType: null });
      const body = await projectAsAnon(publicId);

      expectNoDirectoryValues(body, 'get_public_anchor / absent credential_type');
      expect(body.directory_info_suppressed).toBe(true);
    });

    it('still VERIFIES a suppressed record — the fingerprint is the whole product', async () => {
      // The positive control, and the more important half. Suppression drops
      // directory FIELDS; it must never drop the record, blank the receipt, or
      // answer "Record not found", which would tell an anonymous verifier that
      // a genuinely anchored document does not exist.
      const { publicId, fingerprint } = await seedAnchor({ optOut: true, credentialType: 'DEGREE' });
      const body = await projectAsAnon(publicId);

      expect(body).not.toHaveProperty('error');
      expect(body.verified).toBe(true);
      expect(body.status).toBe('ACTIVE');
      expect(body.public_id).toBe(publicId);
      expect(body.fingerprint).toBe(fingerprint);
      expect(body.network_receipt_id).toBeTruthy();
      expect(body.anchor_timestamp).toBeTruthy();
      // And a display string is still present — never a NULL where consumers
      // assume text (0385's rule).
      expect(typeof body.filename).toBe('string');
      expect((body.filename as string).length).toBeGreaterThan(0);
      expect(typeof body.issuer_name).toBe('string');
      expect((body.issuer_name as string).length).toBeGreaterThan(0);
    });

    it('publishes directory fields when the opt-out is OFF (precision control)', async () => {
      // A gate that blanks legitimate credentials is a worse product than the
      // leak it replaced. Same fixture, flag off.
      const { publicId } = await seedAnchor({ optOut: false, credentialType: 'DEGREE' });
      const body = await projectAsAnon(publicId);
      const serialized = JSON.stringify(body);

      expect(serialized).toContain(ISSUER_NAME);
      expect(serialized).toContain(FIELD_OF_STUDY);
      expect(body.issued_date).toBeTruthy();
      expect(body.expiry_date).toBeTruthy();
      expect(body).not.toHaveProperty('directory_info_suppressed');
    });

    it('leaves a non-education opted-out record published — the recorded residual', async () => {
      // A DELIBERATE, DOCUMENTED boundary, not an oversight: FERPA §99.37 is an
      // education-records right, and the REST path pins the same boundary
      // (verify.test.ts, "does not suppress fields for non-education types even
      // when opt-out is true"). Pinned here so widening it is a decision taken
      // on both surfaces at once rather than a drift discovered later.
      const { publicId } = await seedAnchor({ optOut: true, credentialType: 'INSURANCE' });
      const body = await projectAsAnon(publicId);

      expect(JSON.stringify(body)).toContain(ISSUER_NAME);
      expect(body).not.toHaveProperty('directory_info_suppressed');
    });
  });

  describe('get_public_anchor_by_fingerprint', () => {
    it('inherits the suppression, because it delegates the whole projection', async () => {
      // It has no projection of its own — it resolves a public_id and returns
      // get_public_anchor's body verbatim, which is why 0415 does not redefine
      // it. That is a CLAIM about the code, so it gets an assertion: if a
      // future migration forks the projection (the 0376 failure mode), this
      // fails.
      const { fingerprint } = await seedAnchor({ optOut: true, credentialType: 'TRANSCRIPT' });
      const body = await projectByFingerprintAsAnon(fingerprint);

      expectNoDirectoryValues(body, 'get_public_anchor_by_fingerprint');
      expect(body.directory_info_suppressed).toBe(true);
      // Positive control: the record still resolves by fingerprint.
      expect(body).not.toHaveProperty('error');
      expect(body.verified).toBe(true);
    });

    it('returns byte-identical bodies to get_public_anchor for the same record', async () => {
      // INDISTINGUISHABILITY, not merely "both suppress": the disclosure would
      // be the DIFFERENCE between the two answers, so compare the bodies.
      const { publicId, fingerprint } = await seedAnchor({
        optOut: true,
        credentialType: 'CERTIFICATE',
      });
      const [byId, byFingerprint] = await Promise.all([
        projectAsAnon(publicId),
        projectByFingerprintAsAnon(fingerprint),
      ]);
      expect(byFingerprint).toEqual(byId);
    });
  });

  describe('search_public_credentials', () => {
    /** Search exactly as an unauthenticated caller does. */
    async function searchAsAnon(query: string): Promise<Record<string, unknown>[]> {
      const { data, error } = await anon.rpc('search_public_credentials' as never, {
        p_query: query,
        p_limit: 50,
      } as never);
      if (error) throw new Error(`search_public_credentials as anon failed: ${error.message}`);
      return (data ?? []) as Record<string, unknown>[];
    }

    it('does not MATCH an opted-out record — closing the hit-count oracle', async () => {
      // 0387's invariant: you can only search for text we would be willing to
      // show you. Blanking the projected title while leaving the row matchable
      // converts a disclosure into an oracle — a caller confirms the record
      // exists from a non-empty result set without reading a single field.
      // CLE is deliberate: it is in the FERPA set but NOT in the academic set,
      // so 0387's academic exclusion does not already cover it and this
      // assertion is not vacuous.
      const { filename } = await seedAnchor({ optOut: true, credentialType: 'CLE' });
      const results = await searchAsAnon(filename);

      expect(
        results,
        'An opted-out record matched public search. Suppressing the projected title alone is ' +
          'not enough: a non-empty result set is itself the disclosure.',
      ).toEqual([]);
    });

    it('still MATCHES the same record when the opt-out is OFF (non-vacuity control)', async () => {
      // Without this, "returns nothing" passes just as well against a search
      // that is broken, renamed, or matching nothing at all.
      const { filename, publicId } = await seedAnchor({ optOut: false, credentialType: 'CLE' });
      const results = await searchAsAnon(filename);

      expect(results.map((r) => r.public_id)).toContain(publicId);
    });

    it('does not MATCH an opted-out record with no credential type', async () => {
      const { filename } = await seedAnchor({ optOut: true, credentialType: null });
      expect(await searchAsAnon(filename)).toEqual([]);
    });
  });
});
