/**
 * `event.extra` PII scrubbing gap (§1.1 hardening).
 *
 * The gap
 * -------
 * `scrubPiiFromEvent` ran `scrubString` over exception values, the message, the
 * transaction name, tags and `request.url` — but for `event.extra` it only
 * replaced EXACT top-level keys listed in `SENSITIVE_EXTRA_KEYS` with
 * `[FILTERED]`. Consequences:
 *
 *   1. Any OTHER top-level key's string value passed through verbatim.
 *   2. NESTED extras were never key-filtered at all: `{ ctx: { email: … } }`
 *      sailed straight through, because `'email' in event.extra` is false.
 *
 * `captureCreditRpcFailureAlert` spreads caller-supplied `...args.extra`
 * straight into that bag, so any call site that hands it a nested object was a
 * live path for an email / document fingerprint / API key to reach Sentry —
 * which §1.1 forbids outright.
 *
 * The fix walks `event.extra` recursively, applying BOTH the key filter and
 * `scrubString` at every level, bounded by `MAX_SCRUB_DEPTH`, and preserving
 * the SCRUM-2492 type-based binary drop that still runs first.
 */

import { describe, it, expect } from 'vitest';
import { scrubPiiFromEvent, REDACTED_BYTES_TOKEN } from './sentry.js';

const EMAIL = 'victim@example.com';
const FINGERPRINT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
// ak_test_ + 16+ hex chars: matches scrubString's `ak_(live|test)_` API-key
// regex (so the test exercises the real redaction path) AND the existing
// `.gitleaks.toml` allowlist entry for `ak_test_[a-f0-9]{16,}` test fixtures —
// no gitleaks config change needed. `ak_live_xyzzy123abc` (prior value)
// tripped gitleaks' generic-api-key entropy rule as a false positive.
const API_KEY = 'ak_test_deadbeef0123456789abcdef';

function scrubExtra(extra: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrubPiiFromEvent({ extra });
  return (scrubbed?.extra ?? {}) as Record<string, unknown>;
}

function serialize(extra: Record<string, unknown>): string {
  return JSON.stringify(extra);
}

describe('scrubPiiFromEvent — nested event.extra (§1.1)', () => {
  it('scrubs an email planted at a NESTED extra path', () => {
    const out = scrubExtra({
      rpc_context: { requested_by: { contact: EMAIL } },
    });

    expect(serialize(out)).not.toContain(EMAIL);
    expect(serialize(out)).toContain('[EMAIL]');
  });

  it('scrubs a 64-hex document fingerprint planted at a NESTED extra path', () => {
    const out = scrubExtra({
      job: { payload: { document: FINGERPRINT } },
    });

    expect(serialize(out)).not.toContain(FINGERPRINT);
    expect(serialize(out)).toContain('[FINGERPRINT]');
  });

  it('scrubs an API-key-shaped string planted at a NESTED extra path', () => {
    const out = scrubExtra({
      request: { headers: { supplied: `Bearer ${API_KEY}` } },
    });

    expect(serialize(out)).not.toContain(API_KEY);
    expect(serialize(out)).toContain('[API_KEY]');
  });

  it('walks arrays inside extra, not just plain objects', () => {
    const out = scrubExtra({
      failures: [{ step: 'notify', target: EMAIL }, { step: 'anchor' }],
    });

    expect(serialize(out)).not.toContain(EMAIL);
    expect(serialize(out)).toContain('[EMAIL]');
  });

  it('applies the SENSITIVE key filter at NESTED depth, not only at the top level', () => {
    const out = scrubExtra({
      ctx: { email: 'anything-at-all', api_key: 'anything-at-all' },
    });

    const ctx = out.ctx as Record<string, unknown>;
    expect(ctx.email).toBe('[FILTERED]');
    expect(ctx.api_key).toBe('[FILTERED]');
  });

  it('scrubs a NON-sensitive top-level key whose value carries PII', () => {
    // `notes` is not in SENSITIVE_EXTRA_KEYS, so before the fix its value was
    // emitted verbatim even at the top level.
    const out = scrubExtra({ notes: `escalated to ${EMAIL}` });

    expect(out.notes).not.toContain(EMAIL);
    expect(out.notes).toContain('[EMAIL]');
  });

  it('leaves non-string scalars alone', () => {
    const out = scrubExtra({
      counts: { secured: 2_972_264, healthy: false, missing: null },
    });

    expect(out.counts).toEqual({ secured: 2_972_264, healthy: false, missing: null });
  });
});

describe('scrubPiiFromEvent — extra scrubbing preserves existing contracts', () => {
  it('still replaces top-level SENSITIVE_EXTRA_KEYS with [FILTERED]', () => {
    const out = scrubExtra({
      user_id: '550e8400-e29b-41d4-a716-446655440000',
      org_id: '550e8400-e29b-41d4-a716-446655440001',
      file_content: 'JVBERi0xLjQK',
      action: 'create_anchor',
    });

    expect(out.user_id).toBe('[FILTERED]');
    expect(out.org_id).toBe('[FILTERED]');
    expect(out.file_content).toBe('[FILTERED]');
    expect(out.action).toBe('create_anchor');
  });

  it('still drops binary values BY TYPE first (SCRUM-2492), at nested depth too', () => {
    const out = scrubExtra({
      connector: { fetched: Buffer.from('%PDF-1.4 secret bytes'), name: 'docusign' },
    });

    const connector = out.connector as Record<string, unknown>;
    expect(connector.fetched).toBe(REDACTED_BYTES_TOKEN);
    expect(connector.name).toBe('docusign');
  });

  it('keeps a GCP service-account principal intact (operational attribution, not user PII)', () => {
    // SCRUM-2900: the scheduler-pause dead-man's whole diagnostic value is
    // "which principal paused the job". A service-account identity is not a
    // user email under §1.1, and the shape is anchored so nothing can ride
    // alongside it.
    const out = scrubExtra({
      findings: [
        { job_id: 'batch-anchors', actor_principal: 'ops-sa@arkova1.iam.gserviceaccount.com' },
      ],
    });

    const findings = out.findings as Array<Record<string, unknown>>;
    expect(findings[0].actor_principal).toBe('ops-sa@arkova1.iam.gserviceaccount.com');
    expect(findings[0].job_id).toBe('batch-anchors');
  });

  it('but a HUMAN email in that same field IS scrubbed — §1.1 has no person-shaped exemption', () => {
    const out = scrubExtra({
      findings: [{ job_id: 'batch-anchors', actor_principal: 'carson@arkova.ai' }],
    });

    const findings = out.findings as Array<Record<string, unknown>>;
    expect(findings[0].actor_principal).toBe('[EMAIL]');
  });

  it('does not treat a human email merely CONTAINING the SA suffix as a principal', () => {
    const out = scrubExtra({
      findings: [
        { actor_principal: 'attacker@evil.com ops-sa@arkova1.iam.gserviceaccount.com' },
      ],
    });

    expect(serialize(out)).not.toContain('attacker@evil.com');
  });
});

describe('scrubPiiFromEvent — MAX_SCRUB_DEPTH is a bound, not a bypass', () => {
  it('scrubs PII nested within the depth budget', () => {
    const out = scrubExtra({ a: { b: { c: { d: EMAIL } } } });

    expect(serialize(out)).not.toContain(EMAIL);
    expect(serialize(out)).toContain('[EMAIL]');
  });

  it('does NOT pass an over-deep subtree through verbatim — "could not check" is not "it is fine"', () => {
    let deep: Record<string, unknown> = { leaf: EMAIL, key: API_KEY };
    for (let i = 0; i < 14; i += 1) deep = { nest: deep };

    const out = scrubExtra({ deep });

    expect(serialize(out)).not.toContain(EMAIL);
    expect(serialize(out)).not.toContain(API_KEY);
  });

  it('terminates on a cyclic extra instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { note: EMAIL };
    cyclic.self = cyclic;

    expect(() => scrubExtra({ cyclic })).not.toThrow();
  });
});
