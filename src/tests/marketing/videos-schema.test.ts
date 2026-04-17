/**
 * Unit test for GEO-11 VideoObject schema helper at src/lib/geo/videos.ts.
 *
 * The inventory is intentionally empty in-repo; this test exercises the
 * generator with a fixture so we catch schema drift before the first video
 * lands (SCRUM-478).
 */

import { describe, it, expect } from 'vitest';

import {
  VIDEOS,
  buildVideoObjectsJsonLd,
  type VideoInventoryEntry,
} from '../../lib/geo/videos';

describe('arkova-marketing/data/videos', () => {
  it('ships with an empty inventory so no stub VideoObjects leak to Google', () => {
    expect(VIDEOS).toEqual([]);
    expect(buildVideoObjectsJsonLd()).toEqual([]);
  });

  it('renders schema.org VideoObject with required + recommended fields', () => {
    const fixture: VideoInventoryEntry = {
      youtubeId: 'abc123',
      name: 'How Arkova anchors a credential',
      description: 'A 90-second walkthrough of the verify flow.',
      uploadDate: '2026-05-01T00:00:00Z',
      duration: 'PT1M30S',
      thumbnailUrl: 'https://arkova.ai/video-thumbnails/anchor-walkthrough.jpg',
      embedPage: 'https://arkova.ai/how-it-works',
    };

    const [schema] = buildVideoObjectsJsonLd([fixture]);

    expect(schema).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: fixture.name,
      description: fixture.description,
      thumbnailUrl: fixture.thumbnailUrl,
      uploadDate: fixture.uploadDate,
      duration: fixture.duration,
      contentUrl: 'https://www.youtube.com/watch?v=abc123',
      embedUrl: 'https://www.youtube.com/embed/abc123',
      publisher: { '@id': 'https://arkova.ai/#org' },
      isAccessibleForFree: true,
      inLanguage: 'en',
    });
    expect(schema.isPartOf).toMatchObject({
      '@type': 'WebPage',
      url: fixture.embedPage,
    });
  });

  it('falls back to arkova.ai root when embedPage is omitted', () => {
    const [schema] = buildVideoObjectsJsonLd([
      {
        youtubeId: 'xyz',
        name: 'n',
        description: 'd',
        uploadDate: '2026-05-01T00:00:00Z',
        duration: 'PT1M',
        thumbnailUrl: 'https://arkova.ai/t.jpg',
      },
    ]);
    expect(schema.isPartOf).toMatchObject({ url: 'https://arkova.ai/' });
  });
});
