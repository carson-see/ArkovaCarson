/**
 * SCRUM-5023 — API-key expiry notice template.
 *
 * An email is the least controllable artifact this system produces: it lands
 * in a partner's inbox, their mail archive, and usually a support thread. What
 * this template is allowed to carry is therefore a security property, not a
 * style choice — Constitution 1.4.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({ config: { resendApiKey: undefined, emailFrom: 'noreply@test' } }));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { buildApiKeyExpiryEmail } from './api-key-expiry.js';

const base = {
  recipientEmail: 'admin@partner.example',
  keyName: 'HakiChain Production',
  keyPrefix: 'ak_live_a172',
  expiresAt: '2026-09-20T00:00:00.000Z',
  daysRemaining: 8,
  manageKeysUrl: 'https://app.arkova.ai/settings/api-keys',
};

describe('what the notice may carry', () => {
  it('shows the key prefix and name', () => {
    const { html } = buildApiKeyExpiryEmail({ ...base, kind: 'expiring' });
    expect(html).toContain('ak_live_a172');
    expect(html).toContain('HakiChain Production');
  });

  it('carries no full-length credential and no hash', () => {
    const { html, subject } = buildApiKeyExpiryEmail({ ...base, kind: 'expiring' });
    const body = `${subject}\n${html}`;
    // The raw key format is ak_(live|test)_ + 64 hex. Nothing of that shape
    // may appear — nor anything else 64 hex chars long, which is also the
    // shape of the stored HMAC.
    expect(body).not.toMatch(/ak_(live|test)_[a-f0-9]{64}/);
    expect(body).not.toMatch(/\b[a-f0-9]{64}\b/);
  });

  it('escapes a key name so a crafted name cannot inject markup', () => {
    // Key names are user-supplied and land in an HTML document.
    const { html } = buildApiKeyExpiryEmail({
      ...base,
      keyName: '<img src=x onerror="alert(1)">',
      kind: 'expiring',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('the two kinds say different things', () => {
  it('an EXPIRING notice states the deadline and that time remains', () => {
    const { subject, html } = buildApiKeyExpiryEmail({ ...base, kind: 'expiring' });
    expect(subject).toMatch(/expires in 8 days/);
    expect(html).toMatch(/expires in 8 days/);
    expect(html).not.toMatch(/stopped working/);
  });

  it('an EXPIRED notice states that requests are ALREADY being refused', () => {
    // The distinction is the deliverable. A partner reading "expires soon"
    // about a key that died in July learns nothing actionable.
    const { subject, html } = buildApiKeyExpiryEmail({
      ...base,
      kind: 'expired',
      expiresAt: '2026-07-01T00:00:00.000Z',
      daysRemaining: -73,
    });
    expect(subject).toMatch(/has expired/);
    expect(html).toMatch(/stopped working/);
    expect(html).toMatch(/being refused/);
  });

  it('says "today", not "in 0 days", on the final day', () => {
    const { subject } = buildApiKeyExpiryEmail({ ...base, kind: 'expiring', daysRemaining: 0 });
    expect(subject).toMatch(/expires today/);
    expect(subject).not.toMatch(/0 days/);
  });

  it('says "in 1 day", not "in 1 days"', () => {
    const { subject } = buildApiKeyExpiryEmail({ ...base, kind: 'expiring', daysRemaining: 1 });
    expect(subject).toMatch(/in 1 day\b/);
  });

  it('degrades to "soon" rather than printing null when the count is unknown', () => {
    const { subject } = buildApiKeyExpiryEmail({ ...base, kind: 'expiring', daysRemaining: null });
    expect(subject).toMatch(/expires soon/);
    expect(subject).not.toMatch(/null|NaN|undefined/);
  });
});

describe('the reader can act on it', () => {
  it('links to the keys page', () => {
    const { html } = buildApiKeyExpiryEmail({ ...base, kind: 'expired' });
    expect(html).toContain('https://app.arkova.ai/settings/api-keys');
  });

  it('says extending keeps the same key, so nothing has to be redistributed', () => {
    const { html } = buildApiKeyExpiryEmail({ ...base, kind: 'expiring' });
    expect(html).toMatch(/nothing to redistribute/i);
  });
});

describe('subject-line sanitisation (SCRUM-5023 review)', () => {
  // The key name is caller-supplied (`z.string().min(1).max(100)` — newlines
  // and quotes included) and lands inside quotes in the subject. Resend builds
  // the message from JSON, so CR/LF header injection is not reachable today;
  // this does not depend on that staying true.
  it('strips CR/LF from the subject', () => {
    const { subject } = buildApiKeyExpiryEmail({
      ...base, kind: 'expired',
      keyName: 'prod\r\nBcc: attacker@evil.example',
    });

    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain('prod Bcc: attacker@evil.example');
  });

  it('collapses whitespace used to push content off the visible subject', () => {
    const { subject } = buildApiKeyExpiryEmail({
      ...base, kind: 'expired',
      keyName: 'prod' + ' '.repeat(60) + 'ACTION REQUIRED',
    });

    expect(subject).toContain('prod ACTION REQUIRED');
  });

  it('bounds the key name so a 100-char name cannot crowd out the notice', () => {
    const { subject } = buildApiKeyExpiryEmail({ ...base, kind: 'expired', keyName: 'x'.repeat(100) });

    expect(subject).toContain('has expired');
    expect(subject.length).toBeLessThan(200);
  });

  it('does NOT html-escape the subject — a subject line is not markup', () => {
    // `esc()` here would ship a literal `&amp;` to the reader's inbox.
    const { subject } = buildApiKeyExpiryEmail({ ...base, kind: 'expired', keyName: 'Ops & Billing' });

    expect(subject).toContain('Ops & Billing');
    expect(subject).not.toContain('&amp;');
  });

  it('still escapes the key name in the HTML BODY', () => {
    const { html } = buildApiKeyExpiryEmail({ ...base, kind: 'expiring', keyName: '<img src=x onerror=alert(1)>' });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
