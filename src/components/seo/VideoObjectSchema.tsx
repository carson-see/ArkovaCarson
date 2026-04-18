/**
 * VideoObject JSON-LD Schema Component (GEO-11 / SCRUM-478).
 *
 * Thin React wrapper that renders schema.org VideoObject markup for a single
 * embedded video. The shape comes from `buildVideoObjectsJsonLd` in
 * `src/lib/geo/videos.ts` so the emitted schema stays aligned with the
 * marketing-site inventory model and the canonical Organization `@id`.
 */

import { buildVideoObjectsJsonLd, type VideoInventoryEntry } from '../../lib/geo/videos';

export interface VideoObjectProps {
  /** Canonical YouTube video ID (e.g. "dQw4w9WgXcQ"). */
  youtubeId: string;
  name: string;
  description: string;
  thumbnailUrl: string;
  /** ISO 8601 (YYYY-MM-DD or full datetime). */
  uploadDate: string;
  /** ISO 8601 duration (e.g. "PT3M30S"). */
  duration: string;
  /** Canonical page URL the video is embedded on; falls back to site root. */
  embedPage?: string;
}

export function VideoObjectSchema(props: VideoObjectProps) {
  const entry: VideoInventoryEntry = props;
  const [schema] = buildVideoObjectsJsonLd([entry]);
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
