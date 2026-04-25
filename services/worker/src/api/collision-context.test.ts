/**
 * Tests for SCRUM-1150 — version collision context.
 *
 * AC:
 *   - Collision queue item shows candidate versions, source system, modified
 *     timestamps, and suggested terminal version when available.
 *   - Admin can confirm, defer, or reject (flow handled by resolve endpoint).
 *   - Decision audit-logged (resolve endpoint already does this).
 *   - UI avoids flooding the audit trail with intermediate redline versions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const profilesMaybeSingle = vi.fn();
const anchorsList = vi.fn();

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => {
  const profilesChain = {
    select: () => ({ eq: () => ({ maybeSingle: () => profilesMaybeSingle() }) }),
  };
  // The collision endpoint queries:
  //   anchors.select(...).eq('org_id', orgId).eq('status', 'PENDING_RESOLUTION')
  //         .eq('metadata->>external_file_id', x).order(created_at).limit(N)
  const anchorsChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({ limit: () => anchorsList() }),
          }),
        }),
      }),
    }),
  };
  return {
    db: {
      from: (table: string) => {
        if (table === 'profiles') return profilesChain;
        if (table === 'anchors') return anchorsChain;
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
});

const { handleCollisionContext, suggestTerminalVersion } = await import('./collision-context.js');

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildRes() {
  let statusCode: number | undefined;
  let body: unknown;
  const json = vi.fn((payload: unknown) => { body = payload; });
  const status = vi.fn((code: number) => { statusCode = code; return { json }; });
  const setHeader = vi.fn();
  const res = { status, json, setHeader } as unknown as Response;
  return { res, status, json, get body() { return body; }, get statusCode() { return statusCode; } };
}

function buildReq(externalFileId: string): Request {
  return { params: { externalFileId }, query: {}, headers: {}, body: {} } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  profilesMaybeSingle.mockResolvedValue({ data: { org_id: ORG_ID }, error: null });
  anchorsList.mockResolvedValue({ data: [], error: null });
});

describe('suggestTerminalVersion (SCRUM-1150)', () => {
  it('returns null when no candidates supplied', () => {
    expect(suggestTerminalVersion([])).toBeNull();
  });
  it('picks the candidate with the latest modified_at when available', () => {
    const result = suggestTerminalVersion([
      { public_id: 'pid_old', fingerprint: 'fp_old', filename: 'old.pdf', vendor: 'docusign', modified_at: '2026-04-20T00:00:00Z', created_at: '2026-04-20T00:00:00Z', size_bytes: 1000 },
      { public_id: 'pid_new', fingerprint: 'fp_new', filename: 'new.pdf', vendor: 'docusign', modified_at: '2026-04-24T00:00:00Z', created_at: '2026-04-21T00:00:00Z', size_bytes: 2000 },
    ]);
    expect(result?.public_id).toBe('pid_new');
  });
  it('falls back to created_at when modified_at is missing', () => {
    const result = suggestTerminalVersion([
      { public_id: 'pid_a', fingerprint: 'fp_a', filename: 'a.pdf', vendor: null, modified_at: null, created_at: '2026-04-20T00:00:00Z', size_bytes: null },
      { public_id: 'pid_b', fingerprint: 'fp_b', filename: 'b.pdf', vendor: null, modified_at: null, created_at: '2026-04-22T00:00:00Z', size_bytes: null },
    ]);
    expect(result?.public_id).toBe('pid_b');
  });
  it('breaks ties on modified_at by larger size_bytes', () => {
    const ts = '2026-04-22T00:00:00Z';
    const result = suggestTerminalVersion([
      { public_id: 'pid_small', fingerprint: 'fp_s', filename: 's.pdf', vendor: 'docusign', modified_at: ts, created_at: ts, size_bytes: 1000 },
      { public_id: 'pid_big', fingerprint: 'fp_b', filename: 'b.pdf', vendor: 'docusign', modified_at: ts, created_at: ts, size_bytes: 5000 },
    ]);
    expect(result?.public_id).toBe('pid_big');
  });
});

describe('handleCollisionContext (SCRUM-1150)', () => {
  it('rejects callers without an organization with 403', async () => {
    profilesMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const ctx = buildRes();
    await handleCollisionContext(USER_ID, buildReq('drive-123'), ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(403);
  });

  it('400s when externalFileId param is missing/empty', async () => {
    const ctx = buildRes();
    await handleCollisionContext(USER_ID, buildReq(''), ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(400);
  });

  it('returns empty candidates + null suggestion when no collision exists', async () => {
    const ctx = buildRes();
    await handleCollisionContext(USER_ID, buildReq('drive-no-collision'), ctx.res);
    const body = ctx.body as { external_file_id: string; candidates: unknown[]; suggested_terminal_public_id: string | null };
    expect(body.external_file_id).toBe('drive-no-collision');
    expect(body.candidates).toEqual([]);
    expect(body.suggested_terminal_public_id).toBeNull();
  });

  it('returns candidates with public_id, source vendor, timestamps, and suggested terminal', async () => {
    anchorsList.mockResolvedValueOnce({
      data: [
        {
          public_id: 'pid_v1',
          fingerprint: 'sha256:v1',
          filename: 'msa.pdf',
          created_at: '2026-04-20T00:00:00Z',
          metadata: { external_file_id: 'drive-123', vendor: 'docusign', modified_at: '2026-04-20T00:00:00Z', size_bytes: 1000 },
        },
        {
          public_id: 'pid_v2',
          fingerprint: 'sha256:v2',
          filename: 'msa-v2.pdf',
          created_at: '2026-04-22T00:00:00Z',
          metadata: { external_file_id: 'drive-123', vendor: 'docusign', modified_at: '2026-04-22T00:00:00Z', size_bytes: 1500 },
        },
      ],
      error: null,
    });
    const ctx = buildRes();
    await handleCollisionContext(USER_ID, buildReq('drive-123'), ctx.res);
    const body = ctx.body as {
      external_file_id: string;
      candidates: Array<{
        public_id: string;
        fingerprint: string;
        filename: string | null;
        vendor: string | null;
        modified_at: string | null;
        created_at: string;
        size_bytes: number | null;
      }>;
      suggested_terminal_public_id: string | null;
    };
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].public_id).toBe('pid_v1');
    expect(body.candidates[0].vendor).toBe('docusign');
    expect(body.candidates[0].modified_at).toBe('2026-04-20T00:00:00Z');
    expect(body.suggested_terminal_public_id).toBe('pid_v2');
  });

  it('does not expose internal anchor.id or org_id (CLAUDE.md §6)', async () => {
    anchorsList.mockResolvedValueOnce({
      data: [
        {
          public_id: 'pid_v1',
          fingerprint: 'sha256:v1',
          filename: 'msa.pdf',
          created_at: '2026-04-20T00:00:00Z',
          metadata: { external_file_id: 'drive-123', vendor: 'docusign' },
        },
      ],
      error: null,
    });
    const ctx = buildRes();
    await handleCollisionContext(USER_ID, buildReq('drive-123'), ctx.res);
    const body = ctx.body as { org_id?: unknown; candidates: Array<Record<string, unknown>> };
    expect(body.org_id).toBeUndefined();
    for (const c of body.candidates) {
      expect(Object.keys(c)).not.toContain('id');
    }
  });
});
