/**
 * Badge SVG Generator (CSI-03 / SCRUM-1599)
 *
 * Generates an embeddable verification badge SVG string for use in
 * LinkedIn profiles, websites, and proof packages.
 *
 * This is a pure function that generates SVG markup — no DOM required.
 */

import { BADGE_LABELS } from '@/lib/copy';

export type BadgeStatus =
  | 'verified'
  | 'revoked'
  | 'expired'
  | 'pending'
  | 'submitted'
  | 'superseded'
  | 'unavailable';

interface BadgeSvgOptions {
  status?: BadgeStatus;
  width?: number;
}

const STATUS_COLORS: Record<BadgeStatus, { bg: string; text: string; accent: string }> = {
  verified: { bg: '#059669', text: '#ffffff', accent: '#34d399' },
  revoked: { bg: '#dc2626', text: '#ffffff', accent: '#f87171' },
  expired: { bg: '#d97706', text: '#ffffff', accent: '#fbbf24' },
  pending: { bg: '#d97706', text: '#ffffff', accent: '#fbbf24' },
  submitted: { bg: '#2563eb', text: '#ffffff', accent: '#60a5fa' },
  superseded: { bg: '#6b7280', text: '#ffffff', accent: '#9ca3af' },
  unavailable: { bg: '#475569', text: '#ffffff', accent: '#94a3b8' },
};

export const BADGE_STATUS_LABELS: Record<BadgeStatus, string> = {
  verified: BADGE_LABELS.STATUS_VERIFIED,
  revoked: BADGE_LABELS.STATUS_REVOKED,
  expired: BADGE_LABELS.STATUS_EXPIRED,
  pending: BADGE_LABELS.STATUS_PENDING,
  submitted: BADGE_LABELS.STATUS_SUBMITTED,
  superseded: BADGE_LABELS.STATUS_SUPERSEDED,
  unavailable: BADGE_LABELS.STATUS_UNAVAILABLE,
};

/**
 * Escape a string for safe use in SVG/XML attributes.
 * Prevents XSS via crafted publicId values.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate an Arkova verification badge SVG string.
 *
 * @param publicId - The public verification ID
 * @param options - Badge configuration
 * @returns SVG markup string
 */
export function generateBadgeSvg(publicId: string, options: BadgeSvgOptions = {}): string {
  // Sanitize publicId for use in SVG attributes
  const safeId = escapeXml(publicId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'badge');
  const { status = 'verified', width = 180 } = options;
  const safeStatus = STATUS_COLORS[status] ? status : 'unavailable';
  const colors = STATUS_COLORS[safeStatus];
  const statusLabel = BADGE_STATUS_LABELS[safeStatus];
  const ariaLabel = `${BADGE_LABELS.ALT_TEXT_PREFIX} ${statusLabel}`;
  const height = 28;
  const arkovaWidth = 60;
  const statusWidth = width - arkovaWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(ariaLabel)}">
  <title>${BADGE_LABELS.TITLE}</title>
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
  <!-- Arkova shield icon -->
  <path d="M12 5L7 8v6l5 4 5-4V8l-5-3z" fill="${colors.accent}" opacity="0.9" transform="translate(2, 2) scale(0.85)"/>
  <text x="22" y="18" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="600" fill="#e2e8f0">Arkova</text>
  <!-- Status label -->
  <text x="${arkovaWidth + statusWidth / 2}" y="18" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="600" fill="${colors.text}" text-anchor="middle">${statusLabel}</text>
</svg>`;
}

/**
 * Map anchor status to badge status.
 */
export function toBadgeStatus(anchorStatus: string): BadgeStatus {
  const upper = anchorStatus.toUpperCase();
  if (upper === 'SECURED' || upper === 'ACTIVE' || upper === 'VERIFIED') return 'verified';
  if (upper === 'REVOKED') return 'revoked';
  if (upper === 'EXPIRED') return 'expired';
  if (upper === 'PENDING') return 'pending';
  if (upper === 'SUBMITTED') return 'submitted';
  if (upper === 'SUPERSEDED') return 'superseded';
  return 'unavailable';
}
