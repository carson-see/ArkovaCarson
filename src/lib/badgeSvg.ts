/**
 * Badge SVG Generator (CSI-03 / SCRUM-1599)
 *
 * Generates an embeddable verification badge SVG string for use in
 * LinkedIn profiles, websites, and proof packages.
 *
 * This is a pure function that generates SVG markup — no DOM required.
 */

import { BADGE_LABELS } from '@/lib/copy';

export type BadgeStatus = 'verified' | 'revoked' | 'expired';

interface BadgeSvgOptions {
  status?: BadgeStatus;
  width?: number;
}

const STATUS_COLORS: Record<BadgeStatus, { bg: string; text: string; accent: string }> = {
  verified: { bg: '#059669', text: '#ffffff', accent: '#34d399' },
  revoked: { bg: '#dc2626', text: '#ffffff', accent: '#f87171' },
  expired: { bg: '#d97706', text: '#ffffff', accent: '#fbbf24' },
};

const STATUS_LABELS: Record<BadgeStatus, string> = {
  verified: 'Verified',
  revoked: 'Revoked',
  expired: 'Expired',
};

/**
 * Generate an Arkova verification badge SVG string.
 *
 * @param publicId - The public verification ID
 * @param options - Badge configuration
 * @returns SVG markup string
 */
export function generateBadgeSvg(publicId: string, options: BadgeSvgOptions = {}): string {
  const { status = 'verified', width = 180 } = options;
  const colors = STATUS_COLORS[status];
  const statusLabel = STATUS_LABELS[status];
  const height = 28;
  const arkovaWidth = 60;
  const statusWidth = width - arkovaWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${BADGE_LABELS.ALT_TEXT}">
  <title>${BADGE_LABELS.TITLE}</title>
  <defs>
    <linearGradient id="bg-${publicId}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#1e293b"/>
      <stop offset="${arkovaWidth / width}" stop-color="#1e293b"/>
      <stop offset="${arkovaWidth / width}" stop-color="${colors.bg}"/>
      <stop offset="1" stop-color="${colors.bg}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="4" fill="url(#bg-${publicId})"/>
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
  if (upper === 'REVOKED') return 'revoked';
  if (upper === 'EXPIRED') return 'expired';
  return 'verified';
}
