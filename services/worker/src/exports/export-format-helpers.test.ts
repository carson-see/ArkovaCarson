/**
 * Tests for the shared export formatting + PDF-builder seam
 * (`export-format-helpers.ts`) used by the CPE (SCRUM-1848) and CLE
 * (SCRUM-1870) compliance-log exporters.
 *
 * The headline behaviour under test is the `ExportPdfBuilder.records()`
 * multi-line title wrap: a long record title must be wrapped AND advance the
 * jsPDF cursor by the rendered line count, so the title never overlaps the
 * detail lines beneath it. This mirrors the standalone CPE fix from PR #1029;
 * the shared builder carried the older single-line `y += 5` cursor advance,
 * which this test pins shut for the CLE path (and any future builder consumer).
 */
import { describe, it, expect, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import {
  asString,
  asNumber,
  asDateOnly,
  stripTrailingSlashes,
  formatUtc,
  ExportPdfBuilder,
  assertExportsBucketReady,
  uploadAndSignExportArtifacts,
  type ExportPdfRecord,
  type ExportStorageLike,
} from './export-format-helpers.js';

describe('export-format-helpers field coercion', () => {
  it('asString trims and rejects blank', () => {
    expect(asString('  hi  ')).toBe('hi');
    expect(asString('   ')).toBeNull();
    expect(asString(42)).toBeNull();
  });

  it('asNumber accepts finite numbers and numeric strings', () => {
    expect(asNumber(6)).toBe(6);
    expect(asNumber('6.5')).toBe(6.5);
    expect(asNumber('not-a-number')).toBeNull();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('asDateOnly reduces an ISO timestamp to YYYY-MM-DD', () => {
    expect(asDateOnly('2026-01-15T12:34:56.000Z')).toBe('2026-01-15');
    expect(asDateOnly('not-a-date')).toBeNull();
  });

  it('stripTrailingSlashes removes only trailing slashes', () => {
    expect(stripTrailingSlashes('https://app.arkova.io///')).toBe('https://app.arkova.io');
    expect(stripTrailingSlashes('https://app.arkova.io')).toBe('https://app.arkova.io');
  });

  it('formatUtc renders a UTC-suffixed timestamp or an em dash', () => {
    expect(formatUtc(null)).toBe('—');
    expect(formatUtc('2026-01-15T00:00:00.000Z')).toMatch(/UTC$/);
  });
});

describe('ExportPdfBuilder.records() title wrap (PR #1029 / #1034)', () => {
  /**
   * Drive the builder against a doc whose `splitTextToSize` is forced to return
   * a fixed number of lines, then assert that the cursor `y` advanced by that
   * line count * the per-line height — proving the title is wrapped and does not
   * collapse to a single-line advance.
   */
  function buildWithTitleLines(lineCount: number): { ys: number[]; titleArgs: unknown[][] } {
    const doc = new jsPDF();
    const ys: number[] = [];
    const titleArgs: unknown[][] = [];

    // Force a deterministic wrap result: N identical lines for the title, single
    // line for everything else (detail cells, etc.).
    const realSplit = doc.splitTextToSize.bind(doc);
    doc.splitTextToSize = ((text: string, width: number) => {
      if (text.startsWith('TITLE')) {
        return Array.from({ length: lineCount }, () => 'TITLE');
      }
      return realSplit(text, width) as string[];
    }) as typeof doc.splitTextToSize;

    // Capture the y passed to each `text` call so we can read the cursor march.
    const realText = doc.text.bind(doc);
    doc.text = ((arg: unknown, x: number, y: number, opts?: unknown) => {
      ys.push(y);
      if (Array.isArray(arg) && (arg as string[])[0] === 'TITLE') {
        titleArgs.push(arg as unknown[]);
      }
      return realText(arg as string, x, y, opts as never);
    }) as typeof doc.text;

    const builder = new ExportPdfBuilder();
    // Replace the builder's internal doc with our instrumented one.
    (builder as unknown as { doc: jsPDF }).doc = doc;

    const records: ExportPdfRecord[] = [
      { title: 'TITLE', lines: [{ cells: ['Detail: x'] }] },
    ];
    builder.records(records, (r) => r);

    return { ys, titleArgs };
  }

  it('wraps a long title via splitTextToSize (passes an array to doc.text)', () => {
    const { titleArgs } = buildWithTitleLines(3);
    // The title is rendered as an array of wrapped lines, not a single string.
    expect(titleArgs.length).toBe(1);
    expect((titleArgs[0] as string[]).length).toBe(3);
  });

  it('advances the cursor further for a 3-line title than a 1-line title', () => {
    // y of the FIRST detail line == y after the title block. A 3-line title must
    // push the detail line lower than a 1-line title (no overlap).
    const oneLine = buildWithTitleLines(1);
    const threeLine = buildWithTitleLines(3);

    // ys[0] is the title, ys[1] is the first detail line.
    const detailYOneLine = oneLine.ys[1];
    const detailYThreeLine = threeLine.ys[1];

    expect(detailYThreeLine).toBeGreaterThan(detailYOneLine);
    // Each extra title line adds TITLE_LINE_HEIGHT (5pt); 2 extra lines = +10pt.
    expect(detailYThreeLine - detailYOneLine).toBe(10);
  });
});

// ─── Shared upload/sign seam bucket-visibility preflight ──
// The private-bucket guard lives INSIDE `uploadAndSignExportArtifacts` (behind
// the `getBucket` storage seam) so NO exporter can reach an upload without it —
// this is the structural fix for the CLE path, which previously called the
// shared helper directly with no preflight (PR #1415, Carson [P1]). The direct
// `assertExportsBucketReady` unit tests below pin the check itself; the helper
// tests pin that the helper ACTUALLY runs it exactly once before any upload.

/** A storage double that records upload/sign/getBucket calls. */
function makeStorage(
  bucketRes: { exists: boolean; isPublic: boolean | null; error: Error | null } = {
    exists: true,
    isPublic: false,
    error: null,
  },
): {
  storage: ExportStorageLike;
  uploads: string[];
  getBucketCalls: number;
} {
  const uploads: string[] = [];
  let getBucketCalls = 0;
  const storage: ExportStorageLike = {
    upload: vi.fn().mockImplementation((_bucket: string, path: string) => {
      uploads.push(path);
      return Promise.resolve({ error: null });
    }),
    createSignedUrl: vi.fn().mockImplementation((bucket: string, path: string, expiresIn: number) =>
      Promise.resolve({ signedUrl: `https://s.example/${bucket}/${path}?e=${expiresIn}`, error: null }),
    ),
    getBucket: vi.fn().mockImplementation(() => {
      getBucketCalls += 1;
      return Promise.resolve(bucketRes);
    }),
  };
  return {
    storage,
    uploads,
    get getBucketCalls() {
      return getBucketCalls;
    },
  };
}

function uploadArgs(storage: ExportStorageLike) {
  return {
    storage,
    bucket: 'exports',
    basePath: 'cle-log/org-1/user-1/req-1',
    pdfBody: new Uint8Array([1, 2, 3]),
    jsonBody: '{"ok":true}',
    expiresIn: 3600,
    label: 'CLE',
  };
}

describe('assertExportsBucketReady (shared seam)', () => {
  function storageReturning(
    res: { exists: boolean; isPublic: boolean | null; error: Error | null },
  ): ExportStorageLike {
    return {
      upload: vi.fn(),
      createSignedUrl: vi.fn(),
      getBucket: vi.fn().mockResolvedValue(res),
    } as unknown as ExportStorageLike;
  }

  it('resolves for an existing private bucket', async () => {
    await expect(
      assertExportsBucketReady(storageReturning({ exists: true, isPublic: false, error: null }), 'exports'),
    ).resolves.toBeUndefined();
  });

  it('throws when the bucket does not exist', async () => {
    await expect(
      assertExportsBucketReady(storageReturning({ exists: false, isPublic: null, error: null }), 'exports'),
    ).rejects.toThrow(/does not exist/i);
  });

  it('throws (with the underlying message) when the lookup errors and the bucket is absent', async () => {
    await expect(
      assertExportsBucketReady(
        storageReturning({ exists: false, isPublic: null, error: new Error('connection refused') }),
        'exports',
      ),
    ).rejects.toThrow(/unavailable.*connection refused/i);
  });

  it('throws when the bucket is PUBLIC (would leak unsigned bodies)', async () => {
    await expect(
      assertExportsBucketReady(storageReturning({ exists: true, isPublic: true, error: null }), 'exports'),
    ).rejects.toThrow(/PUBLIC/i);
  });
});

describe('uploadAndSignExportArtifacts bucket-visibility preflight', () => {
  it('runs the bucket-ready guard exactly once BEFORE any upload', async () => {
    const s = makeStorage();
    await uploadAndSignExportArtifacts(uploadArgs(s.storage));
    // getBucket ran, and both artifacts uploaded after it.
    expect(s.getBucketCalls).toBe(1);
    expect(s.uploads).toHaveLength(2);
  });

  it('blocks the upload (writes NOTHING) when the bucket is PUBLIC', async () => {
    const s = makeStorage({ exists: true, isPublic: true, error: null });
    await expect(uploadAndSignExportArtifacts(uploadArgs(s.storage))).rejects.toThrow(/PUBLIC/i);
    expect(s.uploads).toHaveLength(0);
  });

  it('blocks the upload (writes NOTHING) when the bucket does not exist', async () => {
    const s = makeStorage({ exists: false, isPublic: null, error: null });
    await expect(uploadAndSignExportArtifacts(uploadArgs(s.storage))).rejects.toThrow(/does not exist/i);
    expect(s.uploads).toHaveLength(0);
  });
});
