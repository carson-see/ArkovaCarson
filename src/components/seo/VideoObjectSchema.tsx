/**
 * VideoObject JSON-LD Schema Component (GEO-11)
 *
 * Renders schema.org VideoObject markup for embedded videos.
 * Improves discoverability in Google, Gemini, and AI search engines.
 */

export interface VideoObjectProps {
  name: string;
  description: string;
  thumbnailUrl: string;
  uploadDate: string;
  contentUrl?: string;
  embedUrl?: string;
  duration?: string; // ISO 8601 format (e.g., "PT3M30S")
  publisher?: string;
}

export function VideoObjectSchema({
  name,
  description,
  thumbnailUrl,
  uploadDate,
  contentUrl,
  embedUrl,
  duration,
  publisher = 'Arkova',
}: VideoObjectProps) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name,
    description,
    thumbnailUrl,
    uploadDate,
    ...(contentUrl ? { contentUrl } : {}),
    ...(embedUrl ? { embedUrl } : {}),
    ...(duration ? { duration } : {}),
    publisher: {
      '@type': 'Organization',
      name: publisher,
      logo: {
        '@type': 'ImageObject',
        url: 'https://app.arkova.ai/arkova-icon.png',
      },
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
