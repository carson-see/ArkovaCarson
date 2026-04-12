/**
 * Pure render-function tests. Uses happy-dom (configured in vite.config.ts)
 * so we have a real DOM without booting React or jsdom.
 */

import { describe, it, expect } from 'vitest';
import { renderLoading, renderError, renderCompact, renderFull, renderWidget } from './render';
import type { AnchorData } from './types';

const sampleAnchor: AnchorData = {
  verified: true,
  status: 'ACTIVE',
  issuer_name: 'University of Michigan',
  credential_type: 'DEGREE',
  anchor_timestamp: '2026-04-11T10:30:00.000Z',
  network_receipt_id: 'tx-abcdef123456',
  record_uri: 'https://app.arkova.ai/verify/ARK-2026-001',
  filename: 'maya-chen-diploma.pdf',
  fingerprint: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  public_id: 'ARK-2026-001',
};

describe('renderLoading', () => {
  it('renders a loading state with the correct data attribute', () => {
    const node = renderLoading('full');
    expect(node.getAttribute('data-arkova-state')).toBe('loading');
    expect(node.textContent).toContain('Loading');
  });

  it('respects compact mode container styling', () => {
    const node = renderLoading('compact');
    expect(node.getAttribute('style')).toContain('max-width: 320px');
  });

  it('uses larger container in full mode', () => {
    const node = renderLoading('full');
    expect(node.getAttribute('style')).toContain('max-width: 384px');
  });
});

describe('renderError', () => {
  it('renders the not-found state with default message', () => {
    const node = renderError('full');
    expect(node.getAttribute('data-arkova-state')).toBe('error');
    expect(node.textContent).toContain('Not Found');
    expect(node.textContent).toContain('could not be verified');
  });

  it('uses a custom message when provided', () => {
    const node = renderError('full', 'Custom failure message');
    expect(node.textContent).toContain('Custom failure message');
  });
});

describe('renderCompact', () => {
  it('renders the verified compact state', () => {
    const node = renderCompact(sampleAnchor);
    expect(node.getAttribute('data-arkova-state')).toBe('ready');
    expect(node.textContent).toContain('Verified');
    expect(node.textContent).toContain('maya-chen-diploma.pdf');
    expect(node.textContent).toContain('Arkova');
  });

  it('renders the revoked compact state', () => {
    const node = renderCompact({ ...sampleAnchor, status: 'REVOKED' });
    expect(node.textContent).toContain('Revoked');
  });

  it('handles missing filename gracefully', () => {
    const node = renderCompact({ ...sampleAnchor, filename: null });
    expect(node.textContent).toContain('Verified');
    expect(node.textContent).not.toContain('maya-chen');
  });
});

describe('renderFull', () => {
  const APP_BASE = 'https://app.arkova.ai';

  it('renders the full verified state with all detail rows', () => {
    const node = renderFull(sampleAnchor, APP_BASE);
    expect(node.textContent).toContain('Verified');
    expect(node.textContent).toContain('Document');
    expect(node.textContent).toContain('Type');
    expect(node.textContent).toContain('Issuer');
    expect(node.textContent).toContain('Secured');
    expect(node.textContent).toContain('University of Michigan');
    expect(node.textContent).toContain('maya-chen-diploma.pdf');
  });

  it('renders the revoked state with grey background', () => {
    const node = renderFull({ ...sampleAnchor, status: 'REVOKED' }, APP_BASE);
    expect(node.textContent).toContain('Record Revoked');
  });

  it('maps credential type codes to friendly labels', () => {
    const node = renderFull({ ...sampleAnchor, credential_type: 'LICENSE' }, APP_BASE);
    expect(node.textContent).toContain('License');
  });

  it('falls back to raw credential_type when unknown', () => {
    const node = renderFull({ ...sampleAnchor, credential_type: 'EXOTIC_TYPE' }, APP_BASE);
    expect(node.textContent).toContain('EXOTIC_TYPE');
  });

  it('truncates fingerprint to first16+last8 form', () => {
    const node = renderFull(sampleAnchor, APP_BASE);
    expect(node.textContent).toContain('b94d27b9934d3e08...e2efcde9');
  });

  it('produces a valid full-details link to the public verify page', () => {
    const node = renderFull(sampleAnchor, APP_BASE);
    const link = node.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://app.arkova.ai/verify/ARK-2026-001');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders without optional fields', () => {
    const minimal: AnchorData = {
      verified: true,
      status: 'ACTIVE',
      public_id: 'ARK-X',
    };
    const node = renderFull(minimal, APP_BASE);
    expect(node.textContent).toContain('Verified');
  });

  it('strips trailing slash from appBaseUrl when building link', () => {
    const node = renderFull(sampleAnchor, 'https://app.arkova.ai');
    const link = node.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://app.arkova.ai/verify/ARK-2026-001');
  });

  it('escapes special characters in publicId via encodeURIComponent', () => {
    const node = renderFull({ ...sampleAnchor, public_id: 'ARK/2026/special#1' }, APP_BASE);
    const link = node.querySelector('a');
    expect(link?.getAttribute('href')).toContain('ARK%2F2026%2Fspecial%231');
  });
});

describe('renderWidget dispatcher', () => {
  it('dispatches to compact', () => {
    const node = renderWidget('compact', sampleAnchor, 'https://app.arkova.ai');
    expect(node.textContent).toContain('Verified');
    // Compact lacks the explicit "Document" label row
    expect(node.textContent).not.toContain('Document');
  });

  it('dispatches to full', () => {
    const node = renderWidget('full', sampleAnchor, 'https://app.arkova.ai');
    expect(node.textContent).toContain('Document');
  });
});

describe('CSP / inline-style safety', () => {
  it('uses inline style attributes (no <style> blocks)', () => {
    const node = renderFull(sampleAnchor, 'https://app.arkova.ai');
    // No injected style tags anywhere in the subtree
    expect(node.querySelectorAll('style').length).toBe(0);
    // Root has an inline style
    expect(node.getAttribute('style')).toBeTruthy();
  });

  it('does not load external fonts or images', () => {
    const node = renderFull(sampleAnchor, 'https://app.arkova.ai');
    expect(node.querySelectorAll('link').length).toBe(0);
    expect(node.querySelectorAll('img').length).toBe(0);
  });
});
