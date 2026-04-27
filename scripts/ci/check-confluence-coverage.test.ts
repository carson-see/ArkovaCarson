/**
 * Tests for check-confluence-coverage.ts (SCRUM-1207 / AUDIT-26).
 *
 * Pure tests on the SCRUM-ref parser + the missing-page detector.
 * Confluence API itself is mocked via the injected lookup.
 */
import { describe, it, expect, vi } from 'vitest';
import { extractScrumRefs, findMissingPages } from './check-confluence-coverage';

describe('extractScrumRefs', () => {
  it('extracts a single ref from PR title', () => {
    expect(extractScrumRefs('feat(SCRUM-1207): add Confluence drift guard')).toEqual(['SCRUM-1207']);
  });

  it('extracts multiple refs from a multi-story PR title (slash-chain form)', () => {
    expect(
      extractScrumRefs('fix(advisor): SCRUM-1187/1188/1189 + SCRUM-948 dashboard widget'),
    ).toEqual(['SCRUM-948', 'SCRUM-1187', 'SCRUM-1188', 'SCRUM-1189']);
  });

  it('extracts refs from PR body markdown links', () => {
    const body = '- **[SCRUM-1207](https://arkova.atlassian.net/browse/SCRUM-1207)** — adds the guard';
    expect(extractScrumRefs(body)).toEqual(['SCRUM-1207']);
  });

  it('dedupes refs across title + body + commit messages', () => {
    const text = `
      title: feat(SCRUM-1207): add guard
      body: Closes SCRUM-1207. See SCRUM-1252 for the parent rule.
      commit: SCRUM-1207 — implementation
      commit: SCRUM-1207 — tests
    `;
    expect(extractScrumRefs(text)).toEqual(['SCRUM-1207', 'SCRUM-1252']);
  });

  it('returns empty array when no SCRUM refs present', () => {
    expect(extractScrumRefs('chore(deps): bump vite to 8.0.10')).toEqual([]);
  });

  it('ignores partial / malformed refs', () => {
    expect(extractScrumRefs('SCRUM- and SCRUMX-12 and scrum-12 and SCRUM12')).toEqual([]);
  });

  it('matches SCRUM-NNNN with up to 5 digits', () => {
    expect(extractScrumRefs('SCRUM-1 SCRUM-12 SCRUM-12345')).toEqual([
      'SCRUM-1',
      'SCRUM-12',
      'SCRUM-12345',
    ]);
  });

  it('returns refs in stable sorted order', () => {
    expect(extractScrumRefs('SCRUM-999 SCRUM-100 SCRUM-50')).toEqual([
      'SCRUM-50',
      'SCRUM-100',
      'SCRUM-999',
    ]);
  });
});

describe('findMissingPages', () => {
  it('returns empty when every ref has a Confluence page', async () => {
    const lookup = vi.fn().mockResolvedValue(true);
    const missing = await findMissingPages(['SCRUM-1207', 'SCRUM-1252'], lookup);
    expect(missing).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('flags refs whose lookup returns false', async () => {
    const lookup = vi.fn().mockImplementation(async (ref: string) =>
      ref === 'SCRUM-9999' ? false : true,
    );
    const missing = await findMissingPages(['SCRUM-1207', 'SCRUM-9999'], lookup);
    expect(missing).toEqual(['SCRUM-9999']);
  });

  it('treats lookup errors as missing (fail-closed) and continues with the rest', async () => {
    const lookup = vi.fn().mockImplementation(async (ref: string) => {
      if (ref === 'SCRUM-NETERR') throw new Error('network error');
      return true;
    });
    const missing = await findMissingPages(['SCRUM-1207', 'SCRUM-NETERR'], lookup);
    expect(missing).toEqual(['SCRUM-NETERR']);
  });

  it('returns empty when no refs to check', async () => {
    const lookup = vi.fn();
    const missing = await findMissingPages([], lookup);
    expect(missing).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
});
