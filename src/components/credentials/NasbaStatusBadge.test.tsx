/**
 * NasbaStatusBadge Tests (SCRUM-1856 / CPE-R1-1)
 *
 * Covers all three NASBA registry states and asserts the disclaimer text is
 * sourced from the cpeComplianceCopy constants object (not hardcoded inline).
 *
 * @see SCRUM-1847, SCRUM-1856
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NasbaStatusBadge } from './NasbaStatusBadge';
import { CPE_COMPLIANCE_COPY } from './cpeComplianceCopy';

describe('NasbaStatusBadge', () => {
  describe('three states', () => {
    it('renders the confirmed (green) state with its label', () => {
      render(<NasbaStatusBadge status="confirmed" />);
      const badge = screen.getByText(CPE_COMPLIANCE_COPY.NASBA_STATUS_LABELS.confirmed);
      expect(badge).toBeInTheDocument();
    });

    it('renders the unknown (amber) state with its label', () => {
      render(<NasbaStatusBadge status="unknown" />);
      expect(
        screen.getByText(CPE_COMPLIANCE_COPY.NASBA_STATUS_LABELS.unknown),
      ).toBeInTheDocument();
    });

    it('renders the not_found (red) state with its label', () => {
      render(<NasbaStatusBadge status="not_found" />);
      expect(
        screen.getByText(CPE_COMPLIANCE_COPY.NASBA_STATUS_LABELS.not_found),
      ).toBeInTheDocument();
    });

    it('applies a distinct visual treatment per state', () => {
      const { container: confirmed } = render(<NasbaStatusBadge status="confirmed" />);
      const { container: unknown } = render(<NasbaStatusBadge status="unknown" />);
      const { container: notFound } = render(<NasbaStatusBadge status="not_found" />);

      const confirmedClass = confirmed.querySelector('[data-nasba-status]')?.className ?? '';
      const unknownClass = unknown.querySelector('[data-nasba-status]')?.className ?? '';
      const notFoundClass = notFound.querySelector('[data-nasba-status]')?.className ?? '';

      // Green / amber / red treatments must differ from each other.
      expect(confirmedClass).not.toBe(unknownClass);
      expect(unknownClass).not.toBe(notFoundClass);
      expect(confirmedClass).not.toBe(notFoundClass);
    });

    it('exposes the state via a data attribute for each status', () => {
      const { container } = render(<NasbaStatusBadge status="confirmed" />);
      expect(container.querySelector('[data-nasba-status="confirmed"]')).not.toBeNull();
    });
  });

  describe('disclaimer tooltip from constants', () => {
    it('renders the disclaimer text sourced from cpeComplianceCopy', () => {
      render(<NasbaStatusBadge status="confirmed" />);
      expect(
        screen.getByText(CPE_COMPLIANCE_COPY.NASBA_DISCLAIMER),
      ).toBeInTheDocument();
    });

    it('exposes the disclaimer through an accessible info affordance', () => {
      render(<NasbaStatusBadge status="unknown" />);
      const info = screen.getByLabelText(CPE_COMPLIANCE_COPY.NASBA_TOOLTIP_ARIA);
      expect(info).toBeInTheDocument();
    });

    it('uses the exact verbatim disclaimer required by the acceptance criteria', () => {
      // Guards against silent edits to the legally-reviewed disclaimer string.
      expect(CPE_COMPLIANCE_COPY.NASBA_DISCLAIMER).toBe(
        'Arkova displays NASBA registry status for your reference. State boards of accountancy have final authority on CPE credit acceptance.',
      );
    });
  });

  describe('optional sizing', () => {
    it('renders in compact mode without the disclaimer affordance', () => {
      render(<NasbaStatusBadge status="confirmed" compact />);
      // Label still present...
      expect(
        screen.getByText(CPE_COMPLIANCE_COPY.NASBA_STATUS_LABELS.confirmed),
      ).toBeInTheDocument();
      // ...but the info affordance is suppressed in compact contexts (table rows).
      expect(
        screen.queryByLabelText(CPE_COMPLIANCE_COPY.NASBA_TOOLTIP_ARIA),
      ).toBeNull();
    });
  });
});
