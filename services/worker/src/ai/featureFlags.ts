/**
 * AI runtime feature flags.
 *
 * These flags select model endpoints / prompts / decoding modes at request time
 * and are controlled by Cloud Run env vars (see `docs/runbooks/v6-cutover.md`).
 * Distinct from `config.ts` (startup config snapshot) because AI flags may need
 * to be readable by the test suite after env mutation — tests flip
 * `process.env.GEMINI_V6_PROMPT` inside `beforeEach/afterEach` and expect the
 * helper to reflect the new value on the next call.
 */

/** GME2-03: Gemini Golden v6 prompt + tuned endpoint + v6 calibration knots all active together. */
export function isV6PromptActive(): boolean {
  return process.env.GEMINI_V6_PROMPT === 'true';
}
