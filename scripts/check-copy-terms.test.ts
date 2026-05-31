/**
 * CIBA-HARDEN-05 — ensure the new [A-Za-z0-9] boundaries catch the leak
 * vectors that the old \w boundaries missed.
 *
 * The old pattern `(?<![-\w])service_role(?![-\w])` failed on
 * SUPABASE_SERVICE_ROLE_KEY because `_` is a word character, so the
 * lookbehind matched adjacent `_` and rejected. Swapping to [A-Za-z0-9]
 * lets `_` act as a boundary.
 */

import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_TERMS,
  LAUNCH_BLOCKER_COPY_TERMS,
  RISKY_ENUM_FIELDS,
  type BaselineEntry,
  type Violation,
  findRawEnumRenders,
  findTermViolations,
  partitionAgainstBaseline,
  shouldCheck,
  shouldSkipLine,
  stripClassNameAttributes,
} from './check-copy-terms.js';

function matches(term: string, haystack: string): boolean {
  return new RegExp(term, 'gi').test(haystack);
}

function findTerm(substring: string): string {
  // Multiple FORBIDDEN_TERMS entries can share a substring (e.g. both
  // `(?<![-\w])hash(?![-\w])` and `(?<![-\w])block hash(?![-\w])` contain
  // "hash"). Prefer the entry whose stripped-inner-token equals the
  // substring exactly so callers asking for "hash" don't get the more
  // specific "block hash" pattern.
  const stripBoundaries = (t: string): string =>
    t
      // character-class boundaries: (?<![-\w]) / (?![A-Za-z0-9]) etc.
      .replaceAll(/\(\?<!\[[^\]]+\]\)/g, '')
      .replaceAll(/\(\?!\[[^\]]+\]\)/g, '')
      // word boundaries (SCRUM-2149 review B1): (?<!\w) / (?!\w)
      .replaceAll(/\(\?<!\\w\)/g, '')
      .replaceAll(/\(\?!\\w\)/g, '')
      .trim();
  const exactToken = FORBIDDEN_TERMS.find((t) => stripBoundaries(t) === substring);
  const term = exactToken ?? FORBIDDEN_TERMS.find((t) => t.includes(substring));
  if (!term) throw new Error(`No FORBIDDEN_TERMS entry contains "${substring}"`);
  return term;
}

describe('FORBIDDEN_TERMS — service_role / service role boundaries', () => {
  const term = findTerm('service_role');

  it('matches the service_role env-var name embedded in a larger identifier', () => {
    expect(matches(term, 'SUPABASE_SERVICE_ROLE_KEY not set')).toBe(true);
    expect(matches(term, 'Using service_role permissions')).toBe(true);
  });

  it('does not match genuinely unrelated words', () => {
    expect(matches(term, 'ideaservice_roles are outside scope')).toBe(false);
  });
});

describe('FORBIDDEN_TERMS — postgrest CamelCase', () => {
  const term = findTerm('postgrest');

  it('matches PostgRESTError case-insensitively', () => {
    expect(matches(term, 'PostgRESTError: connection reset')).toBe(true);
    expect(matches(term, 'error.PostgRESTError')).toBe(true);
  });

  it('matches plain "postgrest" references', () => {
    expect(matches(term, 'postgrest rejected the upsert')).toBe(true);
  });

  it('does not match unrelated words sharing a prefix', () => {
    expect(matches(term, 'postgresql is the DB')).toBe(false);
  });
});

describe('stripClassNameAttributes — compound-phrase bypass (SCRUM-951)', () => {
  it('strips a string-literal className value', () => {
    const out = stripClassNameAttributes(
      '<p className="text-[10px] block text-block-fg">Block Height</p>',
    );
    expect(out).not.toContain('text-[10px]');
    expect(out).toContain('Block Height');
  });

  it('strips a single-quoted className value', () => {
    const out = stripClassNameAttributes("<p className='inline-block'>Block Height</p>");
    expect(out).not.toContain('inline-block');
    expect(out).toContain('Block Height');
  });

  it('strips a brace-expression className with a template literal', () => {
    const out = stripClassNameAttributes(
      '<p className={`text-${primary} block`}>Block Height</p>',
    );
    expect(out).toContain('Block Height');
    expect(out).not.toMatch(/`text-\$\{primary\} block`/);
  });

  it('strips a brace-expression className with a function call', () => {
    const out = stripClassNameAttributes(
      "<p className={cn('inline-block', isOpen && 'block')}>Block Height</p>",
    );
    expect(out).toContain('Block Height');
    expect(out).not.toContain("'inline-block'");
  });

  it('removes JSX comments so engineering notes can mention banned terms by name', () => {
    const out = stripClassNameAttributes(
      '<div>{/* SCRUM-951 — Block Height label rename */}<p>OK</p></div>',
    );
    expect(out).not.toContain('Block Height');
    expect(out).toContain('OK');
  });

  it('preserves user-visible JSX text outside attributes', () => {
    const out = stripClassNameAttributes(
      '<button className="bg-block">Click here to view receipt</button>',
    );
    expect(out).toContain('Click here to view receipt');
  });
});

/**
 * The `isCodeIdentifier` post-filter must skip JSX components (`<Hash`),
 * closing tags (`</Hash>`), and property access (`obj.bitcoin`) — but it
 * must NOT mask user-visible copy that happens to share a prefix character.
 */
describe('isCodeIdentifier — does not over-skip user-visible copy', () => {
  it('flags banned word after a bare slash (URL-like) — bare slash is not a code prefix', () => {
    const term = findTerm('hash');
    const cleaned = stripClassNameAttributes('<p>Please visit /hash for guidance.</p>');
    const regex = new RegExp(term, 'gi');
    const match = regex.exec(cleaned);
    expect(match).not.toBeNull();
    // Without the `</` tightening, isCodeIdentifier returned true for any
    // preceding `/`, silently masking this hit.
    expect(cleaned[match!.index - 1]).toBe('/');
  });

  it('flags a banned word that follows a sentence-ending period', () => {
    const term = findTerm('postgrest');
    const cleaned = stripClassNameAttributes('<p>Done. PostgRESTError thrown.</p>');
    expect(matches(term, cleaned)).toBe(true);
  });
});

describe('FORBIDDEN_TERMS — block compound-phrase detection (SCRUM-951)', () => {
  const blockTerm = findTerm('block(');

  it('flags free-standing "Block Height" in JSX text after className strip', () => {
    const cleaned = stripClassNameAttributes(
      '<p className="text-[10px] text-[#859398]">Block Height</p>',
    );
    expect(matches(blockTerm, cleaned)).toBe(true);
  });

  it('flags "Block Hash" in JSX text after className strip', () => {
    const cleaned = stripClassNameAttributes(
      '<span className="font-mono">Block Hash</span>',
    );
    expect(matches(blockTerm, cleaned)).toBe(true);
  });

  it('does not flag Tailwind tokens like inline-block or text-block-fg', () => {
    // hyphen boundaries on both sides — never a user-copy match.
    const cleaned = stripClassNameAttributes(
      '<p className="inline-block text-block-fg">Network Checkpoint</p>',
    );
    expect(matches(blockTerm, cleaned)).toBe(false);
  });
});

describe('LAUNCH_BLOCKER_COPY_TERMS — public legal placeholder copy', () => {
  it.each(LAUNCH_BLOCKER_COPY_TERMS)('flags "%s" independently', (term) => {
    expect(matches(term, `Public page copy says ${term} to users.`)).toBe(true);
  });

  it('flags launch-blocker copy on plain multiline JSX text lines', () => {
    const violations = findTermViolations(
      'This privacy policy is a placeholder and will be updated following legal review.',
      42,
      'src/pages/PrivacyPage.tsx',
    );

    expect(violations.map((violation) => violation.term)).toEqual([
      'placeholder and will be updated',
      'following legal review',
    ]);
  });

  it('does not ban the placeholder attribute keyword by itself', () => {
    // The launch-blocker list is phrase-based. Normal form placeholder attrs
    // remain valid unless the legal launch-blocker phrase itself is present.
    for (const term of LAUNCH_BLOCKER_COPY_TERMS) {
      expect(matches(term, 'placeholder="you@example.com"')).toBe(false);
    }
  });

  it('skips block comment opener lines that mention legal review work', () => {
    const line = '/* following legal review, approved 2026-03-01 */';
    expect(shouldSkipLine(line, line.trim())).toBe(true);
  });

  it('does not globally skip visible star-prefixed copy outside block comments', () => {
    const line = '* following legal review prior to production launch';

    expect(shouldSkipLine(line, line.trim())).toBe(false);
    expect(
      findTermViolations(line, 7, 'src/pages/TermsPage.tsx').map((violation) => violation.term),
    ).toEqual(['following legal review', 'prior to production launch']);
  });
});

// =============================================================================
// SCRUM-2149 — coverage expansion (src/lib, src/hooks, packages/embed/src)
// =============================================================================

describe('shouldCheck — coverage expansion (SCRUM-2149)', () => {
  it('scans src/components and src/pages (existing scope)', () => {
    expect(shouldCheck('src/components/anchor/AssetDetailView.tsx')).toBe(true);
    expect(shouldCheck('src/pages/DashboardPage.tsx')).toBe(true);
  });

  it('now scans src/lib (the previously-blind shared utility layer)', () => {
    expect(shouldCheck('src/lib/explorer.ts')).toBe(true);
    expect(shouldCheck('src/lib/proofPackage.ts')).toBe(true);
  });

  it('still excludes the copy.ts vocabulary file itself', () => {
    expect(shouldCheck('src/lib/copy.ts')).toBe(false);
  });

  it('now scans src/hooks (previously blind)', () => {
    expect(shouldCheck('src/hooks/useActiveOrg.ts')).toBe(true);
  });

  it('now scans the PUBLIC embeddable widget (packages/embed/src)', () => {
    expect(shouldCheck('packages/embed/src/report-block.ts')).toBe(true);
    expect(shouldCheck('packages/embed/src/web-component.ts')).toBe(true);
  });

  it('keeps excluding tests, ui primitives, and treasury admin', () => {
    expect(shouldCheck('src/lib/explorer.test.ts')).toBe(false);
    expect(shouldCheck('packages/embed/src/render.test.ts')).toBe(false);
    expect(shouldCheck('src/components/ui/button.tsx')).toBe(false);
    expect(shouldCheck('src/components/admin/treasury/TreasuryPanel.tsx')).toBe(false);
  });

  it('does not scan unrelated source roots (e.g. services/worker, supabase)', () => {
    expect(shouldCheck('services/worker/src/index.ts')).toBe(false);
    expect(shouldCheck('supabase/migrations/0001_init.sql')).toBe(false);
    expect(shouldCheck('src/tests/rls/helpers.ts')).toBe(false);
  });
});

// =============================================================================
// SCRUM-2149 (b) — §1.3 term parity: testnet / mainnet / utxo / broadcast
// =============================================================================

describe('FORBIDDEN_TERMS — §1.3 chain-enum parity (SCRUM-2149b)', () => {
  it.each(['testnet', 'mainnet', 'utxo', 'broadcast'])(
    'flags "%s" in user-visible JSX text (case-insensitive)',
    (word) => {
      const term = findTerm(word);
      expect(matches(term, `<p>Anchored on the ${word} network</p>`)).toBe(true);
      expect(matches(term, `<p>Anchored on the ${word.toUpperCase()} network</p>`)).toBe(true);
    },
  );

  it('does not match these terms as a substring of a longer identifier', () => {
    // (?<![-\w]) / (?![-\w]) boundaries keep them off camel/snake identifiers.
    expect(matches(findTerm('mainnet'), 'const mainnetConfig = {}')).toBe(false);
    expect(matches(findTerm('testnet'), 'type TestnetParams = {}')).toBe(false);
    expect(matches(findTerm('broadcast'), 'function broadcastTx() {}')).toBe(false);
    expect(matches(findTerm('utxo'), 'const utxoSet = []')).toBe(false);
  });

  it('flags each new term through findTermViolations on a real JSX-text line', () => {
    const terms = findTermViolations(
      '<span>Your document was anchored to the mainnet via broadcast.</span>',
      10,
      'src/pages/PublicVerifyPage.tsx',
    ).map((v) => v.term.toLowerCase());
    expect(terms).toContain('mainnet');
    expect(terms).toContain('broadcast');
  });
});

// =============================================================================
// SCRUM-2149 (d) — identifier / type-union / object-key / URL / bare-value
// false-positive suppression. Only user-visible words must flag.
// =============================================================================

describe('findTermViolations — structural false-positive suppression (SCRUM-2149d)', () => {
  it('does not flag a banned word inside a camelCase type/identifier name', () => {
    // "Bitcoin" inside "BitcoinNetwork"; "crypto" inside "Cryptographic".
    expect(
      findTermViolations("type BitcoinNetwork = 'a' | 'b';", 11, 'src/lib/explorer.ts'),
    ).toHaveLength(0);
    expect(
      findTermViolations("const x = 'Cryptographic Proof';", 1, 'src/lib/generateAuditReport.ts')
        .map((v) => v.term.toLowerCase()),
    ).not.toContain('crypto');
  });

  it('does not flag a banned word inside an UPPER_SNAKE identifier', () => {
    expect(
      findTermViolations("BITCOIN_NETWORK: env.VITE_BITCOIN_NETWORK || 'x',", 41, 'src/lib/env.ts')
        .map((v) => v.term.toLowerCase()),
    ).not.toContain('bitcoin');
  });

  it('does not flag string-literal members of a TS type-union declaration', () => {
    const v = findTermViolations(
      "type Net = 'testnet4' | 'testnet' | 'signet' | 'mainnet';",
      11,
      'src/lib/explorer.ts',
    );
    expect(v).toHaveLength(0);
  });

  it('does not flag a banned word in object-key position', () => {
    // Record/object keys are config, not copy: `testnet: '...'`, `mainnet: '...'`.
    const v = findTermViolations("  mainnet: 'https://example.com',", 17, 'src/lib/explorer.ts');
    expect(v.map((x) => x.term.toLowerCase())).not.toContain('mainnet');
  });

  it('does not flag a banned word inside a URL string or URL path template', () => {
    expect(
      findTermViolations("  testnet: 'https://mempool.space/testnet',", 15, 'src/lib/explorer.ts'),
    ).toHaveLength(0);
    expect(
      findTermViolations('  return `${base}/block/${blockHeight}`;', 59, 'src/lib/explorer.ts')
        .map((v) => v.term.toLowerCase()),
    ).not.toContain('block');
  });

  it('does not flag a bare-value string literal (enum/list member) in code', () => {
    // `'token'` as a Set/array element; `|| 'mainnet'` as a fallback value.
    expect(
      findTermViolations("  'token',", 51, 'src/lib/sourceProvenance.ts')
        .map((v) => v.term.toLowerCase()),
    ).not.toContain('token');
    expect(
      findTermViolations("const net = cfg.net || 'mainnet';", 41, 'src/lib/env.ts')
        .map((v) => v.term.toLowerCase()),
    ).not.toContain('mainnet');
  });

  it('STILL flags a banned word that is a JSX/HTML attribute value (=" / =\')', () => {
    // The bare-value skip must NOT apply to attribute copy — only to code values.
    expect(
      findTermViolations('<input placeholder="Wallet address" />', 1, 'src/components/X.tsx')
        .map((v) => v.term.toLowerCase()),
    ).toContain('wallet');
  });

  it('STILL flags a banned word embedded mid-phrase in a quoted UI string', () => {
    // Genuine copy: the banned word is part of a longer phrase, not a bare value.
    const v = findTermViolations(
      "  fingerprint: 'A SHA-256 hash of the document contents.',",
      160,
      'src/lib/proofPackage.ts',
    ).map((x) => x.term.toLowerCase());
    expect(v).toContain('hash');
  });

  it('STILL flags free-standing banned copy in JSX text (regression guard)', () => {
    const v = findTermViolations(
      '<p className="text-xs">Block Height</p>',
      5,
      'src/components/X.tsx',
    ).map((x) => x.term.toLowerCase());
    expect(v.some((t) => t.includes('block'))).toBe(true);
  });
});

// =============================================================================
// SCRUM-2149 review B1 — hyphenated banned phrases in visible copy MUST flag.
// The `(?<![-\w])X(?![-\w])` boundary excluded a trailing/leading hyphen, so
// hero/marketing copy like `Bitcoin-anchored` slipped through. The hyphen
// carve-out is only needed for `block`/`gas` (CSS `inline-block`); the chain
// terms switch to a word-style boundary that still flags a hyphen-adjacent hit.
// =============================================================================

describe('FORBIDDEN_TERMS — hyphen-adjacent banned phrases flag (SCRUM-2149 review B1)', () => {
  it.each([
    ['<p>Bitcoin-anchored</p>', 'bitcoin'],
    ['<p>Blockchain-based</p>', 'blockchain'],
    ['<p>Crypto-secured</p>', 'crypto'],
    ['<p>UTXO-based</p>', 'utxo'],
    ['<p>Re-broadcast the receipt</p>', 'broadcast'],
  ])('flags %s (hyphen no longer masks the banned word)', (line, expected) => {
    const terms = findTermViolations(line, 1, 'src/components/X.tsx').map((v) =>
      v.term.toLowerCase(),
    );
    expect(terms).toContain(expected);
  });

  it('flags each chain term directly through its regex when hyphen-adjacent', () => {
    expect(matches(findTerm('bitcoin'), 'Bitcoin-anchored')).toBe(true);
    expect(matches(findTerm('blockchain'), 'Blockchain-based')).toBe(true);
    expect(matches(findTerm('crypto'), 'Crypto-secured')).toBe(true);
    expect(matches(findTerm('cryptocurrency'), 'Cryptocurrency-native')).toBe(true);
    expect(matches(findTerm('testnet'), 'Testnet-only feature')).toBe(true);
    expect(matches(findTerm('mainnet'), 'mainnet-ready')).toBe(true);
    expect(matches(findTerm('utxo'), 'UTXO-based ledger')).toBe(true);
    expect(matches(findTerm('broadcast'), 'Re-broadcast')).toBe(true);
  });

  it('does NOT flag the `inline-block` Tailwind token (className stripped)', () => {
    const v = findTermViolations(
      '<p className="inline-block text-block-fg">Network Checkpoint</p>',
      1,
      'src/components/X.tsx',
    ).map((x) => x.term.toLowerCase());
    expect(v.some((t) => t.includes('block'))).toBe(false);
  });

  it('does NOT flag the `BitcoinNetwork` type identifier', () => {
    expect(
      findTermViolations("type BitcoinNetwork = 'a' | 'b';", 1, 'src/lib/explorer.ts'),
    ).toHaveLength(0);
    // ...even outside a type-decl line: `crypto` inside `Cryptographic` stays clean.
    expect(
      findTermViolations("const label = 'Cryptographic Proof';", 1, 'src/lib/x.ts').map((v) =>
        v.term.toLowerCase(),
      ),
    ).not.toContain('crypto');
  });

  it('still keeps the hyphen guard for `block` and `gas` (CSS-token false positives)', () => {
    // Bare `block`/`gas` adjacent to a hyphen in visible text is intentionally
    // NOT flagged — these collide with Tailwind utilities (inline-block, etc.).
    expect(matches(findTerm('block('), 'inline-block')).toBe(false);
    expect(matches(findTerm('gas'), 'no-gas-zone')).toBe(false);
  });
});

// =============================================================================
// SCRUM-2149 review N2 — suppression bleed. The URL-path and bare-quoted-value
// suppressions must NOT fire on text that is clearly JSX-visible (between `>`
// and `<`). `<p>Testnet/Mainnet</p>` previously suppressed "Mainnet" (slash);
// `<p>"Bitcoin"</p>` / `<button>'Broadcast'</button>` suppressed the term.
// =============================================================================

describe('findTermViolations — JSX-visible suppression bleed (SCRUM-2149 review N2)', () => {
  it('flags BOTH terms in `<p>Testnet/Mainnet</p>` (URL-path suppression gated)', () => {
    const terms = findTermViolations('<p>Testnet/Mainnet</p>', 1, 'src/components/X.tsx').map((v) =>
      v.term.toLowerCase(),
    );
    expect(terms).toContain('testnet');
    expect(terms).toContain('mainnet');
  });

  it('flags a double-quoted-for-emphasis banned word in JSX text (`<p>"Bitcoin"</p>`)', () => {
    const terms = findTermViolations('<p>"Bitcoin"</p>', 1, 'src/components/X.tsx').map((v) =>
      v.term.toLowerCase(),
    );
    expect(terms).toContain('bitcoin');
  });

  it('flags a single-quoted-for-emphasis banned word in JSX text (`<button>\'Broadcast\'</button>`)', () => {
    const terms = findTermViolations(
      "<button>'Broadcast'</button>",
      1,
      'src/components/X.tsx',
    ).map((v) => v.term.toLowerCase());
    expect(terms).toContain('broadcast');
  });

  it('STILL suppresses a genuine bare in-code value string (not JSX-visible)', () => {
    // The N2 gate must only lift suppression for JSX-visible text — bare code
    // values like `|| 'mainnet'` and `'token'` must remain suppressed.
    expect(
      findTermViolations("const net = cfg.net || 'mainnet';", 1, 'src/lib/env.ts').map((v) =>
        v.term.toLowerCase(),
      ),
    ).not.toContain('mainnet');
    expect(
      findTermViolations("  'token',", 51, 'src/lib/sourceProvenance.ts').map((v) =>
        v.term.toLowerCase(),
      ),
    ).not.toContain('token');
  });

  it('STILL suppresses a banned word inside a quoted URL value (not JSX-visible)', () => {
    expect(
      findTermViolations("  testnet: 'https://mempool.space/testnet',", 1, 'src/lib/explorer.ts'),
    ).toHaveLength(0);
  });
});

// =============================================================================
// SCRUM-2149 review N1 — raw-enum heuristic must catch leading text before the
// expression: `<div>Label: {row.status}</div>` is a JSX child even though text
// precedes the `{`. Clean false-positives (attr / template / key / comparison)
// must still NOT flag.
// =============================================================================

describe('findRawEnumRenders — leading-text JSX child (SCRUM-2149 review N1)', () => {
  it('flags `<div>Label: {row.status}</div>` (text precedes the expression)', () => {
    const v = findRawEnumRenders('<div>Label: {row.status}</div>', 1, 'src/components/X.tsx');
    expect(v).toHaveLength(1);
    expect(v[0].term).toContain('row.status');
  });

  it('flags a leading-text child with trailing text too (`>Type: {x.credential_type} (beta)<`)', () => {
    const v = findRawEnumRenders(
      '          <span>Type: {x.credential_type} (beta)</span>',
      1,
      'src/components/X.tsx',
    );
    expect(v).toHaveLength(1);
    expect(v[0].term).toContain('credential_type');
  });

  it('integrates through findTermViolations for a leading-text .tsx child', () => {
    const v = findTermViolations('<div>Label: {row.status}</div>', 1, 'src/pages/Foo.tsx');
    expect(v.some((x) => x.term.includes('row.status'))).toBe(true);
  });

  it('does NOT flag attribute pass-through even with leading text on the line', () => {
    expect(
      findRawEnumRenders('  <div>Status</div> <StatusBadge status={x.status} />', 1, 'src/components/X.tsx'),
    ).toHaveLength(0);
  });

  it('does NOT flag a template interpolation even with leading JSX on the line', () => {
    expect(
      findRawEnumRenders('  <p>x</p>; throw new Error(`HTTP ${res.status}`);', 1, 'src/components/X.tsx'),
    ).toHaveLength(0);
  });

  it('does NOT flag a key={x.status} prop with leading text', () => {
    expect(
      findRawEnumRenders('  <ul><li key={x.status}>{x.label}</li></ul>', 1, 'src/components/X.tsx'),
    ).toHaveLength(0);
  });

  it('does NOT flag an `x.status === ...` comparison (no brace-wrapped child)', () => {
    expect(
      findRawEnumRenders('  {x.status === "active" ? <A/> : <B/>}', 1, 'src/components/X.tsx'),
    ).toHaveLength(0);
  });
});

// =============================================================================
// SCRUM-2149 (c) — raw DB-enum render heuristic. A bare {X.<riskyfield>} as a
// JSX expression-child dumps a DB enum to users without a display mapper.
// =============================================================================

describe('findRawEnumRenders — raw enum JSX-child detection (SCRUM-2149c)', () => {
  it('exposes a small, curated set of risky fields', () => {
    expect(RISKY_ENUM_FIELDS).toEqual(
      expect.arrayContaining(['status', 'anchor_status', 'network', 'credential_type']),
    );
    // Keep the set small/conservative.
    expect(RISKY_ENUM_FIELDS.length).toBeLessThanOrEqual(8);
  });

  it('flags a bare {x.status} JSX expression child on its own line', () => {
    const v = findRawEnumRenders('            {result.status}', 72, 'src/components/search/Foo.tsx');
    expect(v).toHaveLength(1);
    expect(v[0].term).toContain('result.status');
    expect(v[0].line).toBe(72);
  });

  it('flags an inline >{x.credential_type}< JSX child', () => {
    const v = findRawEnumRenders(
      '          <Badge className="text-[10px]">{r.credential_type}</Badge>',
      427,
      'src/pages/AdminUserDetailPage.tsx',
    );
    expect(v).toHaveLength(1);
    expect(v[0].term).toContain('credential_type');
  });

  it('flags optional-chained {x?.anchor_status} children', () => {
    const v = findRawEnumRenders('  {anchor?.anchor_status}', 5, 'src/components/X.tsx');
    expect(v).toHaveLength(1);
  });

  it('does NOT flag a template-literal interpolation ${res.status} (HTTP code)', () => {
    expect(
      findRawEnumRenders('  throw new Error(`HTTP ${res.status}`);', 63, 'src/components/X.tsx'),
    ).toHaveLength(0);
    expect(
      findRawEnumRenders('  setError(`Request failed (${response.status})`);', 9, 'src/components/X.tsx'),
    ).toHaveLength(0);
  });

  it('does NOT flag a JSX attribute pass-through status={x.status}', () => {
    // Passing the enum into a mapper component is the CORRECT pattern.
    expect(
      findRawEnumRenders('        <StatusBadge status={job.status} />', 110, 'src/components/X.tsx'),
    ).toHaveLength(0);
    expect(
      findRawEnumRenders('  variant={subscription.status === "active" ? "a" : "b"}', 1, 'src/components/X.tsx'),
    ).toHaveLength(0);
  });

  it('does NOT flag fields outside the curated risky set', () => {
    expect(findRawEnumRenders('  {item.public_id}', 1, 'src/components/X.tsx')).toHaveLength(0);
    expect(findRawEnumRenders('  {user.email}', 1, 'src/components/X.tsx')).toHaveLength(0);
  });

  it('does NOT flag in non-.tsx files (heuristic is JSX-only)', () => {
    expect(findRawEnumRenders('  {x.status}', 1, 'src/lib/helper.ts')).toHaveLength(0);
    expect(findRawEnumRenders('  {x.status}', 1, 'packages/embed/src/report-block.ts')).toHaveLength(0);
  });

  it('integrates into findTermViolations for .tsx files', () => {
    // findTermViolations is the single per-line entry point checkFile uses.
    const v = findTermViolations('            {result.status}', 72, 'src/pages/Foo.tsx');
    expect(v.some((x) => x.term.includes('result.status'))).toBe(true);
  });
});

// =============================================================================
// SCRUM-2148 — grandfather baseline partitioning. The hardened linter must
// PASS on recorded pre-existing violations and FAIL only on NEW ones.
// =============================================================================

describe('partitionAgainstBaseline — grandfather logic (SCRUM-2148)', () => {
  const baseline: BaselineEntry[] = [
    { file: 'src/pages/A.tsx', line: 10, term: 'hash', reason: 'locked by PR #964' },
    { file: 'src/pages/B.tsx', line: 20, term: 'raw enum render: {x.status}', reason: 'SCRUM-2003 track' },
  ];

  const v = (file: string, line: number, term: string): Violation => ({ file, line, term, context: '' });

  it('classifies a violation present in the baseline as grandfathered (not new)', () => {
    const { fresh, grandfathered, stale } = partitionAgainstBaseline(
      [v('src/pages/A.tsx', 10, 'hash')],
      baseline,
    );
    expect(fresh).toHaveLength(0);
    expect(grandfathered).toHaveLength(1);
    expect(stale).toHaveLength(1); // B.tsx:20 was expected but not seen this run
  });

  it('classifies an unrecorded violation as NEW (fails the build)', () => {
    const { fresh } = partitionAgainstBaseline(
      [v('src/pages/A.tsx', 10, 'hash'), v('src/pages/C.tsx', 99, 'wallet')],
      baseline,
    );
    expect(fresh.map((x) => x.file)).toEqual(['src/pages/C.tsx']);
  });

  it('treats a baselined file at a DIFFERENT line as a new violation (line drift)', () => {
    const { fresh } = partitionAgainstBaseline([v('src/pages/A.tsx', 11, 'hash')], baseline);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].line).toBe(11);
  });

  it('treats a DIFFERENT term on a grandfathered file:line as a FRESH violation (same-line blind-spot regression)', () => {
    // P1 fix (SCRUM-2149 review): including `term` in the match key means a
    // second (or different) violation on an already-baselined line is reported
    // as NEW and fails the build — closing the silent-toleration blind spot.
    const { fresh, grandfathered } = partitionAgainstBaseline(
      [v('src/pages/B.tsx', 20, 'raw enum render: {x.anchor_status}')],
      baseline,
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0].term).toBe('raw enum render: {x.anchor_status}');
    expect(grandfathered).toHaveLength(0);
  });

  it('grandfathers the exact baselined term and passes a second different term on the same line as fresh', () => {
    // If a line already has a grandfathered violation AND a new violation appears
    // on the same line (e.g. a forbidden term added to a line that already had a
    // raw-enum render), only the baselined one is tolerated; the new one fails.
    const { fresh, grandfathered } = partitionAgainstBaseline(
      [
        v('src/pages/B.tsx', 20, 'raw enum render: {x.status}'), // exact baseline term — grandfathered
        v('src/pages/B.tsx', 20, 'wallet'),                       // new violation on same line — fresh
      ],
      baseline,
    );
    expect(grandfathered).toHaveLength(1);
    expect(grandfathered[0].term).toBe('raw enum render: {x.status}');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].term).toBe('wallet');
  });

  it('reports baseline entries with no matching current violation as STALE', () => {
    const { stale } = partitionAgainstBaseline([], baseline);
    expect(stale).toHaveLength(2);
    expect(stale.map((e) => e.file).sort((a, b) => a.localeCompare(b))).toEqual([
      'src/pages/A.tsx',
      'src/pages/B.tsx',
    ]);
  });

  it('normalises path separators so OS-specific paths still match', () => {
    const { fresh } = partitionAgainstBaseline(
      [v(String.raw`src\pages\A.tsx`, 10, 'hash')],
      baseline,
    );
    expect(fresh).toHaveLength(0);
  });
});

describe('copy-terms-baseline.json — shipped baseline is well-formed (SCRUM-2148)', () => {
  it('every entry has file, line, term, and a non-empty reason', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, 'ci/snapshots/copy-terms-baseline.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { violations: BaselineEntry[] };
    expect(Array.isArray(parsed.violations)).toBe(true);
    expect(parsed.violations.length).toBeGreaterThan(0);
    for (const e of parsed.violations) {
      expect(typeof e.file).toBe('string');
      expect(e.file.length).toBeGreaterThan(0);
      expect(Number.isInteger(e.line)).toBe(true);
      expect(typeof e.term).toBe('string');
      expect(typeof e.reason).toBe('string');
      expect(e.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
