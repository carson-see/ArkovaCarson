/**
 * decode-pdf.mjs — PR #2528 evidence, step 2c (decode the QR AS EMBEDDED).
 *
 * The certificate paints its QR as vector fill rectangles (`drawQrMatrix` →
 * `doc.rect(..., 'F')` → PDF `re`/`f` ops), not as an image XObject, so there
 * is no image to extract: the page has to be rasterised. Two independent
 * renderers are used so the result cannot be an artefact of one of them:
 *
 *   1. pdf.js (pdfjs-dist 6.2.108 legacy build on @napi-rs/canvas), rendered
 *      at several scales; and
 *   2. macOS QuickLook (`qlmanage -t`, Apple's CoreGraphics PDF renderer),
 *      rendered at ~2400 px tall.
 *
 * Each bitmap is decoded with jsQR 1.4.0 (a) on the FULL page (text, rules and
 * all) and (b) on a crop around the painted rects' bounding box, read back from
 * the PDF content stream (`x y w h re`) — the same geometry the PR's own
 * content-stream test measures — padded by the 4-module quiet zone. The crop
 * is therefore defined by the PDF itself, not by a hand-picked region.
 *
 * Writes certificate-<id>-page-N.png, certificate-<id>-qr-crop.png,
 * quicklook/certificate-<id>.pdf.png, certificate-<id>-quicklook-crop.png and
 * decode-pdf-results.json.
 *
 * Run from the scratchpad dir:  node decode-pdf.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const { createCanvas } = require('@napi-rs/canvas');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const OUT = dirname(fileURLToPath(import.meta.url));
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'));
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(PDFJS_DIR, 'legacy/build/pdf.worker.mjs')).href;

const IDS = ['ARK-DOC-9G5HQZ', 'ARK-DOC-ZZZZZZ'];
const FULL_PAGE_SCALES = [2, 3, 4]; // × 72 dpi
const CROP_SCALE = 4; // 288 dpi
const QUICKLOOK_PX = 2400; // longest side
const QUIET_MODULES = 4;
const PT_PER_MM = 72 / 25.4;

/** Every `x y w h re` in the (uncompressed) content stream, as top-left-origin points. */
function paintedRectsPt(rawLatin1, pageHeightPt) {
  return [...rawLatin1.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\b/g)].map(mm => {
    const [x, y, w, h] = mm.slice(1, 5).map(Number);
    // jsPDF COMPAT mode: y is the TOP edge in bottom-left PDF space, h is negative.
    return { x, top: pageHeightPt - y, w, h: Math.abs(h) };
  });
}

/** Bounding box (pt, top-left origin) of the painted modules, padded by the quiet zone. */
function qrBoxPt(rects) {
  const modulePt = Math.min(...rects.map(r => r.h));
  const left = Math.min(...rects.map(r => r.x));
  const top = Math.min(...rects.map(r => r.top));
  const right = Math.max(...rects.map(r => r.x + r.w));
  const bottom = Math.max(...rects.map(r => r.top + r.h));
  const pad = modulePt * QUIET_MODULES;
  return { modulePt, left, top, right, bottom, pad, x: left - pad, y: top - pad, w: right - left + 2 * pad, h: bottom - top + 2 * pad };
}

async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return { canvas, ctx, viewport };
}

function decodeRGBA(data, w, h) {
  const res = jsQR(data, w, h);
  return res ? { data: res.data, binaryData: res.binaryData, version: res.version } : null;
}

function cropCanvas(src, sx, sy, sw, sh) {
  const c2 = createCanvas(sw, sh);
  const x2 = c2.getContext('2d');
  x2.fillStyle = '#ffffff';
  x2.fillRect(0, 0, sw, sh);
  x2.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return { canvas: c2, ctx: x2 };
}

/** Copy a sub-rectangle out of a raw RGBA buffer. */
function cropRGBA(src, srcW, sx, sy, sw, sh) {
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const from = ((sy + y) * srcW + sx) * 4;
    out.set(src.subarray(from, from + sw * 4), y * sw * 4);
  }
  return out;
}

function writePng(path, data, w, h) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}

function verdict(res, expected) {
  return {
    decoded: res ? res.data : null,
    textEqual: !!res && res.data === expected,
    bytesEqual: !!res && Buffer.compare(Buffer.from(res.binaryData), Buffer.from(expected, 'utf8')) === 0,
    qrVersion: res ? res.version : null,
  };
}

const results = {
  renderers: {
    pdfjs: `pdfjs-dist ${require('pdfjs-dist/package.json').version} + @napi-rs/canvas ${require('@napi-rs/canvas/package.json').version}`,
    quicklook: '/usr/bin/qlmanage -t (macOS CoreGraphics)',
  },
  decoder: `jsqr ${require('jsqr/package.json').version}`,
  fullPageScales: FULL_PAGE_SCALES,
  cropScale: CROP_SCALE,
  quickLookPx: QUICKLOOK_PX,
  ids: {},
};
let failures = 0;

for (const id of IDS) {
  const expected = `https://app.arkova.ai/verify/${id}`;
  const file = join(OUT, `certificate-${id}.pdf`);
  const buf = readFileSync(file);
  const raw = buf.toString('latin1');

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: join(PDFJS_DIR, 'standard_fonts') + '/',
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const page1 = await doc.getPage(1);
  const pageHeightPt = page1.getViewport({ scale: 1 }).height;
  const pageWidthPt = page1.getViewport({ scale: 1 }).width;
  const rects = paintedRectsPt(raw, pageHeightPt);
  const box = qrBoxPt(rects);

  // Which page carries the Verify Online block (text layer).
  const pageText = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n);
    const t = (await p.getTextContent()).items.map(i => i.str).join(' ');
    pageText.push({ page: n, hasVerifyOnlineText: t.includes('Verify Online'), urlInTextLayer: t.includes(expected) });
  }
  const qrPageNo = (pageText.find(p => p.hasVerifyOnlineText) || { page: 1 }).page;

  // (1) pdf.js — full page at several scales, every page.
  const fullPage = [];
  for (const scale of FULL_PAGE_SCALES) {
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const { canvas, ctx } = await renderPage(p, scale);
      if (scale === CROP_SCALE) writeFileSync(join(OUT, `certificate-${id}-page-${n}.png`), canvas.toBuffer('image/png'));
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const v = verdict(decodeRGBA(img.data, canvas.width, canvas.height), expected);
      fullPage.push({ scale, page: n, widthPx: canvas.width, heightPx: canvas.height, ...v });
      console.log(`[decode-pdf] ${id} pdfjs full page ${n}/${doc.numPages} @${scale}x (${canvas.width}x${canvas.height}) decoded=${JSON.stringify(v.decoded)} equal=${v.textEqual}`);
    }
  }

  // (1b) pdf.js — crop defined by the content stream's own rect geometry.
  const qrPage = await doc.getPage(qrPageNo);
  const { canvas: pageCanvas } = await renderPage(qrPage, CROP_SCALE);
  const sx = Math.max(0, Math.floor(box.x * CROP_SCALE));
  const sy = Math.max(0, Math.floor(box.y * CROP_SCALE));
  const sw = Math.ceil(box.w * CROP_SCALE);
  const sh = Math.ceil(box.h * CROP_SCALE);
  const { canvas: cropC, ctx: cropX } = cropCanvas(pageCanvas, sx, sy, sw, sh);
  const cropPng = join(OUT, `certificate-${id}-qr-crop.png`);
  writeFileSync(cropPng, cropC.toBuffer('image/png'));
  const cropImg = cropX.getImageData(0, 0, sw, sh);
  const pdfjsCrop = { page: qrPageNo, cropPx: { sx, sy, sw, sh }, png: cropPng, ...verdict(decodeRGBA(cropImg.data, sw, sh), expected) };
  console.log(`[decode-pdf] ${id} pdfjs crop page=${qrPageNo} decoded=${JSON.stringify(pdfjsCrop.decoded)} textEqual=${pdfjsCrop.textEqual} bytesEqual=${pdfjsCrop.bytesEqual}`);

  // (2) QuickLook — Apple's renderer, independent of pdf.js. Page 1 only.
  let quicklook = null;
  try {
    const qlDir = join(OUT, 'quicklook');
    mkdirSync(qlDir, { recursive: true });
    execFileSync('/usr/bin/qlmanage', ['-t', '-s', String(QUICKLOOK_PX), '-o', qlDir, file], { stdio: 'pipe' });
    const png = PNG.sync.read(readFileSync(join(qlDir, `certificate-${id}.pdf.png`)));
    const data = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
    const scale = png.height / pageHeightPt;
    const full = verdict(decodeRGBA(data, png.width, png.height), expected);
    let crop = null;
    if (qrPageNo === 1) {
      const qx = Math.max(0, Math.floor(box.x * scale));
      const qy = Math.max(0, Math.floor(box.y * scale));
      const qw = Math.min(png.width - qx, Math.ceil(box.w * scale));
      const qh = Math.min(png.height - qy, Math.ceil(box.h * scale));
      const sub = cropRGBA(data, png.width, qx, qy, qw, qh);
      const qlCropPng = join(OUT, `certificate-${id}-quicklook-crop.png`);
      writePng(qlCropPng, sub, qw, qh);
      crop = { cropPx: { sx: qx, sy: qy, sw: qw, sh: qh }, png: qlCropPng, ...verdict(decodeRGBA(sub, qw, qh), expected) };
    }
    quicklook = { png: join(qlDir, `certificate-${id}.pdf.png`), widthPx: png.width, heightPx: png.height, pxPerPt: Number(scale.toFixed(4)), fullPage: full, crop };
    console.log(`[decode-pdf] ${id} quicklook ${png.width}x${png.height} full=${JSON.stringify(full.decoded)} crop=${JSON.stringify(crop ? crop.decoded : null)} cropEqual=${crop ? crop.textEqual : null}`);
  } catch (e) {
    quicklook = { error: String(e).split('\n')[0] };
    console.log(`[decode-pdf] ${id} quicklook failed: ${quicklook.error}`);
  }

  const pdfjsCropOk = pdfjsCrop.textEqual && pdfjsCrop.bytesEqual;
  const qlCropOk = !!(quicklook && quicklook.crop && quicklook.crop.textEqual && quicklook.crop.bytesEqual);
  const anyFullPageOk = fullPage.some(f => f.textEqual) || !!(quicklook && quicklook.fullPage && quicklook.fullPage.textEqual);
  if (!pdfjsCropOk) failures++;
  if (quicklook && !quicklook.error && !qlCropOk) failures++;

  results.ids[id] = {
    expected,
    pdfBytes: buf.length,
    pages: doc.numPages,
    pageSizePt: { width: Number(pageWidthPt.toFixed(2)), height: Number(pageHeightPt.toFixed(2)) },
    pageText,
    qrPage: qrPageNo,
    paintedGeometry: {
      rectOps: rects.length,
      moduleMm: Number((box.modulePt / PT_PER_MM).toFixed(4)),
      sideMm: Number(((box.right - box.left) / PT_PER_MM).toFixed(3)),
      leftMm: Number((box.left / PT_PER_MM).toFixed(3)),
      topMm: Number((box.top / PT_PER_MM).toFixed(3)),
      quietZoneMm: Number((box.pad / PT_PER_MM).toFixed(3)),
    },
    pdfjs: { fullPage, crop: pdfjsCrop },
    quicklook,
    pdfjsCropDecodeEqual: pdfjsCropOk,
    quicklookCropDecodeEqual: qlCropOk,
    anyFullPageDecodeEqual: anyFullPageOk,
  };
  try { await loadingTask.destroy(); } catch {}
}

results.failures = failures;
writeFileSync(join(OUT, 'decode-pdf-results.json'), JSON.stringify(results, null, 2));
console.log(`[decode-pdf] failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
