import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SIGNUP_EMAIL_LINK_LIFETIME_SECONDS,
  SIGNUP_EMAIL_RESEND_COOLDOWN_SECONDS,
} from '../../src/lib/authEmailPolicy';

const config = readFileSync(resolve(process.cwd(), 'supabase/config.toml'), 'utf8');
const confirmationTemplate = readFileSync(
  resolve(process.cwd(), 'supabase/templates/confirmation.html'),
  'utf8',
);
const emailSection = config.match(/\[auth\.email\]\n([\s\S]*?)(?=\n\[|$)/)?.[1] ?? '';

describe('SCRUM-5145 email confirmation configuration contract', () => {
  it('keeps local Auth expiry and resend enforcement aligned with the application', () => {
    expect(emailSection).toMatch(
      new RegExp(`^otp_expiry = ${SIGNUP_EMAIL_LINK_LIFETIME_SECONDS}$`, 'm'),
    );
    expect(emailSection).toMatch(
      new RegExp(`^max_frequency = "${SIGNUP_EMAIL_RESEND_COOLDOWN_SECONDS}s"$`, 'm'),
    );
  });

  it('uses an Arkova-branded confirmation template without vendor-facing copy', () => {
    expect(confirmationTemplate).toContain('Welcome to Arkova');
    expect(confirmationTemplate).toContain('{{ .ConfirmationURL }}');
    expect(confirmationTemplate).not.toMatch(/supabase/i);
  });
});
