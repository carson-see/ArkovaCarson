/**
 * Tests for SCRUM-1086 anonymization helper.
 *
 * The 9-row SQL truth table from migration `0264_get_org_members_public.sql`
 * (verified against prod 2026-04-25 via Supabase MCP) is mirrored exactly so
 * the TS implementation cannot drift from the server-side authority.
 */
import { describe, it, expect } from 'vitest';
import { anonymizeMemberDisplayName } from './anonymizeMember';

describe('anonymizeMemberDisplayName — mirror of SQL anonymize_member_display_name', () => {
  it.each([
    // [input, expected, why]
    [null, 'Anonymous member', 'null falls back to safe label'],
    [undefined, 'Anonymous member', 'undefined falls back to safe label'],
    ['', 'Anonymous member', 'empty falls back'],
    ['   ', 'Anonymous member', 'whitespace-only falls back'],
    ['Cher', 'Anonymous member', 'single-token names fall back (cannot derive last name)'],
    ['Casey Privacy', 'C. Privacy', 'first + last → initial + last'],
    ['Casey M Privacy', 'C. Privacy', 'middle name dropped — only first + last token'],
    ['Anna Maria Smith', 'A. Smith', 'three tokens → first initial + last'],
    ['casey privacy', 'c. privacy'.replace('c', 'C'), 'lowercase first → uppercased initial; last preserved as-is'],
    ['   Casey   Privacy ', 'C. Privacy', 'extra whitespace tolerated'],
    ['Carson Seeger', 'C. Seeger', 'real prod row (public profile would never see this — sanity)'],
    ['Sarah Rushton', 'S. Rushton', 'real prod row anonymized form (private profile)'],
  ])('anonymizeMemberDisplayName(%j) === %j (%s)', (input, expected, _description) => {
    expect(anonymizeMemberDisplayName(input)).toBe(expected);
  });

  it('never returns the original full name for any non-empty input with two+ tokens', () => {
    const samples = ['John Smith', 'Mary-Jane Watson', 'Søren Kierkegaard'];
    for (const s of samples) {
      const out = anonymizeMemberDisplayName(s);
      expect(out).not.toBe(s);
      // Initial + ". " + something
      expect(out).toMatch(/^[A-Z]\. .+$/);
    }
  });

  it('output never contains the first name beyond its initial (PII boundary)', () => {
    expect(anonymizeMemberDisplayName('Casey Privacy')).not.toContain('Casey');
    expect(anonymizeMemberDisplayName('Anonymous Person')).not.toContain('Anonymous');
  });
});
