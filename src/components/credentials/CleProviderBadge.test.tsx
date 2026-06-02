/**
 * CleProviderBadge Tests (SCRUM-1869 / CLE-R1)
 *
 * Covers all three CLE provider approval states and asserts the disclaimer text
 * is sourced from the cleComplianceCopy constants object (not hardcoded inline).
 *
 * @see SCRUM-1869, SCRUM-1856
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CleProviderBadge } from './CleProviderBadge';
import { CLE_COMPLIANCE_COPY } from './cleComplianceCopy';

describe('CleProviderBadge', () => {
  describe('three states', () => {
    it('renders the approved (green) state with its label', () => {
      render(<CleProviderBadge status="approved" />);
      const badge = screen.getByText(CLE_COMPLIANCE_COPY.PROVIDER_STATUS_LABELS.approved);
      expect(badge).toBeInTheDocument();
    });

    it('renders the unknown (amber) state with its label', () => {
      render(<CleProviderBadge status="unknown" />);
      expect(
        screen.getByText(CLE_COMPLIANCE_COPY.PROVIDER_STATUS_LABELS.unknown),
      ).toBeInTheDocument();
    });

    it('renders the not_approved (red) state with its label', () => {
      render(<CleProviderBadge status="not_approved" />);
      expect(
        screen.getByText(CLE_COMPLIANCE_COPY.PROVIDER_STATUS_LABELS.not_approved),
      ).toBeInTheDocument();
    });

    it('applies a distinct visual treatment per state', () => {
      const { container: approved } = render(<CleProviderBadge status="approved" />);
      const { container: unknown } = render(<CleProviderBadge status="unknown" />);
      const { container: notApproved } = render(<CleProviderBadge status="not_approved" />);

      const approvedClass = approved.querySelector('[data-cle-provider-status]')?.className ?? '';
      const unknownClass = unknown.querySelector('[data-cle-provider-status]')?.className ?? '';
      const notApprovedClass = notApproved.querySelector('[data-cle-provider-status]')?.className ?? '';

      // Green / amber / red treatments must differ from each other.
      expect(approvedClass).not.toBe(unknownClass);
      expect(unknownClass).not.toBe(notApprovedClass);
      expect(approvedClass).not.toBe(notApprovedClass);
    });

    it('exposes the state via a data attribute for each status', () => {
      const { container } = render(<CleProviderBadge status="approved" />);
      expect(container.querySelector('[data-cle-provider-status="approved"]')).not.toBeNull();
    });
  });

  describe('disclaimer tooltip from constants', () => {
    it('renders the disclaimer text sourced from cleComplianceCopy', () => {
      render(<CleProviderBadge status="approved" />);
      expect(
        screen.getByText(CLE_COMPLIANCE_COPY.PROVIDER_DISCLAIMER),
      ).toBeInTheDocument();
    });

    it('exposes the disclaimer through an accessible info affordance', () => {
      render(<CleProviderBadge status="unknown" />);
      const info = screen.getByLabelText(CLE_COMPLIANCE_COPY.PROVIDER_TOOLTIP_ARIA);
      expect(info).toBeInTheDocument();
    });

    it('uses the exact verbatim disclaimer required by the acceptance criteria', () => {
      // Guards against silent edits to the legally-reviewed disclaimer string.
      expect(CLE_COMPLIANCE_COPY.PROVIDER_DISCLAIMER).toBe(
        'Arkova displays provider approval status based on our reference registry. Your state bar has final authority on CLE credit acceptance.',
      );
    });
  });

  describe('optional sizing', () => {
    it('renders in compact mode without the disclaimer affordance', () => {
      render(<CleProviderBadge status="approved" compact />);
      // Label still present...
      expect(
        screen.getByText(CLE_COMPLIANCE_COPY.PROVIDER_STATUS_LABELS.approved),
      ).toBeInTheDocument();
      // ...but the info affordance is suppressed in compact contexts (table rows).
      expect(
        screen.queryByLabelText(CLE_COMPLIANCE_COPY.PROVIDER_TOOLTIP_ARIA),
      ).toBeNull();
    });
  });
});
