/**
 * YouTubeExplainerEmbed — GEO-11 / SCRUM-478.
 *
 * Declarative slot that pairs a YouTube iframe embed with its schema.org
 * `VideoObject` JSON-LD. Pages reserve a slot by `embedPage` (their canonical
 * URL); when an entry matching that URL is appended to
 * `src/lib/geo/videos.ts :: VIDEOS`, the slot lights up automatically — no
 * further page changes required.
 *
 * The component renders nothing when no matching entry exists. That protects
 * the "no placeholder VideoObject schema" invariant from `videos.ts` while
 * still letting us pre-wire the embed location on pages that will carry an
 * explainer video once production is complete.
 */

import { VideoObjectSchema } from './VideoObjectSchema';
import { VIDEOS, type VideoInventoryEntry } from '../../lib/geo/videos';

export interface YouTubeExplainerEmbedProps {
  /** Canonical URL of the page reserving this slot (matched against VideoInventoryEntry.embedPage). */
  embedPage: string;
  /** Override inventory (tests only; production callers omit this and read from VIDEOS). */
  inventory?: readonly VideoInventoryEntry[];
  /** Optional Tailwind overrides for the iframe wrapper. */
  className?: string;
}

export function YouTubeExplainerEmbed({
  embedPage,
  inventory = VIDEOS,
  className,
}: YouTubeExplainerEmbedProps) {
  const video = inventory.find((v) => v.embedPage === embedPage);
  if (!video) return null;

  const wrapper =
    className ??
    'relative mx-auto w-full max-w-3xl overflow-hidden rounded-xl border bg-black shadow-sm aspect-video';

  return (
    <>
      <VideoObjectSchema {...video} />
      <div className={wrapper}>
        <iframe
          title={video.name}
          src={`https://www.youtube.com/embed/${video.youtubeId}`}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          className="absolute inset-0 h-full w-full"
        />
      </div>
    </>
  );
}
