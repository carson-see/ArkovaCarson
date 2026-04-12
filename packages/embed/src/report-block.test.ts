/**
 * Screening Report Embed Template Tests (INT-08)
 *
 * Tests renderReportBlock and renderReportBlockFromData in all formats.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderReportBlock, renderReportBlockFromData } from './report-block';
import type { AnchorData } from './types';

const mockFetch = vi.fn();

const SAMPLE_DATA: AnchorData = {
  public_id: 'ARK-2026-RPT-001',
  fingerprint: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
  status: 'ACTIVE',
  verified: true,
  filename: 'nursing_license.pdf',
  credential_type: 'LICENSE',
  issuer_name: 'State Board of Nursing',
  anchor_timestamp: '2026-04-01T00:00:00Z',
  chain_tx_id: 'tx123abc456def789ghi012jkl345mno678pqr901stu234vwx',
};

const REVOKED_DATA: AnchorData = {
  ...SAMPLE_DATA,
  status: 'REVOKED',
  verified: false,
};

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('renderReportBlock (with fetch)', () => {
  it('fetches data and renders HTML', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_DATA,
    });

    const html = await renderReportBlock('ARK-2026-RPT-001');
    expect(html).toContain('Verified');
    expect(html).toContain('nursing_license.pdf');
    expect(html).toContain('Professional License');
    expect(html).toContain('State Board of Nursing');
    expect(html).toContain('Verified by Arkova');
    expect(html).toContain('ARK-2026-RPT-001');
  });

  it('renders error HTML on 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const html = await renderReportBlock('ARK-MISSING');
    expect(html).toContain('Record not found');
    expect(html).toContain('ARK-MISSING');
    expect(html).toContain('Verified by Arkova');
  });

  it('renders JSON format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_DATA,
    });

    const jsonStr = await renderReportBlock('ARK-2026-RPT-001', { format: 'json' });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.public_id).toBe('ARK-2026-RPT-001');
    expect(parsed.verified).toBe(true);
    expect(parsed.status).toBe('ACTIVE');
    expect(parsed.credential_type).toBe('LICENSE');
    expect(parsed.verification_url).toContain('ARK-2026-RPT-001');
    expect(parsed.branding).toBe('Verified by Arkova');
  });

  it('renders JSON error on 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const jsonStr = await renderReportBlock('ARK-MISSING', { format: 'json' });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.verified).toBe(false);
    expect(parsed.error).toBe('not_found');
  });

  it('renders PDF format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_DATA,
    });

    const pdfHtml = await renderReportBlock('ARK-2026-RPT-001', { format: 'pdf' });
    expect(pdfHtml).toContain('page-break-inside:avoid');
    expect(pdfHtml).toContain('width:480px');
    expect(pdfHtml).toContain('Verified');
  });
});

describe('renderReportBlockFromData (no fetch)', () => {
  it('renders HTML from data', () => {
    const html = renderReportBlockFromData(SAMPLE_DATA, 'ARK-2026-RPT-001');
    expect(html).toContain('Verified');
    expect(html).toContain('nursing_license.pdf');
    expect(html).toContain('#15803d'); // Green for verified
    expect(html).not.toContain('#dc2626'); // No red
  });

  it('renders revoked state', () => {
    const html = renderReportBlockFromData(REVOKED_DATA, 'ARK-2026-RPT-001');
    expect(html).toContain('Revoked');
    expect(html).toContain('#dc2626'); // Red for revoked
  });

  it('hides fingerprint when option disabled', () => {
    const html = renderReportBlockFromData(SAMPLE_DATA, 'ARK-001', {
      showFingerprint: false,
    });
    expect(html).not.toContain('Fingerprint');
  });

  it('hides network receipt when option disabled', () => {
    const html = renderReportBlockFromData(SAMPLE_DATA, 'ARK-001', {
      showNetworkReceipt: false,
    });
    expect(html).not.toContain('Network Receipt');
  });

  it('shows explorer link when enabled', () => {
    const html = renderReportBlockFromData(SAMPLE_DATA, 'ARK-001', {
      showExplorerLink: true,
    });
    expect(html).toContain('mempool.space/tx/');
  });

  it('uses custom branding text', () => {
    const html = renderReportBlockFromData(SAMPLE_DATA, 'ARK-001', {
      brandingText: 'Powered by CredentialCheck',
    });
    expect(html).toContain('Powered by CredentialCheck');
    expect(html).not.toContain('Verified by Arkova');
  });

  it('renders JSON with all fields', () => {
    const jsonStr = renderReportBlockFromData(SAMPLE_DATA, 'ARK-001', {
      format: 'json',
      showExplorerLink: true,
    });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.document_name).toBe('nursing_license.pdf');
    expect(parsed.fingerprint).toBeDefined();
    expect(parsed.network_receipt_id).toBeDefined();
    expect(parsed.explorer_url).toContain('mempool.space');
  });

  it('renders PDF with print styles', () => {
    const html = renderReportBlockFromData(SAMPLE_DATA, 'ARK-001', { format: 'pdf' });
    expect(html).toContain('page-break-inside:avoid');
  });

  it('escapes HTML in document names', () => {
    const xssData: AnchorData = {
      ...SAMPLE_DATA,
      filename: '<script>alert("xss")</script>',
    };
    const html = renderReportBlockFromData(xssData, 'ARK-001');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles missing optional fields gracefully', () => {
    const minimal: AnchorData = {
      public_id: 'ARK-001',
      status: 'ACTIVE',
      verified: true,
    };
    const html = renderReportBlockFromData(minimal, 'ARK-001');
    expect(html).toContain('Verified');
    expect(html).toContain('ARK-001');
    // Should not throw even with missing fields
  });
});
