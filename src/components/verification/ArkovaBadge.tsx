/**
 * Arkova Verification Badge (CSI-03 / SCRUM-1599)
 *
 * SVG badge component for embedding in external pages.
 * Shows verification status with Arkova branding.
 *
 * Used in:
 * - Public verify page (inline display)
 * - Badge embed endpoint (rendered as SVG response)
 */

import { SOURCE_PROVENANCE_LABELS } from '@/lib/copy';

interface ArkovaBadgeProps {
  status: string;
  className?: string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  SECURED: { bg: '#16a34a', text: '#ffffff', label: 'Verified' },
  PENDING: { bg: '#d97706', text: '#ffffff', label: 'Pending' },
  SUBMITTED: { bg: '#d97706', text: '#ffffff', label: 'Processing' },
  REVOKED: { bg: '#6b7280', text: '#ffffff', label: 'Revoked' },
  EXPIRED: { bg: '#d97706', text: '#ffffff', label: 'Expired' },
};

/**
 * Generate SVG markup for the Arkova badge (for embedding / endpoint use).
 */
export function generateBadgeSvg(status: string): string {
  const config = STATUS_COLORS[status] ?? STATUS_COLORS.SECURED;
  const labelWidth = 52;
  const statusWidth = config.label.length * 7 + 12;
  const totalWidth = labelWidth + statusWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${SOURCE_PROVENANCE_LABELS.BADGE_ALT}: ${config.label}">
  <title>${SOURCE_PROVENANCE_LABELS.BADGE_ALT}: ${config.label}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${statusWidth}" height="20" fill="${config.bg}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelWidth / 2}" y="14" fill="#010101" fill-opacity=".3">arkova</text>
    <text x="${labelWidth / 2}" y="13" fill="#fff">arkova</text>
    <text x="${labelWidth + statusWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${config.label}</text>
    <text x="${labelWidth + statusWidth / 2}" y="13" fill="#fff">${config.label}</text>
  </g>
</svg>`;
}

/**
 * React component rendering the badge inline.
 */
export function ArkovaBadge({ status, className }: Readonly<ArkovaBadgeProps>) {
  const svg = generateBadgeSvg(status);

  return (
    <span
      className={className}
      data-testid="arkova-badge"
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
      aria-label={`${SOURCE_PROVENANCE_LABELS.BADGE_ALT}: ${status}`}
    />
  );
}
