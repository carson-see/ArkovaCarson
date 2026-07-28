/**
 * SVG text extraction (F3 / SCRUM sprint amendment A3).
 *
 * CLIENT-SIDE ONLY — uses the browser's native `DOMParser`. No network, no
 * file-system access. Constitution §1.6: never import this in
 * `services/worker/`.
 *
 * SVG is XML. We don't want the raw markup (attribute soup, path data,
 * transform matrices) — only the human-readable content: `<title>` and
 * `<desc>` (accessibility/metadata text) and `<text>` (visible on-canvas
 * labels, including nested `<tspan>` runs, which `textContent` already
 * folds in).
 */

/** Parse malformed SVG/XML defensively: jsdom + browsers both emit a `<parsererror>` element instead of throwing. */
function parseXmlOrThrow(source: string, mimeType: DOMParserSupportedType): Document {
  const doc = new DOMParser().parseFromString(source, mimeType);
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    throw new Error('Malformed SVG markup — could not parse as XML');
  }
  return doc;
}

/**
 * Extract visible/labeling text from an SVG document: `<title>`, `<desc>`,
 * and `<text>` (with nested `<tspan>` content included via `textContent`),
 * in document order, markup stripped.
 */
export function extractTextFromSvg(svgSource: string): string {
  const doc = parseXmlOrThrow(svgSource, 'image/svg+xml');

  // querySelectorAll on an XML document matches by local name regardless of
  // the default SVG namespace, so a plain selector list is sufficient here.
  const nodes = doc.querySelectorAll('title, desc, text');

  const parts: string[] = [];
  nodes.forEach((el) => {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  });

  return parts.join('\n').trim();
}
