/**
 * Serialize a JSON-LD object for `<script type="application/ld+json">`.
 *
 * `JSON.stringify` alone is not safe to drop inside a `<script>` element:
 *
 * - `</script` closes the block, so a string field can end it and start a live
 *   script (JSON itself does not escape `/`).
 * - `<!--` puts the HTML tokenizer into script-data-escaped state; a later
 *   `<script` reaches double-escaped state, where the real closing tag no
 *   longer ends the block and the rest of the document is swallowed.
 * - U+2028 / U+2029 are legal raw inside a JSON string but are JS line
 *   terminators, so any consumer that evaluates rather than parses the block
 *   breaks on them.
 *
 * Escaping every `<` covers all three at once. It is deliberately NOT the
 * `replace(/<\/script/gi, '<\\/script')` form: that substitutes a lowercase
 * literal for whatever it matched, so `</ScRiPt>` inside a title comes back
 * out of the block as `</script>` and the payload stops round-tripping.
 *
 * `<` only ever occurs inside a JSON string literal, so the output is still
 * valid JSON that parses back to the identical value — the tests pin that.
 *
 * One helper for every JSON-LD emitter in src/ — OrganizationSchema and
 * VideoObjectSchema carried an escape inline; the static marketing pages had
 * none at all. `src/components/verification/PublicVerification.tsx` still has
 * its own broader `</` escape (T2 surface, folded in separately).
 */
export function toJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
