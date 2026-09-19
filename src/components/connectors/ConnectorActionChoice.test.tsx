import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectorActionChoice } from './ConnectorActionChoice';
import { CONNECTORS_LABELS } from '@/lib/copy';

describe('ConnectorActionChoice', () => {
  it('renders both options, stacked, with the credit-cost help text visible', () => {
    render(<ConnectorActionChoice value="AUTO_ANCHOR" onChange={vi.fn()} name="test" />);
    expect(screen.getByText(CONNECTORS_LABELS.CONNECTOR_ACTION_INSTANT)).toBeInTheDocument();
    expect(screen.getByText(CONNECTORS_LABELS.CONNECTOR_ACTION_QUEUE)).toBeInTheDocument();
    // The credit cost must be visible inline, not hidden in a tooltip (PM-12).
    expect(screen.getByText(CONNECTORS_LABELS.CONNECTOR_ACTION_INSTANT_HELP)).toBeInTheDocument();
  });

  it('the AUTO_ANCHOR radio is checked when value=AUTO_ANCHOR (default pre-selection, PM-12)', () => {
    render(<ConnectorActionChoice value="AUTO_ANCHOR" onChange={vi.fn()} name="test" />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    const queueRadio = radios.find((r) => r.value === 'AUTO_ANCHOR')!;
    const instantRadio = radios.find((r) => r.value === 'INSTANT_SECURE')!;
    expect(queueRadio.checked).toBe(true);
    expect(instantRadio.checked).toBe(false);
  });

  it('calls onChange with INSTANT_SECURE when that option is clicked', () => {
    const onChange = vi.fn();
    render(<ConnectorActionChoice value="AUTO_ANCHOR" onChange={onChange} name="test" />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    const instantRadio = radios.find((r) => r.value === 'INSTANT_SECURE')!;
    fireEvent.click(instantRadio);
    expect(onChange).toHaveBeenCalledWith('INSTANT_SECURE');
  });

  it('disables both radios when disabled=true (Managed-in-Rules state)', () => {
    render(<ConnectorActionChoice value="AUTO_ANCHOR" onChange={vi.fn()} disabled name="test" />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    radios.forEach((r) => expect(r).toBeDisabled());
  });

  it('never renders a "review queue" third option (§1.4 — two options only)', () => {
    render(<ConnectorActionChoice value="AUTO_ANCHOR" onChange={vi.fn()} name="test" />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });
});
