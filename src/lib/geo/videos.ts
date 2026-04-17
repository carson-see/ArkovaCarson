/**
 * GEO-11 / SCRUM-478 — schema.org VideoObject helper.
 *
 * The helper lives in the main repo (canonical source). The marketing site
 * (separate repo `carson-see/arkova-marketing`) consumes it via a mirror or
 * a future monorepo bridge, but keeping the helper here keeps tests + types
 * in the main build.
 *
 * Flow when the first Arkova explainer goes live:
 *   1. Push the video on the Arkova YouTube channel.
 *   2. Append a `VideoInventoryEntry` to `VIDEOS`.
 *   3. Inject `buildVideoObjectsJsonLd()` output via a
 *      `<script type="application/ld+json">` on the page that embeds the
 *      player.
 *   4. Validate with Google Rich Results Test:
 *      https://search.google.com/test/rich-results
 *
 * The channel URL is already advertised via `sameAs` on the Organization
 * schema (arkova-marketing/index.html). VideoObject entries are per-video.
 */

export interface VideoInventoryEntry {
  /** Canonical YouTube video ID (e.g. "dQw4w9WgXcQ"). */
  youtubeId: string;
  /** Human-readable title (schema.org `name`). */
  name: string;
  /** 1-2 sentence description (schema.org `description`). */
  description: string;
  /** ISO 8601 publish date (UTC preferred). */
  uploadDate: string;
  /** ISO 8601 duration, e.g. "PT2M30S" for 2 minutes 30 seconds. */
  duration: string;
  /** HTTPS URL of the thumbnail (1280x720 preferred). */
  thumbnailUrl: string;
  /** Canonical page URL where the video is embedded. */
  embedPage?: string;
}

/**
 * Live inventory. Empty until the first explainer lands.
 *
 * Do NOT emit schema for placeholder/unreleased videos — Google penalises
 * VideoObject pointing at missing content.
 */
export const VIDEOS: VideoInventoryEntry[] = [];

const YT_CHANNEL = 'https://www.youtube.com/channel/UCTTDFFSLxl85omCeJ9DBvrg';

/**
 * Build schema.org VideoObject JSON-LD from the inventory.
 *
 * Returns `[]` when the inventory is empty so callers can safely spread the
 * result into a page-level schema array without guarding.
 */
export function buildVideoObjectsJsonLd(
  videos: readonly VideoInventoryEntry[] = VIDEOS,
): Record<string, unknown>[] {
  return videos.map((v) => ({
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: v.name,
    description: v.description,
    thumbnailUrl: v.thumbnailUrl,
    uploadDate: v.uploadDate,
    duration: v.duration,
    contentUrl: `https://www.youtube.com/watch?v=${v.youtubeId}`,
    embedUrl: `https://www.youtube.com/embed/${v.youtubeId}`,
    publisher: { '@id': 'https://arkova.ai/#org' },
    author: { '@id': 'https://arkova.ai/#org' },
    isPartOf: { '@type': 'WebPage', url: v.embedPage ?? 'https://arkova.ai/' },
    isAccessibleForFree: true,
    inLanguage: 'en',
    potentialAction: {
      '@type': 'SeekToAction',
      target: `${YT_CHANNEL}?t={seek_to_second_number}`,
      'startOffset-input': 'required name=seek_to_second_number',
    },
  }));
}
