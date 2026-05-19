import { Router } from 'express';
import { z } from 'zod';

type BadgeStatus =
  | 'verified'
  | 'revoked'
  | 'expired'
  | 'pending'
  | 'submitted'
  | 'superseded'
  | 'unavailable';

export interface PublicBadgeAnchor {
  public_id: string;
  status: string;
}

export type PublicBadgeAnchorLookup = (publicId: string) => Promise<PublicBadgeAnchor | null>;

interface BadgeRouterDeps {
  lookupPublicAnchor?: PublicBadgeAnchorLookup;
}

interface PublicAnchorRpcClient {
  rpc(
    name: 'get_public_anchor',
    args: { p_public_id: string },
  ): Promise<{ data: unknown; error: { message?: string } | null }>;
}

const publicIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

const STATUS_LABELS: Record<BadgeStatus, string> = {
  verified: 'Verified',
  revoked: 'Revoked',
  expired: 'Expired',
  pending: 'Pending',
  submitted: 'Submitted',
  superseded: 'Superseded',
  unavailable: 'Unavailable',
};

const STATUS_COLORS: Record<BadgeStatus, { bg: string; text: string; accent: string }> = {
  verified: { bg: '#059669', text: '#ffffff', accent: '#34d399' },
  revoked: { bg: '#dc2626', text: '#ffffff', accent: '#f87171' },
  expired: { bg: '#d97706', text: '#ffffff', accent: '#fbbf24' },
  pending: { bg: '#d97706', text: '#ffffff', accent: '#fbbf24' },
  submitted: { bg: '#2563eb', text: '#ffffff', accent: '#60a5fa' },
  superseded: { bg: '#6b7280', text: '#ffffff', accent: '#9ca3af' },
  unavailable: { bg: '#475569', text: '#ffffff', accent: '#94a3b8' },
};

async function defaultLookupPublicAnchor(publicId: string): Promise<PublicBadgeAnchor | null> {
  const { db } = await import('../utils/db.js');
  const rpcClient = db as unknown as PublicAnchorRpcClient;
  const { data, error } = await rpcClient.rpc('get_public_anchor', {
    p_public_id: publicId,
  });

  if (error) {
    throw new Error(error.message ?? 'Failed to load public anchor');
  }

  if (!data || typeof data !== 'object' || 'error' in data) {
    return null;
  }

  const status = (data as { status?: unknown }).status;
  if (typeof status !== 'string') return null;

  const returnedPublicId = (data as { public_id?: unknown }).public_id;
  return {
    public_id: typeof returnedPublicId === 'string' ? returnedPublicId : publicId,
    status,
  };
}

async function logBadgeError(err: unknown, publicId: string): Promise<void> {
  try {
    const { logger } = await import('../utils/logger.js');
    logger.error({ err, publicId }, 'Failed to render public verification badge');
  } catch {
    // If config-bound logging is unavailable, still return the safe HTTP error below.
  }
}

function toBadgeStatus(anchorStatus: string): BadgeStatus {
  const upper = anchorStatus.toUpperCase();
  if (upper === 'SECURED' || upper === 'ACTIVE' || upper === 'VERIFIED') return 'verified';
  if (upper === 'REVOKED') return 'revoked';
  if (upper === 'EXPIRED') return 'expired';
  if (upper === 'PENDING') return 'pending';
  if (upper === 'SUBMITTED') return 'submitted';
  if (upper === 'SUPERSEDED') return 'superseded';
  return 'unavailable';
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateBadgeSvg(publicId: string, status: BadgeStatus): string {
  const safeId = escapeXml(publicId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'badge');
  const colors = STATUS_COLORS[status];
  const statusLabel = STATUS_LABELS[status];
  const width = 180;
  const height = 28;
  const arkovaWidth = 60;
  const statusWidth = width - arkovaWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Arkova ${escapeXml(statusLabel)}">
  <title>Arkova Verification Badge</title>
  <defs>
    <linearGradient id="bg-${safeId}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#1e293b"/>
      <stop offset="${arkovaWidth / width}" stop-color="#1e293b"/>
      <stop offset="${arkovaWidth / width}" stop-color="${colors.bg}"/>
      <stop offset="1" stop-color="${colors.bg}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="4" fill="url(#bg-${safeId})"/>
  <rect x="${arkovaWidth}" width="${statusWidth}" height="${height}" rx="0" fill="${colors.bg}"/>
  <rect x="${width - 4}" width="4" height="${height}" rx="0" fill="${colors.bg}"/>
  <rect width="4" height="${height}" rx="0" fill="#1e293b"/>
  <rect x="0" width="${arkovaWidth}" height="${height}" rx="4" fill="#1e293b"/>
  <path d="M12 5L7 8v6l5 4 5-4V8l-5-3z" fill="${colors.accent}" opacity="0.9" transform="translate(2, 2) scale(0.85)"/>
  <text x="22" y="18" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="600" fill="#e2e8f0">Arkova</text>
  <text x="${arkovaWidth + statusWidth / 2}" y="18" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="600" fill="${colors.text}" text-anchor="middle">${statusLabel}</text>
</svg>`;
}

export function createBadgeRouter(deps: BadgeRouterDeps = {}): Router {
  const router = Router();
  const lookupPublicAnchor = deps.lookupPublicAnchor ?? defaultLookupPublicAnchor;

  router.get('/badge/:publicId', async (req, res) => {
    const publicId = req.params.publicId;
    const parsed = publicIdSchema.safeParse(publicId);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_public_id',
        message: 'Invalid badge public ID.',
      });
    }

    try {
      const anchor = await lookupPublicAnchor(parsed.data);
      if (!anchor) {
        return res.status(404).json({
          error: 'not_found',
          message: 'Public badge record not found.',
        });
      }

      const badgeStatus = toBadgeStatus(anchor.status);
      const svg = generateBadgeSvg(anchor.public_id, badgeStatus);
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type('image/svg+xml');
      return res.status(200).send(svg);
    } catch (err) {
      void logBadgeError(err, parsed.data);
      return res.status(503).json({
        error: 'badge_unavailable',
        message: 'Badge is temporarily unavailable.',
      });
    }
  });

  return router;
}

export const badgeRouter = createBadgeRouter();
