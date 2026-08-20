#!/usr/bin/env -S npx tsx
/**
 * Wave 2 T2 soak driver — #2267 (fix/surrogate-safe-truncation-worker-sweep).
 *
 * Reproduces the exact 2026-08-17 poison-record mechanism (a slice landing
 * inside a UTF-16 surrogate pair) at each of the three call-site boundaries
 * named in the wave plan: webhook-body (500), error-message (500), and
 * registry-name / filename (255 for the CE-registry filename site). Confirms
 * (a) the OLD unsafe `.slice(0, N)` really does poison at that exact
 * boundary — the incident is reproducible, not hypothetical — and (b) the
 * fixed `truncateUtf16Safe` never does, and both encode to valid UTF-8 JSON.
 */
import { truncateUtf16Safe } from '../src/utils/utf16-truncate.js';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failures += 1;
}

/** A 4-byte astral character (U+1F600 GRINNING FACE) = a surrogate PAIR in UTF-16. */
const ASTRAL = '\u{1F600}';

/** Builds a string whose surrogate pair straddles exactly the cut point `n`. */
function poisonAt(n: number): string {
  // n-1 plain ASCII chars, then the astral pair spanning code units (n-1, n) —
  // slicing at exactly `n` code units keeps the high surrogate, drops the low.
  return 'x'.repeat(n - 1) + ASTRAL + 'y'.repeat(50);
}

/**
 * Node/browser UTF-8 encoders are WHATWG-lenient: they do not throw on a lone
 * surrogate, they silently substitute U+FFFD REPLACEMENT CHARACTER — which is
 * itself the corruption this fix exists to prevent (a byte-for-byte identity
 * round-trip is lost). PostgREST's own encoder is stricter and rejects the
 * request outright (PGRST102) rather than substituting, but "does this
 * string survive an identity UTF-8 round-trip with zero replacement
 * characters" is the accurate, Node-verifiable proxy for "is this string
 * well-formed UTF-16" without asserting Haskell-runtime behavior this driver
 * cannot execute.
 */
function survivesIdentityUtf8RoundTrip(s: string): boolean {
  const roundTripped = Buffer.from(s, 'utf8').toString('utf8');
  return roundTripped === s && !roundTripped.includes('�');
}

function endsInLoneSurrogate(s: string): boolean {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
}

// --- webhook-body / error-message boundary: maxUnits=500 -------------------
const poison500 = poisonAt(500);
const oldSlice500 = poison500.slice(0, 500);
check(
  'webhook-body/error-message boundary (500): the OLD unsafe slice really does produce a lone high surrogate (incident reproduced, not hypothetical)',
  endsInLoneSurrogate(oldSlice500),
);
check(
  'webhook-body/error-message boundary (500): the OLD unsafe slice does NOT survive an identity UTF-8 round-trip (silent corruption via U+FFFD substitution)',
  !survivesIdentityUtf8RoundTrip(oldSlice500),
);
const fixed500 = truncateUtf16Safe(poison500, 500);
check(
  'webhook-body/error-message boundary (500): truncateUtf16Safe never ends in a lone surrogate',
  !endsInLoneSurrogate(fixed500),
);
check(
  'webhook-body/error-message boundary (500): truncateUtf16Safe output survives UTF-8/JSON round-trip',
  survivesIdentityUtf8RoundTrip(fixed500),
);
check(
  'webhook-body/error-message boundary (500): fixed output is at most 500 code units',
  fixed500.length <= 500,
);

// --- registry-name / filename boundary: maxUnits=255 ------------------------
const poison255 = poisonAt(255);
const oldSlice255 = poison255.slice(0, 255);
check(
  'registry-name boundary (255): the OLD unsafe slice reproduces the same poison shape at this smaller boundary',
  endsInLoneSurrogate(oldSlice255) && !survivesIdentityUtf8RoundTrip(oldSlice255),
);
const fixed255 = truncateUtf16Safe(poison255, 255);
check(
  'registry-name boundary (255): truncateUtf16Safe is clean and JSON-safe at this boundary too',
  !endsInLoneSurrogate(fixed255) && survivesIdentityUtf8RoundTrip(fixed255) && fixed255.length <= 255,
);

function hasAnyLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true; // unpaired high
    } else if (isLow) {
      const prev = s.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true; // unpaired low
    }
  }
  return false;
}

// --- Already-malformed input (lone surrogate present in the SOURCE string,
// not created by the cut) — the toWellFormed() final-invariant guard.
// toWellFormed()'s documented contract is to REPLACE a lone surrogate with
// U+FFFD, not drop it — so the correct assertion is "no lone surrogate
// remains" (well-formed UTF-16), not "no U+FFFD appears" (U+FFFD is now a
// legitimate character in the output, not corruption).
const alreadyMalformed = 'abc\uD800def'; // lone high surrogate mid-string, no cut involved
const fixedMalformed = truncateUtf16Safe(alreadyMalformed, 100);
check(
  'toWellFormed() invariant guard handles a source string that was ALREADY malformed (not just cut-induced): no lone surrogate remains',
  !hasAnyLoneSurrogate(fixedMalformed),
);
check(
  'toWellFormed() guard replaces (not silently drops) the lone surrogate, per its documented contract',
  fixedMalformed.includes('�'),
);

// --- No-op path: input shorter than maxUnits is untouched.
check(
  'short input (no truncation needed) passes through unchanged',
  truncateUtf16Safe('hello', 500) === 'hello',
);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
