/**
 * Tests for VideoObjectSchema (GEO-11 / SCRUM-478).
 *
 * The underlying schema shape is exercised in `src/lib/geo/videos.test.ts`;
 * this file only verifies the React wrapper correctly emits a
 * `<script type="application/ld+json">` tag with the helper's output.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { VideoObjectSchema } from './VideoObjectSchema';

describe('VideoObjectSchema', () => {
  const baseProps = {
    youtubeId: 'abc123',
    name: 'How Arkova Works',
    description: 'Learn how Arkova verifies credentials using cryptographic fingerprinting.',
    thumbnailUrl: 'https://img.youtube.com/vi/abc123/maxresdefault.jpg',
    uploadDate: '2026-04-01',
    duration: 'PT3M30S',
  };

  it('renders a valid JSON-LD script tag with VideoObject payload', () => {
    const { container } = render(<VideoObjectSchema {...baseProps} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).toBeTruthy();

    const data = JSON.parse(script!.innerHTML);
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('VideoObject');
    expect(data.name).toBe(baseProps.name);
    expect(data.duration).toBe(baseProps.duration);
    expect(data.contentUrl).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('references the canonical Organization @id, not an inline Organization block', () => {
    const { container } = render(<VideoObjectSchema {...baseProps} />);
    const data = JSON.parse(container.querySelector('script')!.innerHTML);
    expect(data.publisher).toEqual({ '@id': 'https://arkova.ai/#org' });
    expect(data.author).toEqual({ '@id': 'https://arkova.ai/#org' });
  });
});
