/**
 * PDF Audit Report Generator
 *
 * Generates a downloadable PDF audit certificate for a secured anchor,
 * including document info, cryptographic proof, and lifecycle timeline.
 *
 * PROOF-04 (SCRUM-2337): the certificate now embeds a machine-readable proof
 * packet (the cryptographic fields a third party needs to re-verify the
 * document offline) plus an "verify this offline" instruction block pointing
 * at the reference verifier. The proof packet is rendered human-readably AND
 * stored verbatim in the PDF document properties so automated tooling can
 * extract it.
 *
 * §1.6 BOUNDARY: this generator is CLIENT-SIDE only and stays that way. It
 * embeds ONLY the proof packet — fingerprint, merkle root/proof/index,
 * tx/block fields, op_return payload, schema version, signature metadata. It
 * NEVER embeds document bytes or PII. `buildProofPacket()` deliberately
 * excludes filename, issuer name, file size, and any record identifier.
 *
 * §1.3 TERMINOLOGY: every user-facing string is routed through `copy.ts`
 * (CERTIFICATE_COPY) and the status badge comes from `getStatusDisplay` — no
 * banned terms, no hardcoded "Verified".
 *
 * @see P6-TS-05
 * @see PROOF-04 / SCRUM-2337
 */

import { jsPDF } from 'jspdf';
import { CERTIFICATE_COPY } from './copy';
import { getStatusDisplay, isProofDownloadable } from './statusDisplay';

/**
 * One sibling along the Merkle inclusion branch. Matches the stored
 * `anchor_proofs.proof_path` shape and the verify-proof API / PROOF-07 CLI
 * `MerkleProofEntry` field-for-field — the offline verifier needs both the
 * `hash` and its `position` to recompute the root, so the branch is NEVER
 * flattened to a `string[]`.
 */
export interface MerkleProofEntry {
  hash: string;
  position: 'left' | 'right';
}

/**
 * Inline signature envelope metadata (never the private key). Matches the
 * canonical PROOF-05 `proof_bundle.signature` shape so the embedded packet is
 * field-compatible with what the API emits and the CLI parses.
 */
export interface ProofSignature {
  alg: string;
  signing_key_id: string;
}

/**
 * The machine-readable proof packet embedded in the certificate. This is the
 * CANONICAL `proof_bundle` shape — PROOF-05 (SCRUM-2338) emits it on the
 * verify-proof API, the PROOF-07 reference CLI parses it, and Lane 2
 * (SCRUM-2501) renders it; the field set + names MUST match field-for-field.
 *
 * It is a strict allow-list of cryptographic fields, chosen so the packet is
 * independently verifiable yet carries no document bytes and no PII (no
 * filename, issuer, or record id).
 */
export interface ProofPacket {
  fingerprint: string;
  merkle_root: string | null;
  /** Structured inclusion branch — `{ hash, position }[]`, never `string[]`. */
  merkle_proof: MerkleProofEntry[] | null;
  merkle_index: number | null;
  /** Total leaf count of the batch tree — enables the CVE-2012-2459 guard. */
  leaf_count: number | null;
  tx_id: string | null;
  block_height: number | null;
  block_hash: string | null;
  /** Raw 80-byte block header as plain 160-hex. */
  block_header: string | null;
  /** Raw OP_RETURN payload ("ARKV"+root, no version byte) as plain hex. */
  op_return_payload: string | null;
  /** Format version (1 = plain double-SHA256). Non-null; defaults to 1. */
  proof_schema_version: number;
  /** ISO-8601 network-observed block time (the machine field name). */
  block_timestamp: string | null;
  /** Inline signature envelope metadata; `null` on the default unsigned path. */
  signature: ProofSignature | null;
}

/** Raw proof inputs the caller pulls from `anchor_proofs` (+ anchor row). */
export interface ProofInput {
  fingerprint: string;
  merkle_root?: string | null;
  merkle_proof?: MerkleProofEntry[] | null;
  merkle_index?: number | null;
  leaf_count?: number | null;
  tx_id?: string | null;
  block_height?: number | null;
  block_hash?: string | null;
  block_header?: string | null;
  op_return_payload?: string | null;
  proof_schema_version?: number | null;
  block_timestamp?: string | null;
  signature?: ProofSignature | null;
}

export interface AuditReportData {
  publicId: string;
  filename: string;
  fingerprint: string;
  status: string;
  fileSize?: number;
  credentialType?: string;
  issuerName?: string;
  createdAt: string;
  issuedAt?: string;
  securedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
  expiresAt?: string;
  networkReceipt?: string;
  blockHeight?: number;
  /** Full proof inputs (from `anchor_proofs`). When absent or non-SECURED, no
   *  machine-readable proof packet is embedded. */
  proof?: ProofInput;
  /**
   * Whether the embedded packet is a COMPLETE offline proof — i.e. every field
   * needed to run all offline checks (notably `leaf_count`, which arms the
   * CVE-2012-2459 guard) was sourced. Defaults to `true` for backwards
   * compatibility. When `false`, the certificate still embeds the packet for
   * inspection but uses the "incomplete" offline-verify copy and does NOT claim
   * the proof can run every check (§1.5 — measured vs not asserted).
   */
  proofComplete?: boolean;
}

export interface AuditReportResult {
  doc: jsPDF;
  filename: string;
  /** The embedded proof JSON string, or null when the record is not SECURED /
   *  has no proof. Exposed so callers and tests can inspect it. */
  embeddedProofJson: string | null;
}

function formatDate(dateStr: string): string {
  return (
    new Date(dateStr).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) + ' UTC'
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

/**
 * Build the machine-readable proof packet from report data.
 *
 * Returns null when the record is not SECURED or carries no proof data —
 * download/embed is gated on `isProofDownloadable` (SECURED-only) per the
 * FE-PROOF-GATE contract. The packet is a strict allow-list of cryptographic
 * fields: no document bytes, no PII, no filename/issuer/record id.
 */
export function buildProofPacket(data: AuditReportData): ProofPacket | null {
  if (!isProofDownloadable(data.status)) return null;
  if (!data.proof) return null;

  const p = data.proof;
  // Preserve the structured `{ hash, position }` branch verbatim — validate
  // each entry but NEVER flatten to strings (that would drop the position the
  // offline verifier needs to recompute the root). Reject malformed entries.
  const merkleProof =
    Array.isArray(p.merkle_proof) && p.merkle_proof.every(isMerkleProofEntry)
      ? p.merkle_proof
      : null;

  return {
    fingerprint: p.fingerprint ?? data.fingerprint,
    merkle_root: p.merkle_root ?? null,
    merkle_proof: merkleProof,
    merkle_index: typeof p.merkle_index === 'number' ? p.merkle_index : null,
    leaf_count: typeof p.leaf_count === 'number' ? p.leaf_count : null,
    tx_id: p.tx_id ?? data.networkReceipt ?? null,
    block_height:
      typeof p.block_height === 'number'
        ? p.block_height
        : typeof data.blockHeight === 'number'
          ? data.blockHeight
          : null,
    block_hash: p.block_hash ?? null,
    block_header: p.block_header ?? null,
    op_return_payload: p.op_return_payload ?? null,
    // proof_schema_version is non-null; default to 1 (plain double-SHA256).
    proof_schema_version:
      typeof p.proof_schema_version === 'number' ? p.proof_schema_version : 1,
    block_timestamp: p.block_timestamp ?? data.securedAt ?? null,
    signature: p.signature ?? null,
  };
}

/** Type guard: a value is a well-formed `{ hash, position }` Merkle entry. */
function isMerkleProofEntry(v: unknown): v is MerkleProofEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.hash === 'string' && (e.position === 'left' || e.position === 'right')
  );
}

/**
 * Build the audit-certificate PDF. Pure / client-side: returns the jsPDF
 * instance (no DOM, no save) plus the embedded proof JSON so callers and tests
 * can inspect the result. Use `generateAuditReport` to also trigger download.
 */
export function buildAuditReport(data: AuditReportData): AuditReportResult {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  // ── Header ──────────────────────────────────────────
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text(CERTIFICATE_COPY.TITLE, margin, y);
  y += 10;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text(
    interpolate(CERTIFICATE_COPY.GENERATED_AT, { date: formatDate(new Date().toISOString()) }),
    margin,
    y,
  );
  y += 4;
  doc.text(interpolate(CERTIFICATE_COPY.VERIFICATION_ID, { id: data.publicId }), margin, y);
  y += 8;

  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, margin + contentWidth, y);
  y += 10;

  // ── Status (badge label from getStatusDisplay — never a raw enum) ──────
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  const statusLabel = getStatusDisplay(data.status).label;
  doc.text(interpolate(CERTIFICATE_COPY.STATUS_LABEL, { status: statusLabel }), margin, y);
  y += 12;

  // ── Document Information ───────────────────
  y = addSection(doc, CERTIFICATE_COPY.SECTION_DOCUMENT, y, margin);
  y = addField(doc, CERTIFICATE_COPY.FIELD_FILENAME, data.filename, y, margin, contentWidth);
  if (data.fileSize) {
    y = addField(doc, CERTIFICATE_COPY.FIELD_FILE_SIZE, formatFileSize(data.fileSize), y, margin, contentWidth);
  }
  if (data.credentialType) {
    y = addField(doc, CERTIFICATE_COPY.FIELD_CREDENTIAL_TYPE, data.credentialType, y, margin, contentWidth);
  }
  y += 4;

  // ── Issuer ─────────────────────────────────────────
  if (data.issuerName) {
    y = addSection(doc, CERTIFICATE_COPY.SECTION_ISSUER, y, margin);
    y = addField(doc, CERTIFICATE_COPY.FIELD_ORGANIZATION, data.issuerName, y, margin, contentWidth);
    if (data.issuedAt) {
      y = addField(doc, CERTIFICATE_COPY.FIELD_ISSUED, formatDate(data.issuedAt), y, margin, contentWidth);
    }
    y += 4;
  }

  // ── Cryptographic Proof (human-readable) ────────────────────
  const packet = buildProofPacket(data);

  y = addSection(doc, CERTIFICATE_COPY.SECTION_PROOF, y, margin);
  y = addField(doc, CERTIFICATE_COPY.FIELD_FINGERPRINT, '', y, margin, contentWidth);
  y = addMono(doc, data.fingerprint, y, margin);

  if (packet) {
    if (packet.tx_id) {
      y = addField(doc, CERTIFICATE_COPY.FIELD_NETWORK_RECEIPT, '', y, margin, contentWidth);
      y = addMono(doc, packet.tx_id, y, margin);
    }
    if (packet.merkle_root) {
      y = addField(doc, CERTIFICATE_COPY.FIELD_VERIFICATION_TREE_ROOT, '', y, margin, contentWidth);
      y = addMono(doc, packet.merkle_root, y, margin);
    }
    if (packet.merkle_proof && packet.merkle_proof.length > 0) {
      y = addField(
        doc,
        CERTIFICATE_COPY.FIELD_VERIFICATION_PATH,
        `${packet.merkle_proof.length} step(s)`,
        y,
        margin,
        contentWidth,
      );
      // Each step carries its sibling hash AND its position (left/right) — both
      // are required to recompute the root, so render them together.
      for (const step of packet.merkle_proof) {
        y = addMono(doc, `${step.position}: ${step.hash}`, y, margin);
      }
    }
    if (typeof packet.merkle_index === 'number') {
      y = addField(doc, CERTIFICATE_COPY.FIELD_RECORD_POSITION, `#${packet.merkle_index}`, y, margin, contentWidth);
    }
    if (typeof packet.leaf_count === 'number') {
      y = addField(doc, CERTIFICATE_COPY.FIELD_LEAF_COUNT, String(packet.leaf_count), y, margin, contentWidth);
    }
    if (packet.block_height) {
      y = addField(
        doc,
        CERTIFICATE_COPY.FIELD_NETWORK_RECORD,
        `#${packet.block_height.toLocaleString()}`,
        y,
        margin,
        contentWidth,
      );
    }
    y = addField(
      doc,
      CERTIFICATE_COPY.FIELD_PROOF_SCHEMA,
      String(packet.proof_schema_version),
      y,
      margin,
      contentWidth,
    );
    if (packet.signature) {
      y = addField(
        doc,
        CERTIFICATE_COPY.FIELD_SIGNATURE,
        `${packet.signature.alg} (${packet.signature.signing_key_id})`,
        y,
        margin,
        contentWidth,
      );
    }
    if (packet.block_timestamp) {
      y = addField(doc, CERTIFICATE_COPY.FIELD_OBSERVED_TIME, formatDate(packet.block_timestamp), y, margin, contentWidth);
    }
  } else {
    // Non-SECURED fallback: surface the legacy network fields if present.
    if (data.networkReceipt) {
      y = addField(doc, CERTIFICATE_COPY.FIELD_NETWORK_RECEIPT, '', y, margin, contentWidth);
      y = addMono(doc, data.networkReceipt, y, margin);
    }
    if (data.blockHeight) {
      y = addField(doc, CERTIFICATE_COPY.FIELD_NETWORK_RECORD, `#${data.blockHeight.toLocaleString()}`, y, margin, contentWidth);
    }
    if (data.securedAt) {
      y = addField(doc, CERTIFICATE_COPY.FIELD_OBSERVED_TIME, formatDate(data.securedAt), y, margin, contentWidth);
    }
  }
  y += 4;

  // ── Lifecycle ──────────────────────────────────────
  y = addSection(doc, CERTIFICATE_COPY.SECTION_LIFECYCLE, y, margin);
  y = addField(doc, CERTIFICATE_COPY.FIELD_CREATED, formatDate(data.createdAt), y, margin, contentWidth);
  if (data.securedAt) {
    y = addField(doc, CERTIFICATE_COPY.FIELD_SECURED, formatDate(data.securedAt), y, margin, contentWidth);
  }
  if (data.expiresAt) {
    y = addField(doc, CERTIFICATE_COPY.FIELD_EXPIRES, formatDate(data.expiresAt), y, margin, contentWidth);
  }
  if (data.revokedAt) {
    y = addField(doc, CERTIFICATE_COPY.FIELD_REVOKED, formatDate(data.revokedAt), y, margin, contentWidth);
  }
  if (data.revocationReason) {
    y = addField(doc, CERTIFICATE_COPY.FIELD_REVOCATION_REASON, data.revocationReason, y, margin, contentWidth);
  }
  y += 8;

  // ── Offline-verify block + embedded machine-readable proof ──────────
  let embeddedProofJson: string | null = null;
  if (packet) {
    embeddedProofJson = JSON.stringify(packet, null, 2);

    ensureSpace(60);
    y = addSection(doc, CERTIFICATE_COPY.SECTION_OFFLINE_VERIFY, y, margin);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(40, 40, 40);
    // When the packet is missing a field required to run every check (e.g.
    // `leaf_count` could not be sourced for a batch member), the certificate
    // must NOT claim a complete offline proof (§1.5). `proofComplete` defaults
    // to `true` so existing callers are unaffected.
    const offlineIntro =
      data.proofComplete === false
        ? CERTIFICATE_COPY.OFFLINE_VERIFY_INTRO_INCOMPLETE
        : CERTIFICATE_COPY.OFFLINE_VERIFY_INTRO;
    for (const line of [
      offlineIntro,
      CERTIFICATE_COPY.OFFLINE_VERIFY_STEP_1,
      CERTIFICATE_COPY.OFFLINE_VERIFY_STEP_2,
      CERTIFICATE_COPY.OFFLINE_VERIFY_STEP_3,
      CERTIFICATE_COPY.OFFLINE_VERIFY_TOOL,
    ]) {
      const wrapped = doc.splitTextToSize(line, contentWidth);
      ensureSpace(wrapped.length * 5 + 2);
      doc.text(wrapped, margin, y);
      y += wrapped.length * 5 + 2;
    }
    y += 4;

    // Machine-readable JSON — embedded in document properties (verbatim, for
    // automated extraction) AND rendered visibly (chunked, monospace) so a
    // human can copy it out of a printed certificate.
    doc.setProperties({
      title: `${CERTIFICATE_COPY.TITLE} — ${data.publicId}`,
      subject: 'arkova-proof-packet',
      keywords: embeddedProofJson,
    });

    ensureSpace(30);
    y = addSection(doc, CERTIFICATE_COPY.SECTION_MACHINE_PROOF, y, margin);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(120, 120, 120);
    const noteLines = doc.splitTextToSize(CERTIFICATE_COPY.MACHINE_PROOF_NOTE, contentWidth);
    doc.text(noteLines, margin, y);
    y += noteLines.length * 4 + 2;

    doc.setFont('courier', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(0, 0, 0);
    const jsonLines = embeddedProofJson.split('\n');
    for (const jl of jsonLines) {
      const wrapped = doc.splitTextToSize(jl, contentWidth);
      ensureSpace(wrapped.length * 3 + 1);
      doc.text(wrapped, margin, y);
      y += wrapped.length * 3 + 1;
    }
    y += 8;
  }

  // ── Footer / disclaimer ─────────────────────────────
  ensureSpace(24);
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, margin + contentWidth, y);
  y += 6;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(120, 120, 120);
  doc.text(CERTIFICATE_COPY.DISCLAIMER_OBSERVED, margin, y, { maxWidth: contentWidth });
  y += 8;
  doc.text(CERTIFICATE_COPY.DISCLAIMER_NOT_ASSERTED, margin, y, { maxWidth: contentWidth });

  const safeName = data.filename.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50);
  const filename = `arkova-certificate-${safeName}.pdf`;

  return { doc, filename, embeddedProofJson };
}

/**
 * Build and download the audit certificate. Thin wrapper over
 * `buildAuditReport` that triggers the browser save (client-side only).
 */
export function generateAuditReport(data: AuditReportData): void {
  const { doc, filename } = buildAuditReport(data);
  doc.save(filename);
}

function addSection(doc: jsPDF, title: string, y: number, margin: number): number {
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 0, 0);
  doc.text(title, margin, y);
  return y + 7;
}

function addField(
  doc: jsPDF,
  label: string,
  value: string,
  y: number,
  margin: number,
  contentWidth: number,
): number {
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(80, 80, 80);
  doc.text(label, margin + 4, y);

  if (value) {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0, 0, 0);
    const labelWidth = doc.getTextWidth(label + '  ');
    doc.text(value, margin + 4 + labelWidth, y, { maxWidth: contentWidth - labelWidth - 8 });
  }

  return y + 5;
}

/** Render a value on its own line in monospace (fingerprints, roots, etc.). */
function addMono(doc: jsPDF, value: string, y: number, margin: number): number {
  doc.setFontSize(7);
  doc.setFont('courier', 'normal');
  doc.setTextColor(0, 0, 0);
  doc.text(value, margin + 4, y);
  return y + 6;
}
