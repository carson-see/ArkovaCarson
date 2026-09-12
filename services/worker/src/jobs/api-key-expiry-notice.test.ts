/**
 * SCRUM-5023 — daily API-key expiry notice.
 *
 * Nobody was ever told. Not before expiry, not after. HakiChain's two keys
 * lapsed 2026-07-01 and the first signal anyone got was a 401 in their own
 * logs, months later. This job is the signal.
 *
 * THE DEDUPE IS THE HARD PART, and it is deliberately schema-free. There is no
 * `last_notified_at` column and this story does not add one (no migration in
 * scope), so the audit trail IS the ledger: an `api_key.expiry_notice` row per
 * key per kind, and a key with a matching row inside the last 7 days is
 * skipped. That makes re-sends idempotent across the two ways this job can run
 * twice in a day — Cloud Scheduler retrying a 500, and the in-process backup
 * schedule firing on every warm Cloud Run instance (prod runs minScale 2, so
 * every in-process cron fires at least twice). Without it the first partner to
 * hit T-7 gets a fortnight of daily duplicate mail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test wires a real db/config/mailer in its deps factory.
// Every assertion below drives the injected-deps entry point instead, so these
// stubs exist only to keep importing the module from booting the worker config.
vi.mock('../config.js', () => ({ config: { resendApiKey: undefined, frontendUrl: 'https://app.test' } }));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/auditEvent.js', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../emails/api-key-expiry.js', () => ({
  sendApiKeyExpiryEmail: vi.fn().mockResolvedValue({ success: true }),
}));

import {
  runApiKeyExpiryNotice,
  type ApiKeyExpiryNoticeDeps,
  type ExpiringKeyRow,
} from './api-key-expiry-notice.js';

const NOW = new Date('2026-09-12T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function at(offsetDays: number): string {
  return new Date(NOW.getTime() + offsetDays * DAY_MS).toISOString();
}

function keyRow(overrides: Partial<ExpiringKeyRow> = {}): ExpiringKeyRow {
  return {
    id: 'key-1',
    org_id: 'org-1',
    name: 'HakiChain Production',
    key_prefix: 'ak_live_a172',
    expires_at: at(3),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ApiKeyExpiryNoticeDeps> = {}): ApiKeyExpiryNoticeDeps {
  return {
    emailConfigured: true,
    now: NOW,
    listKeysInWindow: vi.fn().mockResolvedValue([keyRow()]),
    listRecentNoticeKinds: vi.fn().mockResolvedValue([]),
    listOrgAdminEmails: vi.fn().mockResolvedValue(['admin@partner.example']),
    sendNotice: vi.fn().mockResolvedValue({ success: true }),
    recordNotice: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('window selection', () => {
  it('asks for keys from 24h behind to 7 days ahead', async () => {
    const deps = makeDeps();
    await runApiKeyExpiryNotice(deps);

    const [windowStart, windowEnd] = vi.mocked(deps.listKeysInWindow).mock.calls[0];
    expect(new Date(windowStart).getTime()).toBe(NOW.getTime() - DAY_MS);
    expect(new Date(windowEnd).getTime()).toBe(NOW.getTime() + 7 * DAY_MS);
  });

  it('classifies a future expiry as "expiring"', async () => {
    const deps = makeDeps({ listKeysInWindow: vi.fn().mockResolvedValue([keyRow({ expires_at: at(3) })]) });
    await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'expiring' }));
  });

  it('classifies a past expiry as "expired"', async () => {
    const deps = makeDeps({ listKeysInWindow: vi.fn().mockResolvedValue([keyRow({ expires_at: at(-0.5) })]) });
    await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'expired' }));
  });
});

describe('dedupe via the audit trail', () => {
  it('sends when no matching notice exists', async () => {
    const deps = makeDeps();
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).toHaveBeenCalledTimes(1);
    expect(result.notified).toBe(1);
    expect(result.deduped).toBe(0);
  });

  it('skips a key already notified for the SAME kind inside the window', async () => {
    const deps = makeDeps({ listRecentNoticeKinds: vi.fn().mockResolvedValue(['expiring']) });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).not.toHaveBeenCalled();
    expect(result.deduped).toBe(1);
    expect(result.notified).toBe(0);
  });

  it('still sends the EXPIRED notice to a key that already got the EXPIRING one', async () => {
    // The two are different events with different asks: "renew it" vs "it is
    // already refusing traffic". Deduping across kinds would swallow the one
    // that matters most — exactly HakiChain's situation, where the warning
    // would have been stale and the lapse notice never arrived.
    const deps = makeDeps({
      listKeysInWindow: vi.fn().mockResolvedValue([keyRow({ expires_at: at(-0.5) })]),
      listRecentNoticeKinds: vi.fn().mockResolvedValue(['expiring']),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'expired' }));
    expect(result.notified).toBe(1);
  });

  it('looks back exactly 7 days for prior notices', async () => {
    const deps = makeDeps();
    await runApiKeyExpiryNotice(deps);

    const [keyId, since] = vi.mocked(deps.listRecentNoticeKinds).mock.calls[0];
    expect(keyId).toBe('key-1');
    expect(new Date(since).getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
  });

  it('records the notice with the kind, so the next run can dedupe on it', async () => {
    const deps = makeDeps();
    await runApiKeyExpiryNotice(deps);

    expect(deps.recordNotice).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 'key-1', orgId: 'org-1', kind: 'expiring' }),
    );
  });

  it('does NOT record a notice when every send failed — the run must be retryable', async () => {
    // Writing the ledger row on a failed send would mark the key "notified"
    // for 7 days and permanently swallow the one warning it had coming.
    const deps = makeDeps({ sendNotice: vi.fn().mockResolvedValue({ success: false }) });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.recordNotice).not.toHaveBeenCalled();
    expect(result.notified).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('records once when at least one of several admins was reached', async () => {
    const deps = makeDeps({
      listOrgAdminEmails: vi.fn().mockResolvedValue(['a@example.test', 'b@example.test']),
      sendNotice: vi.fn()
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true }),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).toHaveBeenCalledTimes(2);
    expect(deps.recordNotice).toHaveBeenCalledTimes(1);
    expect(result.notified).toBe(1);
  });
});

describe('safety when the email provider is unconfigured', () => {
  it('skips the whole run, sends nothing, and writes no ledger row', async () => {
    const deps = makeDeps({ emailConfigured: false });
    const result = await runApiKeyExpiryNotice(deps);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('email_not_configured');
    expect(deps.listKeysInWindow).not.toHaveBeenCalled();
    expect(deps.sendNotice).not.toHaveBeenCalled();
    // No ledger row means a correctly-configured environment still sends the
    // notice tomorrow. A skip must not consume the key's one warning.
    expect(deps.recordNotice).not.toHaveBeenCalled();
  });
});

describe('recipients and payload', () => {
  it('emails every ORG_ADMIN of the key owning org', async () => {
    const deps = makeDeps({
      listOrgAdminEmails: vi.fn().mockResolvedValue(['one@example.test', 'two@example.test']),
    });
    await runApiKeyExpiryNotice(deps);

    expect(deps.listOrgAdminEmails).toHaveBeenCalledWith('org-1');
    expect(deps.sendNotice).toHaveBeenCalledWith(expect.objectContaining({ to: 'one@example.test' }));
    expect(deps.sendNotice).toHaveBeenCalledWith(expect.objectContaining({ to: 'two@example.test' }));
  });

  it('counts an org with no admins instead of failing the run', async () => {
    const deps = makeDeps({ listOrgAdminEmails: vi.fn().mockResolvedValue([]) });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).not.toHaveBeenCalled();
    expect(deps.recordNotice).not.toHaveBeenCalled();
    expect(result.noRecipients).toBe(1);
  });

  it('hands the template ONLY the key prefix and name — never the credential', async () => {
    const deps = makeDeps();
    await runApiKeyExpiryNotice(deps);

    const payload = vi.mocked(deps.sendNotice).mock.calls[0][0];
    expect(payload.keyPrefix).toBe('ak_live_a172');
    expect(payload.keyName).toBe('HakiChain Production');
    // The raw key is unrecoverable by construction (Constitution 1.4 — only
    // the HMAC is stored), and the hash must not travel either.
    expect(JSON.stringify(payload)).not.toMatch(/key_hash|keyHash/);
    expect(Object.keys(payload)).not.toContain('id');
  });

  it('carries whole days remaining so the copy can say how long is left', async () => {
    const deps = makeDeps({ listKeysInWindow: vi.fn().mockResolvedValue([keyRow({ expires_at: at(3.5) })]) });
    await runApiKeyExpiryNotice(deps);

    expect(vi.mocked(deps.sendNotice).mock.calls[0][0].daysRemaining).toBe(3);
  });

  it('keeps going after one key throws, so a single bad row cannot stop the sweep', async () => {
    const deps = makeDeps({
      listKeysInWindow: vi.fn().mockResolvedValue([
        keyRow({ id: 'key-bad', org_id: 'org-bad' }),
        keyRow({ id: 'key-good', org_id: 'org-good' }),
      ]),
      listOrgAdminEmails: vi.fn()
        .mockRejectedValueOnce(new Error('lookup blew up'))
        .mockResolvedValueOnce(['ok@example.test']),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(result.failed).toBe(1);
    expect(result.notified).toBe(1);
    expect(result.scanned).toBe(2);
  });
});
