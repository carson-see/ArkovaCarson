/**
 * GET /api/v1/anchor/:publicId/evidence (HAKI-REQ-04 / SCRUM-1173)
 *
 * Audit-ready evidence trail package for verified legal documents. Bundles
 * the verification result, document hash, timestamps (both
 * `document_issued_date` and Arkova-side `anchored_at` per AC4), lifecycle
 * events, proof URL, and explorer link into a single response — so a
 * lawyer / compliance officer / court clerk gets one URL to share instead
 * of stitching responses together.
 *
 * Public-safe projection by default (Constitution §1.4): no internal UUIDs
 * leave the worker. API-key callers in the anchor's org get richer
 * metadata (actor_public_id on lifecycle entries). Cross-org API keys get
 * 404 to avoid existence-leak. Anonymous calls allowed via the same
 * anon-allow shape /verify uses.
 */
import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { buildProofUrl, buildVerifyUrl } from '../../lib/urls.js';

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
  actor_public_id?: string | null;
  previous_status: AnchorStatus | null;
  new_status: AnchorStatus | null;
  tx_id?: string;
}

export interface EvidencePackage {
  public_id: string;
  verified: boolean;
  status: 'ACTIVE' | 'REVOKED' | 'SUPERSEDED' | 'EXPIRED' | 'PENDING' | undefined;
  fingerprint: string;
  /** When the underlying document was issued by the original authority. */
  document_issued_date: string | null;
  /** When Arkova received and anchored the document — NOT the document's
   *  execution date. AC4 calls these out as separate, labelled fields. */
  anchored_at: string;
  expiry_date: string | null;
  bitcoin_block: number | null;
  network_receipt_id: string | null;
  merkle_proof_hash: string | null;
  credential_type: string | null;
  issuer_name: string | null;
  recipient_identifier: string | null;
  description: string | null;
  jurisdiction: string | null;
  lifecycle: LifecycleEntry[];
  links: {
    record_uri: string;
    proof_url: string;
    explorer_url: string | null;
  };
  /** False when chain_tx_id is null — caller can render a "pending" state
   *  with explicit retry guidance from `notes`. */
  chain_data_available: boolean;
  /** Human-readable caveats (AC4 + AC6): timestamp clarification, retroactive
   *  anchoring disclosure, retry guidance when chain data is unavailable. */
  notes: string[];
}

export interface AnchorEvidenceRow {
  public_id: string;
  fingerprint: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  created_at: string;
  credential_type: string | null;
  /** Internal UUID — never returned to caller. */
  org_id: string | null;
  org_name: string | null;
  issued_at: string | null;
  expires_at: string | null;
  description: string | null;
  jurisdiction: string | null;
  merkle_root: string | null;
  recipient_hash: string | null;
}

export interface AuditEventRow {
  event_type: string;
  created_at: string;
  actor_id: string | null;
  details: unknown;
}

export interface EvidenceLookup {
  byPublicId(publicId: string): Promise<{ anchor: AnchorEvidenceRow; internalAnchorId: string } | null>;
  auditEventsForAnchor(internalAnchorId: string): Promise<AuditEventRow[]>;
  profilePublicIdsByActorIds(actorIds: string[]): Promise<Map<string, string>>;
}

export interface BuildOptions {
  includeActorPublicId: boolean;
  actorPublicIdMap?: Map<string, string>;
}

const STATUS_TRANSITIONS: Record<string, { previous: AnchorStatus | null; next: AnchorStatus | null }> = {
  ANCHOR_CREATED: { previous: null, next: 'PENDING' },
  ANCHOR_BATCHED: { previous: 'PENDING', next: 'BATCHED' },
  ANCHOR_SUBMITTED: { previous: 'BATCHED', next: 'SUBMITTED' },
  ANCHOR_CONFIRMED: { previous: 'SUBMITTED', next: 'CONFIRMED' },
  ANCHOR_SECURED: { previous: 'CONFIRMED', next: 'SECURED' },
  ANCHOR_REVOKED: { previous: 'SECURED', next: 'REVOKED' },
  ANCHOR_EXPIRED: { previous: 'SECURED', next: 'EXPIRED' },
  ANCHOR_SUPERSEDED: { previous: 'SECURED', next: 'SUPERSEDED' },
};

const RETROACTIVE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

function mapStatus(status: string): EvidencePackage['status'] {
  switch (status) {
    case 'SECURED':
    case 'ACTIVE':
      return 'ACTIVE';
    case 'REVOKED':
      return 'REVOKED';
    case 'SUPERSEDED':
      return 'SUPERSEDED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'PENDING':
      return 'PENDING';
    default:
      return undefined;
  }
}

function buildExplorerUrl(chainTxId: string): string | null {
  if (!/^[a-fA-F0-9]+$/.test(chainTxId)) return null;
  const network = config.bitcoinNetwork;
  const baseMap: Record<string, string> = {
    testnet4: 'https://mempool.space/testnet4',
    testnet: 'https://mempool.space/testnet',
    signet: 'https://mempool.space/signet',
    mainnet: 'https://mempool.space',
  };
  const base = baseMap[network] ?? baseMap.signet;
  return `${base}/tx/${chainTxId}`;
}

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
  const candidate = details.tx_id ?? details.txId ?? details.chain_tx_id ?? details.bitcoin_tx_id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function buildLifecycleEntry(
  event: AuditEventRow,
  actorPublicIdMap: Map<string, string>,
  includeActorPublicId: boolean,
): LifecycleEntry {
  const details = parseDetails(event.details);
  const transition = STATUS_TRANSITIONS[event.event_type] ?? { previous: null, next: null };
  const entry: LifecycleEntry = {
    event_type: event.event_type,
    timestamp_utc: event.created_at,
    actor_type: event.actor_id ? 'user' : 'system',
    previous_status: transition.previous,
    new_status: transition.next,
  };
  if (includeActorPublicId) {
    entry.actor_public_id = event.actor_id
      ? (actorPublicIdMap.get(event.actor_id) ?? null)
      : null;
  }
  const txId = pickTxId(details);
  if (txId) entry.tx_id = txId;
  return entry;
}

/**
 * Pure builder — composes a verification snapshot, lifecycle events, and the
 * standing set of audit-ready notes into a single evidence package.
 * Exported for unit tests; the route handler glues it to the DB lookups.
 */
export function buildEvidencePackage(
  anchor: AnchorEvidenceRow,
  events: AuditEventRow[],
  options: BuildOptions,
): EvidencePackage {
  const actorMap = options.actorPublicIdMap ?? new Map<string, string>();
  const isVerified = anchor.status === 'SECURED' || anchor.status === 'ACTIVE';
  const chainAvailable = anchor.chain_tx_id !== null && anchor.chain_tx_id !== '';
  const explorerUrl = chainAvailable ? buildExplorerUrl(anchor.chain_tx_id as string) : null;

  const notes: string[] = [
    'anchored_at proves the Arkova receive timestamp, not the document execution date.',
  ];
  if (anchor.issued_at && anchor.created_at) {
    const issued = new Date(anchor.issued_at).getTime();
    const anchored = new Date(anchor.created_at).getTime();
    if (Number.isFinite(issued) && Number.isFinite(anchored) && anchored - issued >= RETROACTIVE_THRESHOLD_MS) {
      notes.push(
        'Document was anchored retroactively: original document_issued_date predates anchored_at by 30+ days.',
      );
    }
  }
  if (!chainAvailable) {
    notes.push(
      'Chain receipt not yet available — anchor is pending confirmation. Retry after a few minutes for explorer_url, network_receipt_id, and bitcoin_block.',
    );
  }

  return {
    public_id: anchor.public_id,
    verified: isVerified,
    status: mapStatus(anchor.status),
    fingerprint: anchor.fingerprint,
    document_issued_date: anchor.issued_at,
    anchored_at: anchor.created_at,
    expiry_date: anchor.expires_at,
    bitcoin_block: anchor.chain_block_height ?? null,
    network_receipt_id: anchor.chain_tx_id ?? null,
    merkle_proof_hash: anchor.merkle_root ?? null,
    credential_type: anchor.credential_type,
    issuer_name: anchor.org_name,
    recipient_identifier: anchor.recipient_hash,
    description: anchor.description,
    jurisdiction: anchor.jurisdiction,
    lifecycle: events.map((e) => buildLifecycleEntry(e, actorMap, options.includeActorPublicId)),
    links: {
      record_uri: buildVerifyUrl(anchor.public_id),
      proof_url: buildProofUrl(anchor.public_id),
      explorer_url: explorerUrl,
    },
    chain_data_available: chainAvailable,
    notes,
  };
}

const defaultLookup: EvidenceLookup = {
  async byPublicId(publicId) {
    const { data } = await dbAny
      .from('anchors')
      .select(
        'id, public_id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, created_at, ' +
          'credential_type, issued_at, expires_at, description, jurisdiction, merkle_root, recipient_hash, ' +
          'org_id, organization:org_id(display_name)',
      )
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();
    if (!data) return null;
    return {
      internalAnchorId: data.id as string,
      anchor: {
        public_id: data.public_id,
        fingerprint: data.fingerprint,
        status: data.status,
        chain_tx_id: data.chain_tx_id,
        chain_block_height: data.chain_block_height,
        chain_timestamp: data.chain_timestamp,
        created_at: data.created_at,
        credential_type: data.credential_type,
        org_id: data.org_id ?? null,
        org_name: data.organization?.display_name ?? null,
        issued_at: data.issued_at,
        expires_at: data.expires_at,
        description: data.description ?? null,
        jurisdiction: data.jurisdiction ?? null,
        merkle_root: data.merkle_root ?? null,
        recipient_hash: data.recipient_hash ?? null,
      },
    };
  },
  async auditEventsForAnchor(internalAnchorId) {
    const { data } = await dbAny
      .from('audit_events')
      .select('event_type, created_at, actor_id, details')
      .eq('target_type', 'anchor')
      .eq('target_id', internalAnchorId)
      .order('created_at', { ascending: true });
    return (data ?? []) as AuditEventRow[];
  },
  async profilePublicIdsByActorIds(actorIds) {
    if (actorIds.length === 0) return new Map();
    const { data } = await dbAny.from('profiles').select('id, public_id').in('id', actorIds);
    const out = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ id: string; public_id: string | null }>) {
      if (row.public_id) out.set(row.id, row.public_id);
    }
    return out;
  },
};

router.get('/:publicId/evidence', async (req: Request, res: Response) => {
  const rawPublicId = req.params.publicId;
  const publicId = typeof rawPublicId === 'string' ? rawPublicId : '';

  if (!publicId || publicId.length < 3) {
    res.status(400).json({ error: 'Invalid anchor ID' });
    return;
  }

  const apiKey = (req as Request & { apiKey?: { orgId?: string | null } }).apiKey;
  const callerOrgId = apiKey?.orgId ?? null;

  try {
    const lookup =
      (req as Request & { _testEvidenceLookup?: EvidenceLookup })._testEvidenceLookup ??
      defaultLookup;

    const found = await lookup.byPublicId(publicId);
    if (!found) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }

    if (apiKey && callerOrgId && found.anchor.org_id && found.anchor.org_id !== callerOrgId) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }

    const events = await lookup.auditEventsForAnchor(found.internalAnchorId);
    const includeActorPublicId = Boolean(apiKey);

    let actorPublicIdMap = new Map<string, string>();
    if (includeActorPublicId) {
      const actorIds = Array.from(
        new Set(events.map((e) => e.actor_id).filter((id): id is string => Boolean(id))),
      );
      actorPublicIdMap = await lookup.profilePublicIdsByActorIds(actorIds);
    }

    const pkg = buildEvidencePackage(found.anchor, events, {
      includeActorPublicId,
      actorPublicIdMap,
    });

    res.json(pkg);
  } catch (err) {
    logger.error({ error: err, publicId }, 'Evidence package lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as anchorEvidenceRouter };
