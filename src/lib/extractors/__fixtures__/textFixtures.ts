/**
 * Test-only fixture source strings for RTF (F3) and SVG (F3).
 * TEST-ONLY — not imported by any production module.
 */

/**
 * A real RTF document (matches the shape Word/TextEdit actually export):
 * `\fonttbl`/`\colortbl`/`\generator` destinations that must be dropped,
 * `\par` paragraph breaks, bold formatting control words that must produce
 * no visible artifact, a `\'92` CP-1252 hex escape (right single quote), a
 * `\bullet` named control word, and a `\uN` Unicode escape with a
 * single-character ASCII fallback that must be swallowed (trademark sign).
 */
// The trademark sign's decimal UTF-16 code unit (U+2122), computed from a
// numeric literal rather than typed as a literal `\u` escape sequence in
// this source file, so it can't be mistaken for — or silently "helpfully"
// decoded as — a JS/TS unicode escape by tooling.
const TRADEMARK_CODE_UNIT = String(0x2122);
const BACKSLASH = '\\';

const RTF_LINES = [
  String.raw`{\rtf1\ansi\ansicpg1252\deff0\nouicompat{\fonttbl{\f0\fswiss\fcharset0 Helvetica;}}`,
  String.raw`{\colortbl ;\red0\green0\blue0;}`,
  String.raw`{\*\generator Riched20 10.0.19041}\viewkind4\uc1`,
  String.raw`\pard\sa200\sl276\slmult1\f0\fs24 Founder\'92s Letter of Intent\par`,
  String.raw`This LOI is entered into by \b Acme Corp\b0  and \b Arkova\b0 .\par`,
  String.raw`Bullet points:\par`,
  String.raw`\bullet  Term: 12 months\par`,
  String.raw`\bullet  Renewal: automatic\par`,
  // RTF \uN control word: real code point + a 1-char ASCII fallback ("?")
  // that a \uc1-scoped reader must swallow.
  `Trademark test: ${BACKSLASH}uc1${BACKSLASH}u${TRADEMARK_CODE_UNIT}?${BACKSLASH}par`,
  String.raw`\pard\sa200\sl276\slmult1 Signed,\par`,
  String.raw`The Parties\par`,
  '}',
];

export const SAMPLE_RTF = RTF_LINES.join('\n');

/** An SVG with title/desc metadata + on-canvas text (including nested tspans) mixed with pure markup that must be stripped. */
export const SAMPLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <title>Arkova Anchor Seal</title>
  <desc>A tamper-evident seal for the Founder LOI batch.</desc>
  <rect x="0" y="0" width="200" height="100" fill="#0f172a" />
  <text x="10" y="30" font-size="12">Anchor ID: <tspan font-weight="bold">SCRUM-2911</tspan></text>
  <text x="10" y="50">Status: Verified</text>
</svg>`;

/** Malformed SVG (unclosed tag) — used to verify graceful (non-hanging, non-crashing) failure. */
export const CORRUPT_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><text>unclosed`;

export function fixtureFile(name: string, type: string, content: string): File {
  return new File([content], name, { type });
}
