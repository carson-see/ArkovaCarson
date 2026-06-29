/**
 * Compliance Auth Helpers — `getCallerOrgId` org resolution.
 *
 * Regression (prod UAT 2026-06-24): the "Audit My Organization" gate 403'd
 * org OWNERS with "Must belong to an organization". Root cause: this helper
 * resolved org membership via `org_members` ONLY, while every other resolver
 * in the codebase (`src/api/_org-auth.ts`, `orgVerification.ts`, the
 * `get_user_org_id()` SQL helper, and `useCanIssueCredential` on the client)
 * resolves via `profiles.org_id`. An owner is attached to their org through
 * `profiles.org_id` (it drives the dashboard "Managing X" header); the
 * happy-path onboarding RPC sets it on the creator, but a matching
 * `org_members` 'owner' row is not guaranteed for every owner.
 *
 * DB is mocked at the `db.from(table)` level so the test stays isolated from
 * Supabase. The fluent-builder mock is shared with the v1 router tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getCallerOrgId } from './auth-helpers.js';
import { db } from '../utils/db.js';
import { makeBuilder } from '../api/v1/__testHelpers.js';

/** Minimal Express `Response` double that records status + json payload. */
function mockRes(): Response & { _status?: number; _json?: unknown } {
  const res = {} as Response & { _status?: number; _json?: unknown };
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res._json = body;
    return res;
  }) as unknown as Response['json'];
  return res;
}

function reqWith(authUserId?: string): Request {
  return { authUserId } as unknown as Request;
}

describe('getCallerOrgId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401s when the request is unauthenticated', async () => {
    const res = mockRes();
    const out = await getCallerOrgId(reqWith(undefined), res);

    expect(out).toBeNull();
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Authentication required' });
    expect(db.from).not.toHaveBeenCalled();
  });

  it('resolves an org OWNER linked only via profiles.org_id (no org_members row)', async () => {
    // The regression: owner has profiles.org_id set but NO org_members row.
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') {
        return makeBuilder({ maybeSingleData: { org_id: 'org-owner-1' } }) as unknown as never;
      }
      // org_members yields nothing — the owner has no membership row.
      return makeBuilder({ maybeSingleData: null, singleData: null }) as unknown as never;
    });

    const res = mockRes();
    const out = await getCallerOrgId(reqWith('owner-user'), res);

    expect(out).toBe('org-owner-1');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('falls back to an org_members row when profiles.org_id is null', async () => {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') {
        return makeBuilder({ maybeSingleData: { org_id: null } }) as unknown as never;
      }
      if (table === 'org_members') {
        return makeBuilder({ maybeSingleData: { org_id: 'org-member-2' } }) as unknown as never;
      }
      return makeBuilder({}) as unknown as never;
    });

    const res = mockRes();
    const out = await getCallerOrgId(reqWith('member-user'), res);

    expect(out).toBe('org-member-2');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('403s only when neither profiles.org_id nor an org_members row resolves', async () => {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') {
        return makeBuilder({ maybeSingleData: { org_id: null } }) as unknown as never;
      }
      return makeBuilder({ maybeSingleData: null, singleData: null }) as unknown as never;
    });

    const res = mockRes();
    const out = await getCallerOrgId(reqWith('orphan-user'), res);

    expect(out).toBeNull();
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Must belong to an organization' });
  });

  it('resolves a multi-org member via the org_members fallback (limit(1).maybeSingle, not .single)', async () => {
    // profiles.org_id null; the user belongs to 2+ orgs. The old `.single()`
    // threw PostgREST "more than one row" → swallowed to 403. limit(1).maybeSingle()
    // returns one of the caller's OWN orgs instead — this is the latent
    // crash-to-403 the fix also closes.
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') {
        return makeBuilder({ maybeSingleData: { org_id: null } }) as unknown as never;
      }
      if (table === 'org_members') {
        return makeBuilder({ maybeSingleData: { org_id: 'org-C' } }) as unknown as never;
      }
      return makeBuilder({}) as unknown as never;
    });

    const res = mockRes();
    const out = await getCallerOrgId(reqWith('multi-org-user'), res);

    expect(out).toBe('org-C');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('profiles.org_id wins and short-circuits — org_members is never queried', async () => {
    const tables: string[] = [];
    vi.mocked(db.from).mockImplementation((table: string): never => {
      tables.push(table);
      if (table === 'profiles') {
        return makeBuilder({ maybeSingleData: { org_id: 'org-A' } }) as unknown as never;
      }
      // If the fallback were (wrongly) consulted it would surface a different
      // org — asserting org-A proves profiles precedence + short-circuit.
      return makeBuilder({ maybeSingleData: { org_id: 'org-B' } }) as unknown as never;
    });

    const res = mockRes();
    const out = await getCallerOrgId(reqWith('owner-of-A'), res);

    expect(out).toBe('org-A');
    expect(tables).not.toContain('org_members');
  });

  it('fails closed (403) when the profiles lookup errors and no org_members row exists', async () => {
    // _org-auth's resolver fails closed on a DB error (→ null), so we fall
    // through to the org_members fallback; with no row there, 403 — never open.
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: { message: 'profiles unavailable' } }),
            }),
          }),
        } as unknown as never;
      }
      return makeBuilder({ maybeSingleData: null }) as unknown as never; // org_members empty
    });

    const res = mockRes();
    const out = await getCallerOrgId(reqWith('user-during-db-blip'), res);

    expect(out).toBeNull();
    expect(res._status).toBe(403);
  });

  it('fails closed (403) when the org_members fallback lookup errors', async () => {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') {
        return makeBuilder({ maybeSingleData: { org_id: null } }) as unknown as never;
      }
      // org_members chain: select -> eq -> limit -> maybeSingle (errors).
      return {
        select: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: { message: 'org_members unavailable' } }),
            }),
          }),
        }),
      } as unknown as never;
    });

    const res = mockRes();
    const out = await getCallerOrgId(reqWith('user-during-db-blip-2'), res);

    expect(out).toBeNull();
    expect(res._status).toBe(403);
  });
});
