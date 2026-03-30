/**
 * Unit tests for email templates (BETA-03)
 */

import { describe, it, expect } from 'vitest';
import {
  buildActivationEmail,
  buildAnchorSecuredEmail,
  buildRevocationEmail,
  buildDomainVerificationEmail,
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

describe('buildDomainVerificationEmail', () => {
  const baseData = {
    domain: 'example.com',
    verificationCode: '123456',
  };

  it('returns subject and HTML', () => {
    const result = buildDomainVerificationEmail(baseData);
    expect(result.subject).toContain('example.com');
    expect(result.html).toContain('Verify Your Domain');
  });

  it('includes the verification code', () => {
    const result = buildDomainVerificationEmail(baseData);
    expect(result.html).toContain('123456');
  });

  it('includes the domain name', () => {
    const result = buildDomainVerificationEmail(baseData);
    expect(result.html).toContain('example.com');
  });

  it('includes organization name in subject when provided', () => {
    const result = buildDomainVerificationEmail({
      ...baseData,
      organizationName: 'Acme Corp',
    });
    expect(result.subject).toContain('Acme Corp');
  });

  it('uses domain in subject when no organization name', () => {
    const result = buildDomainVerificationEmail(baseData);
    expect(result.subject).toContain('example.com');
  });

  it('mentions 24 hour expiry', () => {
    const result = buildDomainVerificationEmail(baseData);
    expect(result.html).toContain('24 hours');
  });

  it('escapes HTML in domain name', () => {
    const result = buildDomainVerificationEmail({
      ...baseData,
      domain: '<script>alert("xss")</script>.com',
    });
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('does not contain banned terminology', () => {
    const result = buildDomainVerificationEmail(baseData);
    const banned = ['wallet', 'gas', 'hash', 'blockchain', 'bitcoin', 'crypto', 'transaction'];
    for (const term of banned) {
      expect(result.html.toLowerCase()).not.toContain(term);
      expect(result.subject.toLowerCase()).not.toContain(term);
    }
  });
});
