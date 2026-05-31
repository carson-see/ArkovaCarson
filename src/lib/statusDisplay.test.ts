/**
 * Tests for src/lib/statusDisplay.ts — human-readable status labels (SCRUM-2003).
 *
 * The module is the single source of truth for turning a raw anchor or
 * attestation status enum value into a CLAUDE.md §1.3-compliant, user-facing
 * label + semantic tone. These tests pin:
 *   1. Every known anchor_status value → expected label/tone.
 *   2. Every known attestation_status value → expected label/tone.
 *   3. Unknown / malformed input → safe title-cased fallback, never the raw
 *      enum and never a banned term.
 *   4. The output never contains a CLAUDE.md §1.3 banned term (the whole point
 *      of the story).
 *   5. The function is pure / idempotent.
 */

import { describe, it, expect } from 'vitest';
import {
  getStatusDisplay,
  getStatusLabel,
  type StatusTone,
} from './statusDisplay';
// Import the forbidden-term list straight from the copy-lint script so this
// test stays in lock-step with the canonical §1.3 enforcement and can never
// drift from it.
import { FORBIDDEN_TERMS } from '../../scripts/check-copy-terms';

// Mirrors the database.types.ts `anchor_status` enum (8 values).
const ANCHOR_STATUSES = [
  'PENDING',
  'SECURED',
  'REVOKED',
  'EXPIRED',
  'SUBMITTED',
  'BROADCASTING',
  'SUPERSEDED',
  'PENDING_RESOLUTION',
] as const;

// Mirrors the database.types.ts `attestation_status` enum (6 values).
const ATTESTATION_STATUSES = [
  'DRAFT',
  'PENDING',
  'ACTIVE',
  'REVOKED',
  'EXPIRED',
  'CHALLENGED',
] as const;

describe('getStatusDisplay — anchor_status', () => {
  const cases: Array<[string, string, StatusTone]> = [
    ['PENDING', 'Processing', 'neutral'],
    ['BROADCASTING', 'Processing', 'neutral'],
    ['SUBMITTED', 'Submitted', 'neutral'],
    ['SECURED', 'Verified', 'positive'],
    ['REVOKED', 'Revoked', 'danger'],
    ['EXPIRED', 'Expired', 'warning'],
    ['SUPERSEDED', 'Superseded', 'neutral'],
    ['PENDING_RESOLUTION', 'Needs Review', 'warning'],
  ];

  it.each(cases)('maps %s → { label: %s, tone: %s }', (status, label, tone) => {
    const result = getStatusDisplay(status);
    expect(result.label).toBe(label);
    expect(result.tone).toBe(tone);
  });

  it('maps PENDING_RESOLUTION away from its raw title-cased form', () => {
    // A naive fallback would yield "Pending Resolution"; we want "Needs Review".
    expect(getStatusDisplay('PENDING_RESOLUTION').label).not.toBe('Pending Resolution');
  });

  it('maps BROADCASTING away from the banned-adjacent raw form', () => {
    expect(getStatusDisplay('BROADCASTING').label).not.toBe('Broadcasting');
  });
});

describe('getStatusDisplay — attestation_status', () => {
  const cases: Array<[string, string, StatusTone]> = [
    ['DRAFT', 'Draft', 'neutral'],
    ['PENDING', 'Processing', 'neutral'],
    ['ACTIVE', 'Active', 'positive'],
    ['REVOKED', 'Revoked', 'danger'],
    ['EXPIRED', 'Expired', 'warning'],
    ['CHALLENGED', 'Challenged', 'warning'],
  ];

  it.each(cases)('maps %s → { label: %s, tone: %s }', (status, label, tone) => {
    const result = getStatusDisplay(status);
    expect(result.label).toBe(label);
    expect(result.tone).toBe(tone);
  });

  it('covers every attestation_status enum value with a non-raw label', () => {
    for (const status of ATTESTATION_STATUSES) {
      const { label } = getStatusDisplay(status);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(status); // never the raw uppercase enum
    }
  });
});

describe('getStatusDisplay — case / format normalisation', () => {
  it('is case-insensitive on known values', () => {
    expect(getStatusDisplay('secured').label).toBe('Verified');
    expect(getStatusDisplay('Secured').label).toBe('Verified');
    expect(getStatusDisplay('SECURED').label).toBe('Verified');
  });

  it('normalises hyphenated variants to underscore form', () => {
    expect(getStatusDisplay('pending-resolution').label).toBe('Needs Review');
  });

  it('trims surrounding whitespace', () => {
    expect(getStatusDisplay('  SECURED  ').label).toBe('Verified');
  });
});

describe('getStatusDisplay — unknown / malformed input (safe fallback)', () => {
  it('title-cases an unknown single-word status', () => {
    const { label, tone } = getStatusDisplay('QUARANTINED');
    expect(label).toBe('Quarantined');
    expect(tone).toBe('neutral');
  });

  it('title-cases an unknown snake_case status', () => {
    expect(getStatusDisplay('awaiting_signature').label).toBe('Awaiting Signature');
  });

  it('title-cases an unknown hyphenated status', () => {
    expect(getStatusDisplay('on-hold').label).toBe('On Hold');
  });

  it('never returns the raw upper-snake enum for an unknown value', () => {
    expect(getStatusDisplay('SOME_NEW_STATE').label).not.toBe('SOME_NEW_STATE');
  });

  it.each([[''], ['   ']])('returns an em-dash placeholder for blank input (%p)', (input) => {
    const { label, tone } = getStatusDisplay(input);
    expect(label).toBe('—');
    expect(tone).toBe('neutral');
  });

  it.each([[null], [undefined]])(
    'returns an em-dash placeholder for nullish input (%p)',
    (input) => {
      const { label, tone } = getStatusDisplay(input);
      expect(label).toBe('—');
      expect(tone).toBe('neutral');
    },
  );
});

describe('getStatusDisplay — §1.3 banned-term invariant', () => {
  const allInputs = [
    ...ANCHOR_STATUSES,
    ...ATTESTATION_STATUSES,
    // Adversarial unknowns whose title-cased fallback could surface a banned
    // word if the fallback were naive.
    'BLOCK',
    'BLOCK_HEIGHT',
    'HASH',
    'TRANSACTION',
    'WALLET',
    'CRYPTO',
    'BITCOIN_PENDING',
    'TOKEN_EXPIRED',
    'unknown_future_state',
    // Substring-leak adversaries: the canonical FORBIDDEN_TERMS match
    // bitcoin/blockchain/crypto/wallet/gas/transaction/mining as BARE
    // substrings (no word boundaries), so a fallback that only scrubbed
    // \b-bounded whole words would emit a banned substring here while the
    // canonical copy-lint flagged it. These pin canonical-equivalent scrubbing.
    'GASEOUS',
    'WALLETED',
    'TRANSACTIONAL',
    'CRYPTOGRAPHIC_PENDING',
    'MINING_REWARD',
    'BLOCKCHAINED',
    '',
  ];

  const forbiddenRegexes = FORBIDDEN_TERMS.map((t) => new RegExp(t, 'i'));

  it.each(allInputs)('produces no §1.3 banned term for input %p', (input) => {
    const { label } = getStatusDisplay(input);
    for (let i = 0; i < forbiddenRegexes.length; i++) {
      expect(
        forbiddenRegexes[i].test(label),
        `label "${label}" for input "${input}" matched forbidden term /${FORBIDDEN_TERMS[i]}/`,
      ).toBe(false);
    }
  });
});

describe('getStatusDisplay — fallback scrub is canonical-equivalent (bare substrings)', () => {
  // The canonical scrub in scripts/check-copy-terms.ts matches
  // bitcoin / blockchain / crypto / wallet / gas / transaction / mining as
  // BARE substrings (no \b / no custom boundary). A \b-only fallback would let
  // these through unscrubbed — passing the module's own guard but violating the
  // canonical §1.3 rule. The unknown-value fallback must be a true superset of
  // the canonical rule so it can never emit any canonical banned substring.
  it.each([
    ['GASEOUS'],
    ['WALLETED'],
    ['TRANSACTIONAL'],
    ['CRYPTOGRAPHIC_PENDING'],
    ['MINING_REWARD'],
    ['BLOCKCHAINED'],
    ['BITCOINESQUE'],
  ])('scrubs the substring-leak input %p to the safe label', (input) => {
    expect(getStatusLabel(input)).toBe('Unknown Status');
  });

  it('still title-cases an unknown value with no banned substring', () => {
    // Regression guard: the wider scrub must not over-trigger on clean inputs.
    expect(getStatusLabel('QUARANTINED')).toBe('Quarantined');
    expect(getStatusLabel('on-hold')).toBe('On Hold');
    // "BLOCKADE" contains "block" but the canonical `block` term carries
    // (?<![-\w])…(?![-\w]) boundaries, so it is NOT a bare-substring leak and
    // must survive as a normal title-cased label.
    expect(getStatusLabel('BLOCKADE')).toBe('Blockade');
  });
});

describe('getStatusDisplay — fallback scrub is canonical-equivalent (infra / §1.3 spaced terms)', () => {
  // Codex P2 / SHOULD-FIX: title-casing an UPPER_SNAKE token turns each `_` into
  // a SPACE, so an unknown status like ISSUE_CREDENTIAL / WORKER_SERVICE /
  // SERVICE_ROLE / POSTGREST_ERROR reproduces EXACTLY the spaced infra-leak
  // forms the canonical FORBIDDEN_TERMS list bans
  // (`issue credential`, `worker service`, `service role`, `postgrest`). The
  // earlier fallback omitted these (its comment wrongly claimed title-casing
  // could never reproduce a spaced/identifier term), so it would emit
  // "Issue Credential" (§1.3-restricted), "Worker Service", "Service Role", or
  // "Postgrest Error" as user-facing copy. The scrub must catch them too.
  it.each([
    ['ISSUE_CREDENTIAL'],
    ['WORKER_SERVICE'],
    ['SERVICE_ROLE'],
    ['POSTGREST_ERROR'],
  ])('scrubs the infra/§1.3 leak input %p to the safe label', (input) => {
    expect(getStatusLabel(input)).toBe('Unknown Status');
  });

  // The label must contain NONE of the canonical forbidden terms — asserted
  // against the imported FORBIDDEN_TERMS so it stays locked to §1.3 enforcement
  // and can never drift from the canonical infra/banned matchers.
  const forbiddenRegexes = FORBIDDEN_TERMS.map((t) => new RegExp(t, 'i'));
  it.each([
    ['ISSUE_CREDENTIAL'],
    ['WORKER_SERVICE'],
    ['SERVICE_ROLE'],
    ['POSTGREST_ERROR'],
  ])('emits no canonical infra/§1.3 term for input %p', (input) => {
    const { label } = getStatusDisplay(input);
    for (let i = 0; i < forbiddenRegexes.length; i++) {
      expect(
        forbiddenRegexes[i].test(label),
        `label "${label}" for input "${input}" matched forbidden term /${FORBIDDEN_TERMS[i]}/`,
      ).toBe(false);
    }
  });

  it('still title-cases a clean control with no infra/banned term', () => {
    // Control: a benign two-word unknown that shares no banned substring must
    // survive title-casing — proves the wider scrub does not over-trigger.
    expect(getStatusLabel('AWAITING_REVIEW')).toBe('Awaiting Review');
  });
});

describe('getStatusDisplay — purity / idempotency', () => {
  it('returns equal output for repeated calls (deterministic)', () => {
    const a = getStatusDisplay('SECURED');
    const b = getStatusDisplay('SECURED');
    expect(a).toEqual(b);
  });

  it('does not mutate or depend on call order', () => {
    const first = getStatusDisplay('REVOKED');
    getStatusDisplay('PENDING');
    getStatusDisplay('EXPIRED');
    const again = getStatusDisplay('REVOKED');
    expect(again).toEqual(first);
  });

  it('returns a fresh object each call (no shared mutable reference leak)', () => {
    const a = getStatusDisplay('SECURED');
    const b = getStatusDisplay('SECURED');
    expect(a).not.toBe(b);
  });
});

describe('getStatusLabel — convenience wrapper', () => {
  it('returns just the label string', () => {
    expect(getStatusLabel('SECURED')).toBe('Verified');
    expect(getStatusLabel('PENDING_RESOLUTION')).toBe('Needs Review');
    expect(getStatusLabel('unknown_state')).toBe('Unknown State');
  });

  it('agrees with getStatusDisplay().label', () => {
    for (const status of [...ANCHOR_STATUSES, ...ATTESTATION_STATUSES]) {
      expect(getStatusLabel(status)).toBe(getStatusDisplay(status).label);
    }
  });
});
