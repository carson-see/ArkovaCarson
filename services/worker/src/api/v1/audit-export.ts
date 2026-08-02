/**
 * Audit Export Endpoint (CML-03)
 *
 * POST /api/v1/audit-export — Single anchor audit PDF or CSV
 * POST /api/v1/audit-export/batch — Batch export for org (all SECURED anchors)
 *
 * Generates audit-ready documents for GRC platforms (Vanta, Drata, Anecdotes).
 * Includes: fingerprint, compliance controls, chain proof, lifecycle timeline.
 *
 * Constitution refs:
 *   - 1.4: Only exposes public_id (never internal IDs)
 *   - 1.5: Timestamps in UTC, proof statements per Constitution
 *   - 1.8: Additive endpoint, no breaking changes
 */

import { Router, Request, Response } from 'express';
import { jsPDF } from 'jspdf';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import {
  COMPLIANCE_CONTROLS_NOTE,
  controlsApplyForStatus,
  resolveComplianceControlIds,
} from '../../utils/complianceMapping.js';

const router = Router();

/** Max anchors per batch export */
const MAX_BATCH_SIZE = 500;

/**
 * Lowest `y` (mm) a block may START at on an A4 page (297mm) and still be
 * expected to fit. Used by addControlsNote to decide on a page break.
 */
const PAGE_CONTENT_BOTTOM = 275;

// ─── Control metadata for PDF rendering ──────────────
const CONTROL_LABELS: Record<string, { framework: string; label: string; description: string }> = {
  'SOC2-CC6.1': { framework: 'SOC 2', label: 'CC6.1', description: 'Logical and physical access controls' },
  'SOC2-CC6.7': { framework: 'SOC 2', label: 'CC6.7', description: 'Data integrity in transmission and storage' },
  'GDPR-5.1f': { framework: 'GDPR', label: 'Art. 5(1)(f)', description: 'Integrity and confidentiality' },
  'GDPR-25': { framework: 'GDPR', label: 'Art. 25', description: 'Data protection by design' },
  'FERPA-99.31': { framework: 'FERPA', label: '§99.31', description: 'Education record disclosure controls' },
  'ISO27001-A.10': { framework: 'ISO 27001', label: 'A.10', description: 'Cryptographic controls' },
  'ISO27001-A.14': { framework: 'ISO 27001', label: 'A.14', description: 'System acquisition and maintenance' },
  'eIDAS-25': { framework: 'eIDAS', label: 'Art. 25', description: 'Electronic signatures and seals' },
  'eIDAS-35': { framework: 'eIDAS', label: 'Art. 35', description: 'Qualified electronic time stamps' },
  'HIPAA-164.312': { framework: 'HIPAA', label: '§164.312', description: 'Technical safeguards for ePHI' },
};

// ─── Types ───────────────────────────────────────────
interface AnchorRow {
  id: string;
  public_id: string;
  filename: string;
  fingerprint: string;
  credential_type: string | null;
  status: string;
  created_at: string;
  issued_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  chain_confirmations: number | null;
  file_size: number | null;
  compliance_controls: string[] | null;
  metadata: Record<string, unknown> | null;
  org_id: string | null;
}

interface ProofRow {
  merkle_root: string | null;
  proof_path: string[] | null;
}

// ─── Helpers ─────────────────────────────────────────
function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }) + ' UTC';
}

function explorerUrl(txId: string): string {
  const network = config.bitcoinNetwork;
  if (network === 'mainnet') {
    return `https://mempool.space/tx/${txId}`;
  }
  return `https://mempool.space/${network}/tx/${txId}`;
}

function getControlIds(anchor: AnchorRow): string[] {
  // BUG-2026-06-24-007 (worker side): a control list is a statement about a
  // CURRENT posture. Once a credential is revoked / superseded / expired it gets
  // none — the export is the artifact an auditor actually receives, and the
  // SCRUM-2227 note disclaims attestation, not currency. `generateAuditPdf`
  // states WHY they are absent so the gap cannot be misread as "never had any".
  if (!controlsApplyForStatus(anchor.status)) return [];

  // SCRUM-2227/2283: stored controls (CML-02) win, filtered to the IDs this
  // worker still stands behind; falls back to the computed mapping when nothing
  // was stored or nothing survived. Shared with the GRC evidence push so the
  // rule has one home — see resolveComplianceControlIds.
  return resolveComplianceControlIds(anchor.compliance_controls, {
    fallbackCredentialType: anchor.credential_type,
  }) ?? [];
}

/**
 * BUG-2026-06-24-007: explain an EMPTY control section on a non-current
 * credential. Suppression is the right call for machine consumers, but a human
 * reading a PDF with no controls should not be left to guess whether the record
 * ever had any. Absence + reason is honest; absence alone is ambiguous.
 */
const CONTROLS_WITHHELD_NO_LONGER_CURRENT =
  'Compliance control identifiers are not shown for this record because it is no longer '
  + 'current. They describe controls Arkova maps to a live anchored credential; listing them '
  + 'here would suggest a compliance posture this record no longer has. This is not a '
  + 'statement that the record was never anchored — its anchor receipt and timestamps above '
  + 'are unchanged.';

/**
 * The NOT-YET-ANCHORED case. Kept separate because the wording above makes two
 * statements that are false for a PENDING / SUBMITTED record: it was never
 * "current", and there is no anchor receipt above to point at (chain_tx_id,
 * block height and timestamp are all null until it confirms). Shipping one
 * string for both states would have put a false claim on an auditor-facing
 * artifact inside a claims-honesty change.
 */
const CONTROLS_WITHHELD_NOT_YET_ANCHORED =
  'Compliance control identifiers are not shown for this record because it has not completed '
  + 'anchoring. They describe controls Arkova maps to an anchored credential, and this record '
  + 'does not yet have a confirmed anchor receipt. This is not a statement that the record is '
  + 'invalid — only that there is nothing anchored for these controls to describe yet.';

/** Terminal statuses meaning "was anchored, no longer current". */
const NO_LONGER_CURRENT_STATUSES: ReadonlySet<string> = new Set([
  'REVOKED',
  'EXPIRED',
  'SUPERSEDED',
]);

/**
 * Pick the honest explanation for an absent control section. Defaults to the
 * not-yet-anchored wording, which is the safer of the two for an unrecognised
 * status: it asserts nothing about a receipt that may not exist.
 */
function controlsWithheldNote(status: string): string {
  return NO_LONGER_CURRENT_STATUSES.has(status)
    ? CONTROLS_WITHHELD_NO_LONGER_CURRENT
    : CONTROLS_WITHHELD_NOT_YET_ANCHORED;
}

// ─── PDF Generation ──────────────────────────────────
function generateAuditPdf(anchor: AnchorRow, proof: ProofRow | null): Buffer {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  // ── Header ──
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Arkova Compliance Audit Report', margin, y);
  y += 9;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text(`Generated: ${formatDate(new Date().toISOString())}`, margin, y);
  y += 4;
  doc.text(`Verification ID: ${anchor.public_id}`, margin, y);
  y += 8;

  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, margin + contentWidth, y);
  y += 10;

  // ── Document Information ──
  doc.setTextColor(0, 0, 0);
  y = addSection(doc, 'Document Information', y, margin);
  y = addField(doc, 'Filename', anchor.filename, y, margin, contentWidth);
  y = addField(doc, 'Status', anchor.status === 'SECURED' ? 'VERIFIED (SECURED)' : anchor.status, y, margin, contentWidth);
  if (anchor.credential_type) {
    y = addField(doc, 'Credential Type', anchor.credential_type, y, margin, contentWidth);
  }
  if (anchor.file_size) {
    y = addField(doc, 'File Size', formatFileSize(anchor.file_size), y, margin, contentWidth);
  }
  if (anchor.metadata && typeof anchor.metadata === 'object') {
    const issuer = (anchor.metadata as Record<string, unknown>).issuer_name;
    if (issuer && typeof issuer === 'string') {
      y = addField(doc, 'Issuer', issuer, y, margin, contentWidth);
    }
  }
  y += 4;

  // ── Cryptographic Proof ──
  y = addSection(doc, 'Cryptographic Proof', y, margin);
  y = addField(doc, 'Fingerprint (SHA-256)', '', y, margin, contentWidth);
  doc.setFontSize(7);
  doc.setFont('courier', 'normal');
  doc.text(anchor.fingerprint, margin + 4, y);
  y += 6;

  if (anchor.chain_tx_id) {
    y = addField(doc, 'Network Receipt', '', y, margin, contentWidth);
    doc.setFontSize(7);
    doc.setFont('courier', 'normal');
    doc.text(anchor.chain_tx_id, margin + 4, y);
    y += 6;

    y = addField(doc, 'Explorer', explorerUrl(anchor.chain_tx_id), y, margin, contentWidth);
  }

  if (anchor.chain_block_height) {
    y = addField(doc, 'Network Record', `#${anchor.chain_block_height.toLocaleString()}`, y, margin, contentWidth);
  }

  if (anchor.chain_timestamp) {
    y = addField(doc, 'Network Observed Time', formatDate(anchor.chain_timestamp), y, margin, contentWidth);
  }

  if (anchor.chain_confirmations != null && anchor.chain_confirmations > 0) {
    y = addField(doc, 'Confirmations', String(anchor.chain_confirmations), y, margin, contentWidth);
  }

  if (proof?.merkle_root) {
    y = addField(doc, 'Merkle Root', '', y, margin, contentWidth);
    doc.setFontSize(7);
    doc.setFont('courier', 'normal');
    doc.text(proof.merkle_root, margin + 4, y);
    y += 6;
  }
  y += 4;

  // ── Compliance Controls ──
  const controlIds = getControlIds(anchor);
  if (!controlsApplyForStatus(anchor.status)) {
    // BUG-2026-06-24-007: say WHY the section is empty. A silent gap is
    // ambiguous — an auditor could read it as "this record never had controls"
    // rather than "they no longer apply" / "nothing is anchored yet".
    // (`getControlIds` returns [] whenever this gate is false, so these two
    // branches are exclusive.)
    y = addSection(doc, 'Regulatory Compliance Controls', y, margin);
    y = addControlsNote(doc, y, margin, contentWidth, controlsWithheldNote(anchor.status));
  } else if (controlIds.length > 0) {
    y = addSection(doc, 'Regulatory Compliance Controls', y, margin);

    // Group by framework
    const byFramework = new Map<string, Array<{ label: string; description: string }>>();
    for (const id of controlIds) {
      const meta = CONTROL_LABELS[id];
      if (!meta) continue;
      if (!byFramework.has(meta.framework)) byFramework.set(meta.framework, []);
      byFramework.get(meta.framework)!.push({ label: meta.label, description: meta.description });
    }

    for (const [framework, controls] of byFramework) {
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(60, 60, 60);
      doc.text(framework, margin + 4, y);
      y += 5;

      for (const ctrl of controls) {
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(0, 0, 0);
        doc.text(`${ctrl.label} — ${ctrl.description}`, margin + 8, y, { maxWidth: contentWidth - 12 });
        y += 4;
      }
      y += 2;

      // Page overflow check
      if (y > 270) {
        doc.addPage();
        y = margin;
      }
    }

    // SCRUM-2227: the control list never stands alone — state what it does NOT
    // assert, immediately under it, on the same page-flow.
    y = addControlsNote(doc, y, margin, contentWidth);
  }

  // ── Lifecycle Timeline ──
  y = addSection(doc, 'Lifecycle Timeline', y, margin);
  y = addField(doc, 'Created', formatDate(anchor.created_at), y, margin, contentWidth);
  if (anchor.issued_at) {
    y = addField(doc, 'Issued', formatDate(anchor.issued_at), y, margin, contentWidth);
  }
  if (anchor.chain_timestamp) {
    y = addField(doc, 'Secured', formatDate(anchor.chain_timestamp), y, margin, contentWidth);
  }
  if (anchor.expires_at) {
    y = addField(doc, 'Expires', formatDate(anchor.expires_at), y, margin, contentWidth);
  }
  if (anchor.revoked_at) {
    y = addField(doc, 'Revoked', formatDate(anchor.revoked_at), y, margin, contentWidth);
    if (anchor.revocation_reason) {
      y = addField(doc, 'Revocation Reason', anchor.revocation_reason, y, margin, contentWidth);
    }
  }
  y += 8;

  // ── Footer / Disclaimer ──
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, margin + contentWidth, y);
  y += 6;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(120, 120, 120);
  doc.text(
    'This report was generated by Arkova. It asserts that the document fingerprint was observed at the stated time on a public network.',
    margin, y, { maxWidth: contentWidth },
  );
  y += 10;
  doc.text(
    'This report does NOT assert the accuracy of document contents, the identity of the issuer, or the validity of the credential itself.',
    margin, y, { maxWidth: contentWidth },
  );

  return Buffer.from(doc.output('arraybuffer'));
}

function generateBatchPdf(anchors: AnchorRow[]): Buffer {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  // ── Title page ──
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text('Arkova Compliance Audit Summary', margin, y);
  y += 10;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text(`Generated: ${formatDate(new Date().toISOString())}`, margin, y);
  y += 5;
  doc.text(`Total Anchors: ${anchors.length}`, margin, y);
  y += 10;

  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, margin + contentWidth, y);
  y += 10;

  // ── Summary by credential type ──
  doc.setTextColor(0, 0, 0);
  y = addSection(doc, 'Credential Type Summary', y, margin);
  const typeCount = new Map<string, number>();
  for (const a of anchors) {
    const t = a.credential_type ?? 'OTHER';
    typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
  }
  for (const [type, count] of [...typeCount.entries()].sort((a, b) => b[1] - a[1])) {
    y = addField(doc, type, String(count), y, margin, contentWidth);
  }
  y += 6;

  // ── Framework coverage ──
  y = addSection(doc, 'Framework Coverage', y, margin);
  const frameworkSet = new Set<string>();
  for (const a of anchors) {
    const ids = getControlIds(a);
    for (const id of ids) {
      const meta = CONTROL_LABELS[id];
      if (meta) frameworkSet.add(meta.framework);
    }
  }
  if (frameworkSet.size > 0) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text([...frameworkSet].sort().join(' • '), margin + 4, y);
    y += 6;
    // SCRUM-2227: framework coverage is a mapping, not an assessment.
    y = addControlsNote(doc, y, margin, contentWidth);
  } else {
    // BUG-2026-06-24-007: a batch of non-current records (the batch endpoint
    // accepts a caller-supplied `status`, e.g. REVOKED) now yields NO frameworks.
    // Before the currency gate this was unreachable, because getControlIds always
    // fell back to the never-empty universal set. Emitting the blank line plus the
    // informational note would leave the note qualifying a list that is not there
    // — the exact thing this surface's agents.md forbids. Explain the absence
    // instead, matching the single-record PDF.
    y = addControlsNote(
      doc, y, margin, contentWidth,
      'No compliance control identifiers are shown for this batch: none of the included '
      + 'records is a current anchored credential. Controls describe controls Arkova maps to '
      + 'a live anchored credential, so listing them here would suggest a compliance posture '
      + 'these records do not have.',
    );
  }

  // ── Individual entries (compact) ──
  y = addSection(doc, 'Anchor Details', y, margin);

  for (const anchor of anchors) {
    if (y > 260) {
      doc.addPage();
      y = margin;
    }

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text(`${anchor.public_id} — ${anchor.filename}`, margin + 4, y);
    y += 4;

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(80, 80, 80);
    const details = [
      `Type: ${anchor.credential_type ?? 'OTHER'}`,
      `Status: ${anchor.status}`,
      anchor.chain_tx_id ? `TX: ${anchor.chain_tx_id.substring(0, 16)}...` : null,
      `Controls: ${getControlIds(anchor).length}`,
    ].filter(Boolean).join(' | ');
    doc.text(details, margin + 4, y, { maxWidth: contentWidth - 8 });
    y += 6;
  }

  // ── Footer ──
  y += 4;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, margin + contentWidth, y);
  y += 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(120, 120, 120);
  doc.text(
    'This summary report was generated by Arkova for audit purposes. Individual anchor details should be verified independently.',
    margin, y, { maxWidth: contentWidth },
  );

  return Buffer.from(doc.output('arraybuffer'));
}

// ─── CSV Generation ──────────────────────────────────
function generateAnchorCsv(anchors: AnchorRow[]): string {
  const headers = [
    'verification_id', 'filename', 'credential_type', 'status',
    'fingerprint', 'network_receipt', 'block_height', 'network_observed_time',
    'confirmations', 'compliance_controls', 'compliance_frameworks',
    'created_at', 'issued_at', 'expires_at', 'revoked_at',
    // SCRUM-2227: APPENDED, not inserted next to compliance_controls. Auditor
    // tooling that ingests this export by column INDEX would silently shift
    // created_at/issued_at/expires_at/revoked_at by one if this landed
    // mid-row. Appending keeps the addition non-breaking for positional
    // consumers and identical for header-keyed ones.
    'compliance_controls_note',
  ];

  const rows = anchors.map(a => {
    const controlIds = getControlIds(a);
    const frameworks = [...new Set(controlIds.map(id => CONTROL_LABELS[id]?.framework).filter(Boolean))];
    return [
      a.public_id,
      csvEscape(a.filename),
      a.credential_type ?? '',
      a.status,
      a.fingerprint,
      a.chain_tx_id ?? '',
      a.chain_block_height != null ? String(a.chain_block_height) : '',
      a.chain_timestamp ?? '',
      a.chain_confirmations != null ? String(a.chain_confirmations) : '',
      csvEscape(controlIds.join('; ')),
      csvEscape(frameworks.join('; ')),
      a.created_at,
      a.issued_at ?? '',
      a.expires_at ?? '',
      a.revoked_at ?? '',
      // SCRUM-2227: present exactly when controls are. Appended last to match
      // the header — see the note there on positional consumers. The escaped
      // cell is hoisted (NOTE_CSV_CELL) rather than re-escaped up to 500x per
      // export; it is repeated per row on purpose, so a row stays honest when
      // an auditor filters or splits the sheet.
      controlIds.length > 0 ? NOTE_CSV_CELL : '',
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * SCRUM-2227: the compliance note pre-escaped once. It is a module constant, so
 * re-running csvEscape over it for every one of up to MAX_BATCH_SIZE rows is
 * pure waste. Declared after csvEscape's declaration site is irrelevant —
 * function declarations hoist.
 */
const NOTE_CSV_CELL = csvEscape(COMPLIANCE_CONTROLS_NOTE);

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * SCRUM-2227: render the informational-not-attestation note directly under a
 * control list, and return the new `y`.
 *
 * One helper rather than a copy in each generator: the note is a legal string
 * that is NOT yet counsel-reviewed, so it will be reworded, and it must not be
 * possible for the two PDFs to drift in how much room they leave for it.
 * The advance is MEASURED with splitTextToSize rather than a magic constant —
 * `maxWidth` wraps glyphs but does not report how many lines it drew, so a
 * hardcoded advance silently overlaps the next section when the text grows.
 */
function addControlsNote(
  doc: jsPDF, y: number, margin: number, contentWidth: number,
  text: string = COMPLIANCE_CONTROLS_NOTE,
): number {
  const NOTE_FONT_SIZE = 7;
  const LINE_HEIGHT = 3;
  doc.setFontSize(NOTE_FONT_SIZE);
  doc.setFont('helvetica', 'italic');
  const lines = doc.splitTextToSize(text, contentWidth - 8) as string[];

  // Page-break before rendering if the measured block would not fit.
  if (y + lines.length * LINE_HEIGHT > PAGE_CONTENT_BOTTOM) {
    doc.addPage();
    y = margin;
    doc.setFontSize(NOTE_FONT_SIZE);
    doc.setFont('helvetica', 'italic');
  }

  doc.setTextColor(120, 120, 120);
  doc.text(lines, margin + 4, y);
  y += lines.length * LINE_HEIGHT + 4;

  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'normal');
  return y;
}

function addSection(doc: jsPDF, title: string, y: number, margin: number): number {
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 0, 0);
  doc.text(title, margin, y);
  y += 7;
  return y;
}

function addField(
  doc: jsPDF, label: string, value: string, y: number, margin: number, contentWidth: number,
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

  y += 5;
  return y;
}

// ─── Routes ──────────────────────────────────────────

const ANCHOR_SELECT = 'id, public_id, filename, fingerprint, credential_type, status, created_at, issued_at, expires_at, revoked_at, revocation_reason, chain_tx_id, chain_block_height, chain_timestamp, chain_confirmations, file_size, compliance_controls, metadata, org_id';

type AuditOrgLookupResult =
  | { status: 'ok'; orgId: string }
  | { status: 'forbidden' }
  | { status: 'error' };

async function resolveAuditExportOrgId(userId: string, logContext: string): Promise<AuditOrgLookupResult> {
  // Use `.maybeSingle()` so an absent profile resolves to { data: null,
  // error: null } instead of raising PGRST116. A real operational failure
  // returns { data: null, error } and must surface as 500, not be hidden as
  // "no org membership".
  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('org_id')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) {
    // Log coarse message/code only — never row contents or PII (§1.4).
    logger.error({ error: profileError.message, code: profileError.code }, logContext);
    return { status: 'error' };
  }

  if (!profile?.org_id) {
    return { status: 'forbidden' };
  }

  return { status: 'ok', orgId: profile.org_id };
}

/** POST / — Single anchor audit export (PDF or CSV) */
router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { anchorId, format = 'pdf' } = req.body ?? {};
  if (!anchorId || typeof anchorId !== 'string') {
    res.status(400).json({ error: 'anchorId is required' });
    return;
  }

  try {
    const orgLookup = await resolveAuditExportOrgId(userId, 'Audit export: profile lookup failed');
    if (orgLookup.status === 'error') {
      res.status(500).json({ error: 'Failed to generate audit export' });
      return;
    }
    if (orgLookup.status === 'forbidden') {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    // Fetch anchor by public_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: anchor } = await (db as any)
      .from('anchors')
      .select(ANCHOR_SELECT)
      .eq('public_id', anchorId)
      .single();

    if (!anchor) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }

    const anchorRow = anchor as AnchorRow;

    // Org authorization
    if (anchorRow.org_id !== orgLookup.orgId) {
      res.status(403).json({ error: 'Unauthorized — anchor belongs to a different organization' });
      return;
    }

    // Fetch proof data
    const { data: proof } = await db
      .from('anchor_proofs')
      .select('merkle_root, proof_path')
      .eq('anchor_id', anchorRow.id)
      .maybeSingle();

    const proofRow = proof as ProofRow | null;

    if (format === 'csv') {
      const csv = generateAnchorCsv([anchorRow]);
      const safeName = anchorRow.filename.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="arkova-audit-${safeName}.csv"`);
      res.send(csv);
      return;
    }

    // Default: PDF
    const pdfBuffer = generateAuditPdf(anchorRow, proofRow);
    const safeName = anchorRow.filename.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="arkova-audit-${safeName}.pdf"`);
    res.send(pdfBuffer);

    logger.info({ anchorId: anchorRow.public_id, format }, 'Audit export generated');
  } catch (err) {
    logger.error({ error: err, anchorId }, 'Failed to generate audit export');
    res.status(500).json({ error: 'Failed to generate audit export' });
  }
});

/** POST /batch — Batch audit export for org (PDF or CSV) */
router.post('/batch', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const orgLookup = await resolveAuditExportOrgId(userId, 'Batch audit export: profile lookup failed');
    if (orgLookup.status === 'error') {
      res.status(500).json({ error: 'Failed to generate batch audit export' });
      return;
    }
    if (orgLookup.status === 'forbidden') {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    const { format = 'csv', limit: rawLimit, credentialType, status = 'SECURED' } = req.body ?? {};
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || MAX_BATCH_SIZE, 1), MAX_BATCH_SIZE);

    // Fetch org anchors
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .from('anchors')
      .select(ANCHOR_SELECT)
      .eq('org_id', orgLookup.orgId)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (credentialType) {
      query = query.eq('credential_type', credentialType);
    }

    const { data: anchors, error: fetchError } = await query;

    if (fetchError) {
      logger.error({ error: fetchError }, 'Failed to fetch anchors for batch export');
      res.status(500).json({ error: 'Failed to fetch anchors' });
      return;
    }

    const anchorRows = (anchors ?? []) as unknown as AnchorRow[];

    if (format === 'pdf') {
      const pdfBuffer = generateBatchPdf(anchorRows);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="arkova-audit-batch.pdf"');
      res.send(pdfBuffer);
    } else {
      const csv = generateAnchorCsv(anchorRows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="arkova-audit-batch.csv"');
      res.send(csv);
    }

    logger.info({ count: anchorRows.length, format }, 'Batch audit export generated');
  } catch (err) {
    logger.error({ error: err }, 'Failed to generate batch audit export');
    res.status(500).json({ error: 'Failed to generate batch audit export' });
  }
});

export { router as auditExportRouter };
