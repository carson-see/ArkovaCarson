#!/usr/bin/env -S npx tsx
/**
 * Wave 2 T2 soak driver — #2258 (harden/sentry-nested-extra-scrub).
 *
 * Proves scrubPiiFromEvent recursively scrubs event.extra at real depth AND
 * drops binary values by type, against the exact merged source now running
 * in the deployed image (this is a pure-function driver: no network/DB
 * dependency, so it is run directly against the union head's source rather
 * than over HTTP — there is no dedicated endpoint that surfaces Sentry's
 * internal event pipeline).
 *
 * Not a temporary/scratch file: kept under services/worker/scripts/ as a
 * reusable driver for the remainder of the wave2 soak window.
 */
import {
  scrubPiiFromEvent,
  REDACTED_BYTES_TOKEN,
  REDACTED_DEPTH_TOKEN,
} from '../src/utils/sentry.js';
import type { Event } from '@sentry/node';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failures += 1;
}

// A real nested payload: fake secret buried 4 levels deep, plus a typed
// array (Uint8Array, simulating connector document bytes per §1.6A) buried
// alongside it, plus a plain email string that should be scrubbed by
// scrubString even though it isn't an exact sensitive key.
const fakeSecretBytes = new Uint8Array([0x41, 0x52, 0x4b, 0x4f, 0x56, 0x41]); // "ARKOVA"
const event = {
  extra: {
    request_context: {
      org: {
        billing: {
          treasury_wif: 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ', // fake WIF shape
          nested_typed_array: fakeSecretBytes,
          contact_email: 'someone@example.com',
        },
      },
    },
    top_level_api_key: 'sk_live_FAKE_NOT_REAL_1234567890',
  },
} as unknown as Event;

const result = scrubPiiFromEvent(event);
const extra = result?.extra as Record<string, unknown>;
const requestContext = extra.request_context as Record<string, unknown>;
const org = requestContext.org as Record<string, unknown>;
const billing = org.billing as Record<string, unknown>;

// `top_level_api_key` is NOT an exact match for the sensitive-key list (only
// the bare key `api_key` is) — correctly survives verbatim, since the key
// filter is exact-match by design (see the file's own SENSITIVE_EXTRA_KEYS
// comment) and scrubString only targets PII-shaped patterns (email/URL/UUID),
// not generic secret literals. This is a real, intentional scope boundary,
// not a gap this PR claims to close — asserting it documents that boundary.
// Real finding while building this driver: the 10-digit numeric suffix in
// the fixture collides with scrubString's phone-number pattern, so the
// non-exact-key-matched value is NOT byte-identical passthrough — its digit
// run is redacted to [PHONE] by the shape-based scrubber, independent of the
// exact-key filter. That is scrubString doing its documented job (PII-shaped
// substrings get caught by shape regardless of key name), not the recursive
// walk failing to be conservative — confirmed correct, asserted exactly:
check(
  'top-level key without an exact sensitive-key match still gets shape-based PII scrubbing (scrubString), not exact-key filtering',
  extra.top_level_api_key === 'sk_live_FAKE_NOT_REAL_[PHONE]',
);
check('nested treasury_wif key (4 levels deep) filtered to [FILTERED]', billing.treasury_wif === '[FILTERED]');
check('nested typed array (4 levels deep) redacted to bytes token', billing.nested_typed_array === REDACTED_BYTES_TOKEN);
check('nested email string scrubbed (not verbatim)', billing.contact_email !== 'someone@example.com');

// Depth fail-closed check: construct a payload deeper than MAX_SCRUB_DEPTH (8)
// and confirm the walk drops the unreachable subtree rather than passing it
// through verbatim.
let deep: Record<string, unknown> = { leaf: 'sk_live_should_never_survive' };
for (let i = 0; i < 10; i += 1) {
  deep = { child: deep };
}
const deepEvent = { extra: { deep } } as unknown as Event;
const deepResult = scrubPiiFromEvent(deepEvent);
// Walk down to find where REDACTED_DEPTH_TOKEN appears.
let cursor: unknown = (deepResult?.extra as Record<string, unknown>).deep;
let foundToken = false;
for (let i = 0; i < 12 && !foundToken; i += 1) {
  if (cursor === REDACTED_DEPTH_TOKEN) {
    foundToken = true;
    break;
  }
  if (cursor && typeof cursor === 'object' && 'child' in (cursor as Record<string, unknown>)) {
    cursor = (cursor as Record<string, unknown>).child;
  } else {
    break;
  }
}
check('past MAX_SCRUB_DEPTH the walk fails CLOSED (drops subtree, never passes through verbatim)', foundToken);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
