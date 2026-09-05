/**
 * decode-matrix.mjs — PR #2528 evidence, step 2b (independent decode).
 *
 * Rasterises the module matrix that gen-qr.mts captured from the PR's
 * `buildQrMatrix()` into an RGBA buffer (N px per module, 4-module quiet zone)
 * and decodes it with jsQR 1.4.0 — a decoder that shares no code with
 * qrcode-generator. Asserts the decoded text equals the expected canonical URL
 * byte-for-byte. Decodes at three scales so the result is not an artefact of
 * one raster size. Writes qr-<id>-scale8.png and decode-matrix-results.json.
 *
 * Run from the scratchpad dir:  node decode-matrix.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const jsQR = require('jsqr');
const { PNG } = require('pngjs');

const OUT = dirname(fileURLToPath(import.meta.url));
const IDS = ['ARK-DOC-9G5HQZ', 'ARK-DOC-ZZZZZZ'];
const SCALES = [3, 8, 12];
const QUIET = 4;

function rasterise(grid, scale) {
  const n = grid.length;
  const size = (n + 2 * QUIET) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!grid[r][c]) continue;
      for (let y = (r + QUIET) * scale; y < (r + QUIET + 1) * scale; y++) {
        for (let x = (c + QUIET) * scale; x < (c + QUIET + 1) * scale; x++) {
          const i = (y * size + x) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

function writePng(path, data, size) {
  const png = new PNG({ width: size, height: size });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  writeFileSync(path, PNG.sync.write(png));
}

const results = { decoder: `jsqr ${require('jsqr/package.json').version}`, quietModules: QUIET, ids: {} };
let failures = 0;

for (const id of IDS) {
  const m = JSON.parse(readFileSync(join(OUT, `qr-matrix-${id}.json`), 'utf8'));
  const expected = `https://app.arkova.ai/verify/${id}`;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const perScale = [];

  for (const scale of SCALES) {
    const { data, size } = rasterise(m.grid, scale);
    const res = jsQR(data, size, size);
    const decoded = res ? res.data : null;
    const textEqual = decoded === expected;
    const bytesEqual = res ? Buffer.compare(Buffer.from(res.binaryData), expectedBytes) === 0 : false;
    perScale.push({
      scale,
      imagePx: size,
      decoded,
      textEqual,
      bytesEqual,
      decodedLength: decoded ? decoded.length : null,
      expectedLength: expected.length,
      qrVersion: res ? res.version : null,
      chunkTypes: res ? res.chunks.map(c => c.type) : null,
    });
    if (!textEqual || !bytesEqual) failures++;
    if (scale === 8) writePng(join(OUT, `qr-${id}-scale8.png`), data, size);
    console.log(`[decode-matrix] ${id} scale=${scale} (${size}px) decoded=${JSON.stringify(decoded)} textEqual=${textEqual} bytesEqual=${bytesEqual}`);
  }

  results.ids[id] = {
    expected,
    matrixUrlField: m.url,
    matrixUrlFieldEqualsExpected: m.url === expected,
    moduleCount: m.moduleCount,
    matrixSha256: m.sha256,
    perScale,
    allScalesEqual: perScale.every(p => p.textEqual && p.bytesEqual),
  };
}

results.failures = failures;
writeFileSync(join(OUT, 'decode-matrix-results.json'), JSON.stringify(results, null, 2));
console.log(`[decode-matrix] failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
