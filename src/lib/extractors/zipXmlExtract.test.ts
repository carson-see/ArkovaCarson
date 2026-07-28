/**
 * Tests for zipXmlExtract.ts — ZIP-XML family text extraction (F2):
 * .odt / .odp (OpenDocument), .pptx (OOXML presentation), .epub.
 *
 * Fixtures are built with real JSZip archives (`__fixtures__/buildZipFixtures.ts`)
 * containing the genuine XML shapes each format uses — this exercises the
 * real unzip + real XML parse path end to end, not a mocked shortcut.
 *
 * Constitution §1.6: this module is CLIENT-SIDE ONLY. See
 * `no-worker-import.test.ts` for the automated guard.
 */
import { describe, it, expect } from 'vitest';
import {
  extractTextFromOpenDocument,
  extractTextFromPptx,
  extractTextFromEpub,
} from './zipXmlExtract';
import {
  buildOdtFixture,
  buildOdpFixture,
  buildPptxFixture,
  buildEpubFixture,
  buildCorruptZipFixture,
} from './__fixtures__/buildZipFixtures';

describe('extractTextFromOpenDocument — .odt', () => {
  it('extracts real paragraph text from a genuine ODT archive', async () => {
    const file = await buildOdtFixture([
      'Founder Letter of Intent',
      'This LOI is entered into by Acme Corp and Arkova.',
      'Term: 12 months.',
    ]);

    const text = await extractTextFromOpenDocument(file);

    expect(text).toContain('Founder Letter of Intent');
    expect(text).toContain('This LOI is entered into by Acme Corp and Arkova.');
    expect(text).toContain('Term: 12 months.');
  });

  it('separates paragraphs with real line breaks, not one run-on string', async () => {
    const file = await buildOdtFixture(['First paragraph.', 'Second paragraph.']);
    const text = await extractTextFromOpenDocument(file);
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toContain('First paragraph.');
    expect(lines).toContain('Second paragraph.');
  });

  it('strips XML markup — no element/attribute names leak into the output', async () => {
    const file = await buildOdtFixture(['Plain content only.']);
    const text = await extractTextFromOpenDocument(file);
    expect(text).not.toContain('office:document-content');
    expect(text).not.toContain('text:p');
    expect(text).not.toContain('<');
  });

  it('rejects a corrupt (non-zip) file with a clear error, not a hang or crash', async () => {
    const file = buildCorruptZipFixture('corrupt.odt', 'application/vnd.oasis.opendocument.text');
    await expect(extractTextFromOpenDocument(file)).rejects.toThrow();
  });

  it('rejects a valid zip with no content.xml', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'empty.odt', { type: 'application/vnd.oasis.opendocument.text' });
    await expect(extractTextFromOpenDocument(file)).rejects.toThrow(/content\.xml/);
  });
});

describe('extractTextFromOpenDocument — .odp (same content.xml path as .odt)', () => {
  it('extracts real slide text from a genuine ODP archive', async () => {
    const file = await buildOdpFixture([
      ['Welcome Slide', 'Arkova anchors your evidence.'],
      ['Pricing', 'Subscription + credits.'],
    ]);

    const text = await extractTextFromOpenDocument(file);

    expect(text).toContain('Welcome Slide');
    expect(text).toContain('Arkova anchors your evidence.');
    expect(text).toContain('Pricing');
    expect(text).toContain('Subscription + credits.');
  });
});

describe('extractTextFromPptx — .pptx', () => {
  it('extracts real per-slide text from a genuine PPTX archive, in slide order', async () => {
    const file = await buildPptxFixture([
      ['Slide One Title', 'Slide one body text.'],
      ['Slide Two Title', 'Slide two body text.'],
      ['Slide Three Title'],
    ]);

    const text = await extractTextFromPptx(file);

    expect(text).toContain('Slide One Title');
    expect(text).toContain('Slide one body text.');
    expect(text).toContain('Slide Two Title');
    expect(text).toContain('Slide Three Title');
    // Order preserved: slide 1 content appears before slide 3 content.
    expect(text.indexOf('Slide One Title')).toBeLessThan(text.indexOf('Slide Three Title'));
  });

  it('sorts slides numerically, not lexically (slide2 before slide10)', async () => {
    const slides = Array.from({ length: 11 }, (_, i) => [`Marker-${i + 1}`]);
    const file = await buildPptxFixture(slides);
    const text = await extractTextFromPptx(file);
    expect(text.indexOf('Marker-2')).toBeLessThan(text.indexOf('Marker-10'));
  });

  it('strips OOXML drawingml markup — no <a:t>/<a:p> tags leak into the output', async () => {
    const file = await buildPptxFixture([['Clean text only.']]);
    const text = await extractTextFromPptx(file);
    expect(text).not.toContain('a:t');
    expect(text).not.toContain('a:p');
    expect(text).not.toContain('<');
  });

  it('rejects a corrupt (non-zip) file with a clear error, not a hang or crash', async () => {
    const file = buildCorruptZipFixture(
      'corrupt.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    await expect(extractTextFromPptx(file)).rejects.toThrow();
  });

  it('rejects a valid zip with no ppt/slides/*.xml entries', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'no-slides.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    await expect(extractTextFromPptx(file)).rejects.toThrow(/slides/);
  });
});

describe('extractTextFromEpub — .epub', () => {
  it('extracts real chapter text from a genuine EPUB archive, following the OPF spine order', async () => {
    const file = await buildEpubFixture([
      ['Chapter One', 'It was the best of times.'],
      ['Chapter Two', 'It was the worst of times.'],
    ]);

    const text = await extractTextFromEpub(file);

    expect(text).toContain('Chapter One');
    expect(text).toContain('It was the best of times.');
    expect(text).toContain('Chapter Two');
    expect(text.indexOf('Chapter One')).toBeLessThan(text.indexOf('Chapter Two'));
  });

  it('strips XHTML markup — no tag names leak into the output', async () => {
    const file = await buildEpubFixture([['Clean chapter text.']]);
    const text = await extractTextFromEpub(file);
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('<html');
    expect(text).not.toContain('<');
  });

  it('falls back to a sorted file scan when META-INF/container.xml is missing', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('chapter1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Fallback chapter text.</p></body></html>');
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'no-container.epub', { type: 'application/epub+zip' });

    const text = await extractTextFromEpub(file);
    expect(text).toContain('Fallback chapter text.');
  });

  it('rejects a corrupt (non-zip) file with a clear error, not a hang or crash', async () => {
    const file = buildCorruptZipFixture('corrupt.epub', 'application/epub+zip');
    await expect(extractTextFromEpub(file)).rejects.toThrow();
  });

  it('rejects a valid zip with no readable content documents', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], 'empty.epub', { type: 'application/epub+zip' });
    await expect(extractTextFromEpub(file)).rejects.toThrow(/EPUB/);
  });
});
