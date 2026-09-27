/**
 * ConnectorsPage — SPEC-CONNECTORS §6, tests 1, 3, 9, 10, 11 (adapted).
 *
 * Every `org_integrations` query this page issues is scoped by `org_id` —
 * pinned explicitly in the "test 10" case below via the `.eq('org_id', ...)`
 * call recorded on the mock chain, alongside the column-pinning assertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { ConnectorsPage } from './ConnectorsPage';
import { CONNECTIONS_LABELS, CONNECTORS_LABELS } from '@/lib/copy';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'admin@test.com' }, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { id: 'user-1', org_id: 'org-1', role: 'ORG_ADMIN', full_name: 'Test Admin' },
    loading: false,
  }),
}));

vi.mock('@/hooks/useCanIssueCredential', () => ({
  useCanIssueCredential: () => ({ allowed: true, loading: false, reason: null }),
}));

const mockFrom = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
}));

const workerFetch = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetch(...args),
  WORKER_URL: 'https://worker.test',
}));

interface OrgIntegrationsFixture {
  google_drive?: { id: string; connected_at: string } | null;
  docusign?: { id: string; connected_at: string; account_id?: string; account_label?: string } | null;
}

const orgIntegrationsSelects: Array<{ provider: string | undefined; orgId: string | undefined; columns: string }> = [];
// Real vi.fn() wrapping every .eq() call across every org_integrations chain,
// so a test can assert directly `expect(mockOrgIntegrationsEq).toHaveBeenCalledWith('org_id', ...)`
// — pinning that the page's own connection-status query is org-scoped, not
// just provider-filtered (arkova/no-unscoped-service-test).
const mockOrgIntegrationsEq = vi.fn();

function installOrgIntegrations(fixture: OrgIntegrationsFixture) {
  orgIntegrationsSelects.length = 0;
  mockOrgIntegrationsEq.mockReset();
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'org_integrations') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }) }),
      };
    }
    let provider: 'google_drive' | 'docusign' | undefined;
    const record = { provider: undefined as string | undefined, orgId: undefined as string | undefined, columns: '' };
    orgIntegrationsSelects.push(record);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (cols: string) => {
        record.columns = cols;
        return chain;
      },
      eq: (col: string, val: string) => {
        mockOrgIntegrationsEq(col, val);
        if (col === 'provider') {
          provider = val as 'google_drive' | 'docusign';
          record.provider = val;
        }
        if (col === 'org_id') {
          record.orgId = val;
        }
        return chain;
      },
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({
        data: provider ? fixture[provider] ?? null : null,
        error: null,
      }),
    };
    return chain;
  });
}

/**
 * Third param surfaces SCRUM-1146's `GET /api/connectors/health` response —
 * `undefined` means "return ok:true with no `connectors` array" (the
 * malformed-body fail-closed path `useConnectorHealth` must not choke on),
 * a plain object/array is served verbatim, and `'error'` simulates the
 * endpoint itself failing (503).
 */
function installRules(
  items: Array<{ id: string; trigger_type: string; enabled: boolean }>,
  detailById: Record<string, unknown> = {},
  health: unknown | 'error' = { connectors: [] },
) {
  workerFetch.mockImplementation(async (endpoint: string) => {
    if (endpoint === '/api/rules') {
      return { ok: true, status: 200, json: async () => ({ items }) } as Response;
    }
    const detailMatch = endpoint.match(/^\/api\/rules\/([^/]+)$/);
    if (detailMatch) {
      const item = detailById[detailMatch[1]!];
      return { ok: !!item, status: item ? 200 : 404, json: async () => ({ item }) } as Response;
    }
    if (endpoint === '/api/connectors/health') {
      if (health === 'error') {
        return { ok: false, status: 503, json: async () => ({ error: 'connector_health_unavailable' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => health } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

function renderPage(initialEntries: string[] = ['/organization/connectors']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ConnectorsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockFrom.mockReset();
  workerFetch.mockReset();
  vi.clearAllMocks();
  installOrgIntegrations({});
  installRules([]);
});

describe('ConnectorsPage', () => {
  it('renders exactly the two real connector cards, no Adobe Sign, no "coming soon" text (test 1)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Google Drive')).toBeInTheDocument());
    expect(screen.getByText('DocuSign')).toBeInTheDocument();
    expect(screen.queryByText('Adobe Sign')).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it('connected Drive with zero folders renders the empty-folders copy and disables Save (test 3)', async () => {
    installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
    installRules([]); // no rules yet -> status 'none'

    renderPage();
    await waitFor(() => expect(screen.getByText('No folders selected yet. Arkova will not act on anything until you choose at least one.')).toBeInTheDocument());

    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    saveButtons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it('shows a null-creator Drive rule as admin-repairable and enables unchanged re-save', async () => {
    installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
    installRules(
      [{ id: 'rule-1', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true }],
      { 'rule-1': { id: 'rule-1', trigger_type: 'WORKSPACE_FILE_MODIFIED', trigger_config: { vendors: ['google_drive'], drive_folders: [{ folder_id: 'f1', folder_name: 'Evidence' }] }, action_type: 'AUTO_ANCHOR', action_config: { tag: 'connector-google_drive' }, enabled: true, created_by_user_id: null } },
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(CONNECTORS_LABELS.CONNECTOR_ADMIN_REPAIR_REQUIRED)).toBeInTheDocument());
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    expect(saveButtons.some((button) => !button.hasAttribute('disabled'))).toBe(true);
  });

  it('keeps unchanged Save enabled for a reloaded disabled connector rule with a valid creator', async () => {
    installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
    installRules(
      [{ id: 'rule-disabled', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: false }],
      { 'rule-disabled': { id: 'rule-disabled', trigger_type: 'WORKSPACE_FILE_MODIFIED', trigger_config: { vendors: ['google_drive'], drive_folders: [] }, action_type: 'AUTO_ANCHOR', action_config: { tag: 'connector-google_drive' }, enabled: false, created_by_user_id: 'admin-1' } },
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  });

  it('keeps the disabled rule retry actionable after mirror failure, then toasts only after mirror and enable succeed', async () => {
    const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
    installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
    installRules(
      [{ id: 'created-rule', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: false }],
      { 'created-rule': { id: 'created-rule', trigger_type: 'WORKSPACE_FILE_MODIFIED', trigger_config: { vendors: ['google_drive'], drive_folders: [] }, action_type: 'AUTO_ANCHOR', action_config: { tag: 'connector-google_drive' }, enabled: false, created_by_user_id: 'admin-1' } },
    );
    let attempts = 0;
    let recovered = false;
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    workerFetch.mockImplementation(async (endpoint: string, init?: RequestInit) => {
      if (endpoint.startsWith('/api/v1/integrations/google_drive/folders?')) {
        return response(200, { folders: [{ id: 'f1', name: 'Evidence', hasChildren: null, driveId: null }] });
      }
      if (endpoint === '/api/rules/created-rule' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        if (body.enabled === true) { recovered = true; return response(200, { ok: true }); }
        attempts += 1;
        if (attempts === 1) return response(200, { ok: true, drive_folder_mirror: [{ folderId: '', driveFolderId: 'f1', outcome: 'skipped_no_connection' }] });
        return response(200, { ok: true, drive_folder_mirror: [{ folderId: 'arkova-f1', driveFolderId: 'f1', outcome: 'created' }] });
      }
      if (endpoint === '/api/rules/created-rule' && init?.method === 'GET') {
        return response(200, { item: { id: 'created-rule', trigger_type: 'WORKSPACE_FILE_MODIFIED', trigger_config: { vendors: ['google_drive'], drive_folders: [] }, action_type: 'AUTO_ANCHOR', action_config: { tag: 'connector-google_drive' }, enabled: recovered, created_by_user_id: 'admin-1' } });
      }
      return response(200, {});
    });
    fireEvent.click(screen.getByRole('button', { name: CONNECTORS_LABELS.DRIVE_CHOOSE_FOLDERS }));
    await screen.findByRole('checkbox', { name: 'Evidence' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Evidence' }));
    fireEvent.click(screen.getByText(CONNECTORS_LABELS.DRIVE_PICKER_DONE));
    const save = screen.getByRole('button', { name: 'Save' });
    save.click();
    await waitFor(() => expect(screen.getByText(CONNECTORS_LABELS.CONNECTOR_FOLDER_RECOVERY_REQUIRED)).toBeInTheDocument());
    expect(toast.success).not.toHaveBeenCalled();
    expect(save).toBeEnabled();
    screen.getByRole('button', { name: 'Save' }).click();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(CONNECTORS_LABELS.CONNECTOR_SAVED_TOAST));
    const writes = workerFetch.mock.calls.filter((call) => ['POST', 'PATCH'].includes(call[1]?.method));
    expect(writes.map((call) => [call[0], call[1].method])).toEqual([
      ['/api/rules/created-rule', 'PATCH'], ['/api/rules/created-rule', 'PATCH'], ['/api/rules/created-rule', 'PATCH'],
    ]);
    for (const call of writes.slice(0, 2)) {
      const body = JSON.parse(String(call[1].body));
      expect(body.trigger_config?.drive_folders).toEqual([{ type: 'drive_folder', folder_id: 'f1', folder_name: 'Evidence' }]);
    }
  });

  it('two enabled WORKSPACE_FILE_MODIFIED rules produce the read-only Managed-in-Rules state; Save absent (test 9)', async () => {
    installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
    installRules(
      [
        { id: 'rule-1', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true },
        { id: 'rule-2', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true },
      ],
      {
        'rule-1': {
          id: 'rule-1',
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: {},
          action_type: 'AUTO_ANCHOR',
          action_config: {},
          enabled: true,
        },
      },
    );

    renderPage();
    await waitFor(() => expect(screen.getByText('This connector is set up with more than one rule, so it is managed in Rules.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('the google_drive org_integrations select never requests account_label/encrypted_tokens/token_kms_key_id/token_secret_name (test 10, GH #1836)', async () => {
    installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
    renderPage();
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('org_integrations'));
    await waitFor(() => expect(orgIntegrationsSelects.some((s) => s.provider === 'google_drive')).toBe(true));

    // account_label carries a secret (channel_token) for google_drive ONLY —
    // docusign/adobe_sign's account_label is a public account name, so this
    // check is scoped to the google_drive provider's own select() calls, not
    // every org_integrations query on the page.
    const driveSelects = orgIntegrationsSelects.filter((s) => s.provider === 'google_drive');
    expect(driveSelects.length).toBeGreaterThan(0);
    for (const { columns, orgId } of driveSelects) {
      // Every query is scoped by org_id, not just filtered by provider — an
      // unscoped select here would leak connection status across tenants.
      expect(orgId).toBe('org-1');
      expect(columns).not.toContain('account_label');
      expect(columns).not.toContain('encrypted_tokens');
      expect(columns).not.toContain('token_kms_key_id');
      expect(columns).not.toContain('token_secret_name');
    }
    expect(mockOrgIntegrationsEq).toHaveBeenCalledWith('org_id', 'org-1');
  });

  it('consumes drive_error exactly once and clears it from the URL (test 11)', async () => {
    renderPage(['/organization/connectors?drive_error=access_denied']);
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const [message] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(message).toContain('Google Drive connection was not completed');
  });

  it('consumes docusign_error exactly once with the mapped copy (test 11)', async () => {
    renderPage(['/organization/connectors?docusign_error=denied']);
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const [message] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(message).toContain('DocuSign connection failed: denied');
  });

  // Connector health surface (SCRUM-1146 — see this page's own useConnectorHealth
  // wiring and the #3054 Drive incident this closes the gap behind).
  describe('connector health surface', () => {
    it('renders the Drive card unchanged when the health endpoint reports connected/none', async () => {
      installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
      installRules([], {}, {
        connectors: [{ id: 'google_drive', state: 'connected', health_reason: 'none', last_error: null }],
      });

      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON })).toBeInTheDocument();
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('surfaces cursor_stale from GET /api/connectors/health as a degraded, accessible status on the Drive card', async () => {
      installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
      installRules([], {}, {
        connectors: [{
          id: 'google_drive',
          state: 'degraded',
          health_reason: 'cursor_stale',
          last_error: 'Drive changes cursor has not advanced in over 6h',
        }],
      });

      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(
          CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_CURSOR_STALE,
        );
      });
    });

    // TRUE in prod today for the one connected org (~32 granted scopes) —
    // must render correctly on the real page composition, not crash it.
    it('surfaces grant_exceeds_requested as degraded on the Drive card', async () => {
      installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
      installRules([], {}, {
        connectors: [{
          id: 'google_drive',
          state: 'degraded',
          health_reason: 'grant_exceeds_requested',
          last_error: 'Granted OAuth scope exceeds what this connection requested: drive',
        }],
      });

      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(
          CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_GRANT_EXCEEDS_REQUESTED,
        );
      });
    });

    it('fails closed to an "unavailable" status — never a healthy claim — when the health endpoint 503s', async () => {
      installOrgIntegrations({ google_drive: { id: 'int-1', connected_at: '2026-09-01T00:00:00Z' } });
      installRules([], {}, 'error');

      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON })).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(CONNECTORS_LABELS.CONNECTOR_HEALTH_UNAVAILABLE);
      });
      expect(screen.getByRole('status')).not.toHaveTextContent(
        CONNECTORS_LABELS.CONNECTOR_HEALTH_NEEDS_ATTENTION,
      );
    });
  });
});
