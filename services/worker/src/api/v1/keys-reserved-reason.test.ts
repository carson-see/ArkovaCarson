/**
 * SCRUM-5290: `revocation_reason` marker prefixes are RESERVED.
 *
 * Automated reactivation paths restore a key by matching its reason string:
 * `api/v1/agents.ts` matches 'admin:agent.suspended' and migration 0448 matches
 * 'computeid:passport.suspended'. `revocation_reason` is otherwise free text on
 * `PATCH /api/v1/keys/:keyId`, so without this guard an admin could revoke a key
 * FOR CAUSE under one of those exact strings and have a later agent
 * suspend/resume cycle silently resurrect it — turning a revocation the module
 * documents as one-way into a reversible one.
 */
import { describe, expect, it, vi } from 'vitest';

// keys.ts pulls in utils/db -> config, which throws without a full worker env.
// This suite only exercises the Zod schema, so stub the IO edges.
vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() }, rpc: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { RESERVED_REVOCATION_PREFIXES, UpdateKeySchema } from './keys.js';

describe('UpdateKeySchema — reserved revocation_reason prefixes', () => {
  it('rejects the admin agent-suspension marker', () => {
    const r = UpdateKeySchema.safeParse({ is_active: false, revocation_reason: 'admin:agent.suspended' });
    expect(r.success).toBe(false);
  });

  it('rejects any computeid marker', () => {
    const r = UpdateKeySchema.safeParse({ is_active: false, revocation_reason: 'computeid:passport.suspended' });
    expect(r.success).toBe(false);
  });

  it('rejects every reserved prefix, so the list cannot drift from the guard', () => {
    for (const prefix of RESERVED_REVOCATION_PREFIXES) {
      const r = UpdateKeySchema.safeParse({ is_active: false, revocation_reason: `${prefix}anything` });
      expect(r.success, `expected ${prefix} to be reserved`).toBe(false);
    }
  });

  it('still accepts an ordinary human reason', () => {
    const r = UpdateKeySchema.safeParse({ is_active: false, revocation_reason: 'Rotated after contractor offboarding' });
    expect(r.success).toBe(true);
  });
});
