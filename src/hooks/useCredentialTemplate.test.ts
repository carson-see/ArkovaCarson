/**
 * useCredentialTemplate + parseTemplateFields Tests (UF-01 / AUDIT-12)
 *
 * SCRUM-5105: the authenticated branch used to query ONLY
 * `.eq('org_id', oid)`, so a PLATFORM-level template (org_id IS NULL) — the
 * shape prod holds for credential_type='PUBLICATION', used by pipeline
 * anchors (OpenAlex, EDGAR, etc., whose org_id is the pipeline owner's org,
 * never null) — was unreachable even though it exists and is_active. These
 * tests pin the new fallback: org-scoped lookup first, then a
 * `.is('org_id', null)` platform lookup only when the org query finds
 * nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { parseTemplateFields } from './useCredentialTemplate';
import type { TemplateField } from './useCredentialTemplate';

describe('parseTemplateFields', () => {
  it('returns empty array for null input', () => {
    expect(parseTemplateFields(null)).toEqual([]);
    expect(parseTemplateFields(undefined)).toEqual([]);
  });

  it('returns empty array for non-object input', () => {
    expect(parseTemplateFields('string' as never)).toEqual([]);
    expect(parseTemplateFields(42 as never)).toEqual([]);
  });

  it('returns empty array when fields is not an array', () => {
    expect(parseTemplateFields({ fields: 'not-array' })).toEqual([]);
    expect(parseTemplateFields({ other: 'data' })).toEqual([]);
  });

  it('parses valid fields correctly', () => {
    const metadata = {
      fields: [
        { key: 'name', label: 'Full Name', type: 'text', required: true },
        { key: 'gpa', label: 'GPA', type: 'number' },
        { key: 'degree', label: 'Degree Type', type: 'select', options: ['BS', 'BA', 'MS', 'PhD'] },
      ],
    };

    const result = parseTemplateFields(metadata);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ key: 'name', label: 'Full Name', type: 'text', required: true, options: undefined });
    expect(result[2].options).toEqual(['BS', 'BA', 'MS', 'PhD']);
  });

  it('defaults type to text when missing', () => {
    const metadata = { fields: [{ key: 'note', label: 'Notes' }] };
    const result = parseTemplateFields(metadata);
    expect(result[0].type).toBe('text');
  });

  it('skips invalid field objects', () => {
    const metadata = {
      fields: [
        { key: 'valid', label: 'Valid Field' },
        { key: 123, label: 'Invalid Key' }, // key not string
        null,
        'not-an-object',
        { label: 'Missing Key' }, // no key
      ],
    };

    const result = parseTemplateFields(metadata);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('valid');
  });

  it('handles TemplateField type interface', () => {
    const field: TemplateField = {
      key: 'date',
      label: 'Issue Date',
      type: 'date',
      required: true,
    };
    expect(field.type).toBe('date');
    expect(field.options).toBeUndefined();
  });
});

// A single self-referencing chain object: every chainable method returns
// the same object, and all calls converge on the shared `maybeSingle` mock.
// This lets a test control resolution purely by call ORDER (org-scoped
// query first, platform fallback second) without needing to distinguish
// which branch is calling — while `chainEq`/`chainIs` still individually
// record every call for assertions on filter arguments.
const mockMaybeSingle = vi.hoisted(() => vi.fn());
const chain = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = {};
  c.eq = vi.fn(() => c);
  c.is = vi.fn(() => c);
  c.limit = vi.fn(() => c);
  c.maybeSingle = mockMaybeSingle;
  return c;
});
const mockSelect = vi.hoisted(() => vi.fn(() => chain));
const mockFrom = vi.hoisted(() => vi.fn(() => ({ select: mockSelect })));

vi.mock('@/lib/supabase', () => ({
  supabase: { from: mockFrom },
}));

describe('useCredentialTemplate — authenticated platform-template fallback (SCRUM-5105)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('org template wins when present — platform fallback is never queried', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { name: 'Org Publication Template', default_metadata: { fields: [{ key: 'issuerName', label: 'Publisher' }] } },
      error: null,
    });

    const { useCredentialTemplate } = await import('./useCredentialTemplate');
    const { result } = renderHook(() => useCredentialTemplate('PUBLICATION', 'org-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.template?.name).toBe('Org Publication Template');
    expect(chain.eq).toHaveBeenCalledWith('org_id', 'org-1');
    // Only one query round-trip: org-scoped found a row, so `.is('org_id', null)`
    // is never called.
    expect(chain.is).not.toHaveBeenCalled();
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('platform template used when org has none', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // org-scoped: nothing
      .mockResolvedValueOnce({
        data: {
          name: 'Publication',
          default_metadata: {
            fields: [
              { key: 'issuerName', label: 'Publisher / Journal' },
              { key: 'recipientIdentifier', label: 'Author(s)' },
              { key: 'fieldOfStudy', label: 'Title' },
              { key: 'issuedDate', label: 'Publication Date' },
              { key: 'licenseNumber', label: 'DOI / ISSN' },
            ],
          },
        },
        error: null,
      });

    const { useCredentialTemplate } = await import('./useCredentialTemplate');
    const { result } = renderHook(() => useCredentialTemplate('PUBLICATION', 'org-pipeline-owner'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.template?.name).toBe('Publication');
    expect(result.current.template?.fields.map((f) => f.key)).toEqual([
      'issuerName',
      'recipientIdentifier',
      'fieldOfStudy',
      'issuedDate',
      'licenseNumber',
    ]);
    expect(chain.eq).toHaveBeenCalledWith('org_id', 'org-pipeline-owner');
    expect(chain.is).toHaveBeenCalledWith('org_id', null);
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it('resolves null when neither an org nor a platform template exists', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const { useCredentialTemplate } = await import('./useCredentialTemplate');
    const { result } = renderHook(() => useCredentialTemplate('PUBLICATION', 'org-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.template).toBeNull();
    expect(result.current.error).toBeNull();
    expect(chain.is).toHaveBeenCalledWith('org_id', null);
  });
});
