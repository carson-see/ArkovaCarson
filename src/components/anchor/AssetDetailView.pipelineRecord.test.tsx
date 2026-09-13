/**
 * AssetDetailView — pipeline-record display (SCRUM-5105)
 *
 * Two independent, narrow behaviors for a pipeline-anchored public record
 * (OpenAlex, EDGAR, etc. — `metadata.pipeline_source` present):
 *
 * 1. File size: a pipeline anchor has no uploaded file, so `fileSize` is
 *    always 0/absent by design. "0 B" reads as an empty/corrupt file rather
 *    than what it actually is. A non-pipeline anchor's "0 B" (a genuinely
 *    empty uploaded file, however unlikely) is UNCHANGED.
 * 2. `authors` metadata row: `publicRecordTemplate.ts` projects `authors`
 *    as an array of `{ name, orcid? }` objects (CTO ruling), so the generic
 *    metadata dump's default JSON.stringify would show a raw object array
 *    for this one key. A narrow formatter renders it as joined names
 *    (+N more past 10) — every other metadata key's formatting is
 *    untouched.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssetDetailView } from './AssetDetailView';

const baseAnchor = {
  id: 'test-id',
  filename: 'openalex-record.pdf',
  fingerprint: 'a'.repeat(64),
  status: 'SECURED' as const,
  createdAt: '2026-08-01T10:30:00Z',
  securedAt: '2026-08-01T10:35:00Z',
  fileSize: 0,
};

describe('AssetDetailView — pipeline anchor file-size label', () => {
  it('shows "No file — metadata-only record" for a pipeline anchor with no file size', () => {
    render(
      <AssetDetailView
        anchor={{ ...baseAnchor, metadata: { pipeline_source: 'openalex', source_id: 'W123' } }}
      />
    );
    expect(screen.getByText('No file — metadata-only record')).toBeInTheDocument();
    expect(screen.queryByText('0 B')).not.toBeInTheDocument();
  });

  it('still shows "0 B" for a non-pipeline anchor with no file size (unchanged behavior)', () => {
    render(<AssetDetailView anchor={{ ...baseAnchor, metadata: null }} />);
    expect(screen.getByText(/0 B/)).toBeInTheDocument();
    expect(screen.queryByText('No file — metadata-only record')).not.toBeInTheDocument();
  });

  it('shows the real formatted size for a pipeline anchor that DOES have a file size', () => {
    render(
      <AssetDetailView
        anchor={{ ...baseAnchor, fileSize: 2048, metadata: { pipeline_source: 'openalex' } }}
      />
    );
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
    expect(screen.queryByText('No file — metadata-only record')).not.toBeInTheDocument();
  });
});

describe('AssetDetailView — authors metadata row formatting', () => {
  it('renders authors as joined names, not a raw JSON object dump', () => {
    render(
      <AssetDetailView
        anchor={{
          ...baseAnchor,
          metadata: {
            pipeline_source: 'openalex',
            authors: [
              { name: 'Jane Q. Researcher', orcid: '0000-0001-2345-6789' },
              { name: 'Alex Chen' },
            ],
          },
        }}
      />
    );
    expect(screen.getByTestId('metadata-authors-value')).toHaveTextContent('Jane Q. Researcher, Alex Chen');
    expect(screen.queryByText(/"name":"Jane/)).not.toBeInTheDocument();
    expect(screen.queryByText(/orcid/i)).not.toBeInTheDocument();
  });

  it('shows "+N more" past the first 10 authors', () => {
    const authors = Array.from({ length: 13 }, (_, i) => ({ name: `Author ${i}` }));
    render(
      <AssetDetailView anchor={{ ...baseAnchor, metadata: { pipeline_source: 'openalex', authors } }} />
    );
    const value = screen.getByTestId('metadata-authors-value');
    expect(value).toHaveTextContent('Author 0');
    expect(value).toHaveTextContent('Author 9');
    expect(value).toHaveTextContent('+3 more');
    expect(value).not.toHaveTextContent('Author 10');
  });

  it('does not change formatting for any other metadata key (concepts still JSON.stringify)', () => {
    render(
      <AssetDetailView
        anchor={{
          ...baseAnchor,
          metadata: { pipeline_source: 'openalex', concepts: ['Machine learning', 'Neural network'] },
        }}
      />
    );
    expect(screen.queryByTestId('metadata-authors-value')).not.toBeInTheDocument();
    expect(screen.getAllByText('["Machine learning","Neural network"]').length).toBeGreaterThan(0);
  });
});
