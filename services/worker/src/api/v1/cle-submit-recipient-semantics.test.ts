/**
 * `POST /cle/submit` recipient semantics — DECISION PIN, not a bug guard.
 *
 * `get_my_credentials()` (the RPC behind `/my-credentials`) is a strict INNER
 * JOIN through `anchor_recipients`, so a CLE anchor created here never appears
 * in any user's credentials list. That is DELIBERATE — see the 2026-08-11
 * entry "`POST /cle/submit` stays deliberately unlinked from
 * `anchor_recipients`" in this folder's `agents.md` for the full rationale.
 * The short version:
 *
 *   - The credit HOLDER is identified by `bar_number` + `jurisdiction` in the
 *     request body — a professional identifier, not a platform account. No
 *     bar_number↔user mapping exists anywhere in the schema.
 *   - The CALLER is never verifiably the holder: on the API-key path the
 *     caller is the CLE provider submitting on an attorney's behalf, and the
 *     JWT path serves the same one-uploader-many-attorneys bulk-import shape
 *     (`src/components/upload/CleBulkImport.tsx`). Linking the caller would
 *     put other people's CLE credits into the submitter's own
 *     `/my-credentials` list — misattribution of holdership.
 *   - The record's intended consumption surface is `/cle/verify` +
 *     `/cle/credits`, which key on `metadata->>bar_number` and do not depend
 *     on `anchor_recipients` at all.
 *
 * If this test fails because you added an `anchor_recipients` write to this
 * route: stop, read the agents.md entry, and take one of the two sanctioned
 * paths recorded there (optional `attorney_email` → HMAC-hashed unclaimed
 * recipient row → existing `link_recipient_to_anchors` claim flow; or a
 * verified bar↔user mapping → link/backfill from `metadata->>bar_number`).
 * Never link the caller.
 *
 * Scope note: this pin covers the submit HANDLER only. An out-of-route
 * linker (cron, job, backfill) would not trip it — any such future code
 * must be reviewed against the agents.md entry directly.
 *
 * Mock note: the query-builder mock is DELIBERATELY minimal — insert →
 * select → single is the only chain the handler uses. Any other query
 * shape a future change introduces throws in the mock → the handler's
 * catch returns 500 ≠ 201 → the change surfaces here for review. App
 * scaffolding reuses `__testHelpers.ts`'s `buildApp`; the builder mock
 * stays local because the pin needs per-table call recording (which
 * `makeBuilder` does not provide) and because the minimal surface IS the
 * ratchet.
 *
 * Note this file pins EXISTING behavior — there was no red-first phase
 * against production code because the disposition is "no code change".
 * The positive assertions (201 + anchors insert observed) keep it from
 * passing vacuously.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyMeta } from '../../middleware/apiKeyAuth.js';
import { buildApp } from './__testHelpers.js';
import { cleVerifyRouter } from './cle-verify.js';

const mockState = vi.hoisted(() => ({
  fromCalls: [] as string[],
  insertedPayload: null as Record<string, unknown> | null,
}));

vi.mock('../../utils/db.js', () => {
  // Minimal on purpose — see the mock note in the file docblock.
  function createQuery() {
    const query = {
      insert: vi.fn((payload: Record<string, unknown>) => {
        mockState.insertedPayload = payload;
        return query;
      }),
      select: vi.fn(() => query),
      single: vi.fn(() => Promise.resolve({
        data: { id: 'anchor-internal-1', public_id: 'ARK-2026-CLE-PIN-1' },
        error: null,
      })),
    };
    return query;
  }

  return {
    db: {
      from: vi.fn((table: string) => {
        mockState.fromCalls.push(table);
        return createQuery();
      }),
    },
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../auth.js', () => ({
  verifyAuthToken: vi.fn(() => Promise.resolve('user-attorney-1')),
}));

vi.mock('../../config.js', () => ({
  config: {
    nodeEnv: 'test',
    apiKeyHmacSecret: 'test-secret',
    corsAllowedOrigins: '',
    frontendUrl: 'https://app.arkova.ai',
    bitcoinNetwork: 'signet',
  },
}));

const PROVIDER_API_KEY: ApiKeyMeta = {
  keyId: 'key-provider-1',
  orgId: 'org-provider-1',
  userId: 'user-provider-1',
  // Empty on purpose: the route never reads `scopes` — any valid key's
  // userId passes its auth check. Do not read this fixture as evidence of
  // per-route scope enforcement.
  scopes: [],
  rateLimitTier: 'paid',
  keyPrefix: 'ak_test',
};

const MOUNT = '/api/v1/cle';

/** JWT-shaped caller: no injected apiKey; Authorization header per test. */
function jwtApp() {
  return buildApp(cleVerifyRouter, MOUNT);
}

/** API-key-shaped caller: upstream middleware has populated `req.apiKey`. */
function apiKeyApp() {
  return buildApp(cleVerifyRouter, MOUNT, {
    userId: PROVIDER_API_KEY.userId,
    injectUserId: (req) => {
      req.apiKey = PROVIDER_API_KEY;
    },
  });
}

const VALID_SUBMISSION = {
  bar_number: 'BAR-90210',
  course_title: 'Ethics Update 2026',
  provider_name: 'State Bar CLE Institute',
  credit_hours: 2,
  credit_category: 'Ethics',
  jurisdiction: 'Michigan',
  completion_date: '2026-07-15',
};

describe('POST /cle/submit recipient semantics (deliberately unlinked)', () => {
  beforeEach(() => {
    mockState.fromCalls = [];
    mockState.insertedPayload = null;
  });

  it('JWT submission writes anchors only — never anchor_recipients', async () => {
    const res = await request(jwtApp())
      .post('/api/v1/cle/submit')
      .set('Authorization', 'Bearer jwt-token-attorney')
      .send(VALID_SUBMISSION);

    expect(res.status).toBe(201);
    // Positive assertion first so the pin cannot pass vacuously.
    expect(mockState.fromCalls).toContain('anchors');
    expect(mockState.fromCalls).not.toContain('anchor_recipients');
  });

  it('API-key (provider on-behalf) submission writes anchors only — never anchor_recipients', async () => {
    const res = await request(apiKeyApp())
      .post('/api/v1/cle/submit')
      .send(VALID_SUBMISSION);

    expect(res.status).toBe(201);
    expect(mockState.fromCalls).toContain('anchors');
    expect(mockState.fromCalls).not.toContain('anchor_recipients');
    // Attribution (who created the row) is the API-key owner; holdership is
    // NOT implied by it. The provider must never surface in a recipient row.
    expect(mockState.insertedPayload).toHaveProperty('user_id', 'user-provider-1');
  });

  it('the holder identity the CLE surfaces resolve lives in metadata', async () => {
    // `/cle/verify` and `/cle/credits` key on `metadata->>bar_number` (+
    // jurisdiction) — this is the record's intended visibility surface, and
    // the identity a future verified bar↔user mapping would link/backfill
    // from. If these fields move, that future path breaks silently.
    const res = await request(apiKeyApp())
      .post('/api/v1/cle/submit')
      .send(VALID_SUBMISSION);

    expect(res.status).toBe(201);
    const metadata = mockState.insertedPayload?.metadata as Record<string, unknown>;
    expect(metadata.bar_number).toBe('BAR-90210');
    expect(metadata.jurisdiction).toBe('Michigan');
  });
});
