/**
 * Test-only fixture builders for the ZIP-XML family (F2).
 *
 * These build small but STRUCTURALLY REAL archives — genuine ZIP containers
 * with the actual XML shapes each format uses (ODF `content.xml`, OOXML
 * `ppt/slides/slideN.xml`, EPUB `META-INF/container.xml` + OPF spine) — via
 * JSZip, the same library the production extractor reads with. This is
 * preferred over committing opaque binary fixtures: the fixture-building
 * code is itself a readable, diffable spec of what each format contains, and
 * every test exercises the real unzip + real XML parse path end to end.
 *
 * TEST-ONLY — not imported by any production module.
 */
import JSZip from 'jszip';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function zipToFile(zip: JSZip, name: string, mimeType: string): Promise<File> {
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], name, { type: mimeType });
}

/** A genuine (minimal) OpenDocument Text — real `mimetype` + `content.xml` with `<text:p>` paragraphs. */
export async function buildOdtFixture(paragraphs: string[], name = 'fixture.odt'): Promise<File> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">\n` +
      `  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>\n` +
      `  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>\n` +
      `</manifest:manifest>`,
  );
  const body = paragraphs.map((p) => `<text:p>${escapeXml(p)}</text:p>`).join('\n');
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<office:document-content ` +
      `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
      `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">\n` +
      `  <office:body><office:text>\n${body}\n  </office:text></office:body>\n` +
      `</office:document-content>`,
  );
  return zipToFile(zip, name, 'application/vnd.oasis.opendocument.text');
}

/** A genuine (minimal) OpenDocument Presentation — `content.xml` with per-slide `draw:page` / `text:p`. */
export async function buildOdpFixture(slideParagraphs: string[][], name = 'fixture.odp'): Promise<File> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation');
  const pages = slideParagraphs
    .map(
      (paragraphs, i) =>
        `<draw:page draw:name="Slide ${i + 1}">` +
        `<draw:frame><draw:text-box>` +
        paragraphs.map((p) => `<text:p>${escapeXml(p)}</text:p>`).join('') +
        `</draw:text-box></draw:frame>` +
        `</draw:page>`,
    )
    .join('\n');
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<office:document-content ` +
      `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
      `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ` +
      `xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0">\n` +
      `  <office:body><office:presentation>\n${pages}\n  </office:presentation></office:body>\n` +
      `</office:document-content>`,
  );
  return zipToFile(zip, name, 'application/vnd.oasis.opendocument.presentation');
}

/** A genuine (minimal) OOXML PPTX — one `ppt/slides/slideN.xml` per slide, real `<a:p>`/`<a:t>` shapes. */
export async function buildPptxFixture(slideTexts: string[][], name = 'fixture.pptx'): Promise<File> {
  const zip = new JSZip();
  slideTexts.forEach((runs, idx) => {
    const paragraphs = runs
      .map((t) => `<a:p><a:r><a:t>${escapeXml(t)}</a:t></a:r></a:p>`)
      .join('');
    zip.file(
      `ppt/slides/slide${idx + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
        `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">\n` +
        `  <p:cSld><p:spTree><p:sp><p:txBody>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld>\n` +
        `</p:sld>`,
    );
  });
  return zipToFile(
    zip,
    name,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );
}

/** A genuine (minimal) EPUB — container.xml → OPF spine → XHTML chapters, real spine-order resolution. */
export async function buildEpubFixture(chapters: string[][], name = 'fixture.epub'): Promise<File> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">\n` +
      `  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n` +
      `</container>`,
  );

  const manifestItems = chapters
    .map((_, i) => `<item id="ch${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n    ');
  const spineItems = chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('\n    ');
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">\n` +
      `  <manifest>\n    ${manifestItems}\n  </manifest>\n` +
      `  <spine>\n    ${spineItems}\n  </spine>\n` +
      `</package>`,
  );

  chapters.forEach((paragraphs, i) => {
    const body = paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join('\n    ');
    zip.file(
      `OEBPS/chapter${i + 1}.xhtml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<html xmlns="http://www.w3.org/1999/xhtml">\n` +
        `  <body>\n    ${body}\n  </body>\n` +
        `</html>`,
    );
  });

  return zipToFile(zip, name, 'application/epub+zip');
}

/** A file that looks like a zip-family document by name/MIME but is NOT a valid zip — for corrupt-input tests. */
export function buildCorruptZipFixture(name: string, mimeType: string): File {
  return new File(['not-a-real-zip-container-just-garbage-bytes-0000'], name, { type: mimeType });
}
