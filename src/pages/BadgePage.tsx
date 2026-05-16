/**
 * Badge Page (CSI-03 / SCRUM-1599)
 *
 * Public endpoint that renders the Arkova verification badge SVG.
 * Used for embedding in LinkedIn profiles, websites, and emails.
 *
 * Route: /badge/:publicId
 *
 * Renders inline SVG with appropriate content-type handling
 * for browser display and embedding.
 */

import { useParams, useSearchParams } from 'react-router-dom';
import { generateBadgeSvg, toBadgeStatus } from '@/lib/badgeSvg';

export function BadgePage() {
  const { publicId } = useParams<{ publicId: string }>();
  const [searchParams] = useSearchParams();
  const status = searchParams.get('status') ?? 'SECURED';

  if (!publicId) {
    return <div>Invalid badge request</div>;
  }

  const badgeStatus = toBadgeStatus(status);
  const svg = generateBadgeSvg(publicId, { status: badgeStatus });

  return (
    <div
      className="flex items-center justify-center min-h-screen bg-transparent"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
