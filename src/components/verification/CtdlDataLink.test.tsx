/**
 * CtdlDataLink Tests
 *
 * The public CTDL JSON-LD projection (`GET /api/v1/credentials/:publicId/ctdl`,
 * services/worker/src/api/v1/credentials-ctdl.ts) is a mature, heavily-tested,
 * standards-conformant endpoint that was, until this component, linked from
 * NOWHERE in the product — not the verify page, not the credential detail
 * view, nowhere. A capability that exists in the worker but has zero UI
 * surface is invisible to a user, a founder demo, or a Credential Engine
 * evaluator looking at the live product. This component closes that gap with
 * a single, claims-safe discoverability link.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CtdlDataLink, ctdlDataUrl } from './CtdlDataLink';
import { WORKER_URL } from '@/lib/workerClient';

describe('CtdlDataLink', () => {
  it('renders a link to the public CTDL JSON-LD endpoint for this publicId', () => {
    render(<CtdlDataLink publicId="ARK-2026-TEST0001" />);

    const link = screen.getByTestId('ctdl-data-link');
    expect(link).toHaveAttribute('href', `${WORKER_URL}/api/v1/credentials/ARK-2026-TEST0001/ctdl`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('URL-encodes the publicId so an unusual value cannot break the path', () => {
    render(<CtdlDataLink publicId="ARK/weird id?" />);

    const link = screen.getByTestId('ctdl-data-link');
    expect(link.getAttribute('href')).toBe(
      `${WORKER_URL}/api/v1/credentials/${encodeURIComponent('ARK/weird id?')}/ctdl`,
    );
  });

  it('ctdlDataUrl builds the expected worker endpoint path (unit, no render)', () => {
    expect(ctdlDataUrl('ARK-2026-XYZ')).toBe(`${WORKER_URL}/api/v1/credentials/ARK-2026-XYZ/ctdl`);
  });

  it('never claims a Registry-listing or publication-status assertion (R-7 / CE-06a)', () => {
    render(<CtdlDataLink publicId="ARK-2026-TEST0001" />);

    const row = screen.getByTestId('ctdl-data-link-row');
    const text = row.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('listed');
    expect(text).not.toContain('endorsed');
    expect(text).not.toMatch(/(?:published|live|appears?)\s+(?:in|on)\s+(?:the\s+)?(?:ce\s+|credential\s+(?:engine(?:'s)?\s+)?)?registry/);
  });

  it('renders no user-visible §1.3-banned terminology', () => {
    render(<CtdlDataLink publicId="ARK-2026-TEST0001" />);

    const row = screen.getByTestId('ctdl-data-link-row');
    const text = row.textContent ?? '';
    for (const banned of ['Wallet', 'Blockchain', 'Bitcoin', 'Transaction', 'Testnet', 'Mainnet', 'Hash', 'Broadcast']) {
      expect(text).not.toContain(banned);
    }
  });
});
