import { describe, expect, it, vi } from 'vitest';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { from } }));

import { commaAwareTagOptions, fetchPrivateTagSuggestions, parsePrivateTags } from './usePrivateTagSuggestions';

function queryResult(rows: unknown[]) {
  const query = {
    eq: vi.fn(() => query),
    is: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(async () => ({ data: rows, error: null })),
  };
  from.mockReturnValue({ select: vi.fn(() => query) });
  return query;
}

describe('private tag suggestions', () => {
  it('queries user and exact selected organization scopes independently', async () => {
    const query = queryResult([
      { tag: 'Quarterly', scope: 'user', org_id: null },
      { tag: 'quarterly', scope: 'user', org_id: null },
      { tag: 'Audit', scope: 'organization', org_id: 'child-1' },
      { tag: 'Parent-only', scope: 'organization', org_id: 'parent-1' },
    ]);

    await expect(fetchPrivateTagSuggestions('child-1')).resolves.toEqual({
      user: ['Quarterly'],
      organization: ['Audit'],
    });
    expect(from).toHaveBeenCalledWith('anchor_private_tags');
    expect(query.eq).toHaveBeenCalledWith('scope', 'user');
    expect(query.eq).toHaveBeenCalledWith('scope', 'organization');
    expect(query.eq).toHaveBeenCalledWith('org_id', 'child-1');
    expect(query.is).toHaveBeenCalledWith('org_id', null);
  });

  it('does not return organization suggestions for a personal submission', async () => {
    queryResult([{ tag: 'mine', scope: 'user', org_id: null }]);
    await expect(fetchPrivateTagSuggestions(null)).resolves.toEqual({ user: ['mine'], organization: [] });
  });

  it('validates per-tag length and count before submit', () => {
    expect(parsePrivateTags('legal, Legal, quarterly')).toEqual({ ok: true, tags: ['legal', 'quarterly'] });
    expect(parsePrivateTags(`${'x'.repeat(65)}, ok`)).toEqual({ ok: false, reason: 'too_long' });
    expect(parsePrivateTags(Array.from({ length: 11 }, (_, i) => `t${i}`).join(','))).toEqual({ ok: false, reason: 'too_many' });
  });

  it('offers comma-aware second and third tags without repeating chosen tags', () => {
    expect(commaAwareTagOptions('legal, q', ['legal', 'quarterly', 'quality'])).toEqual([
      'legal, quarterly', 'legal, quality',
    ]);
    expect(commaAwareTagOptions('legal, quarterly, a', ['legal', 'quarterly', 'audit'])).toEqual([
      'legal, quarterly, audit',
    ]);
  });
});
