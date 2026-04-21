/**
 * Tests for the YouTubeExplainerEmbed component (GEO-11 / SCRUM-478).
 *
 * Ensures the component renders nothing until an inventory entry exists for
 * the slot's canonical page, and renders both the iframe and VideoObject
 * schema once a matching entry is registered. This keeps the "empty-inventory
 * produces no schema" guarantee from `src/lib/geo/videos.ts` intact.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { YouTubeExplainerEmbed } from './YouTubeExplainerEmbed';
import type { VideoInventoryEntry } from '../../lib/geo/videos';

const SAMPLE: VideoInventoryEntry = {
  youtubeId: 'demo12345AB',
  name: 'How Arkova verifies a credential',
  description: 'A 90-second walkthrough of the verify flow.',
  uploadDate: '2026-05-01',
  duration: 'PT1M30S',
  thumbnailUrl: 'https://arkova.ai/video-thumbnails/demo.jpg',
  embedPage: 'https://arkova.ai/how-it-works',
};

describe('YouTubeExplainerEmbed', () => {
  it('renders nothing when the inventory is empty', () => {
    const { container } = render(
      <YouTubeExplainerEmbed embedPage="https://arkova.ai/how-it-works" inventory={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no inventory entry matches the embedPage', () => {
    const { container } = render(
      <YouTubeExplainerEmbed
        embedPage="https://arkova.ai/how-it-works"
        inventory={[{ ...SAMPLE, embedPage: 'https://arkova.ai/other' }]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders iframe + VideoObject JSON-LD when a matching entry exists', () => {
    const { container, getByTitle } = render(
      <YouTubeExplainerEmbed
        embedPage="https://arkova.ai/how-it-works"
        inventory={[SAMPLE]}
      />,
    );

    const iframe = getByTitle(SAMPLE.name) as HTMLIFrameElement;
    expect(iframe.src).toBe(`https://www.youtube.com/embed/${SAMPLE.youtubeId}`);
    expect(iframe.getAttribute('loading')).toBe('lazy');
    expect(iframe.getAttribute('allowfullscreen')).not.toBeNull();

    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const parsed = JSON.parse(script!.innerHTML);
    expect(parsed).toMatchObject({
      '@type': 'VideoObject',
      name: SAMPLE.name,
      contentUrl: `https://www.youtube.com/watch?v=${SAMPLE.youtubeId}`,
    });
  });

  it('picks the first matching entry when multiple videos target the same page', () => {
    const second: VideoInventoryEntry = {
      ...SAMPLE,
      youtubeId: 'secondVid0',
      name: 'Second video',
    };
    const { getByTitle } = render(
      <YouTubeExplainerEmbed
        embedPage={SAMPLE.embedPage!}
        inventory={[SAMPLE, second]}
      />,
    );
    expect(getByTitle(SAMPLE.name)).toBeTruthy();
  });
});
