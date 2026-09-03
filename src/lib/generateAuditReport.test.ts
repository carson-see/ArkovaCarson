/**
 * PROOF-04 (SCRUM-2337) — audit-certificate PDF proof-JSON embedding.
 *
 * The downloadable audit certificate must carry a machine-readable proof
 * packet so a verifier can re-check the document offline. The embedded packet
 * is the CANONICAL `proof_bundle` shape (PROOF-05 / SCRUM-2338 emits it, the
 * PROOF-07 reference CLI parses it) — they must match field-for-field. We
 * assert that:
 *  - the embedded JSON is present in the PDF output and parses back to the
 *    exact proof_bundle fields,
 *  - `merkle_proof` is the structured `{ hash, position }[]` branch (NOT a
 *    flattened string[]), so the offline verifier can recompute the root,
 *  - the machine field is `block_timestamp` (not `observed_time`),
 *  - `proof_schema_version` is a non-null number (default 1),
 *  - `merkle_index` and `leaf_count` are present,
 *  - only proof-packet fields (never document bytes / PII) are embedded,
 *  - the human-readable proof fields + the offline-verify instructions render,
 *  - the generator stays pure / client-side (returns a jsPDF instance for
 *    inspection, no DOM, no network).
 */
import type { jsPDF } from 'jspdf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildQrMatrix, type QrMatrix } from './certificateQr';
import { CERTIFICATE_COPY } from './copy';
import {
  buildAuditReport,
  buildProofPacket,
  type AuditReportData,
  type MerkleProofEntry,
  type ProofPacket,
} from './generateAuditReport';
import { canonicalVerifyUrl } from './routes';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** jsPDF's mm -> pt scale factor (72 dpi over 25.4 mm/inch). */
const PT_PER_MM = 72 / 25.4;

/**
 * Every `x y w h re` rectangle in the PDF content stream, converted back to mm
 * with a top-left origin.
 *
 * This reads what is actually PAINTED, not what `buildAuditReport` returned.
 * The distinction matters: asserting on the returned `qr` object leaves the
 * draw call itself untested, so transposing it, deleting the quiet zone or
 * shrinking the code to an unscannable size all stay green.
 *
 * jsPDF emits `re` in points against a bottom-left origin and, in its default
 * COMPAT mode, negates the height — hence the flip below. The certificate draws
 * its dividers with `line()` (`m`/`l` ops), so every `re` in the stream belongs
 * to the QR; the count assertion pins that.
 */
function paintedRects(doc: { output: () => string; internal: { pageSize: { getHeight: () => number } } }) {
  const pageHeightMm = doc.internal.pageSize.getHeight();
  return [...doc.output().matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)].map(m => {
    const [xPt, yPt, wPt, hPt] = m.slice(1, 5).map(Number);
    return {
      x: xPt / PT_PER_MM,
      y: pageHeightMm - yPt / PT_PER_MM,
      w: wPt / PT_PER_MM,
      h: Math.abs(hPt) / PT_PER_MM,
    };
  });
}

/** The `Td` y of a given rendered text run, in mm from the page top. */
function textBaselineMm(
  doc: { output: () => string; internal: { pageSize: { getHeight: () => number } } },
  text: string,
): number {
  const out = doc.output();
  const at = out.indexOf(`(${text}) Tj`);
  expect(at, `text not found in content stream: ${text}`).toBeGreaterThan(-1);
  const before = out.slice(0, at);
  const td = [...before.matchAll(/(-?[\d.]+) (-?[\d.]+) Td/g)].pop();
  expect(td, `no Td before ${text}`).toBeTruthy();
  return doc.internal.pageSize.getHeight() - Number(td![2]) / PT_PER_MM;
}

const BRANCH: MerkleProofEntry[] = [
  { hash: 'c'.repeat(64), position: 'left' },
  { hash: 'e'.repeat(64), position: 'right' },
];

function securedData(overrides: Partial<AuditReportData> = {}): AuditReportData {
  return {
    publicId: 'rec_abc123',
    filename: 'diploma.pdf',
    fingerprint: 'a'.repeat(64),
    status: 'SECURED',
    fileSize: 12345,
    credentialType: 'DIPLOMA',
    issuerName: 'Acme University',
    createdAt: '2026-06-01T10:00:00Z',
    issuedAt: '2026-06-01T10:00:00Z',
    securedAt: '2026-06-02T03:00:00Z',
    networkReceipt: 'd'.repeat(64),
    blockHeight: 850123,
    proof: {
      fingerprint: 'a'.repeat(64),
      merkle_root: 'b'.repeat(64),
      merkle_proof: BRANCH,
      merkle_index: 3,
      leaf_count: 8,
      tx_id: 'd'.repeat(64),
      block_height: 850123,
      block_hash: 'f'.repeat(64),
      block_header: '0'.repeat(160),
      op_return_payload: '6a20' + 'b'.repeat(64),
      proof_schema_version: 1,
      block_timestamp: '2026-06-02T03:00:00Z',
      signature: { alg: 'Ed25519', signing_key_id: 'treasury-ed25519-1' },
    },
    ...overrides,
  };
}

describe('PROOF-04 buildProofPacket — canonical proof_bundle shape', () => {
  it('emits exactly the canonical proof_bundle field set (matches PROOF-05 / CLI)', () => {
    const data = securedData();
    const packet = buildProofPacket(data);
    expect(packet).not.toBeNull();
    const keys = Object.keys(packet!).sort();
    expect(keys).toEqual(
      [
        'block_hash',
        'block_header',
        'block_height',
        'block_timestamp',
        'fingerprint',
        'leaf_count',
        'merkle_index',
        'merkle_proof',
        'merkle_root',
        'op_return_payload',
        'proof_schema_version',
        'signature',
        'tx_id',
      ].sort(),
    );
    // No legacy observed_time field on the machine packet.
    expect(keys).not.toContain('observed_time');
  });

  it('preserves the structured { hash, position } Merkle branch (never flattens to strings)', () => {
    const packet = buildProofPacket(securedData());
    expect(Array.isArray(packet!.merkle_proof)).toBe(true);
    expect(packet!.merkle_proof).toEqual(BRANCH);
    for (const entry of packet!.merkle_proof!) {
      expect(typeof entry.hash).toBe('string');
      expect(entry.position === 'left' || entry.position === 'right').toBe(true);
    }
  });

  it('maps block_timestamp (renamed from observed_time)', () => {
    const packet = buildProofPacket(securedData());
    expect(packet!.block_timestamp).toBe('2026-06-02T03:00:00Z');
  });

  it('defaults proof_schema_version to a non-null 1 when absent', () => {
    const data = securedData();
    data.proof!.proof_schema_version = null;
    const packet = buildProofPacket(data);
    expect(packet!.proof_schema_version).toBe(1);
    expect(packet!.proof_schema_version).not.toBeNull();
  });

  it('carries merkle_index and leaf_count', () => {
    const packet = buildProofPacket(securedData());
    expect(packet!.merkle_index).toBe(3);
    expect(packet!.leaf_count).toBe(8);
  });

  it('signature is null when no signer metadata is present', () => {
    const data = securedData();
    delete data.proof!.signature;
    const packet = buildProofPacket(data);
    expect(packet!.signature).toBeNull();
  });

  it('never carries document bytes, PII, filename, or issuer name', () => {
    const packet = buildProofPacket(securedData());
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain('diploma.pdf');
    expect(serialized).not.toContain('Acme University');
    expect(serialized).not.toContain('rec_abc123'); // public_id is record metadata, not proof
    expect(serialized).not.toMatch(/file_?size/i);
    expect(serialized).not.toMatch(/document_bytes|raw_bytes|content/i);
    expect(serialized).not.toMatch(/\bfilename\b|\bissuer/i);
  });

  it('returns null when the record is not SECURED', () => {
    expect(buildProofPacket(securedData({ status: 'PENDING' }))).toBeNull();
  });

  it('returns null when no proof data is present even if SECURED', () => {
    const { proof: _proof, ...rest } = securedData();
    expect(buildProofPacket(rest as AuditReportData)).toBeNull();
  });
});

describe('PROOF-04 buildAuditReport — embedded machine-readable JSON', () => {
  it('embeds the proof packet as parseable JSON and exposes it on the result', () => {
    const r = buildAuditReport(securedData());
    expect(r.embeddedProofJson).toBeTruthy();
    const parsed = JSON.parse(r.embeddedProofJson!) as ProofPacket;
    expect(parsed.merkle_root).toBe('b'.repeat(64));
    expect(parsed.merkle_proof).toEqual(BRANCH);
    expect(parsed.merkle_index).toBe(3);
    expect(parsed.leaf_count).toBe(8);
    expect(parsed.block_timestamp).toBe('2026-06-02T03:00:00Z');
    expect(parsed.proof_schema_version).toBe(1);
    expect(parsed.signature?.alg).toBe('Ed25519');
  });

  it('writes the JSON into the PDF document metadata stream', () => {
    const r = buildAuditReport(securedData());
    const output = r.doc.output();
    // The proof packet is embedded verbatim in PDF metadata so an offline
    // verifier can extract it. The merkle root is a distinctive marker.
    expect(output).toContain('b'.repeat(64));
  });

  it('renders human-readable proof fields and the offline-verify block', () => {
    const r = buildAuditReport(securedData());
    const output = r.doc.output();
    expect(output).toContain('Cryptographic Proof');
    expect(output).toContain('Verify This Certificate Offline');
    // reference verifier URL must be present
    expect(output).toMatch(/arkova\.(ai|io)\/verify/);
  });

  it('omits proof sections gracefully for a non-SECURED record', () => {
    const r = buildAuditReport(securedData({ status: 'PENDING', proof: undefined }));
    expect(r.embeddedProofJson).toBeNull();
    // Still produces a valid single-or-more page certificate.
    expect(r.doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('uses the §1.3-compliant status label from getStatusDisplay (never a raw enum)', () => {
    const output = buildAuditReport(securedData()).doc.output();
    expect(output).toContain('Verified'); // SECURED → "Verified"
    expect(output).not.toMatch(/Status:\s*SECURED/);
  });

  it('claims a complete offline proof by default (proofComplete undefined → true)', () => {
    const output = buildAuditReport(securedData()).doc.output();
    // The default offline-verify intro asserts a complete packet.
    expect(output).toContain('complete, machine-readable proof packet');
  });

  it('does NOT claim a complete offline proof when proofComplete is false', () => {
    // A batch member whose leaf_count could not be sourced: the page passes
    // proofComplete:false. The certificate still embeds the packet but uses the
    // incomplete copy and drops the "complete … proof packet" assertion (§1.5).
    const data = securedData({ proofComplete: false });
    data.proof!.leaf_count = null; // not sourced
    const r = buildAuditReport(data);
    const output = r.doc.output();
    expect(r.embeddedProofJson).toBeTruthy(); // packet still embedded for inspection
    expect(output).toContain('could not be sourced');
    expect(output).not.toContain('complete, machine-readable proof packet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Verification QR (fix/published-verification-pointers)
//
// The certificate is the artifact handed to an auditor, and until now it
// carried no scannable pointer at all — only the bare `publicId` as text. The
// QR must encode EXACTLY `canonicalVerifyUrl(publicId)`.
//
// NOT `verifyUrl()`, which the in-app QR uses (`ShareSheet.tsx` /
// `AssetDetailView.tsx`): that helper honours `VITE_APP_URL` so a share link
// follows the host the user is on, which is right for live UI and wrong for a
// permanent document. The two agree in production and diverge exactly where
// they should — on a preview or dev build, whose certificates must still point
// somewhere that resolves years later.
// ─────────────────────────────────────────────────────────────────────────────
describe('audit certificate — verification QR', () => {
  it('encodes exactly canonicalVerifyUrl(publicId)', () => {
    const r = buildAuditReport(securedData({ publicId: 'ARK-2026-001' }));
    expect(r.verificationUrl).toBe(canonicalVerifyUrl('ARK-2026-001'));
    expect(r.verificationUrl).toBe('https://app.arkova.ai/verify/ARK-2026-001');
    // The drawn matrix IS the matrix for that URL — not a re-derived or
    // near-miss value.
    expect(r.qr).not.toBeNull();
    expect(r.qr).toEqual(buildQrMatrix(canonicalVerifyUrl('ARK-2026-001')));
  });

  it('pins the production origin even when VITE_APP_URL points elsewhere', () => {
    // A certificate is permanent and cannot be reissued once it is in an
    // auditor's hands. `.env.example` ships VITE_APP_URL=http://localhost:5173
    // and preview deploys set an ephemeral host, so a build-time value baked
    // into the QR and the printed link would resolve to localhost, or to a dead
    // preview host, forever. The in-app share QR follows VITE_APP_URL on
    // purpose; the archived artifact must not.
    for (const host of ['http://localhost:5173', 'https://arkova-git-abc123.vercel.app']) {
      vi.stubEnv('VITE_APP_URL', host);
      const r = buildAuditReport(securedData({ publicId: 'ARK-2026-001' }));
      expect(r.verificationUrl).toBe('https://app.arkova.ai/verify/ARK-2026-001');
      expect(r.doc.output()).toContain('https://app.arkova.ai/verify/ARK-2026-001');
      expect(r.doc.output()).not.toContain(host);
      expect(r.qr).toEqual(buildQrMatrix('https://app.arkova.ai/verify/ARK-2026-001'));
    }
  });

  it('renders the verification URL as text so a printed certificate stays usable', () => {
    const output = buildAuditReport(securedData({ publicId: 'ARK-2026-001' })).doc.output();
    expect(output).toContain('https://app.arkova.ai/verify/ARK-2026-001');
    expect(output).toContain(CERTIFICATE_COPY.SECTION_VERIFY_ONLINE);
  });

  it('never fabricates a URL for a record with no publicId', () => {
    const r = buildAuditReport(securedData({ publicId: '' }));
    expect(r.verificationUrl).toBeNull();
    expect(r.qr).toBeNull();
    // …and the certificate still builds.
    expect(r.doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('degrades to URL-as-text when the QR cannot be produced (never throws)', () => {
    // A publicId long enough to exceed QR capacity: buildQrMatrix returns null
    // and the section must still render the link rather than blowing up the
    // whole certificate.
    const huge = 'z'.repeat(4000);
    const r = buildAuditReport(securedData({ publicId: huge }));
    expect(r.qr).toBeNull();
    expect(r.verificationUrl).toBe(canonicalVerifyUrl(huge));
    expect(r.doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('renders the QR for a non-SECURED record too (the live page works either way)', () => {
    const r = buildAuditReport(securedData({ status: 'PENDING', proof: undefined }));
    expect(r.embeddedProofJson).toBeNull();
    expect(r.qr).not.toBeNull();
    expect(r.verificationUrl).toBe(canonicalVerifyUrl('rec_abc123'));
  });

  it('keeps the proof packet and the QR in separate, intact sections', () => {
    const output = buildAuditReport(securedData()).doc.output();
    // Both blocks present; the machine-proof JSON is not clobbered by the QR.
    expect(output).toContain(CERTIFICATE_COPY.SECTION_MACHINE_PROOF);
    expect(output).toContain(CERTIFICATE_COPY.SECTION_VERIFY_ONLINE);
    expect(output).toContain('b'.repeat(64)); // merkle root still embedded
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What is actually painted into the PDF.
//
// Everything above asserts on the object `buildAuditReport` RETURNS, which
// leaves the draw call itself unverified. Three real breakages survive that:
// transposing the rect call (`run.row`/`run.col` swapped), setting
// QR_QUIET_MODULES to 0, and shrinking QR_SIDE_MM to an unscannable 5 mm. Each
// is caught below by measuring the content stream.
// ─────────────────────────────────────────────────────────────────────────────
describe('audit certificate — QR as painted in the content stream', () => {
  /** Mirrors the module-scope constants in generateAuditReport.ts. */
  const MARGIN_MM = 20;
  const QR_SIDE_MM = 26;
  const QR_QUIET_MODULES = 4;
  /** `addSection` advances the cursor by 7 mm below the heading baseline. */
  const SECTION_HEADING_ADVANCE_MM = 7;
  const EPS = 0.01;

  const build = () => buildAuditReport(securedData({ publicId: 'ARK-2026-001' }));

  it('paints one rectangle per run and nothing else', () => {
    const r = build();
    expect(paintedRects(r.doc)).toHaveLength((r.qr as QrMatrix).runs.length);
  });

  it('paints every module at the position the matrix specifies (catches transposition)', () => {
    const r = build();
    const qr = r.qr as QrMatrix;
    const rects = paintedRects(r.doc);
    const moduleMm = QR_SIDE_MM / qr.moduleCount;

    const originX = Math.min(...rects.map(v => v.x));
    const originY = Math.min(...rects.map(v => v.y));

    // Compare as sorted geometry so a mirrored draw cannot coincidentally pass:
    // every run must appear at (col, row), never at (row, col).
    const key = (v: { x: number; y: number; w: number; h: number }) =>
      [v.x, v.y, v.w, v.h].map(n => n.toFixed(3)).join(',');
    const painted = rects.map(key).sort();
    const expected = qr.runs
      .map(run =>
        key({
          x: originX + run.col * moduleMm,
          y: originY + run.row * moduleMm,
          w: run.width * moduleMm,
          h: moduleMm,
        }),
      )
      .sort();
    expect(painted).toEqual(expected);
  });

  it('paints modules at the declared size — a scannable 0.897 mm, not a speck', () => {
    const r = build();
    const qr = r.qr as QrMatrix;
    const rects = paintedRects(r.doc);
    const moduleMm = QR_SIDE_MM / qr.moduleCount;

    expect(moduleMm).toBeCloseTo(0.897, 3);
    for (const v of rects) expect(v.h).toBeCloseTo(moduleMm, 3);

    // The painted code occupies exactly QR_SIDE_MM square.
    const left = Math.min(...rects.map(v => v.x));
    const top = Math.min(...rects.map(v => v.y));
    const right = Math.max(...rects.map(v => v.x + v.w));
    const bottom = Math.max(...rects.map(v => v.y + v.h));
    expect(right - left).toBeCloseTo(QR_SIDE_MM, 2);
    expect(bottom - top).toBeCloseTo(QR_SIDE_MM, 2);
  });

  it('leaves the spec-required 4-module quiet zone on all four sides', () => {
    const r = build();
    const qr = r.qr as QrMatrix;
    const rects = paintedRects(r.doc);
    const moduleMm = QR_SIDE_MM / qr.moduleCount;
    const quietMm = moduleMm * QR_QUIET_MODULES;

    expect(quietMm).toBeCloseTo(3.586, 3);

    const left = Math.min(...rects.map(v => v.x));
    const top = Math.min(...rects.map(v => v.y));
    const right = Math.max(...rects.map(v => v.x + v.w));
    const bottom = Math.max(...rects.map(v => v.y + v.h));

    // Horizontal: measured from the section's content inset (margin + 4).
    expect(left - (MARGIN_MM + 4)).toBeCloseTo(quietMm, 2);
    // Vertical: measured from the "Verify Online" heading baseline.
    const headingY = textBaselineMm(r.doc, CERTIFICATE_COPY.SECTION_VERIFY_ONLINE);
    expect(top - (headingY + SECTION_HEADING_ADVANCE_MM)).toBeCloseTo(quietMm, 2);

    // Right and bottom: the reserved box extends a quiet zone past the modules,
    // and the text column starts beyond it, so nothing encroaches.
    const boxRight = MARGIN_MM + 4 + QR_SIDE_MM + quietMm * 2;
    expect(boxRight - right).toBeCloseTo(quietMm, 2);
    const urlBaseline = textBaselineMm(r.doc, 'https://app.arkova.ai/verify/ARK-2026-001');
    expect(urlBaseline).toBeLessThan(bottom + quietMm + EPS);
  });

  it('paints no QR at all when there is no publicId', () => {
    expect(paintedRects(buildAuditReport(securedData({ publicId: '' })).doc)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Field label / value spacing as painted.
//
// `addField` paints the label in helvetica-bold 9 pt, then starts the value at
// `x + measured label width + gap`. jsPDF's `getTextWidth` measures with the
// CURRENTLY selected font, so measuring the label after switching to the value
// face (helvetica regular) under-counts it: Helvetica-Bold advance widths are
// wider than regular ones ('i' 278 vs 222, 'm' 889 vs 833, 't' 333 vs 278 per
// mille), by an amount that grows with label length. From roughly 13
// characters the value overprinted the label in every renderer (pdf.js
// 6.2.108, macOS QuickLook): "Document TypeDOCUMENT", "Record Position#3",
// "Network Observed TimeJun 2, 2026, 3:00 AM UTC".
//
// These tests read the content stream, not the helper's arithmetic. The `Td` x
// of each value run must sit a real gap past the label's PAINTED width — its
// width in the bold face using advance widths only, because a plain `Tj`
// string is painted with the font's advance widths and never applies kerning
// pairs. Short labels passing while long ones fail is exactly the signature of
// measuring in the wrong face, so the gap must also be uniform across labels.
// ─────────────────────────────────────────────────────────────────────────────

/** Every single-line text run in the content stream, in paint order: the
 *  `Td` origin in mm (top-left page origin) plus the unescaped string. */
function textRuns(doc: {
  output: () => string;
  internal: { pageSize: { getHeight: () => number } };
}): { x: number; y: number; text: string }[] {
  const pageHeightMm = doc.internal.pageSize.getHeight();
  return [
    ...doc.output().matchAll(/(-?[\d.]+) (-?[\d.]+) Td\s*\(((?:\\.|[^\\)])*)\) Tj/g),
  ].map(m => ({
    x: Number(m[1]) / PT_PER_MM,
    y: pageHeightMm - Number(m[2]) / PT_PER_MM,
    text: m[3].replace(/\\([()\\])/g, '$1'),
  }));
}

/**
 * Width of `text` in mm as a PDF viewer paints it in the given face at
 * `sizePt`: the font's advance widths summed, no kerning. Measured through
 * jsPDF's own AFM tables for the standard-14 faces (Helvetica and
 * Helvetica-Bold are separate entries), which is what any metric-compatible
 * substitute (Arial, Liberation Sans, Nimbus Sans) reproduces.
 */
function paintedWidthMm(doc: jsPDF, text: string, style: 'bold' | 'normal', sizePt: number): number {
  doc.setFont('helvetica', style);
  doc.setFontSize(sizePt);
  return (doc.getStringUnitWidth(text, { doKerning: false }) * sizePt) / doc.internal.scaleFactor;
}

describe('audit certificate — field label / value spacing as painted', () => {
  /** Mirrors the module-scope constant in generateAuditReport.ts. */
  const FIELD_LABEL_GAP_MM = 2;
  const FIELD_FONT_PT = 9;
  const EPS = 0.05;

  const FIELD_LABELS = new Set(
    Object.entries(CERTIFICATE_COPY)
      .filter(([k]) => k.startsWith('FIELD_'))
      .map(([, v]) => v as string),
  );

  /** Each painted `FIELD_*` label that has a value run on the same baseline,
   *  with the gap between the label's painted right edge and the value's x. */
  function labelValueGaps(doc: jsPDF) {
    const runs = textRuns(doc);
    const out: { label: string; value: string; gap: number }[] = [];
    runs.forEach((run, i) => {
      const next = runs[i + 1];
      if (!FIELD_LABELS.has(run.text) || !next || Math.abs(next.y - run.y) > 1e-3) return;
      const paintedLabel = paintedWidthMm(doc, run.text, 'bold', FIELD_FONT_PT);
      out.push({ label: run.text, value: next.text, gap: next.x - (run.x + paintedLabel) });
    });
    return out;
  }

  it('paints the long labels the report named, each followed by its value on the same baseline', () => {
    const gaps = labelValueGaps(buildAuditReport(securedData()).doc);
    const byLabel = new Map(gaps.map(g => [g.label, g.value]));
    expect(byLabel.get(CERTIFICATE_COPY.FIELD_CREDENTIAL_TYPE)).toBe('DIPLOMA');
    expect(byLabel.get(CERTIFICATE_COPY.FIELD_VERIFICATION_PATH)).toBe('2 step(s)');
    expect(byLabel.get(CERTIFICATE_COPY.FIELD_RECORD_POSITION)).toBe('#3');
    expect(byLabel.get(CERTIFICATE_COPY.FIELD_LEAF_COUNT)).toBe('8');
    expect(byLabel.get(CERTIFICATE_COPY.FIELD_NETWORK_RECORD)).toBe('#850,123');
    expect(byLabel.get(CERTIFICATE_COPY.FIELD_PROOF_SCHEMA)).toBe('1');
    expect(byLabel.get(CERTIFICATE_COPY.FIELD_OBSERVED_TIME)).toMatch(/^Jun 2, 2026, 3:00/);
    // A short label the report said rendered fine — it is held to the same gap.
    expect(byLabel.get(CERTIFICATE_COPY.FIELD_FILENAME)).toBe('diploma.pdf');
    expect(gaps.length).toBeGreaterThanOrEqual(12);
  });

  it('starts every value at least FIELD_LABEL_GAP_MM past the painted (bold) label', () => {
    const gaps = labelValueGaps(buildAuditReport(securedData()).doc);
    for (const g of gaps) {
      expect(
        g.gap,
        `"${g.label}" → "${g.value}": value starts ${g.gap.toFixed(2)} mm after the painted label`,
      ).toBeGreaterThanOrEqual(FIELD_LABEL_GAP_MM - EPS);
    }
  });

  it('uses one gap for every label — no drift with label length (the wrong-face signature)', () => {
    const gaps = labelValueGaps(buildAuditReport(securedData()).doc).map(g => g.gap);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(EPS);
  });

  it('holds the same gap in the non-SECURED fallback path', () => {
    const gaps = labelValueGaps(
      buildAuditReport(securedData({ status: 'PENDING', proof: undefined })).doc,
    );
    expect(gaps.map(g => g.label)).toContain(CERTIFICATE_COPY.FIELD_OBSERVED_TIME);
    for (const g of gaps) expect(g.gap).toBeGreaterThanOrEqual(FIELD_LABEL_GAP_MM - EPS);
  });

  it('jsPDF measures Helvetica-Bold with its own AFM widths, wider than regular (guards the fix)', () => {
    // jsPDF's standard-14 tables carry the Adobe AFM advance widths at 10 per
    // mille resolution. Summed for "Network Observed Time": Helvetica-Bold
    // 11,410 and Helvetica 10,730 — 36.23 mm vs 34.07 mm at 9 pt. The old
    // helper measured the regular face plus two spaces with kerning on, which
    // came to 35.85 mm: 0.38 mm SHORTER than the bold label it had painted.
    const { doc } = buildAuditReport(securedData());
    const label = CERTIFICATE_COPY.FIELD_OBSERVED_TIME;
    expect(paintedWidthMm(doc, label, 'bold', 9)).toBeCloseTo(36.23, 1);
    expect(paintedWidthMm(doc, label, 'normal', 9)).toBeCloseTo(34.07, 1);
    expect(paintedWidthMm(doc, label, 'bold', 9) - paintedWidthMm(doc, label, 'normal', 9)).toBeGreaterThan(2);
  });
});
