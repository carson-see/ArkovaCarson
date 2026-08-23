/**
 * Tests for Jurisdiction-Specific Privacy Notices — REG-14 (SCRUM-575)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JurisdictionPrivacyNotices } from './JurisdictionPrivacyNotices';
import { PRIVACY_NOTICE_LABELS } from '@/lib/copy';

describe('JurisdictionPrivacyNotices — REG-14', () => {
  it('renders all jurisdictions when no filter is provided', () => {
    render(<JurisdictionPrivacyNotices />);

    // Each jurisdiction renders a card with its title
    const allText = document.body.textContent ?? '';
    expect(allText).toContain('FERPA');
    expect(allText).toContain('HIPAA');
    expect(allText).toContain('Kenya');
    expect(allText).toContain('Australian');
    expect(allText).toContain('POPIA');
    expect(allText).toContain('Nigeria');
    expect(allText).toContain('Colombia Law 1581');
    expect(allText).toContain('Thailand PDPA');
    expect(allText).toContain('Malaysia PDPA');
  });

  it('filters to specific jurisdictions when provided', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['ferpa', 'hipaa']} />);

    expect(screen.getByText(/FERPA/)).toBeDefined();
    expect(screen.getByText(/HIPAA/)).toBeDefined();
    expect(screen.queryByText(/Kenya Data Protection Act/)).toBeNull();
    expect(screen.queryByText(/POPIA/)).toBeNull();
  });

  it('shows regulator links for each jurisdiction', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['kenya']} />);

    const link = screen.getByText(/Office of the Data Protection Commissioner/);
    expect(link).toBeDefined();
    expect(link.closest('a')?.getAttribute('href')).toBe('https://odpc.go.ke');
  });

  it('shows breach timelines for each jurisdiction', () => {
    render(<JurisdictionPrivacyNotices />);

    // Kenya's "72 hours (controller to ODPC)" is deliberately absent as of
    // 2026-08-18 (Tranche 0, counsel-ordered) — see the dedicated Kenya test
    // below. Other jurisdictions are unaffected.
    expect(screen.queryByText(/72 hours.*ODPC/)).toBeNull();
    expect(screen.getByText(/60 calendar days/)).toBeDefined();
    expect(screen.getByText(/30-day assessment/)).toBeDefined();
  });

  it('shows data subject rights badges', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['australia']} />);

    expect(screen.getByText('Access (APP 12)')).toBeDefined();
    expect(screen.getByText('Correction (APP 13)')).toBeDefined();
  });

  it('filters correctly with single jurisdiction', () => {
    const { container } = render(<JurisdictionPrivacyNotices jurisdictions={['nigeria']} />);

    const text = container.textContent ?? '';
    expect(text).toContain('Nigeria');
    expect(text).toContain('NDPC');
  });

  it('shows South Africa POPIA notice with Information Regulator details (REG-22)', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['south-africa']} />);

    const allText = document.body.textContent ?? '';
    expect(allText).toContain('POPIA');
    expect(allText).toContain('Information Regulator');
    expect(allText).toContain('Section 23');
    expect(allText).toContain('Section 24');
    expect(allText).toContain('Section 72');
  });

  it('shows Nigeria NDPA notice with NDPC details (REG-25)', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['nigeria']} />);

    const allText = document.body.textContent ?? '';
    expect(allText).toContain('Nigeria Data Protection Act 2023');
    expect(allText).toContain('NDPC');
    expect(allText).toContain('Access');
    expect(allText).toContain('Rectification');
    expect(allText).toContain('Erasure');
    expect(allText).toContain('72 hours');
  });

  it('shows Information Officer contact for privacy-notice jurisdictions (REG-28 + INTL-04/05/06)', () => {
    render(<JurisdictionPrivacyNotices />);

    const links = document.querySelectorAll('a[href="mailto:privacy@arkova.ai"]');
    // Kenya, South Africa, Nigeria, Brazil, Singapore, Mexico, Colombia, Thailand, Malaysia
    expect(links.length).toBe(9);
  });

  it('shows Colombia INTL-04 notice with SIC details', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['colombia']} />);

    const allText = document.body.textContent ?? '';
    expect(allText).toContain('Colombia Law 1581');
    expect(allText).toContain('Superintendencia de Industria y Comercio');
    expect(allText).toContain('15 business days');
    expect(allText).toContain('SIC adequacy list');
  });

  it('shows Thailand INTL-05 notice with PDPC details', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['thailand']} />);

    const allText = document.body.textContent ?? '';
    expect(allText).toContain('Thailand PDPA');
    expect(allText).toContain('Personal Data Protection Committee');
    expect(allText).toContain('72 hours');
    expect(allText).toContain('Portability (§31)');
  });

  it('shows Malaysia INTL-06 notice with PDP details + TIA basis', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['malaysia']} />);

    const allText = document.body.textContent ?? '';
    expect(allText).toContain('Malaysia PDPA');
    expect(allText).toContain('Personal Data Protection Commissioner');
    expect(allText).toContain('Transfer Impact Assessment');
    expect(allText).toContain('Data portability (§43A)');
  });

  /**
   * The EU–US notice renders on the PUBLIC, unauthenticated /privacy page.
   * It shipped with an internal drafting instruction inside the description
   * ("[Counsel review required — do not assert a specific transfer mechanism
   * until confirmed.]") and a "(counsel-required)" tag on the transfer-basis
   * cell. Both are staff scaffolding and neither may reach a reader.
   *
   * The underlying caution is correct and stays: Arkova holds no DPF
   * self-certification (SCRUM-2283) and asserts no transfer mechanism
   * (§1.13 R-7). This test pins BOTH halves — no scaffolding, and no upgraded
   * claim.
   */
  it('EU–US notice shows no internal counsel instruction and asserts no transfer mechanism', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['eu-us-transfer']} />);

    const allText = document.body.textContent ?? '';

    // No leaked scaffolding.
    expect(allText).not.toMatch(/\[[^\]]*\]/);
    expect(allText.toLowerCase()).not.toContain('counsel-required');
    expect(allText.toLowerCase()).not.toContain('counsel review required');
    expect(allText.toLowerCase()).not.toContain('do not assert');

    // No claim we do not hold.
    expect(allText).not.toMatch(/self-certif/i);
    expect(allText).not.toMatch(/data privacy framework/i);
    expect(allText).not.toMatch(/standard contractual clauses/i);

    // The honest position still reaches the reader.
    expect(allText).toContain('under review by legal counsel');
    expect(allText).toContain('no specific transfer mechanism is asserted');
    expect(allText).toContain('file a complaint');
  });

  it('shows cross-border transfer basis for jurisdictions that have one', () => {
    render(<JurisdictionPrivacyNotices />);

    const allText = document.body.textContent ?? '';
    // SA
    expect(allText).toContain('Section 72 binding agreement');
    // Nigeria — flagged separately (hotfix/kenya-transfer-basis-removal PR
    // description) as the same SCC/Kenya-DPA-style conflation, unresolved
    // pending counsel; not touched in this fix, Kenya only.
    expect(allText).toContain('Standard Contractual Clauses');
  });

  /**
   * Counsel-ordered removal, 2026-08-18 (hotfix/kenya-transfer-basis-removal,
   * first commit). The live bundle asserted "Standard Contractual Clauses
   * (Section 48)" as Kenya's cross-border transfer basis. SCCs are an EU GDPR
   * mechanism; Kenya DPA 2019 §48 is Kenya's own transfer regime and does not
   * name SCCs — the claim was wrong, not just imprecise. Counsel said
   * removed, not reworded, so this pins removal: no transfer-basis row
   * renders for Kenya. As of the second commit (below), title, regulator,
   * and Information Officer are what remains unaffected — rights and breach
   * timeline are now ALSO removed, not "unaffected".
   */
  it('omits the cross-border transfer basis row for Kenya (counsel-ordered removal)', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['kenya']} />);

    const allText = document.body.textContent ?? '';
    expect(allText).not.toContain('Section 48');
    expect(allText).not.toContain('Standard Contractual Clauses');
    expect(allText).not.toContain(PRIVACY_NOTICE_LABELS.TRANSFER_BASIS_LABEL);

    // Rest of the Kenya notice still renders.
    expect(allText).toContain('Kenya Data Protection Act 2019');
    expect(allText).toContain('Office of the Data Protection Commissioner');

    const officerLink = document.querySelector('a[href="mailto:privacy@arkova.ai"]');
    expect(officerLink).not.toBeNull();
  });

  /**
   * Counsel-ordered removal, 2026-08-18 (hotfix/kenya-transfer-basis-removal,
   * second commit — Tranche 0 of the Sarah/Carson privacy-policy addendum,
   * item 1, quoted verbatim in the PR body): "Neutralise the Kenya card:
   * remove the Standard Contractual Clauses under Section 48 transfer basis,
   * the rights list citing Sections 25 to 38, and the 72-hour controller
   * notification timeline. Replace with the counsel-pending placeholder
   * pattern already used for the EU to US basis. Subtraction only. Do not
   * substitute an alternative safeguard."
   *
   * This test pins the two things that make it a subtraction and not a
   * reword: the specific, never-counsel-reviewed content is gone (no
   * "Sections 25-38", no rights badges, no "72 hours"), AND nothing invented
   * takes its place — the only new text is the same counsel-pending sentence
   * already live on the EU–US card, reused verbatim (same "under review by
   * legal counsel and will be published here once confirmed" substring the
   * `eu-us-transfer` test above pins).
   */
  it('Kenya card: rights list and breach timeline removed, counsel-pending placeholder present', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['kenya']} />);

    const allText = document.body.textContent ?? '';

    // The removed, never-counsel-reviewed content is gone.
    expect(allText).not.toContain('Sections 25-38');
    expect(allText).not.toContain('25-38');
    expect(allText).not.toContain('72 hours');
    expect(allText).not.toContain('Rectification');
    expect(allText).not.toContain('Erasure');
    expect(allText).not.toContain('Data portability');
    expect(allText).not.toContain('Object to processing');
    expect(allText).not.toContain(PRIVACY_NOTICE_LABELS.RIGHTS_LABEL);
    expect(allText).not.toContain(PRIVACY_NOTICE_LABELS.BREACH_TIMELINE_LABEL);

    // No alternative safeguard is substituted (counsel: "do not substitute").
    expect(allText).not.toMatch(/standard contractual clauses/i);
    expect(allText).not.toMatch(/72-hour/i);

    // The counsel-pending placeholder is present, mirroring the EU–US
    // pattern (same substring as PRIVACY_NOTICE_LABELS.DPF_DESCRIPTION).
    expect(allText).toContain('under review by legal counsel and will be published here once confirmed');

    // Unaffected: title, regulator, Information Officer.
    expect(allText).toContain('Kenya Data Protection Act 2019');
    expect(allText).toContain('Office of the Data Protection Commissioner');
    const officerLink = document.querySelector('a[href="mailto:privacy@arkova.ai"]');
    expect(officerLink).not.toBeNull();
  });

  /**
   * The Kenya-only removal must not leak into any other jurisdiction's rights
   * list or breach timeline. Full unfiltered render, same assertions the
   * pre-existing tests above already made per-jurisdiction — restated here
   * together as the explicit "other jurisdictions unaffected" regression
   * guard for this change.
   */
  it('other jurisdictions keep their rights lists and breach timelines (Kenya-only change)', () => {
    render(<JurisdictionPrivacyNotices />);

    const allText = document.body.textContent ?? '';

    // Breach timelines, still present.
    expect(allText).toContain('72 hours (controller to NDPC)'); // Nigeria
    expect(allText).toContain('60 calendar days'); // HIPAA
    expect(allText).toContain('30-day assessment'); // Australia

    // Rights lists, still present.
    expect(allText).toContain('Rectification'); // Nigeria (rights shape formerly shared with Kenya)
    expect(allText).toContain('Section 23'); // South Africa
    expect(allText).toContain('ARCO'); // Mexico

    // Only Kenya's card omits the "Your Rights" section entirely — every
    // other jurisdiction still renders the label at least once.
    const rightsLabelCount = allText.split(PRIVACY_NOTICE_LABELS.RIGHTS_LABEL).length - 1;
    expect(rightsLabelCount).toBeGreaterThan(0);
  });
});
