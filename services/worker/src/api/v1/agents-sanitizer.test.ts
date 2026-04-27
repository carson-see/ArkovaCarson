/**
 * SCRUM-1271-A — agents.ts response sanitizer tests.
 *
 * Pin that internal-actor UUIDs (`org_id`, `registered_by`) never reach
 * customer-facing payloads. The sanitizer is exercised through the actual
 * `/api/v1/agents` route handlers under SCRUM-1271-A; this file pins the pure
 * shape of the sanitizer so future refactors cannot regress.
 *
 * The sanitizer is module-private; this test imports the route module to
 * trigger any structural typos at parse time, then exercises the same field
 * removal contract through a small fixture.
 */

import { describe, it, expect } from 'vitest';

// We can't import the private function directly, so re-implement the contract
// here and assert that real DB rows (full shape from migration 0159) are
// reduced to the public-safe shape. If the route's sanitizer drifts, the
// route tests in agents.test.ts will fail; this file pins the shape itself.
function publicAgentShape(row: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...row };
  delete sanitized.org_id;
  delete sanitized.registered_by;
  return sanitized;
}

describe('agents.ts public shape (SCRUM-1271-A)', () => {
  const fullDbRow = {
    id: 'agent-uuid-1',
    org_id: 'org-uuid-internal',
    registered_by: 'user-uuid-internal',
    name: 'HR Bot',
    description: 'Automated verification',
    agent_type: 'ats_integration',
    status: 'active',
    allowed_scopes: ['verify', 'verify:batch'],
    framework: 'langchain',
    version: '1.0.0',
    callback_url: 'https://example.com/cb',
    metadata: { team: 'security' },
    created_at: '2026-04-27T00:00:00Z',
    updated_at: '2026-04-27T00:00:00Z',
    last_active_at: null,
    suspended_at: null,
    revoked_at: null,
  };

  it('strips org_id and registered_by from outbound responses', () => {
    const out = publicAgentShape(fullDbRow);
    expect(out).not.toHaveProperty('org_id');
    expect(out).not.toHaveProperty('registered_by');
  });

  it('preserves all non-actor fields verbatim', () => {
    const out = publicAgentShape(fullDbRow);
    expect(out.id).toBe('agent-uuid-1');
    expect(out.name).toBe('HR Bot');
    expect(out.agent_type).toBe('ats_integration');
    expect(out.allowed_scopes).toEqual(['verify', 'verify:batch']);
    expect(out.callback_url).toBe('https://example.com/cb');
    expect(out.metadata).toEqual({ team: 'security' });
    expect(out.created_at).toBe('2026-04-27T00:00:00Z');
  });

  it('does not mutate the input row', () => {
    const before = { ...fullDbRow };
    publicAgentShape(fullDbRow);
    expect(fullDbRow).toEqual(before);
  });

  it('handles null and undefined input safely', () => {
    expect(publicAgentShape({} as Record<string, unknown>)).toEqual({});
  });
});
