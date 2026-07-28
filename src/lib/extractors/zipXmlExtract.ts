/**
 * Zip-XML family text extraction (F2 / SCRUM sprint amendment A3).
 *
 * CLIENT-SIDE ONLY — runs entirely in the browser via JSZip + DOMParser.
 * Constitution §1.6: never import this in `services/worker/`.
 *
 * .odt (OpenDocument Text), .odp (OpenDocument Presentation), .pptx (Office
 * Open XML presentation), and .epub (zipped XHTML ebook) are all ZIP
 * containers holding XML/XHTML content. This module unzips the relevant
 * entries and walks the XML text nodes, inserting a line break at
 * block-level element boundaries (`<text:p>`/`<text:h>` in ODF, `<a:p>` in
 * OOXML drawingml, `<p>`/`<div>`/... in XHTML) so the output reads as
 * paragraphs rather than one run-on string.
 *
 * .ods (OpenDocument Spreadsheet) is deliberately NOT handled here — it is
 * covered by the F1 spreadsheet dual-mode workstream's SheetJS path
 * (row-mode / anchor-as-document), which needs cell/row structure that a
 * flat text-node walk would destroy. Do not add .ods to this module without
 * checking F1 first.
 *
 * `jszip` is dynamically imported so it never bloats the initial bundle
 * (matches the existing `mammoth`/`pdfjs-dist`/`tesseract.js` lazy-load
 * pattern in `ocrWorker.ts`).
 */
import type JSZip from 'jszip';

/** Defensive cap on the number of zip entries scanned for a slide/content list — guards against pathological archives. */
const MAX_ENTRIES_SCANNED = 5000;
/** Defensive cap on a single decompressed XML entry's length (chars) — guards against runaway text processing on hostile input. */
const MAX_ENTRY_TEXT_LENGTH = 20_000_000;

/** Block-level local names (namespace-prefix stripped) that should force a line break between text runs. */
const BLOCK_LOCAL_NAMES = new Set([
  'p', 'h', 'div', 'li', 'tr', 'br', 'title', 'desc', 'section', 'article', 'lb',
]);

async function loadZip(file: File): Promise<JSZip> {
  const { default: JSZipCtor } = await import('jszip');
  const arrayBuffer = await file.arrayBuffer();
  try {
    return await JSZipCtor.loadAsync(arrayBuffer);
  } catch (err) {
    throw new Error(
      `Couldn't read "${file.name}" as a zip container — the file may be corrupt or not a real ${fileExtensionLabel(file.name)} document.`,
      { cause: err },
    );
  }
}

function fileExtensionLabel(name: string): string {
  const ext = name.split('.').pop();
  return ext ? `.${ext.toLowerCase()}` : 'archive';
}

/** Parse an XML string, throwing (not crashing/hanging) on malformed content. jsdom + browsers both surface a `<parsererror>` element rather than throwing natively. */
function parseXmlOrThrow(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    throw new Error('Malformed XML content inside archive');
  }
  return doc;
}

function collectText(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent;
    if (value && value.trim().length > 0) out.push(value);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  const localName = (el.localName || el.tagName || '').toLowerCase();
  if (localName === 'script' || localName === 'style') return;

  el.childNodes.forEach((child) => collectText(child, out));

  if (BLOCK_LOCAL_NAMES.has(localName)) out.push('\n');
}

function normalizeExtractedText(parts: string[]): string {
  let result = '';
  for (const part of parts) {
    if (part === '\n') {
      result = result.replace(/[ \t]+$/, '');
      if (!result.endsWith('\n')) result += '\n';
      continue;
    }
    const trimmed = part.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    if (result && !result.endsWith('\n') && !result.endsWith(' ')) result += ' ';
    result += trimmed;
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/** Convert one XML string into normalized plain text via the block-aware text-node walk. */
function xmlToText(xml: string): string {
  const bounded = xml.length > MAX_ENTRY_TEXT_LENGTH ? xml.slice(0, MAX_ENTRY_TEXT_LENGTH) : xml;
  const doc = parseXmlOrThrow(bounded);
  const parts: string[] = [];
  collectText(doc.documentElement, parts);
  return normalizeExtractedText(parts);
}

async function readEntryText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) return '';
  return entry.async('string');
}

/**
 * ODT (OpenDocument Text) / ODP (OpenDocument Presentation) — both store
 * their body content in a single `content.xml` entry at the archive root.
 */
export async function extractTextFromOpenDocument(file: File): Promise<string> {
  const zip = await loadZip(file);
  const contentXml = await readEntryText(zip, 'content.xml');
  if (!contentXml) {
    throw new Error(`No content.xml found inside "${file.name}" — not a valid OpenDocument container.`);
  }
  return xmlToText(contentXml);
}

/** PPTX (Office Open XML presentation) — one XML entry per slide under `ppt/slides/`. */
export async function extractTextFromPptx(file: File): Promise<string> {
  const zip = await loadZip(file);

  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .slice(0, MAX_ENTRIES_SCANNED)
    .sort((a, b) => {
      const numA = Number(/slide(\d+)\.xml$/.exec(a)?.[1] ?? 0);
      const numB = Number(/slide(\d+)\.xml$/.exec(b)?.[1] ?? 0);
      return numA - numB;
    });

  if (slidePaths.length === 0) {
    throw new Error(`No slides found inside "${file.name}" — not a valid PPTX container.`);
  }

  const slideTexts: string[] = [];
  for (const path of slidePaths) {
    const xml = await readEntryText(zip, path);
    if (xml) slideTexts.push(xmlToText(xml));
  }
  return slideTexts.filter(Boolean).join('\n\n');
}

/**
 * Resolve the EPUB spine (reading order) via `META-INF/container.xml` →
 * the OPF manifest+spine. Returns `null` (rather than throwing) on any
 * structural surprise, so the caller can gracefully fall back to a
 * file-listing scan — a still-useful best-effort result rather than a
 * hard failure for a slightly nonstandard EPUB.
 */
async function resolveEpubSpine(zip: JSZip): Promise<string[] | null> {
  try {
    const containerXml = await readEntryText(zip, 'META-INF/container.xml');
    if (!containerXml) return null;

    const containerDoc = parseXmlOrThrow(containerXml);
    const rootfile = containerDoc.querySelector('rootfile');
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath) return null;

    const opfXml = await readEntryText(zip, opfPath);
    if (!opfXml) return null;

    const opfDoc = parseXmlOrThrow(opfXml);
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    const manifestById = new Map<string, string>();
    opfDoc.querySelectorAll('manifest > item').forEach((item) => {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (id && href) manifestById.set(id, opfDir + href);
    });

    const spineHrefs: string[] = [];
    opfDoc.querySelectorAll('spine > itemref').forEach((itemref) => {
      const idref = itemref.getAttribute('idref');
      const href = idref ? manifestById.get(idref) : undefined;
      if (href) spineHrefs.push(href);
    });

    return spineHrefs.length > 0 ? spineHrefs : null;
  } catch {
    return null;
  }
}

/**
 * EPUB — zipped XHTML ebook. Prefers the OPF spine's declared reading order;
 * falls back to a sorted scan of `.xhtml`/`.html`/`.htm` entries if the
 * container/OPF structure is missing or unparseable.
 */
export async function extractTextFromEpub(file: File): Promise<string> {
  const zip = await loadZip(file);

  const spinePaths = await resolveEpubSpine(zip);
  const contentPaths = (
    spinePaths ??
    Object.keys(zip.files).filter((name) => /\.(xhtml|html|htm)$/i.test(name)).sort()
  ).slice(0, MAX_ENTRIES_SCANNED);

  if (contentPaths.length === 0) {
    throw new Error(`No readable content documents found inside "${file.name}" — not a valid EPUB container.`);
  }

  const texts: string[] = [];
  for (const path of contentPaths) {
    const xml = await readEntryText(zip, path);
    if (xml) texts.push(xmlToText(xml));
  }
  return texts.filter(Boolean).join('\n\n');
}
