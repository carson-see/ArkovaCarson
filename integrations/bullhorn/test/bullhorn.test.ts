/**
 * Bullhorn Integration Tests (INT-07)
 *
 * Tests Bullhorn connector, candidate verification tab, and webhook handler.
 * All API calls mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BullhornConnector } from '../src/connector';
import { CandidateVerificationTab } from '../src/candidate-tab';
import { BullhornWebhookHandler, constantTimeEqual } from '../src/webhook-handler';
import type { BullhornConfig, BullhornSubscriptionEvent } from '../src/types';

const mockFetch = vi.fn();

const TEST_CONFIG: BullhornConfig = {
  webhookSecret: 'unit-test-webhook-secret',
  bullhornRestUrl: 'https://rest-test.bullhornstaffing.com/rest-services/e999',
  bullhornRestToken: 'bh-test-token',
  arkovaApiKey: 'ak_test_bullhorn',
  arkovaBaseUrl: 'https://test.arkova.ai',
};

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── Connector ────────────────────────────────────────────────────────

describe('BullhornConnector', () => {
  it('gets candidate by ID', async () => {
    const connector = new BullhornConnector(TEST_CONFIG);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          id: 5001,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          status: 'Active',
        },
      }),
    });

    const candidate = await connector.getCandidate(5001);
    expect(candidate.firstName).toBe('John');
    expect(candidate.lastName).toBe('Doe');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/entity/Candidate/5001'),
      expect.objectContaining({
        headers: expect.objectContaining({ BhRestToken: 'bh-test-token' }),
      }),
    );
  });

  it('lists candidate file attachments', async () => {
    const connector = new BullhornConnector(TEST_CONFIG);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        EntityFiles: [
          { id: 101, type: 'Resume', name: 'resume.pdf', contentType: 'application/pdf', dateAdded: Date.now() },
          { id: 102, type: 'Credential', name: 'license.pdf', contentType: 'application/pdf', dateAdded: Date.now() },
        ],
      }),
    });

    const files = await connector.listCandidateFiles(5001);
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe('resume.pdf');
    expect(files[1].type).toBe('Credential');
  });

  it('updates candidate custom fields', async () => {
    const connector = new BullhornConnector(TEST_CONFIG);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await connector.updateCandidateFields(5001, {
      customText1: 'Fully Verified',
      customInt1: 3,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/entity/Candidate/5001'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('searches candidates', async () => {
    const connector = new BullhornConnector(TEST_CONFIG);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 5001, firstName: 'John', lastName: 'Doe', email: 'john@example.com', status: 'Active' },
        ],
      }),
    });

    const results = await connector.searchCandidates('John Doe');
    expect(results).toHaveLength(1);
    expect(results[0].firstName).toBe('John');
  });

  it('throws on API error', async () => {
    const connector = new BullhornConnector(TEST_CONFIG);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(connector.getCandidate(9999)).rejects.toThrow('Failed to get candidate');
  });
});

// ── Candidate Verification Tab ───────────────────────────────────────

describe('CandidateVerificationTab', () => {
  it('gets verification summary for a candidate', async () => {
    const tab = new CandidateVerificationTab(TEST_CONFIG);

    // Mock getCandidate
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          id: 5001,
          firstName: 'Jane',
          lastName: 'Smith',
          email: 'jane@example.com',
          status: 'Active',
          customText3: JSON.stringify([
            { fileId: 101, publicId: 'ARK-2026-BH-001' },
          ]),
        },
      }),
    });

    // Mock listCandidateFiles
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        EntityFiles: [
          { id: 101, type: 'Credential', name: 'nursing_license.pdf', contentType: 'application/pdf', dateAdded: Date.now() },
          { id: 102, type: 'Resume', name: 'resume.docx', contentType: 'application/vnd.openxmlformats', dateAdded: Date.now() },
        ],
      }),
    });

    // Mock batch verify
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{ verified: true, status: 'ACTIVE' }],
      }),
    });

    const summary = await tab.getVerificationSummary(5001);
    expect(summary.candidateName).toBe('Jane Smith');
    expect(summary.totalCredentials).toBe(2);
    expect(summary.verifiedCount).toBe(1);
    expect(summary.notAnchoredCount).toBe(1);
    expect(summary.verificationPercentage).toBe(50);
  });

  it('handles candidate with no stored verifications', async () => {
    const tab = new CandidateVerificationTab(TEST_CONFIG);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { id: 5002, firstName: 'Bob', lastName: 'Jones', customText3: null },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ EntityFiles: [] }),
    });

    const summary = await tab.getVerificationSummary(5002);
    expect(summary.totalCredentials).toBe(0);
    expect(summary.verificationPercentage).toBe(0);
  });

  it('syncs status to candidate custom fields', async () => {
    const tab = new CandidateVerificationTab(TEST_CONFIG);

    // Mock updateCandidateFields
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await tab.syncStatusToCandidate(5001, {
      candidateId: 5001,
      candidateName: 'Jane Smith',
      totalCredentials: 3,
      verifiedCount: 3,
      pendingCount: 0,
      revokedCount: 0,
      notAnchoredCount: 0,
      verificationPercentage: 100,
      credentials: [],
      lastChecked: '2026-04-12T00:00:00Z',
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.customText1).toBe('Fully Verified');
    expect(callBody.customInt1).toBe(3);
    expect(callBody.customInt2).toBe(100);
  });

  it('syncs "Partially Verified" status', async () => {
    const tab = new CandidateVerificationTab(TEST_CONFIG);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await tab.syncStatusToCandidate(5001, {
      candidateId: 5001,
      candidateName: 'Jane',
      totalCredentials: 5,
      verifiedCount: 2,
      pendingCount: 1,
      revokedCount: 0,
      notAnchoredCount: 2,
      verificationPercentage: 40,
      credentials: [],
      lastChecked: '2026-04-12T00:00:00Z',
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.customText1).toBe('Partially Verified');
  });

  it('syncs "Has Revocations" status', async () => {
    const tab = new CandidateVerificationTab(TEST_CONFIG);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await tab.syncStatusToCandidate(5001, {
      candidateId: 5001,
      candidateName: 'Jane',
      totalCredentials: 2,
      verifiedCount: 0,
      pendingCount: 0,
      revokedCount: 1,
      notAnchoredCount: 1,
      verificationPercentage: 0,
      credentials: [],
      lastChecked: '2026-04-12T00:00:00Z',
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.customText1).toBe('Has Revocations');
  });
});

// ── Webhook Handler ──────────────────────────────────────────────────

describe('BullhornWebhookHandler', () => {
  it('skips non-candidate events', async () => {
    const handler = new BullhornWebhookHandler(TEST_CONFIG);
    const event: BullhornSubscriptionEvent = {
      events: [
        { eventId: 'e1', eventType: 'ENTITY', entityName: 'JobOrder', entityId: 1001, eventTimestamp: Date.now() },
      ],
      requestId: 1,
      lastRequestId: 0,
    };
    const results = await handler.handleEvents(event, 'unit-test-webhook-secret');
    expect(results[0].action).toBe('skipped_non_candidate');
  });

  it('handles entity update events', async () => {
    const handler = new BullhornWebhookHandler(TEST_CONFIG);
    const event: BullhornSubscriptionEvent = {
      events: [
        { eventId: 'e2', eventType: 'ENTITY', entityName: 'Candidate', entityId: 5001, eventTimestamp: Date.now() },
      ],
      requestId: 2,
      lastRequestId: 1,
    };
    const results = await handler.handleEvents(event, 'unit-test-webhook-secret');
    expect(results[0].action).toBe('entity_update_noted');
  });

  it('does not auto-verify when disabled', async () => {
    const handler = new BullhornWebhookHandler({ ...TEST_CONFIG, autoVerify: false });
    const event: BullhornSubscriptionEvent = {
      events: [
        { eventId: 'e3', eventType: 'FILE', entityName: 'Candidate', entityId: 5001, eventTimestamp: Date.now() },
      ],
      requestId: 3,
      lastRequestId: 2,
    };
    const results = await handler.handleEvents(event, 'unit-test-webhook-secret');
    expect(results[0].action).toBe('no_action');
  });
});


describe('BullhornWebhookHandler — inbound auth (SCRUM-3901)', () => {
  const event = { events: [{ eventId: 'e1', entityName: 'Candidate', entityId: 1, eventType: 'FILE' }] } as any;
  it('rejects every event when the presented secret is missing', async () => {
    const handler = new BullhornWebhookHandler(TEST_CONFIG);
    expect(await handler.handleEvents(event, undefined)).toEqual([{ eventId: 'e1', action: 'rejected_unauthenticated' }]);
  });
  it('rejects every event when the presented secret mismatches', async () => {
    const handler = new BullhornWebhookHandler(TEST_CONFIG);
    expect(await handler.handleEvents(event, 'wrong')).toEqual([{ eventId: 'e1', action: 'rejected_unauthenticated' }]);
  });
  it('fails closed when no secret is configured, even if one is presented', async () => {
    const handler = new BullhornWebhookHandler({ ...TEST_CONFIG, webhookSecret: undefined });
    expect(handler.verifyInboundSecret('anything')).toBe(false);
    expect(await handler.handleEvents(event, 'anything')).toEqual([{ eventId: 'e1', action: 'rejected_unauthenticated' }]);
  });
  it('constantTimeEqual compares equal-length strings byte-wise and rejects length mismatch', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  // Failing closed on an unset secret is correct, but silent: a deploy that
  // simply forgot to set BULLHORN_WEBHOOK_SECRET rejects 100% of real events
  // as `rejected_unauthenticated` and looks, from the outside, exactly like
  // an attacker being turned away. Say so once, at construction.
  it('warns once at construction when no webhook secret is configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      new BullhornWebhookHandler({ ...TEST_CONFIG, webhookSecret: undefined });

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain('webhookSecret');
      expect(message).toContain('rejected_unauthenticated');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when a webhook secret IS configured, and never prints it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      new BullhornWebhookHandler(TEST_CONFIG);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('never includes the secret value in the construction warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Even the empty-string case (falsy, so it warns) must not echo config.
      new BullhornWebhookHandler({ ...TEST_CONFIG, webhookSecret: '' });
      const printed = warn.mock.calls.flat().map(String).join(' ');
      expect(printed).not.toContain(TEST_CONFIG.webhookSecret as string);
      expect(printed).not.toContain('bh-test-token');
      expect(printed).not.toContain('ak_test_bullhorn');
    } finally {
      warn.mockRestore();
    }
  });
});
