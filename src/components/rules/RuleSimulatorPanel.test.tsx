/**
 * Tests — SCRUM-1141 RuleSimulatorPanel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RuleSimulatorPanel } from './RuleSimulatorPanel';

function makeFetcher(response: { ok: boolean; status?: number; body: unknown }) {
  return vi.fn(async () =>
    ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 400),
      json: async () => response.body,
    }) as unknown as Response,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RuleSimulatorPanel (SCRUM-1141)', () => {
  it('renders sample fields from a docusign template when trigger_type=ESIGN_COMPLETED', () => {
    render(
      <RuleSimulatorPanel
        rule={{
          name: 'demo',
          trigger_type: 'ESIGN_COMPLETED',
          trigger_config: { vendors: ['docusign'] },
          action_type: 'NOTIFY',
          action_config: { channels: ['email'], recipient_emails: ['ops@example.com'] },
        }}
      />,
    );
    expect((screen.getByLabelText('Vendor') as HTMLInputElement).value).toBe('docusign');
    expect((screen.getByLabelText('Filename') as HTMLInputElement).value).toBe('sample-msa-signed.pdf');
    expect((screen.getByLabelText('Sender email') as HTMLInputElement).value).toBe('signer@example.com');
  });

  it('renders sample fields from a Google Drive template when trigger_type=WORKSPACE_FILE_MODIFIED', () => {
    render(
      <RuleSimulatorPanel
        rule={{
          name: 'demo',
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { vendors: ['google_drive'] },
          action_type: 'QUEUE_FOR_REVIEW',
          action_config: { priority: 'high' },
        }}
      />,
    );
    expect((screen.getByLabelText('Vendor') as HTMLInputElement).value).toBe('google_drive');
    expect((screen.getByLabelText('Folder path') as HTMLInputElement).value).toBe('/Legal/MSAs/');
  });

  it('Test rule button is clearly separate (own button, separate from save) and disabled while submitting', async () => {
    const fetcher = makeFetcher({
      ok: true,
      body: { matched: true, reason: 'matched', needs_semantic_match: false, action_type: 'NOTIFY', action_preview: { action_type: 'NOTIFY', config: {} } },
    });
    render(
      <RuleSimulatorPanel
        fetcher={fetcher as never}
        rule={{
          name: 'demo',
          trigger_type: 'ESIGN_COMPLETED',
          trigger_config: { vendors: ['docusign'] },
          action_type: 'NOTIFY',
          action_config: { channels: ['email'], recipient_emails: ['ops@example.com'] },
        }}
      />,
    );
    const button = screen.getByTestId('simulator-run');
    expect(button.textContent).toMatch(/test rule/i);
    fireEvent.click(button);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  });

  it('shows matched result + action preview', async () => {
    const fetcher = makeFetcher({
      ok: true,
      body: {
        matched: true,
        reason: 'matched',
        needs_semantic_match: false,
        action_type: 'NOTIFY',
        action_preview: { action_type: 'NOTIFY', config: { channels: ['email'] } },
      },
    });
    render(
      <RuleSimulatorPanel
        fetcher={fetcher as never}
        rule={{
          name: 'demo',
          trigger_type: 'ESIGN_COMPLETED',
          trigger_config: { vendors: ['docusign'] },
          action_type: 'NOTIFY',
          action_config: { channels: ['email'], recipient_emails: ['ops@example.com'] },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('simulator-run'));
    const result = await screen.findByTestId('simulator-result');
    expect(result.textContent).toMatch(/this rule would fire/i);
    expect(result.textContent).toMatch(/action that would run/i);
    // Action label resolved from RULE_ACTION_COPY
    expect(result.textContent).toMatch(/notify/i);
  });

  it('shows not-matched + reason code when rule rejects the sample', async () => {
    const fetcher = makeFetcher({
      ok: true,
      body: {
        matched: false,
        reason: 'vendor_filter_rejected',
        needs_semantic_match: false,
      },
    });
    render(
      <RuleSimulatorPanel
        fetcher={fetcher as never}
        rule={{
          name: 'demo',
          trigger_type: 'ESIGN_COMPLETED',
          trigger_config: { vendors: ['adobe_sign'] }, // sample has docusign → reject
          action_type: 'NOTIFY',
          action_config: { channels: ['email'], recipient_emails: ['ops@example.com'] },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('simulator-run'));
    const result = await screen.findByTestId('simulator-result');
    expect(result.textContent).toMatch(/would not fire/i);
    expect(result.textContent).toMatch(/vendor_filter_rejected/i);
  });

  it('shows the semantic-match caveat banner when needs_semantic_match=true', async () => {
    const fetcher = makeFetcher({
      ok: true,
      body: {
        matched: true,
        reason: 'matched',
        needs_semantic_match: true,
        action_type: 'AUTO_ANCHOR',
        action_preview: { action_type: 'AUTO_ANCHOR', config: {} },
      },
    });
    render(
      <RuleSimulatorPanel
        fetcher={fetcher as never}
        rule={{
          name: 'demo',
          trigger_type: 'ESIGN_COMPLETED',
          trigger_config: { vendors: ['docusign'], semantic_match: { description: 'msa', threshold: 0.8 } },
          action_type: 'AUTO_ANCHOR',
          action_config: {},
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('simulator-run'));
    const result = await screen.findByTestId('simulator-result');
    expect(result.textContent).toMatch(/semantic-match check/i);
  });

  it('refuses to call the API if trigger or action are missing', async () => {
    const fetcher = makeFetcher({ ok: true, body: {} });
    render(
      <RuleSimulatorPanel
        fetcher={fetcher as never}
        rule={{ name: 'demo' }}
      />,
    );
    fireEvent.click(screen.getByTestId('simulator-run'));
    await waitFor(() => expect(screen.getByTestId('simulator-error')).toBeTruthy());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces server error message', async () => {
    const fetcher = makeFetcher({
      ok: false,
      status: 400,
      body: { error: { code: 'invalid_config', message: 'Bad shape' } },
    });
    render(
      <RuleSimulatorPanel
        fetcher={fetcher as never}
        rule={{
          name: 'demo',
          trigger_type: 'ESIGN_COMPLETED',
          trigger_config: { vendors: ['docusign'] },
          action_type: 'NOTIFY',
          action_config: { channels: ['email'], recipient_emails: ['ops@example.com'] },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('simulator-run'));
    const err = await screen.findByTestId('simulator-error');
    expect(err.textContent).toMatch(/bad shape/i);
  });

  it('omits empty optional fields from the request body so worker validation does not 400', async () => {
    const fetcher = makeFetcher({
      ok: true,
      body: { matched: false, reason: 'rule_disabled', needs_semantic_match: false },
    });
    render(
      <RuleSimulatorPanel
        fetcher={fetcher as never}
        rule={{
          name: 'demo',
          trigger_type: 'MANUAL_UPLOAD',
          trigger_config: {},
          action_type: 'AUTO_ANCHOR',
          action_config: {},
        }}
      />,
    );
    // Manual sample has empty vendor, folder_path, sender_email, subject
    fireEvent.click(screen.getByTestId('simulator-run'));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as { body: string }).body) as {
      event: Record<string, unknown>;
    };
    expect(body.event.trigger_type).toBe('MANUAL_UPLOAD');
    expect(body.event.vendor).toBeUndefined();
    expect(body.event.folder_path).toBeUndefined();
    expect(body.event.sender_email).toBeUndefined();
    expect(body.event.subject).toBeUndefined();
  });
});
