/**
 * Unit tests for the MCP claim-parity gate (BUG-026 class).
 *
 * These run entirely on synthetic fixtures — the live-repo assertions live in
 * `tests/infra/mcp-claim-parity.test.ts`. The split is deliberate: this file
 * has to be able to construct a FAILING repo, and it cannot do that against
 * the real surfaces.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeClaimText,
  violationKey,
  checkCardDescriptionParity,
  checkReferenceCoverage,
  checkProseCoverageRatchet,
  toolRegions,
  checkClaimRules,
  applyBaseline,
  type ClaimRule,
  type ClaimSurface,
  type ToolDescriptor,
} from './check-mcp-claim-parity.js';

const CARD = 'public/.well-known/mcp/server-card.json';
const REF = 'docs/api/mcp-tools.md';

const canonical = (over: Partial<ToolDescriptor> = {}): ToolDescriptor[] => [
  { name: 'search_credentials', description: 'Search for credentials. Uses lexical substring matching.', ...over },
];

describe('normalizeClaimText', () => {
  it('collapses the whitespace that hand-copying between surfaces introduces', () => {
    expect(normalizeClaimText('a  b\n  c\t d ')).toBe('a b c d');
  });

  it('normalises the unicode dash/quote variants the two surfaces disagree on', () => {
    // The TS source writes ' and — directly; JSON hand-copies frequently
    // arrive with the ASCII forms. That difference is not a claim change and
    // must not be reported as drift.
    expect(normalizeClaimText('caller’s — org')).toBe(normalizeClaimText("caller's - org"));
  });
});

describe('checkCardDescriptionParity', () => {
  it('passes when the card description is character-identical', () => {
    const tools = canonical();
    const card = [{ name: 'search_credentials', description: tools[0].description }];
    expect(checkCardDescriptionParity(tools, card, CARD)).toEqual([]);
  });

  it('passes when the card APPENDS discovery-only guidance after the canonical text', () => {
    // 8 of the 16 live tools do exactly this (aliasing notes, conditional
    // availability, item caps). Forbidding it would either delete real agent
    // guidance or force it into the live tools/list payload.
    const tools = canonical();
    const card = [{
      name: 'search_credentials',
      description: `${tools[0].description} Alias of search; kept for v2 REST parity.`,
    }];
    expect(checkCardDescriptionParity(tools, card, CARD)).toEqual([]);
  });

  it('FAILS on the BUG-026 shape: the card restates the mechanism instead of appending', () => {
    const tools = canonical();
    const card = [{
      name: 'search_credentials',
      description: 'Search for credentials. Uses semantic similarity matching against the credential database.',
    }];
    const found = checkCardDescriptionParity(tools, card, CARD);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('card-description-parity');
    expect(found[0].subject).toBe('search_credentials');
    expect(found[0].detail).toContain('semantic similarity');
  });

  it('FAILS on a mid-string edit even when the tail still matches', () => {
    // `oracle_batch_verify` ("an envelope" vs "a response envelope") and
    // `list_agents` ("caller organization" vs "caller's organization") are
    // both this shape on the live surfaces — the hand-copy tell.
    const tools = canonical({ description: 'Use for workflows where an envelope is needed.' });
    const card = [{ name: 'search_credentials', description: 'Use for workflows where a response envelope is needed.' }];
    expect(checkCardDescriptionParity(tools, card, CARD)).toHaveLength(1);
  });

  it('FAILS when the card TRUNCATES the canonical text', () => {
    const tools = canonical();
    const card = [{ name: 'search_credentials', description: 'Search for credentials.' }];
    expect(checkCardDescriptionParity(tools, card, CARD)).toHaveLength(1);
  });

  it('FAILS when the card omits the tool entirely', () => {
    expect(checkCardDescriptionParity(canonical(), [], CARD)).toHaveLength(1);
  });

  it('FAILS CLOSED when the card carries an empty or missing description', () => {
    expect(checkCardDescriptionParity(canonical(), [{ name: 'search_credentials' }], CARD)).toHaveLength(1);
    expect(checkCardDescriptionParity(canonical(), [{ name: 'search_credentials', description: '   ' }], CARD)).toHaveLength(1);
  });
});

describe('checkReferenceCoverage', () => {
  it('passes when the complete reference names every tool', () => {
    const surface = { path: REF, text: '| 1 | `search_credentials` | ... |' };
    expect(checkReferenceCoverage(canonical(), surface)).toEqual([]);
  });

  it('FAILS when a tool the server registers is absent from the complete reference', () => {
    const found = checkReferenceCoverage(canonical(), { path: REF, text: '# MCP tools\n\nNothing here.' });
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('reference-coverage');
    expect(found[0].subject).toBe('search_credentials');
  });

  it('does not accept a SUBSTRING of another tool name as coverage', () => {
    // `verify` is a substring of `verify_credential` / `verify_batch`. A naive
    // includes() reports `verify` as documented when only `verify_batch` is.
    const tools: ToolDescriptor[] = [{ name: 'verify', description: 'd' }];
    expect(checkReferenceCoverage(tools, { path: REF, text: 'see `verify_batch` for details' })).toHaveLength(1);
    expect(checkReferenceCoverage(tools, { path: REF, text: 'see `verify` for details' })).toEqual([]);
  });

  it('requires a SINGLE-TOKEN tool name to be written as a code identifier', () => {
    // `search` and `verify` are ordinary English words. Counting the bare word
    // as documentation is how `verify-anchor` (a REST path in llms-full.txt)
    // came to satisfy coverage for the `verify` MCP tool.
    const tools: ToolDescriptor[] = [{ name: 'verify', description: 'd' }];
    expect(checkReferenceCoverage(tools, { path: REF, text: 'you can verify a document here' })).toHaveLength(1);
    expect(checkReferenceCoverage(tools, { path: REF, text: '`verify-anchor` is at the root path' })).toHaveLength(1);
    expect(checkReferenceCoverage(tools, { path: REF, text: '| 8 | `verify` | ok |' })).toEqual([]);
  });

  it('does not accept a HYPHENATED neighbour of a multi-token tool name', () => {
    const tools: ToolDescriptor[] = [{ name: 'get_anchor', description: 'd' }];
    expect(checkReferenceCoverage(tools, { path: REF, text: 'see get_anchor-legacy' })).toHaveLength(1);
    expect(checkReferenceCoverage(tools, { path: REF, text: 'see get_anchor here' })).toEqual([]);
  });
});

describe('checkProseCoverageRatchet', () => {
  const ratchet = { 'public/AGENTS.md': ['search_credentials', 'verify'] };

  it('passes when the surface still documents every ratcheted tool', () => {
    const prose: ClaimSurface[] = [{ path: 'public/AGENTS.md', text: '`search_credentials` and `verify`' }];
    expect(checkProseCoverageRatchet(prose, ratchet)).toEqual([]);
  });

  it('passes — and does not complain — when a surface documents MORE than the ratchet', () => {
    const prose: ClaimSurface[] = [{ path: 'public/AGENTS.md', text: '`search_credentials` `verify` `get_anchor`' }];
    expect(checkProseCoverageRatchet(prose, ratchet)).toEqual([]);
  });

  it('FAILS when a tool is dropped from a surface that used to document it', () => {
    const prose: ClaimSurface[] = [{ path: 'public/AGENTS.md', text: 'only `search_credentials` now' }];
    const found = checkProseCoverageRatchet(prose, ratchet);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('prose-coverage');
    expect(found[0].subject).toBe('verify');
  });

  it('FAILS CLOSED when a ratcheted surface is missing from the input entirely', () => {
    expect(checkProseCoverageRatchet([], ratchet)).toHaveLength(2);
  });
});

describe('toolRegions', () => {
  it('attributes a single-line mention (table row, llms.txt bullet) to the tool', () => {
    const text = '| 10 | `search_credentials` | Semantic search across credentials |\n| 11 | `verify` | x |';
    const regions = toolRegions(text, 'search_credentials');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain('Semantic search across credentials');
    expect(regions[0]).not.toContain('| 11 |');
  });

  it('attributes a markdown section to the tool named in its heading', () => {
    const text = [
      '## 2. `search_credentials`',
      '',
      'Uses semantic similarity matching against the database.',
      '',
      '## 3. `nessie_query`',
      '',
      'Something else entirely.',
    ].join('\n');
    const joined = toolRegions(text, 'search_credentials').join('\n');
    expect(joined).toContain('Uses semantic similarity matching');
    expect(joined).not.toContain('Something else entirely');
  });

  it('stops a section at the next heading of the SAME OR HIGHER level, not just the same level', () => {
    const text = [
      '### `search_credentials`',
      'in scope',
      '## Rate limits',
      'out of scope',
    ].join('\n');
    const joined = toolRegions(text, 'search_credentials').join('\n');
    expect(joined).toContain('in scope');
    expect(joined).not.toContain('out of scope');
  });

  it('includes a deeper sub-heading inside the tool section', () => {
    const text = ['## `search_credentials`', '### Returns', 'still in scope', '## Next', 'no'].join('\n');
    const joined = toolRegions(text, 'search_credentials').join('\n');
    expect(joined).toContain('still in scope');
    expect(joined).not.toContain('no');
  });

  it('returns nothing when the tool is not mentioned', () => {
    expect(toolRegions('nothing to see', 'search_credentials')).toEqual([]);
  });

  it('does not attribute a longer tool name to its shorter prefix', () => {
    expect(toolRegions('| `verify_batch` | batch |', 'verify')).toEqual([]);
  });

  it('does not attribute ordinary English prose to a single-token tool name', () => {
    // Without this, every sentence containing the word "search" becomes a
    // region for the `search` tool, and a claim rule blames it for a
    // neighbouring tool's wording.
    expect(toolRegions('Semantic search across the nessie corpus.', 'search')).toEqual([]);
    expect(toolRegions('| 7 | `search` | agent-friendly v2 |', 'search')).toHaveLength(1);
  });
});

describe('checkClaimRules', () => {
  const semanticRule: ClaimRule = {
    id: 'retrieval-mechanism-claim',
    tools: ['search_credentials'],
    pattern: /\bsemantic\b|\bvector (?:search|similarity|embeddings?)\b|\bembeddings?\b|\brelevance scores?\b/i,
    qualifier: /\bsearch_mode\b|\blexical\b|\bsubstring\b/i,
    reason: 'the served path is lexical substring matching',
  };

  const structural = (description: string): ClaimSurface[] => [
    { path: CARD, descriptions: { search_credentials: description } },
  ];

  it('FAILS an unqualified semantic claim on a structured surface', () => {
    const found = checkClaimRules([semanticRule], ['search_credentials'], structural('Uses semantic similarity matching.'));
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('retrieval-mechanism-claim');
    expect(found[0].surface).toBe(CARD);
  });

  it('PASSES the same claim when the description discloses the lexical fallback', () => {
    // This is the honest form the canonical source already uses: the claim is
    // not banned outright, it is banned UNQUALIFIED.
    const ok = 'Uses semantic (vector) similarity matching. Every result reports `search_mode`: '
      + '"semantic_vector", or "lexical_substring" when the service falls back to substring matching.';
    expect(checkClaimRules([semanticRule], ['search_credentials'], structural(ok))).toEqual([]);
  });

  it('catches the CLASS, not the wording — a reworded mechanism claim still fails', () => {
    // The BUG-026 fix must not be defeated by a paraphrase. None of these
    // contain the original "uses semantic similarity matching" string.
    for (const reworded of [
      'Ranks results with vector embeddings.',
      'Returns ranked results with relevance scores.',
      'Performs a semantic lookup over the credential corpus.',
    ]) {
      expect(
        checkClaimRules([semanticRule], ['search_credentials'], structural(reworded)),
        reworded,
      ).toHaveLength(1);
    }
  });

  it('does not fire on a tool the rule does not name', () => {
    const surfaces: ClaimSurface[] = [{ path: CARD, descriptions: { nessie_query: 'Uses semantic similarity.' } }];
    expect(checkClaimRules([semanticRule], ['search_credentials', 'nessie_query'], surfaces)).toEqual([]);
  });

  it('scans prose surfaces region-by-region, not whole-file', () => {
    // The semantic claim sits in ANOTHER tool's section. Whole-file scanning
    // would blame search_credentials for it.
    const text = [
      '## `search_credentials`',
      'Keyword (substring) search.',
      '## `nessie_query`',
      'Uses semantic similarity over public records.',
    ].join('\n');
    expect(checkClaimRules([semanticRule], ['search_credentials'], [{ path: REF, text }])).toEqual([]);
  });

  it('FAILS a prose table row that makes the claim', () => {
    const text = '| 10 | `search_credentials` | Semantic search across credentials | P8-S19 |';
    const found = checkClaimRules([semanticRule], ['search_credentials'], [{ path: REF, text }]);
    expect(found).toHaveLength(1);
    expect(found[0].surface).toBe(REF);
  });

  it('reports ONE violation per rule/surface/tool even when the region matches repeatedly', () => {
    // Otherwise the baseline would have to enumerate every occurrence and
    // would churn on unrelated edits to the same section.
    const text = '## `search_credentials`\nsemantic search\nmore semantic ranking\nvector embeddings too';
    expect(checkClaimRules([semanticRule], ['search_credentials'], [{ path: REF, text }])).toHaveLength(1);
  });

  it('applies a tool-less rule to every tool region on every surface', () => {
    const globalRule: ClaimRule = {
      id: 'registry-overclaim',
      tools: [],
      pattern: /listed in the credential registry/i,
      reason: 'CE approved us to publish, not a listing',
    };
    const surfaces = structural('Listed in the Credential Registry.');
    expect(checkClaimRules([globalRule], ['search_credentials'], surfaces)).toHaveLength(1);
  });
});

describe('applyBaseline', () => {
  const v = (rule: string, surface: string, subject: string) => ({
    rule, surface, subject, detail: 'd', key: violationKey({ rule, surface, subject }),
  });

  it('suppresses a violation whose key is baselined', () => {
    const violations = [v('retrieval-mechanism-claim', CARD, 'search_credentials')];
    const baseline = [{ key: violations[0].key, owner: 'PR #2236', reason: 'BUG-026 residue' }];
    const { unbaselined, stale } = applyBaseline(violations, baseline);
    expect(unbaselined).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('does NOT suppress a violation on a different surface — the baseline is per-surface', () => {
    // The whole point: the same false claim on a SIXTH surface must fail.
    const baseline = [{ key: violationKey({ rule: 'retrieval-mechanism-claim', surface: CARD, subject: 'search_credentials' }), owner: 'o', reason: 'r' }];
    const fresh = [v('retrieval-mechanism-claim', 'public/llms.txt', 'search_credentials')];
    expect(applyBaseline(fresh, baseline).unbaselined).toHaveLength(1);
  });

  it('does NOT suppress the same rule applied to a different tool', () => {
    const baseline = [{ key: violationKey({ rule: 'retrieval-mechanism-claim', surface: CARD, subject: 'search_credentials' }), owner: 'o', reason: 'r' }];
    expect(applyBaseline([v('retrieval-mechanism-claim', CARD, 'search')], baseline).unbaselined).toHaveLength(1);
  });

  it('reports a baselined violation that no longer occurs as STALE, and still passes', () => {
    // Stale entries are a notice, not a failure, on purpose: the PR that
    // finally corrects the text must not turn `main` red on merge.
    const baseline = [{ key: violationKey({ rule: 'r', surface: CARD, subject: 't' }), owner: 'o', reason: 'r' }];
    const { unbaselined, stale } = applyBaseline([], baseline);
    expect(unbaselined).toEqual([]);
    expect(stale).toHaveLength(1);
  });
});
