/**
 * Section 3 ("Document Privacy") wording pin — REG-14 / Tranche 0.
 *
 * `PrivacyPage.copy-centralization.test.tsx` (sibling file) deliberately does
 * not pin wording — it only checks that every rendered string traces back to
 * `copy.ts`. This file exists for the opposite job: pin the exact text of
 * counsel's Section 3 replacement, the same way
 * `JurisdictionPrivacyNotices.test.tsx`'s `eu-us-transfer` test pins
 * `DPF_DESCRIPTION`.
 *
 * Counsel-ordered rewrite, 2026-08-18 (Tranche 0 of the Sarah/Carson
 * privacy-policy addendum, item 1): "Fix Section 3. 'Your files never leave
 * your browser' is not true on the connector path." The prior claim was
 * accurate for browser uploads but false for DocuSign/Google Drive documents,
 * which are fingerprinted server-side under the §1.6A carve-out. The
 * replacement text below is counsel's exact approved wording, sent to
 * Solomon Karanja Meru (MNA Legal) — reproduced verbatim per the addendum.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PrivacyPage } from './PrivacyPage';
import { LEGAL_PAGE_LABELS } from '@/lib/copy';

const COUNSEL_APPROVED_SECTION_3 =
  'Personal information is removed before any metadata is sent to our AI processor. For documents you upload directly, that removal happens in your browser, before anything is transmitted. Documents fetched from a source you connect, such as DocuSign or Google Drive, are not subject to AI metadata processing at all. They are fingerprinted in memory on our servers, the file is discarded immediately, and only the fingerprint and a fixed set of technical fields are retained. In neither case is raw document text or document bytes transmitted to the AI processor.';

describe('PrivacyPage — Section 3 (Document Privacy) wording', () => {
  it('PRIVACY_S3_BODY matches counsel\'s approved text exactly, word for word', () => {
    expect(LEGAL_PAGE_LABELS.PRIVACY_S3_BODY).toBe(COUNSEL_APPROVED_SECTION_3);
  });

  it('renders the counsel-approved Section 3 wording verbatim on /privacy', () => {
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(LEGAL_PAGE_LABELS.PRIVACY_S3_HEADING)).toBeDefined();
    expect(screen.getByText(COUNSEL_APPROVED_SECTION_3)).toBeDefined();
  });

  it('no longer asserts the unqualified "never leave your browser" claim', () => {
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );

    const main = document.querySelector('main')?.textContent ?? '';
    expect(main).not.toContain('Your files never leave your browser');
  });

  it('the connector carve-out is stated: connector documents are fingerprinted server-side, not client-side', () => {
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );

    const main = document.querySelector('main')?.textContent ?? '';
    expect(main).toContain('DocuSign or Google Drive');
    expect(main).toContain('fingerprinted in memory on our servers');
    expect(main).toContain('the file is discarded immediately');
    // Neither path sends raw text/bytes to the AI processor — the load-bearing
    // claim the old, simpler wording didn't actually make room for.
    expect(main).toContain('raw document text or document bytes transmitted to the AI processor');
  });
});
