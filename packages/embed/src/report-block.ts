/**
 * Screening Report Embed Template (INT-08)
 *
 * Provides `renderReportBlock(publicId, options)` for embedding
 * credential verification data in screening reports.
 *
 * Output formats:
 * - HTML: Self-contained block with inline styles (no external CSS)
 * - PDF: Structured HTML optimized for wkhtmltopdf / Puppeteer rendering
 * - JSON: Machine-readable structured data
 *
 * All output includes "Verified by Arkova" branding footer.
 */

import { ARKOVA_BRAND } from './styles';
import type { AnchorData } from './types';

/** Report block output format */
export type ReportFormat = 'html' | 'pdf' | 'json';

/** Options for renderReportBlock */
export interface ReportBlockOptions {
  /** Output format (default: 'html') */
  format?: ReportFormat;
  /** API base URL */
  apiBaseUrl?: string;
  /** App base URL for verification links */
  appBaseUrl?: string;
  /** Show fingerprint in output (default: true) */
  showFingerprint?: boolean;
  /** Show network receipt ID (default: true) */
  showNetworkReceipt?: boolean;
  /** Custom branding text (default: 'Verified by Arkova') */
  brandingText?: string;
  /** Include explorer link for network receipt */
  showExplorerLink?: boolean;
}

const DEFAULT_API_BASE = 'https://arkova-worker-270018525501.us-central1.run.app';
const DEFAULT_APP_BASE = 'https://app.arkova.ai';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const CREDENTIAL_LABELS: Record<string, string> = {
  DEGREE: 'Degree',
  LICENSE: 'Professional License',
  CERTIFICATE: 'Certificate',
  TRANSCRIPT: 'Academic Transcript',
  PROFESSIONAL: 'Professional Credential',
  CLE: 'CLE Credit',
  FINANCIAL: 'Financial Document',
  LEGAL: 'Legal Document',
  INSURANCE: 'Insurance Certificate',
  SEC_FILING: 'SEC Filing',
  PATENT: 'Patent',
  RESUME: 'Resume / CV',
  MEDICAL: 'Medical Record',
  IDENTITY: 'Identity Document',
  OTHER: 'Document',
};

/**
 * Fetch anchor data and render a report block.
 *
 * @example
 *   // HTML (for web embedding)
 *   const html = await renderReportBlock('ARK-2026-001');
 *   document.getElementById('report').innerHTML = html;
 *
 *   // PDF (for screening report generation)
 *   const pdfHtml = await renderReportBlock('ARK-2026-001', { format: 'pdf' });
 *
 *   // JSON (for API consumers)
 *   const json = await renderReportBlock('ARK-2026-001', { format: 'json' });
 */
export async function renderReportBlock(
  publicId: string,
  options: ReportBlockOptions = {},
): Promise<string> {
  const apiBase = (options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const appBase = (options.appBaseUrl ?? DEFAULT_APP_BASE).replace(/\/+$/, '');
  const format = options.format ?? 'html';

  // Fetch verification data
  const response = await fetch(
    `${apiBase}/api/v1/verify/${encodeURIComponent(publicId)}`,
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (!response.ok) {
    if (format === 'json') {
      return JSON.stringify({ error: 'not_found', public_id: publicId, verified: false }, null, 2);
    }
    return renderErrorBlock(publicId, format);
  }

  const data = (await response.json()) as AnchorData;

  switch (format) {
    case 'json':
      return renderJsonBlock(data, publicId, appBase, options);
    case 'pdf':
      return renderPdfBlock(data, publicId, appBase, options);
    default:
      return renderHtmlBlock(data, publicId, appBase, options);
  }
}

/**
 * Render report block from pre-fetched data (no API call).
 * Useful when the caller already has the verification data.
 */
export function renderReportBlockFromData(
  data: AnchorData,
  publicId: string,
  options: ReportBlockOptions = {},
): string {
  const appBase = (options.appBaseUrl ?? DEFAULT_APP_BASE).replace(/\/+$/, '');
  const format = options.format ?? 'html';

  switch (format) {
    case 'json':
      return renderJsonBlock(data, publicId, appBase, options);
    case 'pdf':
      return renderPdfBlock(data, publicId, appBase, options);
    default:
      return renderHtmlBlock(data, publicId, appBase, options);
  }
}

// ── Format renderers ─────────────────────────────────────────────────

function renderHtmlBlock(
  data: AnchorData,
  publicId: string,
  appBase: string,
  opts: ReportBlockOptions,
): string {
  const isRevoked = data.status === 'REVOKED';
  const statusColor = isRevoked ? '#dc2626' : '#15803d';
  const statusBg = isRevoked ? '#fef2f2' : '#f0fdf4';
  const statusLabel = isRevoked ? 'Revoked' : 'Verified';
  const statusIcon = isRevoked ? '✕' : '✓';
  const credLabel = CREDENTIAL_LABELS[data.credential_type ?? ''] ?? data.credential_type ?? 'Document';
  const brandText = opts.brandingText ?? 'Verified by Arkova';
  const showFp = opts.showFingerprint !== false;
  const showReceipt = opts.showNetworkReceipt !== false;

  const rows: string[] = [];
  if (data.filename) rows.push(detailRow('Document', escapeHtml(data.filename)));
  rows.push(detailRow('Type', escapeHtml(credLabel)));
  if (data.issuer_name) rows.push(detailRow('Issuer', escapeHtml(data.issuer_name)));
  if (data.anchor_timestamp) rows.push(detailRow('Secured', formatDate(data.anchor_timestamp)));
  if (showFp && data.fingerprint) rows.push(detailRow('Fingerprint', truncateFp(data.fingerprint)));
  if (showReceipt && data.chain_tx_id) {
    const receiptDisplay = opts.showExplorerLink
      ? `<a href="https://mempool.space/tx/${escapeHtml(data.chain_tx_id)}" target="_blank" rel="noopener noreferrer" style="color:${ARKOVA_BRAND};text-decoration:none;">${truncateFp(data.chain_tx_id)}</a>`
      : truncateFp(data.chain_tx_id);
    rows.push(detailRow('Network Receipt', receiptDisplay));
  }

  return `<div style="font-family:${FONT_STACK};max-width:480px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#fff;color:#111827;line-height:1.5;">
  <div style="padding:12px 16px;background:${statusBg};display:flex;align-items:center;gap:8px;">
    <span style="color:${statusColor};font-size:18px;font-weight:bold;">${statusIcon}</span>
    <span style="font-size:16px;font-weight:600;color:${statusColor};">${statusLabel}</span>
    <span style="font-size:12px;color:#6b7280;margin-left:auto;">${escapeHtml(publicId)}</span>
  </div>
  <div style="padding:12px 16px;">
    ${rows.join('\n    ')}
  </div>
  <div style="padding:8px 16px;border-top:1px solid #f3f4f6;display:flex;align-items:center;justify-content:space-between;">
    <a href="${appBase}/verify/${encodeURIComponent(publicId)}" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:${ARKOVA_BRAND};text-decoration:none;">Full verification details →</a>
    <span style="display:flex;align-items:center;gap:4px;">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ARKOVA_BRAND};"></span>
      <span style="font-size:10px;color:#9ca3af;font-weight:500;">${escapeHtml(brandText)}</span>
    </span>
  </div>
</div>`;
}

function renderPdfBlock(
  data: AnchorData,
  publicId: string,
  appBase: string,
  opts: ReportBlockOptions,
): string {
  // PDF format: same as HTML but with print-optimized styles
  // - Explicit page-break-inside: avoid
  // - Full width for PDF rendering
  const html = renderHtmlBlock(data, publicId, appBase, opts);
  return html
    .replace('max-width:480px', 'max-width:100%;width:480px;page-break-inside:avoid');
}

function renderJsonBlock(
  data: AnchorData,
  publicId: string,
  appBase: string,
  opts: ReportBlockOptions,
): string {
  const result: Record<string, unknown> = {
    public_id: publicId,
    verified: data.status !== 'REVOKED',
    status: data.status,
    credential_type: data.credential_type,
    issuer_name: data.issuer_name,
    anchor_timestamp: data.anchor_timestamp,
    verification_url: `${appBase}/verify/${encodeURIComponent(publicId)}`,
    branding: opts.brandingText ?? 'Verified by Arkova',
  };

  if (data.filename) result.document_name = data.filename;
  if (opts.showFingerprint !== false && data.fingerprint) result.fingerprint = data.fingerprint;
  if (opts.showNetworkReceipt !== false && data.chain_tx_id) {
    result.network_receipt_id = data.chain_tx_id;
    if (opts.showExplorerLink) {
      result.explorer_url = `https://mempool.space/tx/${data.chain_tx_id}`;
    }
  }

  return JSON.stringify(result, null, 2);
}

function renderErrorBlock(publicId: string, format: ReportFormat): string {
  if (format === 'pdf') {
    return `<div style="font-family:${FONT_STACK};max-width:480px;width:480px;border:1px solid #e5e7eb;border-radius:8px;padding:16px;background:#fff;text-align:center;page-break-inside:avoid;">
  <p style="font-size:14px;color:#6b7280;margin:0;">Record not found: ${escapeHtml(publicId)}</p>
  <p style="font-size:10px;color:#9ca3af;margin:8px 0 0;">Verified by Arkova</p>
</div>`;
  }
  return `<div style="font-family:${FONT_STACK};max-width:480px;border:1px solid #e5e7eb;border-radius:8px;padding:16px;background:#fff;text-align:center;">
  <p style="font-size:14px;color:#6b7280;margin:0;">Record not found: ${escapeHtml(publicId)}</p>
  <p style="font-size:10px;color:#9ca3af;margin:8px 0 0;">Verified by Arkova</p>
</div>`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function detailRow(label: string, value: string): string {
  return `<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;">
      <span style="color:#6b7280;">${label}</span>
      <span style="color:#111827;font-weight:500;text-align:right;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${value}</span>
    </div>`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function truncateFp(fp: string): string {
  if (fp.length < 20) return fp;
  return `${fp.slice(0, 12)}…${fp.slice(-8)}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
