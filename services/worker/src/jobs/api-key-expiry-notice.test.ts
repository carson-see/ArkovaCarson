/**
 * SCRUM-5023 — daily API-key expiry notice.
 *
 * Nobody was ever told. Not before expiry, not after. HakiChain's two keys
 * lapsed 2026-07-01 and the first signal anyone got was a 401 in their own
 * logs, months later. This job is the signal.
 *
 * THE DEDUPE IS THE HARD PART, and it is deliberately schema-free. There is no
 * `last_notified_at` column and this story does not add one (no migration in
 * scope), so the audit trail IS the ledger: an `api_key.expiry_notice` row
 * carrying the kind AND the expiry it was about, and a key with a matching row
 * is skipped. Cloud Scheduler is the job's only trigger — there is no
 * in-process schedule for it — but Scheduler re-drives a failed attempt and
 * the sweep runs daily, so without the ledger every partner inside the notice
 * window would be re-mailed every day.
 *
 * KEYED ON (kind, expires_at), NOT ON A TIME WINDOW. A key that lapsed in July
 * stays lapsed, so any time-boxed horizon re-mails its "expired" notice
 * forever. The expiry VALUE is the thing that changes when an owner acts, so
 * it is what the ledger keys on.
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
vi.mock('../utils/auditEvent.js', () => ({ recordAuditEvent: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../emails/api-key-expiry.js', () => ({
  sendApiKeyExpiryEmail: vi.fn().mockResolvedValue({ success: true }),
}));

import {
  runApiKeyExpiryNotice,
  makeApiKeyExpiryNoticeDeps,
  EXPIRY_NOTICE_EVENT,
  type ApiKeyExpiryNoticeDeps,
  type ExpiringKeyRow,
} from './api-key-expiry-notice.js';
import { db } from '../utils/db.js';
import { config } from '../config.js';
import { sendApiKeyExpiryEmail } from '../emails/api-key-expiry.js';

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
    listPriorNotices: vi.fn().mockResolvedValue([]),
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
  it('asks for every live key expiring at or before 7 days ahead, with NO lower bound', async () => {
    const deps = makeDeps();
    await runApiKeyExpiryNotice(deps);

    const call = vi.mocked(deps.listKeysInWindow).mock.calls[0];
    expect(call).toHaveLength(1);
    expect(new Date(call[0]).getTime()).toBe(NOW.getTime() + 7 * DAY_MS);
  });

  it('notifies a key that lapsed LONG ago — the 13 prod rows this story is about', async () => {
    // A 24h lookback made a key eligible for its lapse notice on exactly one
    // run. HakiChain's keys expired 2026-07-01, months before this job
    // existed, so a lower bound would have guaranteed they were never told —
    // the exact silence the story was filed to end.
    const deps = makeDeps({
      listKeysInWindow: vi.fn().mockResolvedValue([keyRow({ expires_at: at(-73) })]),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'expired' }));
    expect(result.notified).toBe(1);
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

  it('skips a key already notified for the SAME kind AND the same expiry', async () => {
    const deps = makeDeps({
      listPriorNotices: vi.fn().mockResolvedValue([{ kind: 'expiring', expiresAt: at(3) }]),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).not.toHaveBeenCalled();
    expect(result.deduped).toBe(1);
    expect(result.notified).toBe(0);
  });

  it('NEVER re-mails a long-lapsed key, however many runs go by', async () => {
    // The failure a time-boxed horizon produces: an expiry in the past does
    // not move, so a 7-day window makes the "expired" notice weekly mail
    // forever. Keying on the expiry VALUE ends it at one.
    const expiresAt = at(-73);
    const deps = makeDeps({
      listKeysInWindow: vi.fn().mockResolvedValue([keyRow({ expires_at: expiresAt })]),
      listPriorNotices: vi.fn().mockResolvedValue([{ kind: 'expired', expiresAt }]),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).not.toHaveBeenCalled();
    expect(result.deduped).toBe(1);
  });

  it('warns again once the owner extends, because the expiry VALUE changed', async () => {
    // The prior notice was about the OLD expiry. The key has since been
    // extended and is approaching a new one — a fresh warning is owed.
    const deps = makeDeps({
      listKeysInWindow: vi.fn().mockResolvedValue([keyRow({ expires_at: at(3) })]),
      listPriorNotices: vi.fn().mockResolvedValue([{ kind: 'expiring', expiresAt: at(-40) }]),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).toHaveBeenCalledTimes(1);
    expect(result.notified).toBe(1);
  });

  it('ignores a legacy ledger row that carries no expiry', async () => {
    // A row written before the expiry was recorded cannot prove WHICH notice
    // was sent. One duplicate email beats swallowing the warning entirely.
    const deps = makeDeps({
      listPriorNotices: vi.fn().mockResolvedValue([{ kind: 'expiring', expiresAt: null }]),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(result.notified).toBe(1);
  });

  it('still sends the EXPIRED notice to a key that already got the EXPIRING one', async () => {
    // The two are different events with different asks: "renew it" vs "it is
    // already refusing traffic". Deduping across kinds would swallow the one
    // that matters most — exactly HakiChain's situation, where the warning
    // would have been stale and the lapse notice never arrived.
    const deps = makeDeps({
      listKeysInWindow: vi.fn().mockResolvedValue([keyRow({ expires_at: at(-0.5) })]),
      listPriorNotices: vi.fn().mockResolvedValue([{ kind: 'expiring', expiresAt: at(-0.5) }]),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'expired' }));
    expect(result.notified).toBe(1);
  });

  it('asks for prior notices by key id, unbounded in time', async () => {
    const deps = makeDeps();
    await runApiKeyExpiryNotice(deps);

    expect(vi.mocked(deps.listPriorNotices).mock.calls[0]).toEqual(['key-1']);
  });

  it('records the notice with the kind AND the expiry, so the next run can dedupe on it', async () => {
    const deps = makeDeps();
    await runApiKeyExpiryNotice(deps);

    expect(deps.recordNotice).toHaveBeenCalledWith(
      { keyId: 'key-1', orgId: 'org-1', kind: 'expiring', expiresAt: at(3) },
    );
  });

  it('counts a FAILED ledger write as a failure, not a notification', async () => {
    // `recordAuditEvent` never rejects, so an unchecked `await` reported
    // success on a lost row — and the key was re-mailed on every run until the
    // insert started working. The real deps throw; the run must not count it.
    const deps = makeDeps({
      recordNotice: vi.fn().mockRejectedValue(new Error('ledger write failed')),
    });
    const result = await runApiKeyExpiryNotice(deps);

    expect(deps.sendNotice).toHaveBeenCalledTimes(1);
    expect(result.notified).toBe(0);
    expect(result.failed).toBe(1);
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

/**
 * Everything above drives the INJECTED deps, which is what makes the sweep
 * testable — but it also means the real query builders in
 * `makeApiKeyExpiryNoticeDeps()` were never asserted. The dedupe lookup is the
 * one that cannot be got wrong quietly: it reads `audit_events`, a table shared
 * by every subsystem, and its filters are the only thing stopping a row that
 * belongs to something else from being mistaken for a prior notice.
 */
describe('the real dedupe query (makeApiKeyExpiryNoticeDeps)', () => {
  /** Chainable PostgREST stub that records the filters it was given. */
  function queryStub(result: { data?: unknown; error?: unknown } = { data: [], error: null }) {
    const calls: Array<[string, ...unknown[]]> = [];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'not', 'lte', 'in']) {
      chain[method] = vi.fn((...args: unknown[]) => {
        calls.push([method, ...args]);
        return chain;
      });
    }
    // Awaited at the end of the chain.
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return { chain, calls, eqCalls: () => calls.filter((c) => c[0] === 'eq').map((c) => c.slice(1)) };
  }

  beforeEach(() => {
    vi.mocked(db.from).mockReset();
  });

  it('scopes the dedupe lookup by target_type, not by target_id alone', async () => {
    // `target_id` is a bare TEXT column shared across every audit subject in
    // the table — anchors, orgs, webhooks, api_keys. Without `target_type`,
    // any other row that happened to carry this key's uuid and an
    // `api_key.expiry_notice` event_type would read as a prior notice and
    // swallow the one warning the key had coming. The filter is cheap; the
    // failure it prevents is silent and permanent.
    const { chain, calls, eqCalls } = queryStub({ data: [], error: null });
    vi.mocked(db.from).mockReturnValue(chain as never);

    const deps = makeApiKeyExpiryNoticeDeps();
    await deps.listPriorNotices('key-1');

    expect(vi.mocked(db.from)).toHaveBeenCalledWith('audit_events');
    expect(eqCalls()).toContainEqual(['target_type', 'api_key']);
    // All three filters together, so a future edit cannot drop one and still
    // look scoped.
    expect(eqCalls()).toEqual(
      expect.arrayContaining([
        ['event_type', EXPIRY_NOTICE_EVENT],
        ['target_type', 'api_key'],
        ['target_id', 'key-1'],
      ]),
    );
    // Only `details` is read back — the row's actor and org are none of this
    // job's business.
    expect(calls.find((c) => c[0] === 'select')?.[1]).toBe('details');
  });

  it('THROWS rather than reporting "no prior notice" when the dedupe lookup fails', async () => {
    // The failure mode this guards is re-sending to every admin on every run
    // for as long as the error persists. An empty result and a failed query
    // must never be indistinguishable.
    const { chain } = queryStub({ data: null, error: { message: 'connection reset' } });
    vi.mocked(db.from).mockReturnValue(chain as never);

    const deps = makeApiKeyExpiryNoticeDeps();
    await expect(deps.listPriorNotices('key-1')).rejects.toThrow(/dedupe lookup failed/);
  });
});

describe('notice management link', () => {
  it.each(['https://app.test', 'https://app.test/', 'https://app.test///'])(
    'uses the registered route with frontendUrl=%s', async (frontendUrl) => {
      const original = config.frontendUrl;
      try {
        config.frontendUrl = frontendUrl;
        await makeApiKeyExpiryNoticeDeps().sendNotice({
          to: 'admin@example.test', keyName: 'key', keyPrefix: 'ak_live_demo',
          kind: 'expiring', expiresAt: at(3), daysRemaining: 3, orgId: 'org-1',
        });
        expect(sendApiKeyExpiryEmail).toHaveBeenCalledWith(expect.objectContaining({
          manageKeysUrl: 'https://app.test/settings/api-keys',
        }));
      } finally {
        config.frontendUrl = original;
      }
    },
  );
});
