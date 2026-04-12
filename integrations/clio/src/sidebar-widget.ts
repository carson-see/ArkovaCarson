/**
 * Clio Sidebar Widget — "Anchor with Arkova" (INT-06)
 *
 * A sidebar component for Clio that allows users to:
 * 1. View a document's verification status
 * 2. Anchor a document to Bitcoin with one click
 * 3. See the verification badge on anchored documents
 *
 * Uses client-side SHA-256 hashing — documents never leave the law firm's network.
 */

import type { ClioConfig, ClioDocument, ClioAnchorResult } from './types';
import { ClioConnector } from './connector';
import { computeFingerprint } from '../../shared/src/fingerprint';
import { ARKOVA_DEFAULT_URL } from '../../shared/src/constants';

export class ClioSidebarWidget {
  private readonly connector: ClioConnector;
  private readonly arkovaApiKey: string;
  private readonly arkovaBaseUrl: string;

  constructor(config: ClioConfig) {
    this.connector = new ClioConnector(config);
    this.arkovaApiKey = config.arkovaApiKey;
    this.arkovaBaseUrl = (config.arkovaBaseUrl ?? ARKOVA_DEFAULT_URL).replace(/\/+$/, '');
  }

  /**
   * Anchor a Clio document to Bitcoin.
   *
   * Downloads the document, computes SHA-256 client-side, then submits
   * only the fingerprint to Arkova. The document content never leaves
   * the law firm's infrastructure.
   */
  async anchorDocument(
    documentId: number,
    options?: { credentialType?: string; description?: string },
  ): Promise<ClioAnchorResult> {
    // 1. Download document + get metadata in parallel (skip metadata if description provided)
    const needsMeta = !options?.description;
    const [content, doc] = await Promise.all([
      this.connector.downloadDocument(documentId),
      needsMeta ? this.connector.getDocument(documentId) : Promise.resolve(null),
    ]);

    // 2. Compute SHA-256 fingerprint client-side
    const fingerprint = await computeFingerprint(content);

    // 3. Use provided description or document name
    const description = options?.description ?? `Clio document: ${doc?.data.name ?? 'Unknown'}`;

    // 4. Submit fingerprint to Arkova (document never sent)
    const body: Record<string, string> = { fingerprint };
    if (options?.credentialType) body.credential_type = options.credentialType;
    body.description = description;

    const response = await fetch(`${this.arkovaBaseUrl}/api/v1/anchor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.arkovaApiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(
        (err as any)?.message ?? `Anchor failed: HTTP ${response.status}`,
      );
    }

    const result = await response.json() as Record<string, string>;
    return {
      clio_document_id: documentId,
      arkova_public_id: result.public_id,
      fingerprint: result.fingerprint,
      status: result.status,
      record_uri: result.record_uri ?? '',
    };
  }

  /**
   * Check if a Clio document has been anchored and return its verification status.
   */
  async getVerificationStatus(
    publicId: string,
  ): Promise<{
    verified: boolean;
    status: string;
    anchor_timestamp?: string;
    network_receipt_id?: string;
    record_uri?: string;
  }> {
    const response = await fetch(
      `${this.arkovaBaseUrl}/api/v1/verify/${encodeURIComponent(publicId)}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.arkovaApiKey,
        },
      },
    );

    if (response.status === 404) {
      return { verified: false, status: 'NOT_FOUND' };
    }

    if (!response.ok) {
      throw new Error(`Verification check failed: HTTP ${response.status}`);
    }

    const data = await response.json() as Record<string, any>;
    return {
      verified: data.verified ?? false,
      status: data.status ?? 'UNKNOWN',
      anchor_timestamp: data.anchor_timestamp,
      network_receipt_id: data.network_receipt_id,
      record_uri: data.record_uri,
    };
  }

  /**
   * Render verification badge HTML for embedding in Clio document list.
   *
   * Returns self-contained HTML with inline styles (CSP-safe).
   */
  renderBadge(
    status: 'ACTIVE' | 'REVOKED' | 'PENDING' | 'NOT_FOUND',
    publicId?: string,
  ): string {
    const colors = {
      ACTIVE: { bg: '#f0fdf4', text: '#15803d', icon: '✓' },
      REVOKED: { bg: '#fef2f2', text: '#dc2626', icon: '✕' },
      PENDING: { bg: '#fffbeb', text: '#d97706', icon: '⏳' },
      NOT_FOUND: { bg: '#f3f4f6', text: '#6b7280', icon: '—' },
    };
    const c = colors[status] ?? colors.NOT_FOUND;
    const label = status === 'ACTIVE' ? 'Verified' : status === 'REVOKED' ? 'Revoked' : status === 'PENDING' ? 'Pending' : 'Not Anchored';
    const link = publicId
      ? `<a href="https://app.arkova.ai/verify/${encodeURIComponent(publicId)}" target="_blank" rel="noopener noreferrer" style="color:${c.text};text-decoration:underline;font-size:11px;">Details</a>`
      : '';

    return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;background:${c.bg};color:${c.text};font-size:12px;font-family:system-ui,-apple-system,sans-serif;">
      <span>${c.icon}</span>
      <span>${label}</span>
      ${link}
    </span>`;
  }

  /** Expose connector for advanced Clio API usage */
  get clio(): ClioConnector {
    return this.connector;
  }
}

