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

import {
  generateBadgeSvg,
  toBadgeStatus,
} from '@/lib/badgeSvg';
import { BADGE_LABELS } from '@/lib/copy';

interface ArkovaBadgeProps {
  publicId: string;
  status: string;
  className?: string;
}

export { generateBadgeSvg } from '@/lib/badgeSvg';

/**
 * React component rendering the badge inline.
 */
export function ArkovaBadge({ publicId, status, className }: Readonly<ArkovaBadgeProps>) {
  const badgeStatus = toBadgeStatus(status);
  const svg = generateBadgeSvg(publicId, { status: badgeStatus });
  const label = BADGE_LABELS[badgeStatus];
  const imageSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return (
    <img
      className={className}
      data-testid="arkova-badge"
      src={imageSrc}
      alt={`Arkova ${label}`}
      width={180}
      height={28}
      loading="lazy"
    />
  );
}
