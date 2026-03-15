/**
 * Embed Verification Page
 *
 * Minimal wrapper around VerificationWidget for iframe embedding.
 * Route: /embed/verify/:publicId
 *
 * Designed to be embedded on third-party websites via:
 *   <iframe src="https://app.arkova.io/embed/verify/ARK-2026-001" width="400" height="500" />
 *
 * @see P6-TS-03
 */

import { useParams } from 'react-router-dom';
import { VerificationWidget } from '@/components/embed/VerificationWidget';

export function EmbedVerifyPage() {
  const { publicId } = useParams<{ publicId: string }>();

  if (!publicId) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white p-4">
        <p className="text-sm text-gray-500">Missing record ID.</p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-white p-4">
      <VerificationWidget publicId={publicId} />
    </div>
  );
}
