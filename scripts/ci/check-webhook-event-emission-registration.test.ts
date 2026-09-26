import { describe, expect, it } from 'vitest';
import {
  KNOWN_NON_SUBSCRIBABLE_EMISSIONS,
  extractDispatchLiterals,
  extractDirectInsertLiterals,
  extractFileEmissions,
  collectEmissionViolations,
  readCanonicalEventTypes,
  scanWorkerEmissions,
  checkWebhookEventEmissionRegistration,
  type CanonicalReading,
  type EmissionScanResult,
} from './check-webhook-event-emission-registration.js';

describe('extractDispatchLiterals', () => {
  it('extracts a literal second argument to dispatchWebhookEvent', () => {
    const source = `
      await dispatchWebhookEvent(anchor.org_id, 'anchor.secured', anchor.public_id, {
        public_id: anchor.public_id,
      });
    `;
    expect(extractDispatchLiterals(source)).toEqual(['anchor.secured']);
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
    expect(extractDispatchLiterals(source)).toEqual(['credential.status_changed']);
  });

  it('ignores a call whose event-type argument is a variable, not a literal', () => {
    const source = `
      await dispatchWebhookEvent(orgId, eventType, eventId, payload);
    `;
    expect(extractDispatchLiterals(source)).toEqual([]);
  });

  it('dedupes repeated literals across multiple call sites', () => {
    const source = `
      await dispatchWebhookEvent(a, 'job.completed', b, c);
      await dispatchWebhookEvent(a, 'job.completed', d, e);
    `;
    expect(extractDispatchLiterals(source)).toEqual(['job.completed']);
  });

  it('strips comments before extracting, so a mention in prose does not count', () => {
    const source = `
      // dispatchWebhookEvent(orgId, 'anchor.secured', ...) is the pattern
      doSomethingElse();
    `;
    expect(extractDispatchLiterals(source)).toEqual([]);
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
});

describe('collectEmissionViolations — synthetic fixture pinning the four-event bug', () => {
  it('flags an event type queued by worker code but absent from the canonical map (dispatchWebhookEvent path)', () => {
    const canonical: CanonicalReading = { ids: ['anchor.secured', 'anchor.revoked'] };
    const scan: EmissionScanResult = {
      sources: [
        { file: 'jobs/example.ts', eventTypes: ['anchor.secured', 'anchor.unregistered_thing'] },
      ],
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
    };
    const { violations } = collectEmissionViolations({ canonical, scan });
    expect(violations).toEqual([
      { file: 'jobs/attestationExpiry.ts', unregistered: ['attestation.expiring', 'attestation.expired'] },
      { file: 'signatures/compliance/complianceEvents.ts', unregistered: ['compliance.certificate_expired'] },
    ]);
  });

  it('passes clean when every emitted id is registered', () => {
    const canonical: CanonicalReading = { ids: ['anchor.secured'] };
    const scan: EmissionScanResult = { sources: [{ file: 'jobs/example.ts', eventTypes: ['anchor.secured'] }] };
    expect(collectEmissionViolations({ canonical, scan }).violations).toEqual([]);
  });

  it('fails closed when the canonical map cannot be located', () => {
    const canonical: CanonicalReading = { ids: [], unresolved: 'declaration not found' };
    const scan: EmissionScanResult = { sources: [] };
    const result = collectEmissionViolations({ canonical, scan });
    expect(result.unresolved).toBe('declaration not found');
  });

  it('fails closed when the worker source tree cannot be scanned', () => {
    const canonical: CanonicalReading = { ids: ['anchor.secured'] };
    const scan: EmissionScanResult = { sources: [], unresolved: 'services/worker/src could not be read' };
    const result = collectEmissionViolations({ canonical, scan });
    expect(result.unresolved).toBe('services/worker/src could not be read');
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
