/**
 * Tests for VideoObjectSchema (GEO-11)
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { VideoObjectSchema } from './VideoObjectSchema';

describe('VideoObjectSchema', () => {
  const baseProps = {
    name: 'How Arkova Works',
    description: 'Learn how Arkova verifies credentials using cryptographic fingerprinting.',
    thumbnailUrl: 'https://img.youtube.com/vi/abc123/maxresdefault.jpg',
    uploadDate: '2026-04-01',
  };

  it('renders valid JSON-LD script tag', () => {
    const { container } = render(<VideoObjectSchema {...baseProps} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).toBeTruthy();

    const data = JSON.parse(script!.innerHTML);
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('VideoObject');
  });

  it('includes required fields', () => {
    const { container } = render(<VideoObjectSchema {...baseProps} />);
    const data = JSON.parse(container.querySelector('script')!.innerHTML);

    expect(data.name).toBe('How Arkova Works');
    expect(data.description).toContain('cryptographic fingerprinting');
    expect(data.thumbnailUrl).toContain('youtube.com');
    expect(data.uploadDate).toBe('2026-04-01');
  });

  it('includes publisher with Arkova default', () => {
    const { container } = render(<VideoObjectSchema {...baseProps} />);
    const data = JSON.parse(container.querySelector('script')!.innerHTML);

    expect(data.publisher['@type']).toBe('Organization');
    expect(data.publisher.name).toBe('Arkova');
  });

  it('includes optional fields when provided', () => {
    const { container } = render(
      <VideoObjectSchema
        {...baseProps}
        contentUrl="https://www.youtube.com/watch?v=abc123"
        embedUrl="https://www.youtube.com/embed/abc123"
        duration="PT3M30S"
      />,
    );
    const data = JSON.parse(container.querySelector('script')!.innerHTML);

    expect(data.contentUrl).toContain('youtube.com');
    expect(data.embedUrl).toContain('embed');
    expect(data.duration).toBe('PT3M30S');
  });

  it('omits optional fields when not provided', () => {
    const { container } = render(<VideoObjectSchema {...baseProps} />);
    const data = JSON.parse(container.querySelector('script')!.innerHTML);

    expect(data.contentUrl).toBeUndefined();
    expect(data.embedUrl).toBeUndefined();
    expect(data.duration).toBeUndefined();
  });
});
