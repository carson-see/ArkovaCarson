/**
 * usePageMeta — Sets document.title and meta description for SEO (GEO-13)
 *
 * Applies on mount, restores defaults on unmount.
 */

import { useEffect } from 'react';

const DEFAULT_TITLE = 'Arkova — Document Verification & Credential Anchoring Platform';
const DEFAULT_DESCRIPTION =
  'Arkova — Secure document verification platform. Anchor credentials to an immutable record and verify them instantly.';

interface PageMeta {
  title: string;
  description?: string;
}

export function usePageMeta({ title, description }: PageMeta) {
  useEffect(() => {
    document.title = title;

    const metaDesc = document.querySelector('meta[name="description"]');
    if (description && metaDesc) {
      metaDesc.setAttribute('content', description);
    }

    return () => {
      document.title = DEFAULT_TITLE;
      if (metaDesc) {
        metaDesc.setAttribute('content', DEFAULT_DESCRIPTION);
      }
    };
  }, [title, description]);
}
