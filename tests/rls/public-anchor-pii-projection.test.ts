/**
 * LIVE PROOF that the anon-callable public verification projection no longer
 * leaks learner PII (migration 0384).
 *
 * `public.get_public_anchor(text)` and its delegating sibling
 * `get_public_anchor_by_fingerprint(text)` are GRANTed to `anon` and called
 * unauthenticated, straight from the browser, by the public verify page, the
 * embeddable widget, and the edge MCP `verify` tools. Every free-text field on
 * that projection used to be emitted verbatim, because
 * `sanitize_metadata_for_public` is a key-NAME denylist: it drops keys CALLED
 * `recipient` / `email` / `dob`, and never inspects a VALUE. A learner name
 * written into a credential title — or an upload literally named
 * `jane-doe-transcript.pdf`, which the verify page renders as the record's
 * display title and embeds in its schema.org JSON-LD — reached anonymous
 * callers unchanged.
 *
 * This suite seeds those exact shapes into real anchor rows with a service_role
 * client, then reads them back through the real RPC as a real ANON client. It
 * asserts on the SERIALIZED response body, so a value cannot hide in a field
 * the assertions forgot to name.
 *
 * RED/GREEN: every assertion in the "learner PII" and "revocation reason"
 * blocks fails against the pre-0384 definition — that is the leak. They pass
 * once 0384 is applied.
 *
 * The vectors come from scripts/ci/public-pii-projection-contract.json, the
 * shared contract that also binds services/worker/src/ctdl/ctdl-pii-guard.ts,
 * so this suite and the CTDL suite cannot drift apart on what counts as PII.
 *
 * Prerequisites: local Supabase running + seeded (see tests/rls/agents.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServiceClient, createAnonClient, type TypedClient } from '../../src/tests/rls/helpers';

interface Contract {
  academic_record_credential_types: string[];
  sql_academic_controlled_labels: Record<string, string>;
  high_confidence_vectors: { text: string; family: string }[];
  must_publish_vectors: { text: string; why: string }[];
  leak_vectors: { text: string; shape: string }[];
}

const contract: Contract = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'scripts/ci/public-pii-projection-contract.json'), 'utf8'),
);

const RUN_ID = Date.now().toString(36);
const RUN_HEX = Date.now().toString(16).padStart(12, '0').slice(-12);
const ORG_ID = 'a11ea100-0000-4000-8000-00000000b001';

let fpSeed = 0;
function nextFingerprint(): string {
  fpSeed += 1;
  return (RUN_HEX + fpSeed.toString(16).padStart(4, '0')).repeat(4).slice(0, 64);
}

interface SeedOpts {
  credentialType: string | null;
  filename?: string;
  metadata?: Record<string, unknown>;
  revocationReason?: string;
  status?: 'SECURED' | 'REVOKED';
}

describe('0384 — anon public anchor projection does not leak learner PII', () => {
  const service = createServiceClient();
  const anon = createAnonClient();
  let userId: string;
  const seededPublicIds: string[] = [];

  /** Seed one anchor and return its generated public_id + fingerprint. */
  async function seedAnchor(opts: SeedOpts): Promise<{ publicId: string; fingerprint: string }> {
    const fingerprint = nextFingerprint();
    const status = opts.status ?? 'SECURED';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (service as any)
      .from('anchors')
      .insert({
        user_id: userId,
        org_id: ORG_ID,
        fingerprint,
        filename: opts.filename ?? `pii-projection-${RUN_ID}-${fpSeed}.pdf`,
        file_size: 2048,
        status,
        credential_type: opts.credentialType,
        metadata: opts.metadata ?? {},
        revocation_reason: opts.revocationReason ?? null,
        // anchors_revocation_consistency: a reason is only storable alongside a
        // revocation timestamp.
        revoked_at: opts.revocationReason ? new Date().toISOString() : null,
        // 0357 refuses a transition INTO SECURED without a chain receipt when its
        // GUC is on; set both so this suite is independent of that flag's state.
        chain_tx_id: `tx-${RUN_ID}-${fpSeed}`,
        chain_timestamp: new Date().toISOString(),
        chain_block_height: 900000 + fpSeed,
        issued_at: new Date().toISOString(),
      })
      .select('public_id')
      .single();
    if (error) throw new Error(`anchor seed failed: ${error.message}`);
    seededPublicIds.push(data.public_id);
    return { publicId: data.public_id as string, fingerprint };
  }

  /** The projection exactly as an anonymous caller receives it. */
  async function fetchAsAnon(publicId: string): Promise<Record<string, unknown>> {
    const { data, error } = await anon.rpc('get_public_anchor' as never, {
      p_public_id: publicId,
    } as never);
    expect(error, `anon rpc failed: ${error?.message}`).toBeNull();
    const body = data as unknown as Record<string, unknown>;
    expect(body.error, 'the record must still verify — the gate omits fields, it never hides records').toBeUndefined();
    return body;
  }

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    const orgName = `PII Projection Org ${RUN_ID}`;
    const { error: orgErr } = await svc
      .from('organizations')
      .upsert({ id: ORG_ID, legal_name: orgName, display_name: orgName }, { onConflict: 'id' });
    if (orgErr) throw new Error(`org upsert failed: ${orgErr.message}`);

    const email = `pii-projection-${RUN_ID}@rls.arkova.local`;
    const { data: created, error: createErr } = await svc.auth.admin.createUser({
      email,
      password: process.env.RLS_TEST_PASSWORD as string,
      email_confirm: true,
    });
    if (createErr) throw new Error(`createUser failed: ${createErr.message}`);
    userId = created.user.id as string;

    const { error: profErr } = await svc.from('profiles').upsert(
      { id: userId, email, full_name: 'PII Projection Seed', role: 'ORG_ADMIN', org_id: ORG_ID, is_public_profile: false },
      { onConflict: 'id' },
    );
    if (profErr) throw new Error(`profile upsert failed: ${profErr.message}`);
  }, 60_000);

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    await svc.from('anchors').delete().eq('org_id', ORG_ID);
    if (userId) await svc.auth.admin.deleteUser(userId);
    await svc.from('organizations').delete().eq('id', ORG_ID);
  }, 60_000);

  // ───────────────────────────────────────────────────────────────────────────
  // The reported defect, end to end.
  // ───────────────────────────────────────────────────────────────────────────

  describe('academic records emit no issuer- or extraction-authored free text', () => {
    it('a TRANSCRIPT with a learner name in filename, title, and description leaks NOTHING', async () => {
      const learner = 'Jane Doe';
      const { publicId } = await seedAnchor({
        credentialType: 'TRANSCRIPT',
        filename: 'jane-doe-transcript.pdf',
        metadata: {
          title: `Official Transcript for ${learner}`,
          credential_title: `${learner} — Academic Transcript`,
          description: `Cumulative record of coursework completed by ${learner}, born 1994-02-11.`,
          issuer: 'Example State University',
        },
      });

      const body = await fetchAsAnon(publicId);
      const serialized = JSON.stringify(body);

      // The whole body, not just the fields we remembered to name.
      expect(serialized).not.toContain(learner);
      expect(serialized.toLowerCase()).not.toContain('jane');
      expect(serialized).not.toContain('1994-02-11');

      // Controlled vocabulary in, free text out — the record still verifies and
      // still renders, which is what makes suppression viable here.
      expect(body.filename).toBe(contract.sql_academic_controlled_labels.TRANSCRIPT);
      const metadata = body.metadata as Record<string, unknown>;
      // Omitted, not relabelled: leaving `metadata` non-empty flips the verify
      // card into its key-value render mode and prints the label three times.
      expect(metadata.title).toBeUndefined();
      expect(metadata.credential_title).toBeUndefined();
      expect(metadata.description).toBeUndefined();

      // The verification claim itself is untouched — that is the whole point of
      // omitting fields rather than refusing the record.
      expect(body.verified).toBe(true);
      expect(body.status).toBe('ACTIVE');
      expect(body.network_receipt_id).toBeTruthy();
      // The issuer is an INSTITUTION, not the learner, so it survives.
      expect(body.issuer_name).toBe('Example State University');
    });

    it.each(contract.leak_vectors)(
      'suppresses the "$shape" leak shape ($text)',
      async ({ text }) => {
        const { publicId } = await seedAnchor({
          credentialType: 'TRANSCRIPT',
          filename: `${text}.pdf`,
          metadata: { title: text, credential_title: text, description: text, category: text },
        });
        const serialized = JSON.stringify(await fetchAsAnon(publicId));
        // Structural, not detected: an academic record carries no free text at
        // all, so capitalisation, alphabet, punctuation, and position are
        // irrelevant. None of these would survive a regex-based name detector.
        expect(serialized).not.toContain(text);
      },
    );

    it.each(contract.academic_record_credential_types)(
      '%s is gated (a free-text title never reaches an anon caller)',
      async (credentialType) => {
        const marker = `Awarded to Priyanka Raghunathan ${RUN_ID}`;
        const { publicId } = await seedAnchor({
          credentialType,
          filename: `${marker}.pdf`,
          metadata: { title: marker, description: marker },
        });
        const body = await fetchAsAnon(publicId);
        expect(JSON.stringify(body)).not.toContain('Priyanka');
        expect(body.filename).toBe(contract.sql_academic_controlled_labels[credentialType]);
      },
    );
  });

  describe('revocation_reason', () => {
    it('drops a PII-bearing reason on a NON-academic record but keeps the REVOKED status', async () => {
      const { publicId } = await seedAnchor({
        credentialType: 'LICENSE',
        status: 'REVOKED',
        revocationReason: 'Revoked — contact registrar jane.doe@example.edu for details',
        metadata: { title: 'Professional Practice Licence' },
      });
      const body = await fetchAsAnon(publicId);

      expect(JSON.stringify(body)).not.toContain('jane.doe@example.edu');
      expect(body.revocation_reason).toBeNull();
      // Revocation is a material fact for a verifier: the STATUS must survive
      // even though the free-text reason did not.
      expect(body.status).toBe('REVOKED');
      expect(body.verified).toBe(false);
    });

    it('keeps a clean revocation reason verbatim', async () => {
      const reason = 'Superseded by a corrected issuance in the same term';
      const { publicId } = await seedAnchor({
        credentialType: 'LICENSE',
        status: 'REVOKED',
        revocationReason: reason,
        metadata: { title: 'Professional Practice Licence' },
      });
      const body = await fetchAsAnon(publicId);
      expect(body.revocation_reason).toBe(reason);
    });

    it('omits the reason entirely on an academic record', async () => {
      const { publicId } = await seedAnchor({
        credentialType: 'DEGREE',
        status: 'REVOKED',
        revocationReason: 'Rescinded after academic misconduct review of the student record',
        metadata: { title: 'Bachelor of Science' },
      });
      const body = await fetchAsAnon(publicId);
      expect(body.revocation_reason).toBeNull();
      expect(body.status).toBe('REVOKED');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Value-level detectors, on every credential type.
  // ───────────────────────────────────────────────────────────────────────────

  describe('high-confidence PII detectors run on non-academic types too', () => {
    it('POSITIVE CONTROL: a clean OTHER record round-trips title and description', async () => {
      // Without this, the seven absence assertions below could all pass
      // vacuously — if 'OTHER' ever stopped emitting metadata.title for an
      // unrelated reason (allow-list change, sanitize_metadata_for_public
      // regression, seed not round-tripping) they would go green while proving
      // nothing about the detectors.
      const { publicId } = await seedAnchor({
        credentialType: 'OTHER',
        filename: 'evidence-bundle.pdf',
        metadata: { title: 'Evidence Bundle 2026', description: 'Quarterly evidence package.' },
      });
      const metadata = (await fetchAsAnon(publicId)).metadata as Record<string, unknown>;
      expect(metadata.title).toBe('Evidence Bundle 2026');
      expect(metadata.description).toBe('Quarterly evidence package.');
    });

    it.each(contract.high_confidence_vectors)(
      'drops a $family value from a non-academic credential title',
      async ({ text }) => {
        const { publicId } = await seedAnchor({
          credentialType: 'OTHER',
          filename: 'evidence-bundle.pdf',
          metadata: { title: text, description: text },
        });
        const body = await fetchAsAnon(publicId);
        const metadata = body.metadata as Record<string, unknown>;
        expect(JSON.stringify(body)).not.toContain(text);
        expect(metadata.title).toBeUndefined();
        expect(metadata.description).toBeUndefined();
        // Still a usable verification answer.
        expect(body.verified).toBe(true);
      },
    );

    it('POSITIVE CONTROL: a clean non-academic filename survives EXACTLY', async () => {
      // The `typeof filename === 'string'` check below cannot fail by
      // construction (the COALESCE fallback is always a string), so on its own
      // it would let a regression that replaced EVERY filename with the generic
      // label pass green — blanking every real display title and every
      // schema.org JSON-LD name on the site. This is the assertion that catches
      // that.
      const { publicId } = await seedAnchor({
        credentialType: 'CONTRACT_POSTSIGNING',
        filename: 'master-services-agreement-2026.pdf',
        metadata: { title: 'Master Services Agreement' },
      });
      const body = await fetchAsAnon(publicId);
      expect(body.filename).toBe('master-services-agreement-2026.pdf');
    });

    it('drops a PII-bearing filename on a non-academic record without emitting null', async () => {
      const { publicId } = await seedAnchor({
        credentialType: 'CONTRACT_POSTSIGNING',
        filename: 'signed-by-jane.doe@example.com.pdf',
        metadata: { title: 'Master Services Agreement' },
      });
      const body = await fetchAsAnon(publicId);
      expect(JSON.stringify(body)).not.toContain('jane.doe@example.com');
      // Never null: the verify page renders `filename` as the display title and
      // puts it in schema.org JSON-LD.
      expect(typeof body.filename).toBe('string');
      expect((body.filename as string).length).toBeGreaterThan(0);
    });

    it('DROPS an over-long URL rather than truncating it into a wrong link', async () => {
      const { publicId } = await seedAnchor({
        credentialType: 'OTHER',
        metadata: {
          title: 'Compliance Attestation',
          proof_url: `https://issuer.example.org/proof/${'a'.repeat(2100)}`,
        },
      });
      const metadata = (await fetchAsAnon(publicId)).metadata as Record<string, unknown>;
      // A truncated URL is a VALID-LOOKING WRONG LINK the frontend renders live.
      expect(metadata.proof_url).toBeUndefined();
    });

    it('strips the query string and fragment from proof_url', async () => {
      const { publicId } = await seedAnchor({
        credentialType: 'OTHER',
        metadata: {
          title: 'Compliance Attestation',
          proof_url: 'https://issuer.example.org/proof/9931?student=jane%40example.edu#holder-jane',
        },
      });
      const body = await fetchAsAnon(publicId);
      const metadata = body.metadata as Record<string, unknown>;
      expect(metadata.proof_url).toBe('https://issuer.example.org/proof/9931');
      expect(JSON.stringify(body)).not.toContain('jane');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Precision. A gate that blanks real credentials is a worse product than the
  // leak it replaced, so these are load-bearing, not decorative.
  // ───────────────────────────────────────────────────────────────────────────

  describe('legitimate content still publishes', () => {
    it.each(contract.must_publish_vectors)('publishes "$text" ($why)', async ({ text }) => {
      const { publicId } = await seedAnchor({
        credentialType: 'PROFESSIONAL',
        metadata: { title: text, issuer: text },
      });
      const body = await fetchAsAnon(publicId);
      const metadata = body.metadata as Record<string, unknown>;
      expect(metadata.title, `${text} must still reach the public projection`).toBe(text);
    });

    it('an anchor with NULL credential_type takes the non-academic path and still gates PII', async () => {
      // anchors.credential_type is nullable and plenty of legacy rows have no
      // value, so the academic predicate must resolve NULL to FALSE (not error,
      // not accidentally gate everything) while the value layer still applies.
      const { publicId } = await seedAnchor({
        credentialType: null,
        filename: 'quarterly-compliance-report.pdf',
        metadata: { title: 'Quarterly Compliance Report', description: 'Filed by registrar@example.edu' },
      });
      const body = await fetchAsAnon(publicId);
      const metadata = body.metadata as Record<string, unknown>;
      expect(body.credential_type).toBe('OTHER');
      expect(body.filename).toBe('quarterly-compliance-report.pdf');
      expect(metadata.title).toBe('Quarterly Compliance Report');
      // The value layer still runs on a NULL-typed anchor.
      expect(metadata.description).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('registrar@example.edu');
    });

    it('a CPE record keeps its real descriptive title (CPE/CLE are not academic records)', async () => {
      const title = 'Advanced Federal Tax Update — 8 Contact Hours';
      const { publicId } = await seedAnchor({
        credentialType: 'CPE',
        metadata: { title, description: 'Continuing professional education for licensed CPAs.' },
      });
      const body = await fetchAsAnon(publicId);
      const metadata = body.metadata as Record<string, unknown>;
      expect(metadata.title).toBe(title);
      expect(metadata.description).toBe('Continuing professional education for licensed CPAs.');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The sibling RPC delegates, so it must inherit the fix for free. It is the
  // one the edge MCP `verify` tool calls.
  // ───────────────────────────────────────────────────────────────────────────

  describe('get_public_anchor_by_fingerprint inherits the gate', () => {
    it('returns the same scrubbed body for a fingerprint lookup', async () => {
      const { publicId, fingerprint } = await seedAnchor({
        credentialType: 'TRANSCRIPT',
        filename: 'marcus-oliveira-transcript.pdf',
        metadata: { title: 'Transcript for Marcus Oliveira', description: 'Marcus Oliveira, class of 2021.' },
      });

      const { data, error } = await anon.rpc('get_public_anchor_by_fingerprint' as never, {
        p_fingerprint: fingerprint,
      } as never);
      expect(error).toBeNull();

      const body = data as unknown as Record<string, unknown>;
      expect(body.public_id).toBe(publicId);
      expect(JSON.stringify(body)).not.toContain('Marcus');
      expect(body.filename).toBe(contract.sql_academic_controlled_labels.TRANSCRIPT);
    });
  });
});
