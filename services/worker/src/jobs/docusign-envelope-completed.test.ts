import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const processNextJobMock = vi.hoisted(() => vi.fn());
const processDocusignEnvelopeCompletedJobMock = vi.hoisted(() => vi.fn());

// DS-03 (SCRUM-2363) connector-artifact enqueue guard. The job reads
// `config.enableConnectorArtifactEnqueue`; mock it as a mutable object so each
// test can toggle the flag. Default ON here so every pre-existing enqueue-path
// test exercises the same behavior as production-with-the-flag-on (the real
// config throws at import without the full env, so a mock is mandatory anyway).
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { enableConnectorArtifactEnqueue: true },
}));

vi.mock('../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock('../utils/jobQueue.js', () => ({
  processNextJob: processNextJobMock,
}));

vi.mock('../integrations/connectors/docusign.js', () => ({
  processDocusignEnvelopeCompletedJob: processDocusignEnvelopeCompletedJobMock,
}));

vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  makeDocusignEnvelopeJobDeps,
  runDocusignEnvelopeCompletedJobs,
  type DocusignEnvelopeJobRuntimeDeps,
} from './docusign-envelope-completed.js';
import { logger } from '../utils/logger.js';
import {
  claimDocusignAccountApiSlot,
  resetDocusignAccountRateLimitStoreForTests,
} from '../integrations/oauth/docusign-rate-limit.js';
import { fetchDocusignCombinedDocument } from '../integrations/oauth/docusign.js';

describe('runDocusignEnvelopeCompletedJobs', () => {
  beforeEach(() => {
    processNextJobMock.mockReset();
    processDocusignEnvelopeCompletedJobMock.mockReset();
    resetDocusignAccountRateLimitStoreForTests();
    // Default the DS-03 enqueue flag ON between tests so the existing enqueue-path
    // assertions reflect production-with-the-drain-flag-on. The dedicated guard
    // tests below flip it OFF explicitly. The materializer reads the flag from the
    // ENABLE_CONNECTOR_ARTIFACT_ENQUEUE env var (not config — avoids loadConfig at import).
    process.env.ENABLE_CONNECTOR_ARTIFACT_ENQUEUE = 'true';
  });

  it('claims docusign.envelope_completed jobs through the generic queue and invokes the DocuSign processor', async () => {
    const payload = {
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'int-1',
      account_id: 'acct-1',
      envelope_id: 'env-1',
      rule_event_id: 'evt-1',
      document_ids: ['combined'],
    };
    const jobDeps = {
      resolveConnection: vi.fn(),
      enqueueSignedDocument: vi.fn(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    };
    processNextJobMock
      .mockImplementationOnce(async (_type: string, handler: (job: { payload: unknown }) => Promise<void>) => {
        await handler({ payload });
        return { claimed: true, status: 'completed', jobId: 'job-1' };
      })
      .mockResolvedValueOnce({ claimed: false, status: 'idle' });
    processDocusignEnvelopeCompletedJobMock.mockResolvedValue({ queuedId: 'queue-1' });

    const result = await runDocusignEnvelopeCompletedJobs({ limit: 5, jobDeps });

    expect(processNextJobMock).toHaveBeenCalledWith(
      'docusign.envelope_completed',
      expect.any(Function),
    );
    expect(processDocusignEnvelopeCompletedJobMock).toHaveBeenCalledWith(payload, jobDeps);
    expect(result).toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
      dead: 0,
      updateFailed: 0,
      jobIds: ['job-1'],
    });
  });

  it('returns retry/dead counts from the generic queue result instead of swallowing failures', async () => {
    processNextJobMock
      .mockResolvedValueOnce({ claimed: true, status: 'failed', jobId: 'job-retry' })
      .mockResolvedValueOnce({ claimed: true, status: 'dead', jobId: 'job-dead' });

    const result = await runDocusignEnvelopeCompletedJobs({
      limit: 2,
      jobDeps: {
        resolveConnection: vi.fn(),
        enqueueSignedDocument: vi.fn(),
      },
    });

    expect(result).toEqual({
      claimed: 2,
      completed: 0,
      failed: 1,
      dead: 1,
      updateFailed: 0,
      jobIds: ['job-retry', 'job-dead'],
    });
  });

  it('clamps excessive limits and counts queue update failures distinctly', async () => {
    processNextJobMock.mockResolvedValue({ claimed: true, status: 'update_failed', jobId: 'job-update' });

    const result = await runDocusignEnvelopeCompletedJobs({
      limit: 250,
      jobDeps: {
        resolveConnection: vi.fn(),
        enqueueSignedDocument: vi.fn(),
      },
    });

    expect(processNextJobMock).toHaveBeenCalledTimes(100);
    expect(result).toEqual({
      claimed: 100,
      completed: 0,
      failed: 0,
      dead: 0,
      updateFailed: 100,
      jobIds: Array.from({ length: 100 }, () => 'job-update'),
    });
  });

  describe('enqueueSignedDocument — DS-03 server-side hash + durable connector artifact', () => {
    const SIGNED_BYTES = Buffer.from('signed bytes');
    const EXPECTED_SHA256 = createHash('sha256').update(SIGNED_BYTES).digest('hex');
    const ORG_ID = '11111111-1111-4111-8111-111111111111';
    const SINK_INPUT = {
      orgId: ORG_ID,
      integrationId: 'integration-1',
      accountId: 'account-1',
      envelopeId: 'envelope-1',
      ruleEventId: 'rule-event-1',
      documentBytes: SIGNED_BYTES,
      contentType: 'application/pdf' as string | null,
      sourceTimestamp: '2026-06-24T10:00:00.000Z' as string | null,
    };

    interface MakeDbOpts {
      artifactResult?: { data: string | null; error: unknown };
      auditResult?: { data: { id: string } | null; error: unknown };
      // F1 (security review, docusign-bilateral-2026-08): override the
      // connector_artifact read-back the outbound path now performs after
      // every enqueue, to detect a forged-inbound-row race. Defaults to a
      // clean, matching row (the SAME hash SINK_INPUT's bytes hash to, no
      // `_direction` marker) so every pre-existing test in this describe
      // block — none of which are about this detection path — sees "no
      // conflict" without needing to know it exists.
      provenanceResult?: {
        data: { fingerprint_sha256: string; metadata: Record<string, unknown> | null } | null;
        error: unknown;
      };
      // F1-heal (SCRUM-3818 go-live gate): override the atomic conditional
      // UPDATE (`... WHERE id = :id AND anchor_id IS NULL`) this call now
      // attempts when a provenance conflict is detected. Defaults to
      // "matched" (healed) — the common case. Set `data: null` to simulate
      // the declared row having already materialized a live anchor (or
      // having lost the supersede race) — the WHERE clause then matches zero
      // rows and the refusal branch fires instead.
      supersedeResult?: { data: { id: string } | null; error: unknown };
      // F1-heal: override the audit_events insert performed for EVERY
      // provenance-conflict outcome (healed or refused).
      provenanceAuditResult?: { data: { id: string } | null; error: unknown };
    }

    function makeDb(opts: MakeDbOpts = {}) {
      const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const state: {
        insertedDetails?: Record<string, unknown>;
        insertedRow?: Record<string, unknown>;
        insertCalled: boolean;
        supersedeCalled: boolean;
        supersedePayload?: Record<string, unknown>;
        provenanceAuditInsertCalled: boolean;
        provenanceAuditInsertedRow?: Record<string, unknown>;
        connectorArtifactFromCallCount: number;
      } = {
        insertCalled: false,
        supersedeCalled: false,
        provenanceAuditInsertCalled: false,
        connectorArtifactFromCallCount: 0,
      };
      const db = {
        rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          return Promise.resolve(opts.artifactResult ?? { data: 'artifact-1', error: null });
        }),
        from: vi.fn((table: string) => {
          if (table === 'connector_artifact') {
            state.connectorArtifactFromCallCount += 1;
            if (state.connectorArtifactFromCallCount === 1) {
              // FIRST call: the post-enqueue provenance read-back.
              const provenanceResult = opts.provenanceResult ?? {
                data: { fingerprint_sha256: EXPECTED_SHA256, metadata: null },
                error: null,
              };
              const provenanceQuery = {
                select: vi.fn(() => provenanceQuery),
                eq: vi.fn(() => provenanceQuery),
                is: vi.fn(() => provenanceQuery),
                maybeSingle: vi.fn().mockResolvedValue(provenanceResult),
                // Never called on this branch — present only so this
                // object's inferred shape is a superset of every
                // DbClient.from() overload return type, which a single
                // non-overloaded vi.fn() callback needs to satisfy
                // structurally.
                update: vi.fn(() => provenanceQuery),
                insert: vi.fn(),
              };
              return provenanceQuery;
            }
            // SECOND+ call: the F1-heal atomic conditional UPDATE, only ever
            // reached when a conflict was detected on the first call.
            const supersedeResult = opts.supersedeResult ?? { data: { id: 'artifact-1' }, error: null };
            const supersedeQuery = {
              update: vi.fn((value: Record<string, unknown>) => {
                state.supersedeCalled = true;
                state.supersedePayload = value;
                return supersedeQuery;
              }),
              eq: vi.fn(() => supersedeQuery),
              is: vi.fn(() => supersedeQuery),
              select: vi.fn(() => supersedeQuery),
              maybeSingle: vi.fn().mockResolvedValue(supersedeResult),
              insert: vi.fn(),
            };
            return supersedeQuery;
          }
          if (table === 'audit_events') {
            const query = {
              select: vi.fn(() => query),
              eq: vi.fn(() => query),
              is: vi.fn(() => query),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              insert: vi.fn((value: Record<string, unknown>) => {
                state.provenanceAuditInsertCalled = true;
                state.provenanceAuditInsertedRow = value;
                return {
                  select: vi.fn(() => ({
                    single: vi
                      .fn()
                      .mockResolvedValue(
                        opts.provenanceAuditResult ?? { data: { id: 'audit-event-1' }, error: null },
                      ),
                  })),
                };
              }),
            };
            return query;
          }
          expect(table).toBe('integration_events');
          const query = {
            select: vi.fn(() => query),
            eq: vi.fn(() => query),
            is: vi.fn(() => query),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            insert: vi.fn((value: Record<string, unknown>) => {
              state.insertCalled = true;
              state.insertedRow = value;
              state.insertedDetails = value.details as Record<string, unknown>;
              return {
                select: vi.fn(() => ({
                  single: vi
                    .fn()
                    .mockResolvedValue(opts.auditResult ?? { data: { id: 'event-1' }, error: null }),
                })),
              };
            }),
          };
          return query;
        }),
      };
      return { db, rpcCalls, state };
    }

    it('computes a server-side SHA-256 and enqueues a durable connector artifact via the 0343 RPC', async () => {
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe('enqueue_connector_artifact');
      expect(rpcCalls[0].args).toMatchObject({
        p_org_id: ORG_ID,
        p_source: 'docusign',
        p_external_ref: 'envelope-1',
        p_external_revision: null,
        p_fingerprint_sha256: EXPECTED_SHA256,
        p_byte_length: SIGNED_BYTES.byteLength,
        p_source_timestamp: '2026-06-24T10:00:00.000Z',
      });
      // Canonical lowercase 64-hex SHA-256 — matches the 0343 CHECK constraint
      // connector_artifact_fingerprint_format_check.
      expect(EXPECTED_SHA256).toMatch(/^[a-f0-9]{64}$/);
      // The durable artifact id is the queued id the Lane-2 batch loop consumes.
      expect(result).toEqual({ queuedId: 'artifact-1' });
    });

    it('returns the artifact id as the queued id (idempotent on redelivery via the RPC)', async () => {
      const { db } = makeDb({ artifactResult: { data: 'existing-artifact', error: null } });
      const deps = makeDocusignEnvelopeJobDeps({ db });

      const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

      expect(result).toEqual({ queuedId: 'existing-artifact' });
    });

    it('does not put the fingerprint or raw bytes into the integration_events audit details', async () => {
      const { db, state } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await deps.enqueueSignedDocument({ ...SINK_INPUT });

      expect(state.insertedDetails).toMatchObject({
        account_id: 'account-1',
        envelope_id: 'envelope-1',
        rule_event_id: 'rule-event-1',
        content_type: 'application/pdf',
        byte_length: 12,
        connector_artifact_id: 'artifact-1',
      });
      expect(state.insertedDetails).not.toHaveProperty('document_sha256');
      expect(state.insertedDetails).not.toHaveProperty('fingerprint');
      expect(state.insertedDetails).not.toHaveProperty('fingerprint_sha256');
      // Defensive: the raw signed bytes never appear anywhere in the audit row.
      expect(JSON.stringify(state.insertedDetails)).not.toContain('signed bytes');
    });

    // F1 (security review, docusign-bilateral-2026-08): the connector_artifact
    // race. Both this OUTBOUND path and the INBOUND declared-hash webhook path
    // (api/v1/webhooks/docusign.ts) write via enqueue_connector_artifact keyed
    // on (org_id, source, external_ref, revision) with ON CONFLICT DO NOTHING.
    // A forged inbound event for this SAME org's SAME envelope, with an
    // attacker-chosen fingerprint, can win the race and get returned here as
    // if it were this call's own successful write. These tests pin the
    // detection: never silently accept a returned artifact id without
    // verifying it is the row THIS call's real, measured fingerprint produced.
    describe('F1 — connector_artifact provenance conflict detection', () => {
      it('detects a pre-existing INBOUND-marked row for the same envelope and raises the distinct alert', async () => {
        const { db } = makeDb({
          artifactResult: { data: 'forged-inbound-artifact', error: null },
          provenanceResult: {
            data: {
              // Attacker-chosen hash — deliberately NOT EXPECTED_SHA256, the
              // hash this call's own real fetched bytes produce.
              fingerprint_sha256: 'f'.repeat(64),
              metadata: { _direction: 'inbound', _sending_account_id: 'acct-FOREIGN' },
            },
            error: null,
          },
        });
        const deps = makeDocusignEnvelopeJobDeps({ db });

        // F1-heal below now supersedes this row rather than throwing, so the
        // call succeeds — but the DETECTION signal still fires unconditionally.
        await deps.enqueueSignedDocument({ ...SINK_INPUT });

        // DISTINCT signal — a dedicated marker key, not a reuse of any
        // existing log line — and it never falls through to logger.info
        // (the flag-disabled breadcrumb) or a silent success.
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            docusign_connector_artifact_provenance_conflict: true,
            envelopeId: 'envelope-1',
            artifactId: 'forged-inbound-artifact',
            persistedDirection: 'inbound',
            fingerprintMismatch: true,
          }),
          expect.any(String),
        );
      });

      it('detects a fingerprint mismatch even without an explicit _direction marker (belt-and-suspenders — the hash comparison alone catches it), but does NOT auto-heal it (HIGH, code review 2026-09-01)', async () => {
        const { db, state } = makeDb({
          provenanceResult: {
            data: { fingerprint_sha256: 'e'.repeat(64), metadata: null },
            error: null,
          },
        });
        const deps = makeDocusignEnvelopeJobDeps({ db });

        // No _direction marker at all — still detected on the hash mismatch
        // alone (`fingerprintMismatch`), but `wonByInboundRow` is false, so
        // auto-heal is NOT licensed for this row: the CTO precedence rule
        // ("a MEASURED fingerprint supersedes a DECLARED one, never the
        // reverse") says nothing about two independently-MEASURED
        // fingerprints disagreeing — this could be two legitimate outbound
        // executions for the SAME envelope (a redelivered webhook, a job
        // retry, or DocuSign's combined-PDF embedding a fetch-time
        // timestamp), and auto-healing that shape would let the SECOND run
        // silently overwrite the FIRST run's equally-measured value and
        // mislabel it "forgery resolution". Stays in DETECT-AND-THROW
        // territory (the pre-#2520 behaviour) with its own honest reason.
        await expect(deps.enqueueSignedDocument({ ...SINK_INPUT })).rejects.toThrow(
          'docusign_connector_artifact_provenance_conflict_unresolved',
        );

        // The heal's atomic UPDATE is never even attempted for a non-declared
        // row — auto-heal is not licensed, so there is no race to lose.
        expect(state.supersedeCalled).toBe(false);
        expect(state.connectorArtifactFromCallCount).toBe(1);

        expect(state.provenanceAuditInsertCalled).toBe(true);
        const auditDetails = JSON.parse(state.provenanceAuditInsertedRow?.details as string) as Record<
          string,
          unknown
        >;
        expect(auditDetails.winner).toBe('unresolved_non_declared_mismatch');
        expect(auditDetails.reason).toBe('fingerprint_mismatch_non_declared_row_autoheal_not_licensed');

        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            docusign_connector_artifact_provenance_conflict_unresolved: true,
            envelopeId: 'envelope-1',
          }),
          expect.any(String),
        );

        // Refused before the normal success breadcrumb — no partial state.
        expect(state.insertCalled).toBe(false);
      });

      it('does NOT raise a conflict when the persisted row matches this call\'s own real, measured fingerprint (legitimate idempotent redelivery) — no supersession attempted', async () => {
        // logger.error is a module-level mock shared (and not reset) across
        // this whole test file — clear it locally so this test's negative
        // assertion below reads only what THIS test's own call produced, not
        // accumulated calls from the two provenance-conflict tests above.
        vi.mocked(logger.error).mockClear();
        // Same fingerprint, no _direction marker — this IS this call's own
        // prior write (or an identical concurrent outbound retry), not a
        // forged race. Must proceed to the normal success path.
        const { db, state } = makeDb({
          provenanceResult: {
            data: { fingerprint_sha256: EXPECTED_SHA256, metadata: { queue_scope: 'org' } },
            error: null,
          },
        });
        const deps = makeDocusignEnvelopeJobDeps({ db });

        const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

        expect(result).toEqual({ queuedId: 'artifact-1' });
        expect(state.insertCalled).toBe(true); // audit breadcrumb still written
        expect(logger.error).not.toHaveBeenCalledWith(
          expect.objectContaining({ docusign_connector_artifact_provenance_conflict: true }),
          expect.any(String),
        );
        // No conflict at all => the F1-heal supersede UPDATE is never
        // attempted, and no provenance audit_events row is written — there
        // is nothing to heal or audit when this call's own write already won.
        expect(state.supersedeCalled).toBe(false);
        expect(state.provenanceAuditInsertCalled).toBe(false);
        expect(state.connectorArtifactFromCallCount).toBe(1);
      });

      it('fails closed when the provenance read-back itself errors (never treats an unverifiable id as success)', async () => {
        const { db, state } = makeDb({
          provenanceResult: { data: null, error: { message: 'db unavailable' } },
        });
        const deps = makeDocusignEnvelopeJobDeps({ db });

        await expect(deps.enqueueSignedDocument({ ...SINK_INPUT })).rejects.toThrow(
          'docusign_connector_artifact_readback_failed',
        );
        expect(state.insertCalled).toBe(false); // no audit breadcrumb for an unverified write
        expect(state.supersedeCalled).toBe(false); // never even attempts a heal on an unverified read
      });
    });

    // F1-heal (SCRUM-3818 go-live gate; CTO precedence ruling: a fingerprint
    // Arkova MEASURED from fetched document bytes ALWAYS supersedes one
    // merely DECLARED by a notification, never the reverse). PR #2476 shipped
    // detection only; these tests pin the auto-heal follow-up.
    describe('F1-heal — auto-heal supersedes a declared/forged fingerprint with the verified one', () => {
      const FORGED_HASH = 'f'.repeat(64);

      it('forged-inbound-then-real-outbound: the verified hash WINS, the declared markers are stripped, and the supersession is audited', async () => {
        const { db, state } = makeDb({
          artifactResult: { data: 'forged-inbound-artifact', error: null },
          provenanceResult: {
            data: {
              fingerprint_sha256: FORGED_HASH,
              metadata: { _direction: 'inbound', _sending_account_id: 'acct-FOREIGN', queue_scope: 'org' },
            },
            error: null,
          },
        });
        const deps = makeDocusignEnvelopeJobDeps({ db });

        const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

        // The job succeeds — the verified fingerprint now durably stands.
        expect(result).toEqual({ queuedId: 'forged-inbound-artifact' });

        // The atomic conditional UPDATE carried the verified fingerprint,
        // stripped the declared-inbound classification markers, and recorded
        // supersession provenance — but preserved unrelated metadata
        // (`queue_scope`) untouched.
        expect(state.supersedeCalled).toBe(true);
        expect(state.supersedePayload).toMatchObject({
          fingerprint_sha256: EXPECTED_SHA256,
        });
        const healedMetadata = state.supersedePayload?.metadata as Record<string, unknown>;
        expect(healedMetadata).not.toHaveProperty('_direction');
        expect(healedMetadata).not.toHaveProperty('_sending_account_id');
        expect(healedMetadata.queue_scope).toBe('org');
        expect(healedMetadata._superseded_declared_fingerprint).toBe(FORGED_HASH);
        expect(healedMetadata._superseded_reason).toBe(
          'declared_inbound_row_superseded_by_verified_outbound_fetch',
        );
        expect(typeof healedMetadata._superseded_at).toBe('string');

        // Audited: org, envelope, both fingerprints, which won, why.
        expect(state.provenanceAuditInsertCalled).toBe(true);
        expect(state.provenanceAuditInsertedRow).toMatchObject({
          event_type: 'docusign_connector_artifact_provenance_superseded',
          event_category: 'ANCHOR',
          target_type: 'connector_artifact',
          target_id: 'forged-inbound-artifact',
          org_id: ORG_ID,
        });
        const auditDetails = JSON.parse(state.provenanceAuditInsertedRow?.details as string) as Record<
          string,
          unknown
        >;
        expect(auditDetails).toMatchObject({
          envelope_id: 'envelope-1',
          integration_id: 'integration-1',
          verified_fingerprint_sha256: EXPECTED_SHA256,
          declared_fingerprint_sha256: FORGED_HASH,
          winner: 'verified_document_bytes',
        });

        // Loud, distinct heal signal.
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            docusign_connector_artifact_provenance_superseded: true,
            artifactId: 'forged-inbound-artifact',
          }),
          expect.any(String),
        );

        // Fell through to the normal audit breadcrumb — this call's write
        // now durably stands, exactly as if the RPC's own INSERT had won.
        expect(state.insertCalled).toBe(true);
      });

      it('already-materialized declared row: does NOT silently rewrite a live anchor — refuses, logs loud, and audits the unresolved conflict', async () => {
        const { db, state } = makeDb({
          artifactResult: { data: 'materialized-artifact', error: null },
          provenanceResult: {
            data: {
              fingerprint_sha256: FORGED_HASH,
              metadata: { _direction: 'inbound', _sending_account_id: 'acct-FOREIGN' },
            },
            error: null,
          },
          // The atomic UPDATE's WHERE anchor_id IS NULL matches ZERO rows —
          // the drain already materialized a live anchor from this row
          // between the read-back and this call's supersede attempt (or
          // beforehand). This is the authoritative, race-free "already
          // materialized" signal — never a separate read of anchor_id.
          supersedeResult: { data: null, error: null },
        });
        const deps = makeDocusignEnvelopeJobDeps({ db });

        await expect(deps.enqueueSignedDocument({ ...SINK_INPUT })).rejects.toThrow(
          'docusign_connector_artifact_provenance_conflict_unresolved',
        );

        // The UPDATE was attempted (that's how we learned it was refused) but
        // did not durably change anything a caller can observe on the row —
        // the mock's zero-row-match already models "nothing was rewritten".
        expect(state.supersedeCalled).toBe(true);

        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            docusign_connector_artifact_provenance_conflict_unresolved: true,
            artifactId: 'materialized-artifact',
          }),
          expect.any(String),
        );

        expect(state.provenanceAuditInsertCalled).toBe(true);
        expect(state.provenanceAuditInsertedRow).toMatchObject({
          event_type: 'docusign_connector_artifact_provenance_conflict_unresolved',
          event_category: 'ANCHOR',
          target_id: 'materialized-artifact',
          org_id: ORG_ID,
        });
        const auditDetails = JSON.parse(state.provenanceAuditInsertedRow?.details as string) as Record<
          string,
          unknown
        >;
        expect(auditDetails.winner).toBe('unresolved_declared_row');

        // Refused before the normal success breadcrumb — no partial state.
        expect(state.insertCalled).toBe(false);
      });

      it('a failed provenance audit_events insert does not block a successful heal (awaited-but-non-fatal, mirrors the audit_events convention elsewhere)', async () => {
        const { db, state } = makeDb({
          artifactResult: { data: 'forged-inbound-artifact', error: null },
          provenanceResult: {
            data: { fingerprint_sha256: FORGED_HASH, metadata: { _direction: 'inbound' } },
            error: null,
          },
          provenanceAuditResult: { data: null, error: { message: 'audit_events insert failed' } },
        });
        const deps = makeDocusignEnvelopeJobDeps({ db });

        const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

        expect(result).toEqual({ queuedId: 'forged-inbound-artifact' });
        expect(state.supersedeCalled).toBe(true);
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ integrationId: 'integration-1', artifactId: 'forged-inbound-artifact', healed: true }),
          'DocuSign connector-artifact provenance audit_events insert failed — audit trail incomplete',
        );
      });
    });

    it('fails closed when the connector-artifact enqueue errors (throws, no audit write)', async () => {
      const { db, state } = makeDb({ artifactResult: { data: null, error: { code: '23514' } } });
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await expect(deps.enqueueSignedDocument({ ...SINK_INPUT })).rejects.toThrow(
        'docusign_connector_artifact_enqueue_failed',
      );
      // No partial state: the audit breadcrumb is never written when the durable
      // artifact failed.
      expect(state.insertCalled).toBe(false);
    });

    it('fails closed when the RPC returns no artifact id', async () => {
      const { db } = makeDb({ artifactResult: { data: null, error: null } });
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await expect(deps.enqueueSignedDocument({ ...SINK_INPUT })).rejects.toThrow(
        'docusign_connector_artifact_enqueue_failed',
      );
    });

    // DS-03 (SCRUM-2363) — feature-flag guard. The connector_artifact drain
    // (QUEUE-06/SCRUM-2352, QUEUE-08/SCRUM-2354) is unbuilt, so DS-03 ships
    // DORMANT behind ENABLE_CONNECTOR_ARTIFACT_ENQUEUE (default off in prod):
    // no rows are enqueued until something drains them.
    it('skips the enqueue gracefully when ENABLE_CONNECTOR_ARTIFACT_ENQUEUE is off (no RPC, no throw, no audit write)', async () => {
      process.env.ENABLE_CONNECTOR_ARTIFACT_ENQUEUE = 'false';
      const { db, rpcCalls, state } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      // Must NOT throw — a dormant connector path is a graceful no-op, not a failure.
      const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

      // No connector_artifact row: the idempotent enqueue RPC is never called.
      expect(rpcCalls).toHaveLength(0);
      expect(db.rpc).not.toHaveBeenCalled();
      // No partial state: the integration_events audit breadcrumb is not written
      // either (nothing was enqueued to reference).
      expect(state.insertCalled).toBe(false);
      // A structured breadcrumb records the disabled path — and it carries NO
      // fingerprint and NO raw bytes (§1.6A).
      expect(logger.info).toHaveBeenCalledWith(
        { integrationId: 'integration-1' },
        expect.stringContaining('ENABLE_CONNECTOR_ARTIFACT_ENQUEUE'),
      );
      const loggedBreadcrumbs = (logger.info as unknown as { mock: { calls: unknown[][] } }).mock
        .calls;
      const serialized = JSON.stringify(loggedBreadcrumbs);
      expect(serialized).not.toContain(EXPECTED_SHA256);
      expect(serialized).not.toContain('fingerprint');
      expect(serialized).not.toContain('signed bytes');
      // The skip result is a clearly non-id sentinel, never a real artifact id.
      expect(result.queuedId).not.toBe('artifact-1');
      expect(result.queuedId).toContain('disabled');
    });

    it('enqueues exactly as today when ENABLE_CONNECTOR_ARTIFACT_ENQUEUE is on', async () => {
      process.env.ENABLE_CONNECTOR_ARTIFACT_ENQUEUE = 'true';
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

      // Unchanged behavior: one idempotent enqueue RPC with the server-side digest.
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe('enqueue_connector_artifact');
      expect(rpcCalls[0].args).toMatchObject({
        p_org_id: ORG_ID,
        p_source: 'docusign',
        p_external_ref: 'envelope-1',
        p_fingerprint_sha256: EXPECTED_SHA256,
        p_byte_length: SIGNED_BYTES.byteLength,
      });
      expect(result).toEqual({ queuedId: 'artifact-1' });
    });

    // DS-04 (SCRUM-2364): an org-scoped envelope carries NO owner_user_id in the
    // artifact metadata — routing to the org queue is the absence of an owner.
    it('omits owner_user_id from artifact metadata for an org-scoped envelope (DS-04)', async () => {
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await deps.enqueueSignedDocument({ ...SINK_INPUT, scope: 'org', ownerUserId: null });

      const metadata = rpcCalls[0].args.p_metadata as Record<string, unknown>;
      expect(metadata).toMatchObject({ queue_scope: 'org' });
      expect(metadata).not.toHaveProperty('owner_user_id');
    });

    // DS-04 (SCRUM-2364): a member-owned envelope routes to the PERSONAL queue —
    // materialization is scoped to the owning user via owner_user_id in metadata.
    it('stamps owner_user_id + member scope into artifact metadata for a member envelope (DS-04)', async () => {
      const MEMBER_USER = '55555555-5555-4555-8555-555555555555';
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      const result = await deps.enqueueSignedDocument({
        ...SINK_INPUT,
        scope: 'member',
        ownerUserId: MEMBER_USER,
      });

      expect(rpcCalls).toHaveLength(1);
      const metadata = rpcCalls[0].args.p_metadata as Record<string, unknown>;
      expect(metadata).toMatchObject({
        queue_scope: 'member',
        owner_user_id: MEMBER_USER,
        envelope_id: 'envelope-1',
      });
      expect(result).toEqual({ queuedId: 'artifact-1' });
    });

    // DS-04: member routing must be self-consistent — a 'member' scope with no
    // owning user is a programming error and must fail closed, never silently
    // materialize an unowned personal-queue artifact.
    it('fails closed when a member-scoped envelope has no owner_user_id (DS-04)', async () => {
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await expect(
        deps.enqueueSignedDocument({ ...SINK_INPUT, scope: 'member', ownerUserId: null }),
      ).rejects.toThrow('docusign_member_scope_missing_owner');
      expect(rpcCalls).toHaveLength(0);
    });

    // FK bug (SCRUM-2364/2365): integration_events.integration_id has a FK to
    // org_integrations(id) ONLY. A member envelope carries a member_integrations
    // id, so writing it into integration_id violates the FK at runtime. The audit
    // row must set integration_id = null for a member envelope and carry the member
    // integration id inside details instead.
    it('writes a member audit row with integration_id null + member id in details (FK-safe)', async () => {
      const MEMBER_USER = '77777777-7777-4777-8777-777777777777';
      const { db, state } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await deps.enqueueSignedDocument({
        ...SINK_INPUT,
        scope: 'member',
        ownerUserId: MEMBER_USER,
      });

      // The FK column must NOT carry the member_integrations id.
      expect(state.insertedRow).toMatchObject({ integration_id: null });
      // The member integration id is preserved in the ids-only details JSON.
      expect(state.insertedDetails).toMatchObject({
        member_integration_id: 'integration-1',
        envelope_id: 'envelope-1',
      });
    });

    // An org envelope carries an org_integrations id, which satisfies the FK, so it
    // must still be written into integration_id (regression guard for the fix).
    it('keeps integration_id set for an org-scoped envelope (FK satisfied)', async () => {
      const { db, state } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await deps.enqueueSignedDocument({ ...SINK_INPUT, scope: 'org', ownerUserId: null });

      expect(state.insertedRow).toMatchObject({ integration_id: 'integration-1' });
      expect(state.insertedDetails).not.toHaveProperty('member_integration_id');
    });
  });

  it('resolves member_integrations when no org_integrations row matches', async () => {
    const queriedTables: string[] = [];
    const memberRow = {
      id: 'member-int-1',
      org_id: '11111111-1111-4111-8111-111111111111',
      account_id: 'account-1',
      base_uri: 'https://demo.docusign.net',
      token_secret_name: 'secret/member-int-1',
      // DS-04: member_integrations carries the owning user; the resolver maps it
      // to owner_user_id ⇒ member scope ⇒ personal-queue materialization.
      user_id: '66666666-6666-4666-8666-666666666666',
    };
    const db = {
      from: vi.fn((table: string) => {
        queriedTables.push(table);
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          is: vi.fn(() => query),
          maybeSingle: vi.fn().mockResolvedValue({
            data: table === 'member_integrations' ? memberRow : null,
            error: null,
          }),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
        return query;
      }),
    };
    const refreshTokenStore = {
      get: vi.fn().mockResolvedValue('refresh-token-1'),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'access-token-1',
        refresh_token: 'refresh-token-2',
        token_type: 'Bearer',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const deps = makeDocusignEnvelopeJobDeps({
      db,
      refreshTokenStore,
      fetchImpl,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'integration-key',
        DOCUSIGN_CLIENT_SECRET: 'client-secret',
        DOCUSIGN_AUTH_BASE: 'https://account-d.docusign.com',
      },
    });

    const connection = await deps.resolveConnection({
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'member-int-1',
      account_id: 'account-1',
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    });

    expect(queriedTables).toEqual(['org_integrations', 'member_integrations']);
    expect(connection).toEqual({
      accessToken: 'access-token-1',
      baseUri: 'https://demo.docusign.net',
      // DS-04: the member connection surfaces its personal-queue routing to the
      // materializer — scope 'member' + the owning user id.
      scope: 'member',
      ownerUserId: '66666666-6666-4666-8666-666666666666',
    });
    expect(refreshTokenStore.get).toHaveBeenCalledWith({ name: 'secret/member-int-1' });
    expect(refreshTokenStore.put).toHaveBeenCalledWith({
      name: 'secret/member-int-1',
      value: 'refresh-token-2',
    });
  });

  it('throws when member_integrations lookup fails after no org_integrations row matches', async () => {
    const queriedTables: string[] = [];
    const memberLookupError = new Error('lookup failed');
    const db = {
      from: vi.fn((table: string) => {
        queriedTables.push(table);
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          is: vi.fn(() => query),
          maybeSingle: vi.fn().mockResolvedValue({
            data: null,
            error: table === 'member_integrations' ? memberLookupError : null,
          }),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
        return query;
      }),
    };
    const refreshTokenStore = {
      get: vi.fn().mockResolvedValue('refresh-token-1'),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const deps = makeDocusignEnvelopeJobDeps({ db, refreshTokenStore });

    await expect(deps.resolveConnection({
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'member-int-1',
      account_id: 'account-1',
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    })).rejects.toThrow('docusign_integration_lookup_failed');

    expect(queriedTables).toEqual(['org_integrations', 'member_integrations']);
    expect(logger.error).toHaveBeenCalledWith(
      { error: memberLookupError, integrationId: 'member-int-1' },
      'DocuSign job member integration lookup failed',
    );
    expect(refreshTokenStore.get).not.toHaveBeenCalled();
    expect(refreshTokenStore.put).not.toHaveBeenCalled();
  });

  it('filters inherited parent connection lookup by the requested DocuSign account', async () => {
    const parentOrgId = '11111111-1111-4111-8111-111111111111';
    const subOrgId = '22222222-2222-4222-8222-222222222222';
    const accountId = 'acct-parent-a';
    const parentRow = {
      id: 'parent-int-a',
      org_id: parentOrgId,
      account_id: accountId,
      base_uri: 'https://na1.docusign.net',
      token_secret_name: 'projects/test/secrets/parent-a-refresh',
      inherited_from_org_id: null,
    };
    const lookups: Array<{ table: string; filters: Record<string, unknown> }> = [];
    const db = {
      from: vi.fn((table: string) => {
        const filters: Record<string, unknown> = {};
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn((field: string, value: unknown) => {
            filters[field] = value;
            return query;
          }),
          is: vi.fn((field: string, value: unknown) => {
            filters[field] = value;
            return query;
          }),
          maybeSingle: vi.fn().mockImplementation(async () => {
            lookups.push({ table, filters: { ...filters } });
            if (table === 'org_integrations' && filters.org_id === subOrgId && filters.account_id === null) {
              return {
                data: {
                  id: 'marker-int',
                  org_id: subOrgId,
                  account_id: null,
                  base_uri: null,
                  token_secret_name: null,
                  inherited_from_org_id: parentOrgId,
                },
                error: null,
              };
            }
            if (table === 'org_integrations' && filters.org_id === parentOrgId && filters.account_id === accountId) {
              return { data: parentRow, error: null };
            }
            if (table === 'org_integrations' && filters.org_id === parentOrgId && filters.account_id === undefined) {
              return { data: null, error: new Error('multiple rows returned') };
            }
            if (table === 'organizations') {
              return { data: { parent_org_id: parentOrgId }, error: null };
            }
            return { data: null, error: null };
          }),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
        return query;
      }),
    };
    const refreshTokenStore = {
      get: vi.fn().mockResolvedValue('refresh-token-1'),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'access-token-1',
        token_type: 'Bearer',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const deps = makeDocusignEnvelopeJobDeps({
      db: db as unknown as DocusignEnvelopeJobRuntimeDeps['db'],
      refreshTokenStore,
      fetchImpl,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'integration-key',
        DOCUSIGN_CLIENT_SECRET: 'client-secret',
        DOCUSIGN_AUTH_BASE: 'https://account-d.docusign.com',
      },
    });

    const connection = await deps.resolveConnection({
      org_id: subOrgId,
      integration_id: 'marker-int',
      account_id: accountId,
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    });

    expect(connection).toEqual({
      accessToken: 'access-token-1',
      baseUri: 'https://na1.docusign.net',
      // DS-04: inherited connections are org policy — org scope, no owner user.
      scope: 'org',
      ownerUserId: null,
    });
    const parentLookup = lookups.find(
      (lookup) => lookup.table === 'org_integrations' && lookup.filters.org_id === parentOrgId,
    );
    expect(parentLookup?.filters.account_id).toBe(accountId);
    expect(refreshTokenStore.get).toHaveBeenCalledWith({
      name: 'projects/test/secrets/parent-a-refresh',
    });
  });

  it('blocks token refresh when the DocuSign account hourly API budget is exhausted', async () => {
    let nowMs = Date.UTC(2026, 4, 28, 12, 0, 0);
    const makeIntegrationQuery = () => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        is: vi.fn(() => query),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: 'integration-1',
            org_id: '11111111-1111-4111-8111-111111111111',
            account_id: 'account-1',
            base_uri: 'https://demo.docusign.net',
            token_secret_name: 'projects/test/secrets/docusign-refresh',
          },
          error: null,
        }),
      };
      return query;
    };
    const db = {
      from: vi.fn((table: string) => {
        expect(table).toBe('org_integrations');
        return makeIntegrationQuery();
      }),
    };
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }),
    );
    const deps = makeDocusignEnvelopeJobDeps({
      db: db as unknown as DocusignEnvelopeJobRuntimeDeps['db'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'ik',
        DOCUSIGN_CLIENT_SECRET: 'secret',
      },
      refreshTokenStore: {
        get: vi.fn().mockResolvedValue('rt'),
        put: vi.fn(),
        delete: vi.fn(),
      },
      now: () => new Date(nowMs),
    });
    const payload = {
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'integration-1',
      account_id: 'account-1',
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    };
    for (let i = 0; i < 2_999; i++) {
      claimDocusignAccountApiSlot({
        accountId: 'account-1',
        now: () => new Date(nowMs),
      });
    }

    await expect(deps.resolveConnection(payload)).resolves.toMatchObject({
      accessToken: 'at',
      baseUri: 'https://demo.docusign.net',
    });
    await expect(deps.resolveConnection(payload)).rejects.toThrow(/rate limit/i);

    nowMs += 60 * 60 * 1000;
    await expect(deps.resolveConnection(payload)).resolves.toMatchObject({
      accessToken: 'at',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('counts completed-envelope document fetches against the same DocuSign account budget', async () => {
    const nowMs = Date.UTC(2026, 4, 28, 12, 0, 0);
    const makeIntegrationQuery = () => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        is: vi.fn(() => query),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: 'integration-1',
            org_id: '11111111-1111-4111-8111-111111111111',
            account_id: 'account-1',
            base_uri: 'https://demo.docusign.net',
            token_secret_name: 'projects/test/secrets/docusign-refresh',
          },
          error: null,
        }),
      };
      return query;
    };
    const db = {
      from: vi.fn((table: string) => {
        expect(table).toBe('org_integrations');
        return makeIntegrationQuery();
      }),
    };
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
      }
      if (url.includes('/accounts/account-1/envelopes/envelope-1/documents/combined')) {
        return new Response(new Uint8Array([37, 80, 68, 70]), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });
    const deps = makeDocusignEnvelopeJobDeps({
      db: db as unknown as DocusignEnvelopeJobRuntimeDeps['db'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'ik',
        DOCUSIGN_CLIENT_SECRET: 'secret',
      },
      refreshTokenStore: {
        get: vi.fn().mockResolvedValue('rt'),
        put: vi.fn(),
        delete: vi.fn(),
      },
      now: () => new Date(nowMs),
    });
    const payload = {
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'integration-1',
      account_id: 'account-1',
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    };
    for (let i = 0; i < 2_998; i++) {
      claimDocusignAccountApiSlot({
        accountId: 'account-1',
        now: () => new Date(nowMs),
      });
    }

    const connection = await deps.resolveConnection(payload);
    const document = await fetchDocusignCombinedDocument({
      baseUri: connection.baseUri,
      accountId: payload.account_id,
      envelopeId: payload.envelope_id,
      accessToken: connection.accessToken,
      deps,
    });

    expect(document.bytes).toEqual(Buffer.from('%PDF'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(deps.resolveConnection(payload)).rejects.toThrow(/rate limit/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
