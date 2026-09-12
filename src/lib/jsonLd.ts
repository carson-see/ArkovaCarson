/**
 * Serialize a JSON-LD object for `<script type="application/ld+json">`.
 *
 * `</script` inside any string field would close the block and start a live
 * script (JSON itself does not escape `/`). The replacement keeps the payload
 * valid JSON (`<\/script` parses back to `</script`). One helper for every
 * JSON-LD emitter in src/ — OrganizationSchema and VideoObjectSchema carried
 * this inline; the static marketing pages had no escape at all.
 */
export function toJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}
