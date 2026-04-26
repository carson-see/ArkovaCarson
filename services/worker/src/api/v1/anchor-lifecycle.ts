/**
 * GET /api/v1/anchor/:publicId/lifecycle (API-RICH-03 / SCRUM-896)
 *
 * Returns the chain of custody for an anchor — the ordered audit_events
 * trail from creation through SECURED, plus revocation / supersession.
 *
 * Public-safe projection (Constitution §1.4):
 *   - No internal UUIDs: actor_id, org_id, anchors.id never appear in the
 *     response. Only public_ids and derived fields.
 *   - Anonymous callers: actor_public_id omitted entirely.
 *   - API-key callers with org-read scope on the anchor's org:
 *     actor_public_id surfaced (when an actor profile exists).
 *   - Cross-org API key: 404. The endpoint behaves identically to "anchor
 *     does not exist" so cross-tenant existence isn't probable.
 *
 * Response shape per AC: ordered array of
 *   { event_type, timestamp_utc, actor_type, actor_public_id?, previous_status,
 *     new_status, tx_id? }
 */
import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

export type AnchorStatus =
  | 'PENDING'
  | 'BATCHED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'SECURED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'SUPERSEDED';

export type ActorType = 'user' | 'system';

export interface LifecycleEntry {
  event_type: string;
  timestamp_utc: string;
  actor_type: ActorType;
  /** Only present for API-key callers with valid scope on the anchor's org. */
  actor_public_id?: string | null;
  /** Status before this event (null for the initial creation event). */
  previous_status: AnchorStatus | null;
  /** Status after this event (null for events that aren't state transitions). */
  new_status: AnchorStatus | null;
  /** Bitcoin tx id parsed from event details for chain-bound events. */
  tx_id?: string;
}

export interface AnchorLookup {
  /** Returns the internal anchor row (or null) — used to scope the audit query. */
  byPublicId(publicId: string): Promise<AnchorRow | null>;
}

export interface AuditEventRow {
  event_type: string;
  created_at: string;
  actor_id: string | null;
  details: unknown;
}

export interface AnchorRow {
  /** Internal UUID — never returned to the caller. */
  id: string;
  /** Internal UUID — used only for cross-org auth check. */
  org_id: string | null;
}

export interface ProfileLookup {
  publicIdsByActorIds(actorIds: string[]): Promise<Map<string, string>>;
}

const STATUS_MAP: Record<string, { previous: AnchorStatus | null; next: AnchorStatus | null }> = {
  ANCHOR_CREATED: { previous: null, next: 'PENDING' },
  ANCHOR_BATCHED: { previous: 'PENDING', next: 'BATCHED' },
  ANCHOR_SUBMITTED: { previous: 'BATCHED', next: 'SUBMITTED' },
  ANCHOR_CONFIRMED: { previous: 'SUBMITTED', next: 'CONFIRMED' },
  ANCHOR_SECURED: { previous: 'CONFIRMED', next: 'SECURED' },
  ANCHOR_REVOKED: { previous: 'SECURED', next: 'REVOKED' },
  ANCHOR_EXPIRED: { previous: 'SECURED', next: 'EXPIRED' },
  ANCHOR_SUPERSEDED: { previous: 'SECURED', next: 'SUPERSEDED' },
};

function parseDetails(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function pickTxId(details: Record<string, unknown>): string | undefined {
  const candidate =
    details.tx_id ??
    details.txId ??
    details.chain_tx_id ??
    details.bitcoin_tx_id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * Pure mapper from a raw audit_events row + actor map to a public-safe entry.
 * Exported for unit testing.
 */
export function buildLifecycleEntry(
  event: AuditEventRow,
  actorPublicIdMap: Map<string, string>,
  options: { includeActorPublicId: boolean },
): LifecycleEntry {
  const details = parseDetails(event.details);
  const transition = STATUS_MAP[event.event_type] ?? { previous: null, next: null };
  const actor_type: ActorType = event.actor_id ? 'user' : 'system';

  const entry: LifecycleEntry = {
    event_type: event.event_type,
    timestamp_utc: event.created_at,
    actor_type,
    previous_status: transition.previous,
    new_status: transition.next,
  };

  if (options.includeActorPublicId) {
    entry.actor_public_id = event.actor_id
      ? (actorPublicIdMap.get(event.actor_id) ?? null)
      : null;
  }

  const txId = pickTxId(details);
  if (txId) entry.tx_id = txId;

  return entry;
}

const defaultAnchorLookup: AnchorLookup = {
  async byPublicId(publicId) {
    const { data, error } = await dbAny
      .from('anchors')
      .select('id, org_id')
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();
    if (error || !data) return null;
    return { id: data.id as string, org_id: (data.org_id as string | null) ?? null };
  },
};

const defaultProfileLookup: ProfileLookup = {
  async publicIdsByActorIds(actorIds) {
    if (actorIds.length === 0) return new Map();
    const { data } = await dbAny
      .from('profiles')
      .select('id, public_id')
      .in('id', actorIds);
    const out = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ id: string; public_id: string | null }>) {
      if (row.public_id) out.set(row.id, row.public_id);
    }
    return out;
  },
};

router.get('/:publicId/lifecycle', async (req: Request, res: Response) => {
  const rawPublicId = req.params.publicId;
  const publicId = typeof rawPublicId === 'string' ? rawPublicId : '';

  if (!publicId || publicId.length < 3) {
    res.status(400).json({ error: 'Invalid anchor ID' });
    return;
  }

  const apiKey = (req as Request & { apiKey?: { orgId?: string | null } }).apiKey;
  const callerOrgId = apiKey?.orgId ?? null;

  try {
    const anchorLookup =
      (req as Request & { _testAnchorLookup?: AnchorLookup })._testAnchorLookup ?? defaultAnchorLookup;
    const profileLookup =
      (req as Request & { _testProfileLookup?: ProfileLookup })._testProfileLookup ?? defaultProfileLookup;

    const anchor = await anchorLookup.byPublicId(publicId);
    if (!anchor) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }

    // Cross-org API key — anchor exists but caller's org doesn't own it.
    // Return 404 to avoid leaking existence per AC.
    if (apiKey && callerOrgId && anchor.org_id && anchor.org_id !== callerOrgId) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }

    const { data: events, error } = await dbAny
      .from('audit_events')
      .select('event_type, created_at, actor_id, details')
      .eq('target_type', 'anchor')
      .eq('target_id', anchor.id)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error({ error, publicId }, 'Lifecycle query failed');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const rows = (events ?? []) as AuditEventRow[];
    const includeActorPublicId = Boolean(apiKey);

    let actorPublicIdMap = new Map<string, string>();
    if (includeActorPublicId) {
      const actorIds = Array.from(
        new Set(rows.map((r) => r.actor_id).filter((id): id is string => Boolean(id))),
      );
      actorPublicIdMap = await profileLookup.publicIdsByActorIds(actorIds);
    }

    const lifecycle = rows.map((e) =>
      buildLifecycleEntry(e, actorPublicIdMap, { includeActorPublicId }),
    );

    res.json({
      public_id: publicId,
      lifecycle,
      total: lifecycle.length,
    });
  } catch (error) {
    logger.error({ error, publicId }, 'Lifecycle lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as anchorLifecycleRouter };
