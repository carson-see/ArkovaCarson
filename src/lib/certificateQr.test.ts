/**
 * certificateQr — QR module matrix for the audit-certificate PDF.
 *
 * The certificate is the artifact people hand to auditors, so the QR on it has
 * exactly one job: encode the live verification URL and nothing else. These
 * tests pin the encoding, the run-length packing the PDF renderer consumes, and
 * the graceful-degradation contract (never throw — return null and let the
 * caller fall back to the URL as text).
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildQrMatrix, type QrMatrix } from './certificateQr';

const URL = 'https://app.arkova.ai/verify/ARK-2026-001';

/** Re-expand the run-length rows into a dense boolean grid for assertions. */
function toGrid(m: QrMatrix): boolean[][] {
  const grid = Array.from({ length: m.moduleCount }, () =>
    new Array<boolean>(m.moduleCount).fill(false),
  );
  for (const run of m.runs) {
    for (let i = 0; i < run.width; i++) grid[run.row][run.col + i] = true;
  }
  return grid;
}

describe('buildQrMatrix', () => {
  it('produces a square matrix with a valid QR side length (4·version + 17)', () => {
    const m = buildQrMatrix(URL);
    expect(m).not.toBeNull();
    const n = m!.moduleCount;
    expect(n).toBeGreaterThanOrEqual(21);
    expect((n - 17) % 4).toBe(0);
  });

  it('places the three finder patterns (7×7, dark ring, light gap, 3×3 core)', () => {
    const g = toGrid(buildQrMatrix(URL)!);
    const n = g.length;
    for (const [r0, c0] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ]) {
      // Outer ring dark on all four edges.
      for (let i = 0; i < 7; i++) {
        expect(g[r0][c0 + i]).toBe(true);
        expect(g[r0 + 6][c0 + i]).toBe(true);
        expect(g[r0 + i][c0]).toBe(true);
        expect(g[r0 + i][c0 + 6]).toBe(true);
      }
      // Light separator ring.
      expect(g[r0 + 1][c0 + 1]).toBe(false);
      expect(g[r0 + 5][c0 + 5]).toBe(false);
      // Dark 3×3 core.
      for (let r = 2; r <= 4; r++) {
        for (let c = 2; c <= 4; c++) expect(g[r0 + r][c0 + c]).toBe(true);
      }
    }
  });

  it('emits maximal horizontal runs (never one run per dark module)', () => {
    const m = buildQrMatrix(URL)!;
    // The finder rings alone guarantee 7-wide runs, so a correct packer must
    // produce far fewer runs than dark modules.
    const darkModules = m.runs.reduce((sum, r) => sum + r.width, 0);
    expect(m.runs.length).toBeLessThan(darkModules);
    // No two runs in the same row may be adjacent or overlapping — that would
    // mean the packer failed to merge them.
    const byRow = new Map<number, Array<{ col: number; width: number }>>();
    for (const r of m.runs) {
      const list = byRow.get(r.row) ?? [];
      list.push(r);
      byRow.set(r.row, list);
    }
    for (const list of byRow.values()) {
      const sorted = [...list].sort((a, b) => a.col - b.col);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].col).toBeGreaterThan(sorted[i - 1].col + sorted[i - 1].width);
      }
    }
    for (const r of m.runs) {
      expect(r.width).toBeGreaterThan(0);
      expect(r.col + r.width).toBeLessThanOrEqual(m.moduleCount);
    }
  });

  it('is deterministic — the same value always yields the same matrix', () => {
    expect(buildQrMatrix(URL)).toEqual(buildQrMatrix(URL));
  });

  it('matches the golden matrix that an independent decoder read back as this URL', () => {
    // A structural test cannot prove the payload decodes correctly, and no QR
    // DECODER ships in this repo. So the matrix below was verified once, out of
    // band on 2026-08-31, by rasterising it (scale 6, 4-module quiet zone) and
    // decoding it with jsQR 1.4.0 — which read back exactly
    // `https://app.arkova.ai/verify/ARK-2026-001`, confirming the payload, the
    // run-length packing AND the row/column orientation end to end.
    //
    // Pinning the digest makes that one-off proof durable: any change to the
    // encoder, its parameters, or the packing flips this test, and whoever
    // flips it must re-run the same decode before re-pinning. Do not "fix" this
    // by pasting a new digest.
    const m = buildQrMatrix(URL)!;
    const serialised = `${m.moduleCount}|${m.runs.map(r => `${r.row},${r.col},${r.width}`).join(';')}`;
    expect(m.moduleCount).toBe(29); // version 3
    expect(createHash('sha256').update(serialised).digest('hex')).toBe(
      'b9dfb20052442ba90704109c228aac18b03117a87293b1413969c0b902914f6e',
    );
  });

  it('encodes distinct values to distinct matrices', () => {
    expect(buildQrMatrix(URL)).not.toEqual(
      buildQrMatrix('https://app.arkova.ai/verify/ARK-2026-002'),
    );
  });

  it('returns null (never throws) for an empty value', () => {
    expect(buildQrMatrix('')).toBeNull();
  });

  it('refuses a non-ASCII value rather than encoding a different string', () => {
    // qrcode-generator's default byte conversion is Latin-1, so `é` would encode
    // as 0xE9 instead of the UTF-8 0xC3 0xA9 — the scanned URL would differ from
    // the printed one. Better no QR than a QR that resolves elsewhere (§1.5).
    expect(buildQrMatrix('https://app.arkova.ai/verify/ARK-2026-café')).toBeNull();
    expect(buildQrMatrix('https://app.arkova.ai/verify/ARK—001')).toBeNull();
  });

  it('returns null (never throws) when the value exceeds QR capacity', () => {
    // Version 40 byte-mode capacity tops out around 2 953 bytes; anything past
    // that must degrade to "no QR", not blow up certificate generation.
    expect(() => buildQrMatrix('x'.repeat(10_000))).not.toThrow();
    expect(buildQrMatrix('x'.repeat(10_000))).toBeNull();
  });
});
