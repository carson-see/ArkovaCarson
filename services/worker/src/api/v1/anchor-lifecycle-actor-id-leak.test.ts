/**
 * SCRUM-1271-F (sub-F) — verify anchor-lifecycle.ts does not leak `actor_id`.
 *
 * The original SCRUM-1271 description listed `anchor-lifecycle.ts:48` as
 * leaking the raw `actor_id` UUID. The current code already uses
 * `actor_public_id` per the LifecycleEntry typedef. This test pins that
 * contract so a future regression cannot reintroduce the leak.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { buildLifecycleEntry, type AuditEventRow } from './anchor-lifecycle.js';

describe('SCRUM-1271-F — anchor-lifecycle never leaks actor_id', () => {
  const SOME_ACTOR_UUID = '11111111-1111-1111-1111-111111111111';

  function event(actor: string | null = SOME_ACTOR_UUID): AuditEventRow {
    return {
      event_type: 'ANCHOR_CREATED',
      created_at: '2026-04-27T10:00:00Z',
      actor_id: actor,
      details: null,
    };
  }

  it('omits actor_id when no public-id mapping is supplied (anonymous projection)', () => {
    const entry = buildLifecycleEntry(event(), new Map(), { includeActorPublicId: false });
    const flat = JSON.stringify(entry);
    expect(flat).not.toContain(SOME_ACTOR_UUID);
    expect(flat).not.toContain('actor_id');
  });

  it('exposes only the resolved actor_public_id, never the raw actor_id', () => {
    const map = new Map<string, string>([[SOME_ACTOR_UUID, 'arkv_user_pub_xyz']]);
    const entry = buildLifecycleEntry(event(), map, { includeActorPublicId: true });
    const flat = JSON.stringify(entry);
    expect(flat).not.toContain(SOME_ACTOR_UUID);
    expect(flat).toContain('arkv_user_pub_xyz');
  });

  it('falls back to null actor_public_id when no mapping exists, never the UUID', () => {
    const entry = buildLifecycleEntry(event(), new Map(), { includeActorPublicId: true });
    expect(entry.actor_public_id).toBeNull();
    expect(JSON.stringify(entry)).not.toContain(SOME_ACTOR_UUID);
  });

  it('treats system-actor (null actor_id) as actor_type=system without UUID surface', () => {
    const entry = buildLifecycleEntry(event(null), new Map(), { includeActorPublicId: true });
    expect(entry.actor_type).toBe('system');
    expect(entry.actor_public_id).toBeNull();
  });
});
