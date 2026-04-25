/**
 * Version Collision Context (SCRUM-1150)
 *
 * `GET /api/queue/collision/:externalFileId` returns the rich context an
 * operator needs before confirming a terminal version:
 *   - candidate versions (each keyed by public_id — never internal id)
 *   - source vendor + filename + fingerprint
 *   - modified / created timestamps + size
 *   - suggested_terminal_public_id derived from a "newest first, biggest
 *     wins on tie" heuristic
 *
 * The actual confirm/reject decision is the existing `POST /api/queue/resolve`
 * endpoint (SCRUM-1011 + SCRUM-1121). "Defer" is a no-op on the client (close
 * the dialog, leave the row in PENDING_RESOLUTION).
 */
import type { Request, Response } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getCallerOrgId } from './_org-auth.js';

const MAX_CANDIDATES = 25;

export interface CollisionCandidate {
  public_id: string;
  fingerprint: string;
  filename: string | null;
  vendor: string | null;
  modified_at: string | null;
  created_at: string;
  size_bytes: number | null;
}

interface AnchorRow {
  public_id: string | null;
  fingerprint: string;
  filename: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

function toCandidate(row: AnchorRow): CollisionCandidate | null {
  if (!row.public_id) return null;
  const metadata = (row.metadata ?? {}) as {
    vendor?: string;
    modified_at?: string;
    size_bytes?: number;
  };
  return {
    public_id: row.public_id,
    fingerprint: row.fingerprint,
    filename: row.filename,
    vendor: typeof metadata.vendor === 'string' ? metadata.vendor : null,
    modified_at: typeof metadata.modified_at === 'string' ? metadata.modified_at : null,
    created_at: row.created_at,
    size_bytes: typeof metadata.size_bytes === 'number' ? metadata.size_bytes : null,
  };
}

/**
 * Pick the candidate most likely to be the terminal version. Heuristics:
 *   1. Latest modified_at (vendor's own truth) wins.
 *   2. Otherwise: latest created_at (worker's capture order).
 *   3. Tie-break: larger size_bytes (a redline that grew the doc).
 *
 * Pure function; tested in isolation.
 */
export function suggestTerminalVersion(
  candidates: CollisionCandidate[],
): CollisionCandidate | null {
  if (candidates.length === 0) return null;
  const score = (c: CollisionCandidate): [string, string, number] => [
    c.modified_at ?? '',
    c.created_at,
    c.size_bytes ?? 0,
  ];
  return [...candidates].sort((a, b) => {
    const [am, ac, az] = score(a);
    const [bm, bc, bz] = score(b);
    if (am !== bm) return bm.localeCompare(am);
    if (ac !== bc) return bc.localeCompare(ac);
    return bz - az;
  })[0];
}

export async function handleCollisionContext(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }
  const externalFileId = String(req.params.externalFileId ?? '').trim();
  if (!externalFileId) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'externalFileId required' },
    });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('anchors')
    .select('public_id, fingerprint, filename, created_at, metadata')
    .eq('org_id', orgId)
    .eq('status', 'PENDING_RESOLUTION')
    .eq('metadata->>external_file_id', externalFileId)
    .order('created_at', { ascending: false })
    .limit(MAX_CANDIDATES);

  if (error) {
    logger.warn({ error, externalFileId }, 'collision-context: anchor lookup failed');
    res.status(500).json({ error: { code: 'lookup_failed', message: 'Failed to load collision context' } });
    return;
  }

  const candidates: CollisionCandidate[] = ((data as AnchorRow[] | null) ?? [])
    .map(toCandidate)
    .filter((c): c is CollisionCandidate => c !== null);

  const suggested = suggestTerminalVersion(candidates);

  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    external_file_id: externalFileId,
    candidates,
    suggested_terminal_public_id: suggested?.public_id ?? null,
    generated_at: new Date().toISOString(),
  });
}
