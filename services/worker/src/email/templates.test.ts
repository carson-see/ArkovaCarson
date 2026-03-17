/**
 * Unit tests for email templates (BETA-03)
 */

import { describe, it, expect } from 'vitest';
import {
  buildActivationEmail,
  buildAnchorSecuredEmail,
  buildRevocationEmail,
} from './templates.js';

describe('buildActivationEmail', () => {
  const baseData = {
    recipientEmail: 'student@example.com',
    organizationName: 'University of Michigan',
    activationUrl: 'https://app.arkova.io/activate?token=abc123',
  };

  it('returns subject and HTML', () => {
    const result = buildActivationEmail(baseData);
    expect(result.subject).toContain('University of Michigan');
    expect(result.html).toContain('Activate Your Account');
  });

  it('includes activation URL in HTML', () => {
    const result = buildActivationEmail(baseData);
    expect(result.html).toContain(baseData.activationUrl);
  });

  it('includes organization name in body', () => {
    const result = buildActivationEmail(baseData);
    expect(result.html).toContain('University of Michigan');
  });

  it('includes credential label when provided', () => {
    const result = buildActivationEmail({
      ...baseData,
      credentialLabel: 'Bachelor of Science',
    });
    expect(result.html).toContain('Bachelor of Science');
  });

  it('renders without credential label', () => {
    const result = buildActivationEmail(baseData);
    expect(result.html).toContain('a credential');
    expect(result.html).not.toContain('undefined');
  });

  it('does not contain banned terminology', () => {
    const result = buildActivationEmail(baseData);
    const banned = ['wallet', 'gas', 'hash', 'blockchain', 'bitcoin', 'crypto', 'transaction'];
    for (const term of banned) {
      expect(result.html.toLowerCase()).not.toContain(term);
      expect(result.subject.toLowerCase()).not.toContain(term);
    }
  });
});

describe('buildAnchorSecuredEmail', () => {
  const baseData = {
    recipientEmail: 'student@example.com',
    credentialLabel: 'Bachelor of Science',
    verificationUrl: 'https://app.arkova.io/verify/pub-123',
    organizationName: 'University of Michigan',
  };

  it('returns subject with credential label', () => {
    const result = buildAnchorSecuredEmail(baseData);
    expect(result.subject).toContain('Bachelor of Science');
    expect(result.subject).toContain('secured');
  });

  it('includes verification URL', () => {
    const result = buildAnchorSecuredEmail(baseData);
    expect(result.html).toContain(baseData.verificationUrl);
  });

  it('includes organization name when provided', () => {
    const result = buildAnchorSecuredEmail(baseData);
    expect(result.html).toContain('University of Michigan');
  });

  it('renders without organization name', () => {
    const result = buildAnchorSecuredEmail({
      ...baseData,
      organizationName: undefined,
    });
    expect(result.html).not.toContain('undefined');
  });

  it('does not contain banned terminology', () => {
    const result = buildAnchorSecuredEmail(baseData);
    const banned = ['wallet', 'gas', 'hash', 'blockchain', 'bitcoin', 'crypto', 'transaction'];
    for (const term of banned) {
      expect(result.html.toLowerCase()).not.toContain(term);
    }
  });
});

describe('buildRevocationEmail', () => {
  const baseData = {
    recipientEmail: 'student@example.com',
    credentialLabel: 'Bachelor of Science',
    organizationName: 'University of Michigan',
  };

  it('returns subject with credential label', () => {
    const result = buildRevocationEmail(baseData);
    expect(result.subject).toContain('Bachelor of Science');
    expect(result.subject).toContain('revoked');
  });

  it('includes revocation reason when provided', () => {
    const result = buildRevocationEmail({
      ...baseData,
      revocationReason: 'Degree revoked due to policy violation',
    });
    expect(result.html).toContain('Degree revoked due to policy violation');
  });

  it('renders without revocation reason', () => {
    const result = buildRevocationEmail(baseData);
    expect(result.html).not.toContain('Reason:');
  });

  it('does not contain banned terminology', () => {
    const result = buildRevocationEmail(baseData);
    const banned = ['wallet', 'gas', 'hash', 'blockchain', 'bitcoin', 'crypto', 'transaction'];
    for (const term of banned) {
      expect(result.html.toLowerCase()).not.toContain(term);
    }
  });
});
