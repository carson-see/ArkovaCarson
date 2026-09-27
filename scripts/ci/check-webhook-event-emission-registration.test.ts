import { describe, expect, it } from 'vitest';
import {
  KNOWN_NON_SUBSCRIBABLE_EMISSIONS,
  KNOWN_TYPE_NARROWED_DISPATCH_ARGS,
  extractDispatchArguments,
  extractDirectInsertLiterals,
  extractFileEmissions,
  collectEmissionViolations,
  readCanonicalEventTypes,
  readStringLiteralUnion,
  scanWorkerEmissions,
  checkWebhookEventEmissionRegistration,
  type CanonicalReading,
  type EmissionScanResult,
} from './check-webhook-event-emission-registration.js';

describe('extractDispatchArguments', () => {
  it('extracts a literal second argument to dispatchWebhookEvent', () => {
    const source = `
      await dispatchWebhookEvent(anchor.org_id, 'anchor.secured', anchor.public_id, {
        public_id: anchor.public_id,
      });
    `;
    const result = extractDispatchArguments(source);
    expect(result.eventTypes).toEqual(['anchor.secured']);
    expect(result.unresolved).toEqual([]);
  });

  it('extracts a literal across a multi-line call', () => {
    const source = `
      await db.dispatchWebhookEvent(
        anchor.org_id,
        'credential.status_changed',
        credEventId,
        credData,
      );
    `;
    expect(extractDispatchArguments(source).eventTypes).toEqual(['credential.status_changed']);
  });

  it('dedupes repeated literals across multiple call sites', () => {
    const source = `
      await dispatchWebhookEvent(a, 'job.completed', b, c);
      await dispatchWebhookEvent(a, 'job.completed', d, e);
    `;
    expect(extractDispatchArguments(source).eventTypes).toEqual(['job.completed']);
  });

  it('strips comments before extracting, so a mention in prose does not count', () => {
    const source = `
      // dispatchWebhookEvent(orgId, 'anchor.secured', ...) is the pattern
      doSomethingElse();
    `;
    const result = extractDispatchArguments(source);
    expect(result.eventTypes).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  describe('P2 review follow-up: a variable second argument with no TypeScript constraint', () => {
    it('THE REPORTED BUG — resolves a same-file const-assigned variable to its literal, rather than silently emitting nothing', () => {
      const source = `
        function emit(orgId, id, payload) {
          const eventType = 'new.unregistered';
          dispatchWebhookEvent(orgId, eventType, id, payload);
        }
      `;
      const result = extractDispatchArguments(source);
      expect(result.eventTypes).toEqual(['new.unregistered']);
      expect(result.unresolved).toEqual([]);
    });

    it('resolves regardless of extra whitespace or newlines around the assignment', () => {
      const source = `
        function emit(orgId, id, payload) {
          const eventType


            = 'new.unregistered' ;
          dispatchWebhookEvent(orgId, eventType, id, payload);
        }
      `;
      expect(extractDispatchArguments(source).eventTypes).toEqual(['new.unregistered']);
    });

    it('resolves a let re-assigned in a later branch (the attestationExpiry.ts shape)', () => {
      const source = `
        function emit(orgId, id, payload) {
          let eventType = null;
          if (cond) {
            eventType = 'attestation.expiring';
          } else {
            eventType = 'attestation.expired';
          }
          dispatchWebhookEvent(orgId, eventType, id, payload);
        }
      `;
      expect(extractDispatchArguments(source).eventTypes.sort()).toEqual(
        ['attestation.expired', 'attestation.expiring'].sort(),
      );
    });

    it('does not confuse a comparison (==, ===) with an assignment', () => {
      const source = `
        function emit(orgId, id, payload) {
          const eventType = pickType();
          if (eventType === 'anchor.secured') {
            logger.debug('ok');
          }
          dispatchWebhookEvent(orgId, eventType, id, payload);
        }
      `;
      const result = extractDispatchArguments(source, 'some/unlisted/file.ts');
      expect(result.eventTypes).toEqual([]);
      expect(result.unresolved).toEqual([
        "some/unlisted/file.ts: dispatchWebhookEvent(...) second argument `eventType` is a variable with no " +
          'same-file literal assignment and is not in KNOWN_TYPE_NARROWED_DISPATCH_ARGS',
      ]);
    });

    it('fails closed (unresolved) for a variable with no resolvable assignment and no allowlist entry', () => {
      const source = `
        async function emitSubOrgEvent({ eventType, orgId, id, payload }) {
          await dispatchWebhookEvent(orgId, eventType, id, payload);
        }
      `;
      const result = extractDispatchArguments(source, 'some/unlisted/file.ts');
      expect(result.eventTypes).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]).toContain('eventType');
      expect(result.unresolved[0]).toContain('KNOWN_TYPE_NARROWED_DISPATCH_ARGS');
    });

    it('contributes nothing (and no unresolved failure) for a call on the verified narrowed-type allowlist', () => {
      const source = `
        async function emitFolderEvent(eventType, orgId, payload) {
          await dispatchWebhookEvent(orgId, eventType, crypto.randomUUID(), payload);
        }
      `;
      const result = extractDispatchArguments(source, 'services/worker/src/api/v1/folders-deps.ts');
      expect(result.eventTypes).toEqual([]);
      expect(result.unresolved).toEqual([]);
    });

    it('fails closed for a non-identifier, non-literal second argument (e.g. a ternary or member access)', () => {
      const source = `
        dispatchWebhookEvent(orgId, cond ? 'a.b' : 'c.d', id, payload);
      `;
      const result = extractDispatchArguments(source, 'some/unlisted/file.ts');
      expect(result.eventTypes).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]).toContain('not a literal or a plain identifier');
    });
  });

  describe('does not mistake a declaration for a call', () => {
    it('ignores an interface method signature named dispatchWebhookEvent (services/worker/src/jobs/anchorExpirySweep.ts shape)', () => {
      const source = `
        export interface AnchorExpirySweepDb {
          dispatchWebhookEvent(
            orgId: string,
            eventType: string,
            eventId: string,
            data: Record<string, unknown>,
          ): Promise<unknown>;
        }
      `;
      const result = extractDispatchArguments(source, 'some/unlisted/file.ts');
      expect(result.eventTypes).toEqual([]);
      expect(result.unresolved).toEqual([]);
    });

    it('ignores the dispatchWebhookEvent function declaration itself (services/worker/src/webhooks/delivery.ts shape)', () => {
      const source = `
        export async function dispatchWebhookEvent(
          orgId: string,
          eventType: string,
          eventId: string,
          data: Record<string, unknown>
        ): Promise<WebhookDispatchResult> {
          return dispatchOk();
        }
      `;
      const result = extractDispatchArguments(source, 'some/unlisted/file.ts');
      expect(result.eventTypes).toEqual([]);
      expect(result.unresolved).toEqual([]);
    });

    it('still catches a real call that happens to follow a declaration in the same file', () => {
      const source = `
        export interface Db {
          dispatchWebhookEvent(orgId: string, eventType: string, eventId: string, data: Record<string, unknown>): Promise<unknown>;
        }
        function useIt(db: Db) {
          db.dispatchWebhookEvent(org, 'anchor.secured', id, payload);
        }
      `;
      const result = extractDispatchArguments(source, 'some/unlisted/file.ts');
      expect(result.eventTypes).toEqual(['anchor.secured']);
      expect(result.unresolved).toEqual([]);
    });
  });

  describe('P2 review follow-up: syntax-aware argument boundaries (no more 400-char window)', () => {
    it('does not pick up an event-looking literal from the PAYLOAD argument', () => {
      const source = `
        function emit(orgId, eventId, payload) {
          dispatchWebhookEvent(orgId, eventId, {
            note: 'looks.like_an_event_id_but_is_payload_text',
          });
        }
      `;
      // Here the SECOND argument is actually \`eventId\` (a variable), and the
      // payload-looking literal is the THIRD argument — must not be picked up
      // as if it were the event type.
      const result = extractDispatchArguments(source, 'some/unlisted/file.ts');
      expect(result.eventTypes).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]).toContain('eventId');
    });

    it('does not pick up a literal from an unrelated call that merely follows within the old 400-char window', () => {
      const source = `
        dispatchWebhookEvent(orgId, eventType, id, payload);
        // a long run of unrelated code so a naive window-based scan would have
        // reached into the next statement below
        ${'x'.repeat(200)}
        someOtherFunctionEntirely('not.an_event_type', more, args);
      `;
      const result = extractDispatchArguments(source, 'some/unlisted/file.ts');
      // eventType is unresolved (no same-file assignment, not allowlisted) —
      // the key assertion is that 'not.an_event_type' from the unrelated call
      // below is NEVER attributed to the dispatchWebhookEvent call.
      expect(result.eventTypes).toEqual([]);
    });

    it('correctly attributes each of two adjacent calls to its own literal, not the other one', () => {
      const source = `
        dispatchWebhookEvent(a, 'anchor.secured', b, c);
        dispatchWebhookEvent(d, 'anchor.revoked', e, f);
      `;
      expect(extractDispatchArguments(source).eventTypes.sort()).toEqual(
        ['anchor.revoked', 'anchor.secured'].sort(),
      );
    });

    it('handles a multi-line call whose payload argument itself contains nested parens/braces without losing the boundary', () => {
      const source = `
        await dispatchWebhookEvent(
          anchor.org_id,
          'credential.status_changed',
          anchor.public_id,
          {
            status: computeStatus(a, b, { nested: true }),
            list: [1, 2, 3],
          },
        );
        dispatchWebhookEvent(other.org_id, 'anchor.superseded', other.public_id, {});
      `;
      expect(extractDispatchArguments(source).eventTypes.sort()).toEqual(
        ['anchor.superseded', 'credential.status_changed'].sort(),
      );
    });
  });
});

describe('extractDirectInsertLiterals', () => {
  it('reproduces the attestationExpiry.ts bug pattern: literal assigned to a variable, used as event_type, inserted into a nonexistent queue table', () => {
    // This is the SHAPE of the actual pre-fix jobs/attestationExpiry.ts bug:
    // a literal is assigned to a local variable several lines before the
    // object using it as `event_type` is built, and that object is inserted
    // into `webhook_events` much later still. Neither a per-call window nor a
    // pure-literal scan catches this — only file-scoped identifier resolution
    // does, which is why this extractor is file-scoped rather than windowed.
    const source = `
      function checkAttestationExpiry() {
        let eventType = null;
        if (daysUntilExpiry <= 0) {
          eventType = 'attestation.expired';
        } else if (daysUntilExpiry <= 7) {
          eventType = 'attestation.expiring';
        }
        webhookInserts.push({
          org_id: att.attester_org_id,
          event_type: eventType,
          payload: {},
        });
        // ... many lines later, in a different branch ...
        await dbAny.from('webhook_events').insert(chunk);
      }
    `;
    expect(extractDirectInsertLiterals(source).sort()).toEqual(
      ['attestation.expired', 'attestation.expiring'].sort(),
    );
  });

  it('reproduces the complianceEvents.ts bug pattern: a literal event_type field inserted straight into webhook_delivery_logs', () => {
    const source = `
      async function fireComplianceEvents(events) {
        for (const event of events) {
          void db.from('webhook_delivery_logs').insert({
            endpoint_id: ep.id,
            event_type: 'compliance.certificate_expired',
            payload: event.data,
          });
        }
      }
    `;
    expect(extractDirectInsertLiterals(source)).toEqual(['compliance.certificate_expired']);
  });

  it('returns nothing for a file that never touches a queue table, even if it happens to have an event_type field', () => {
    const source = `
      db.from('audit_events').insert({ event_type: 'WEBHOOK_ENDPOINT_CREATED' });
    `;
    expect(extractDirectInsertLiterals(source)).toEqual([]);
  });

  it('does not resolve an identifier that is never assigned a literal in the same file (e.g. re-projecting an existing row)', () => {
    const source = `
      db.from('webhook_delivery_logs').select();
      const entries = rows.map((row) => ({ event_type: row.event_type }));
    `;
    expect(extractDirectInsertLiterals(source)).toEqual([]);
  });
});

describe('extractFileEmissions — deliberate non-subscribable-ping exclusion', () => {
  it('excludes test.ping and webhook.verification even though they are real literal event_type inserts into webhook_delivery_logs', () => {
    const source = `
      const testPayload = { event_type: 'test.ping' };
      const { error } = await db.from('webhook_delivery_logs').insert({
        event_type: 'test.ping',
        payload: testPayload,
      });
    `;
    expect(extractFileEmissions('api/v1/webhooks-self-service.ts', source).eventTypes).toEqual([]);
  });

  it('KNOWN_NON_SUBSCRIBABLE_EMISSIONS is exactly the two documented system pings', () => {
    expect([...KNOWN_NON_SUBSCRIBABLE_EMISSIONS].sort()).toEqual(['test.ping', 'webhook.verification']);
  });

  it('still reports a real unregistered id from a file that ALSO contains an excluded ping', () => {
    const source = `
      const testPayload = { event_type: 'test.ping' };
      db.from('webhook_delivery_logs').insert({ event_type: 'test.ping' });
      db.from('webhook_events').insert({ event_type: 'compliance.score_degraded' });
    `;
    expect(extractFileEmissions('some/file.ts', source).eventTypes).toEqual(['compliance.score_degraded']);
  });

  it('surfaces an unresolved dispatchWebhookEvent argument alongside any resolved emissions', () => {
    const source = `
      dispatchWebhookEvent(orgId, 'anchor.secured', id, payload);
      dispatchWebhookEvent(orgId, dynamicEventType, id2, payload2);
    `;
    const result = extractFileEmissions('some/unlisted/file.ts', source);
    expect(result.eventTypes).toEqual(['anchor.secured']);
    expect(result.unresolved).toHaveLength(1);
  });
});

describe('collectEmissionViolations — synthetic fixture pinning the four-event bug', () => {
  it('flags an event type queued by worker code but absent from the canonical map (dispatchWebhookEvent path)', () => {
    const canonical: CanonicalReading = { ids: ['anchor.secured', 'anchor.revoked'] };
    const scan: EmissionScanResult = {
      sources: [
        { file: 'jobs/example.ts', eventTypes: ['anchor.secured', 'anchor.unregistered_thing'] },
      ],
      unresolvedArgs: [],
    };
    const { violations } = collectEmissionViolations({ canonical, scan });
    expect(violations).toEqual([{ file: 'jobs/example.ts', unregistered: ['anchor.unregistered_thing'] }]);
  });

  it('reproduces the exact pre-fix shape: attestationExpiry.ts and complianceEvents.ts both drift', () => {
    const canonical: CanonicalReading = {
      ids: [
        'anchor.submitted', 'anchor.secured', 'attestation.created', 'attestation.revoked',
        'attestation.active', 'compliance.document_expiring', 'compliance.certificate_expiring',
        'compliance.anchor_delayed', 'compliance.signature_revoked', 'compliance.timestamp_coverage_low',
      ],
    };
    const scan: EmissionScanResult = {
      sources: [
        { file: 'jobs/attestationExpiry.ts', eventTypes: ['attestation.expiring', 'attestation.expired'] },
        {
          file: 'signatures/compliance/complianceEvents.ts',
          eventTypes: ['compliance.certificate_expiring', 'compliance.certificate_expired', 'compliance.anchor_delayed'],
        },
      ],
      unresolvedArgs: [],
    };
    const { violations } = collectEmissionViolations({ canonical, scan });
    expect(violations).toEqual([
      { file: 'jobs/attestationExpiry.ts', unregistered: ['attestation.expiring', 'attestation.expired'] },
      { file: 'signatures/compliance/complianceEvents.ts', unregistered: ['compliance.certificate_expired'] },
    ]);
  });

  it('passes clean when every emitted id is registered', () => {
    const canonical: CanonicalReading = { ids: ['anchor.secured'] };
    const scan: EmissionScanResult = {
      sources: [{ file: 'jobs/example.ts', eventTypes: ['anchor.secured'] }],
      unresolvedArgs: [],
    };
    expect(collectEmissionViolations({ canonical, scan }).violations).toEqual([]);
  });

  it('fails closed when the canonical map cannot be located', () => {
    const canonical: CanonicalReading = { ids: [], unresolved: 'declaration not found' };
    const scan: EmissionScanResult = { sources: [], unresolvedArgs: [] };
    const result = collectEmissionViolations({ canonical, scan });
    expect(result.unresolved).toBe('declaration not found');
  });

  it('fails closed when the worker source tree cannot be scanned', () => {
    const canonical: CanonicalReading = { ids: ['anchor.secured'] };
    const scan: EmissionScanResult = { sources: [], unresolved: 'services/worker/src could not be read', unresolvedArgs: [] };
    const result = collectEmissionViolations({ canonical, scan });
    expect(result.unresolved).toBe('services/worker/src could not be read');
  });

  it('fails closed when the scan found an unresolved dispatchWebhookEvent argument, even with zero registration violations', () => {
    const canonical: CanonicalReading = { ids: ['anchor.secured'] };
    const scan: EmissionScanResult = {
      sources: [{ file: 'jobs/example.ts', eventTypes: ['anchor.secured'] }],
      unresolvedArgs: ['jobs/other.ts: dispatchWebhookEvent(...) second argument `x` ...'],
    };
    const result = collectEmissionViolations({ canonical, scan });
    expect(result.violations).toEqual([]);
    expect(result.unresolved).toContain('jobs/other.ts');
  });
});

describe('KNOWN_TYPE_NARROWED_DISPATCH_ARGS — allowlist stays honest', () => {
  it('every entry names a union type whose members are ALL currently registered', () => {
    const canonical = readCanonicalEventTypes();
    expect(canonical.unresolved).toBeUndefined();
    const canonicalSet = new Set(canonical.ids);

    for (const entry of KNOWN_TYPE_NARROWED_DISPATCH_ARGS) {
      const members = readStringLiteralUnion(entry.unionFile, entry.unionType);
      expect(members, `${entry.unionType} in ${entry.unionFile} should be a readable string-literal union`).toBeDefined();
      for (const member of members ?? []) {
        expect(
          canonicalSet.has(member),
          `${entry.unionType} member '${member}' (allowlisted for ${entry.file}) must be registered in PAYLOAD_SCHEMAS_BY_EVENT_TYPE`,
        ).toBe(true);
      }
    }
  });
});

describe('readCanonicalEventTypes — real repo', () => {
  it('resolves PAYLOAD_SCHEMAS_BY_EVENT_TYPE and finds a known-good id', () => {
    const canonical = readCanonicalEventTypes();
    expect(canonical.unresolved).toBeUndefined();
    expect(canonical.ids).toContain('anchor.secured');
    expect(canonical.ids.length).toBeGreaterThan(10);
  });
});

describe('scanWorkerEmissions — real repo', () => {
  it('resolves the worker source tree and finds at least one known-good registered emitter', () => {
    const scan = scanWorkerEmissions();
    expect(scan.unresolved).toBeUndefined();
    const allIds = scan.sources.flatMap((s) => s.eventTypes);
    expect(allIds).toContain('anchor.secured');
  });

  it('finds zero unresolved dispatchWebhookEvent arguments against the current tree', () => {
    // Every real variable-argument call site is either resolvable to a
    // same-file literal or is on the verified KNOWN_TYPE_NARROWED_DISPATCH_ARGS
    // allowlist. A non-empty result here means a new call site was added with
    // an argument this scanner cannot verify — register a literal, resolve it,
    // or add a verified allowlist entry, but do not ignore this failure.
    const scan = scanWorkerEmissions();
    expect(scan.unresolvedArgs).toEqual([]);
  });
});

describe('checkWebhookEventEmissionRegistration — real repo, post-fix state', () => {
  it('finds zero unregistered emissions against the current tree', () => {
    // This is the live version of the synthetic fixture above. Before the fix
    // that removed the dead emitters in jobs/attestationExpiry.ts and deleted
    // signatures/compliance/complianceEvents.ts, this assertion failed with
    // exactly the four event types the fixture above reproduces — confirmed
    // by running the checker against the pre-fix tree before making that
    // change (see the PR description for the captured output).
    expect(checkWebhookEventEmissionRegistration()).toBe(0);
  });
});
