/**
 * Clio Integration Tests (INT-06)
 *
 * Tests Clio OAuth2 connector, sidebar widget, CLE compliance, and webhook handler.
 * All API calls mocked — no real Clio or Arkova API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClioConnector } from '../src/connector';
import { ClioSidebarWidget } from '../src/sidebar-widget';
import { CleComplianceTab, CLE_REQUIREMENTS } from '../src/cle-compliance';
import { ClioWebhookHandler } from '../src/webhook-handler';
import type { ClioConfig, ClioWebhookEvent } from '../src/types';

const mockFetch = vi.fn();

const TEST_CONFIG: ClioConfig = {
  clioClientId: 'clio-test-id',
  clioClientSecret: 'clio-test-secret',
  clioRedirectUri: 'https://app.arkova.ai/integrations/clio/callback',
  arkovaApiKey: 'ak_test_clio',
  arkovaBaseUrl: 'https://test.arkova.ai',
  clioBaseUrl: 'https://test.clio.com/api/v4',
};

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── Connector ────────────────────────────────────────────────────────

describe('ClioConnector', () => {
  it('generates authorization URL', () => {
    const connector = new ClioConnector(TEST_CONFIG);
    const url = connector.getAuthorizationUrl('test-state');
    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=clio-test-id');
    expect(url).toContain('state=test-state');
  });

  it('exchanges authorization code for tokens', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'at-123',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'rt-456',
        created_at: Math.floor(Date.now() / 1000),
      }),
    });

    const connector = new ClioConnector(TEST_CONFIG);
    const tokens = await connector.exchangeCode('auth-code-xyz');
    expect(tokens.access_token).toBe('at-123');
    expect(tokens.refresh_token).toBe('rt-456');
  });

  it('lists documents with Clio API', async () => {
    const connector = new ClioConnector(TEST_CONFIG);
    connector.setTokens('at-123', 'rt-456');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 1001,
            name: 'Contract.pdf',
            content_type: 'application/pdf',
            created_at: '2026-04-01T00:00:00Z',
            updated_at: '2026-04-01T00:00:00Z',
            size: 102400,
          },
        ],
        meta: { paging: {} },
      }),
    });

    const result = await connector.listDocuments({ limit: 10 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe('Contract.pdf');
  });

  it('throws on unauthenticated request', async () => {
    const connector = new ClioConnector(TEST_CONFIG);
    await expect(connector.listDocuments()).rejects.toThrow('Not authenticated with Clio');
  });
});

// ── Sidebar Widget ───────────────────────────────────────────────────

describe('ClioSidebarWidget', () => {
  it('anchors a document via SHA-256 fingerprint', async () => {
    const widget = new ClioSidebarWidget(TEST_CONFIG);
    (widget as any).connector.setTokens('at-123', 'rt-456');

    // Mock Clio download
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('document content').buffer,
    });
    // Mock Clio getDocument
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { name: 'Contract.pdf' } }),
    });
    // Mock Arkova anchor
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        public_id: 'ARK-2026-CLIO-001',
        fingerprint: 'abc123',
        status: 'PENDING',
        record_uri: 'https://app.arkova.ai/verify/ARK-2026-CLIO-001',
      }),
    });

    const result = await widget.anchorDocument(1001, { credentialType: 'LEGAL' });
    expect(result.arkova_public_id).toBe('ARK-2026-CLIO-001');
    expect(result.clio_document_id).toBe(1001);
    expect(result.status).toBe('PENDING');
  });

  it('checks verification status', async () => {
    const widget = new ClioSidebarWidget(TEST_CONFIG);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        verified: true,
        status: 'ACTIVE',
        anchor_timestamp: '2026-04-12T00:00:00Z',
        network_receipt_id: 'tx-clio-1',
        record_uri: 'https://app.arkova.ai/verify/ARK-2026-001',
      }),
    });

    const status = await widget.getVerificationStatus('ARK-2026-001');
    expect(status.verified).toBe(true);
    expect(status.status).toBe('ACTIVE');
  });

  it('handles 404 verification', async () => {
    const widget = new ClioSidebarWidget(TEST_CONFIG);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const status = await widget.getVerificationStatus('ARK-MISSING');
    expect(status.verified).toBe(false);
    expect(status.status).toBe('NOT_FOUND');
  });

  it('renders verification badges', () => {
    const widget = new ClioSidebarWidget(TEST_CONFIG);

    const activeBadge = widget.renderBadge('ACTIVE', 'ARK-001');
    expect(activeBadge).toContain('Verified');
    expect(activeBadge).toContain('ARK-001');
    expect(activeBadge).toContain('#15803d');

    const revokedBadge = widget.renderBadge('REVOKED');
    expect(revokedBadge).toContain('Revoked');
    expect(revokedBadge).toContain('#dc2626');

    const pendingBadge = widget.renderBadge('PENDING');
    expect(pendingBadge).toContain('Pending');

    const notFoundBadge = widget.renderBadge('NOT_FOUND');
    expect(notFoundBadge).toContain('Not Anchored');
  });
});

// ── CLE Compliance ───────────────────────────────────────────────────

describe('CleComplianceTab', () => {
  it('looks up bar status', async () => {
    const tab = new CleComplianceTab('ak_test', 'https://test.arkova.ai');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        attorney_name: 'Jane Doe',
        bar_number: '12345',
        jurisdiction: 'CA',
        status: 'ACTIVE',
        cle_hours_required: 25,
        cle_hours_completed: 20,
        cle_hours_remaining: 5,
        next_deadline: '2026-12-31',
        ethics_hours_required: 4,
        ethics_hours_completed: 4,
        public_id: 'ARK-CLE-001',
        verified: true,
        anchor_timestamp: '2026-01-01T00:00:00Z',
        record_uri: 'https://app.arkova.ai/verify/ARK-CLE-001',
      }),
    });

    const status = await tab.lookupBarStatus('12345', 'CA');
    expect(status.attorney_name).toBe('Jane Doe');
    expect(status.status).toBe('ACTIVE');
    expect(status.cle_hours_remaining).toBe(5);
    expect(status.arkova_verification?.verified).toBe(true);
  });

  it('handles unknown bar number', async () => {
    const tab = new CleComplianceTab('ak_test', 'https://test.arkova.ai');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const status = await tab.lookupBarStatus('UNKNOWN', 'CA');
    expect(status.status).toBe('UNKNOWN');
    expect(status.bar_number).toBe('UNKNOWN');
  });

  it('returns CLE requirements by jurisdiction', () => {
    const tab = new CleComplianceTab('ak_test');
    const ca = tab.getRequirements('CA');
    expect(ca).toBeDefined();
    expect(ca!.hours_per_cycle).toBe(25);
    expect(ca!.ethics_hours).toBe(4);
    expect(ca!.jurisdiction_name).toBe('California');

    const ny = tab.getRequirements('NY');
    expect(ny!.hours_per_cycle).toBe(24);

    const unknown = tab.getRequirements('ZZ');
    expect(unknown).toBeNull();
  });

  it('lists supported jurisdictions', () => {
    const tab = new CleComplianceTab('ak_test');
    const jurisdictions = tab.getSupportedJurisdictions();
    expect(jurisdictions).toContain('CA');
    expect(jurisdictions).toContain('NY');
    expect(jurisdictions).toContain('TX');
    expect(jurisdictions.length).toBeGreaterThanOrEqual(10);
  });

  it('has CLE requirements for 10 states', () => {
    expect(Object.keys(CLE_REQUIREMENTS).length).toBe(10);
    // Michigan has no CLE requirement
    expect(CLE_REQUIREMENTS['MI'].hours_per_cycle).toBe(0);
  });
});

// ── Webhook Handler ──────────────────────────────────────────────────

describe('ClioWebhookHandler', () => {
  it('ignores document.deleted events', async () => {
    const handler = new ClioWebhookHandler(TEST_CONFIG);
    const event: ClioWebhookEvent = {
      type: 'document.deleted',
      data: { id: 1001, type: 'Document', url: '' },
      created_at: new Date().toISOString(),
    };
    const result = await handler.handleEvent(event);
    expect(result.processed).toBe(true);
    expect(result.action).toBe('ignored_deletion');
  });

  it('auto-anchors on document.created when enabled', async () => {
    const onAnchor = vi.fn();
    const config = { ...TEST_CONFIG, autoAnchor: true };
    const handler = new ClioWebhookHandler(config, { onAnchor });

    // The widget's anchorDocument will be called, which makes 3 fetch calls
    // Mock: download, getDocument, anchor
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('doc').buffer,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { name: 'New.pdf' } }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        public_id: 'ARK-AUTO-001',
        fingerprint: 'hash123',
        status: 'PENDING',
        record_uri: '',
      }),
    });

    // Need to set tokens on the internal connector
    (handler as any).widget.connector.setTokens('at-123', 'rt-456');

    const event: ClioWebhookEvent = {
      type: 'document.created',
      data: { id: 2001, type: 'Document', url: '' },
      created_at: new Date().toISOString(),
    };
    const result = await handler.handleEvent(event);
    expect(result.action).toBe('auto_anchored');
    expect(onAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ arkova_public_id: 'ARK-AUTO-001' }),
    );
  });

  it('does not auto-anchor when disabled', async () => {
    const handler = new ClioWebhookHandler({ ...TEST_CONFIG, autoAnchor: false });
    const event: ClioWebhookEvent = {
      type: 'document.created',
      data: { id: 2001, type: 'Document', url: '' },
      created_at: new Date().toISOString(),
    };
    const result = await handler.handleEvent(event);
    expect(result.action).toBe('no_action');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls onError callback on anchor failure', async () => {
    const onError = vi.fn();
    const config = { ...TEST_CONFIG, autoAnchor: true };
    const handler = new ClioWebhookHandler(config, { onError });
    (handler as any).widget.connector.setTokens('at-123', 'rt-456');

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const event: ClioWebhookEvent = {
      type: 'document.created',
      data: { id: 3001, type: 'Document', url: '' },
      created_at: new Date().toISOString(),
    };
    const result = await handler.handleEvent(event);
    expect(result.action).toBe('anchor_failed');
    expect(onError).toHaveBeenCalled();
  });
});
