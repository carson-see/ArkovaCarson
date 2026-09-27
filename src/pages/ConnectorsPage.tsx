/**
 * Connectors page (SPEC-CONNECTORS — DocSend-model folder selection + one-click
 * action, founder direction 2026-09-13).
 *
 * Replaces the org header's "Rules" nav entry with "Connectors". One card per
 * REAL connector (Google Drive, DocuSign) — Adobe Sign and the personal
 * DocuSign connector stay on the OrgProfile Settings tab (§1.2). This page
 * writes exactly one `organization_rules` row per connector per org through
 * the EXISTING `/api/rules` CRUD (`useConnectorRule`) — no new rule engine.
 *
 * OAuth return-trip query params (`?drive_error=`, `?docusign_error=`, ...)
 * are consumed HERE, not inside the cards — a card-local `useSearchParams`
 * effect loses the message under React StrictMode's double mount (see
 * `src/components/integrations/agents.md`, 2026-08-30 item 3).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, X } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { supabase } from '@/lib/supabase';
import { ROUTES } from '@/lib/routes';
import { CONNECTIONS_LABELS, CONNECTORS_LABELS } from '@/lib/copy';
import { DriveConnectorCard } from '@/components/connectors/DriveConnectorCard';
import { DocusignConnectorCard } from '@/components/connectors/DocusignConnectorCard';
import { ConnectorActionChoice } from '@/components/connectors/ConnectorActionChoice';
import { DriveFolderPicker, type SelectedDriveFolder } from '@/components/connectors/DriveFolderPicker';
import {
  useConnectorRule,
  type ConnectorActionType,
} from '@/components/connectors/useConnectorRule';
import {
  useConnectorHealth,
  describeConnectorHealthReason,
  type ConnectorHealthEntry,
} from '@/hooks/useConnectorHealth';
import type { ConnectorHealthDisplay } from '@/components/integrations/ConnectorCardStatusRow';

/**
 * SCRUM-1146 health surface: resolves one catalog id's `useConnectorHealth()`
 * entry into the presentational `ConnectorHealthDisplay` the status row
 * understands. `undefined` while the health request is still in flight — the
 * page must not flash an "unavailable" reading before the FIRST fetch has
 * even had a chance to resolve; once it settles, a lookup miss or a fetch
 * failure both resolve to `'unknown'`, never `'connected'` (fail-closed —
 * see `useConnectorHealth`'s own doc comment).
 */
function resolveHealthDisplay(
  loading: boolean,
  entry: ConnectorHealthEntry,
): ConnectorHealthDisplay | undefined {
  if (loading) return undefined;
  if (entry.state === 'degraded') {
    return { kind: 'degraded', reasonText: describeConnectorHealthReason(entry.health_reason) };
  }
  if (entry.state === 'unknown') {
    return { kind: 'unknown' };
  }
  return { kind: 'connected' };
}

/**
 * Minimal, column-pinned connection-status probe (GH #1836 lesson —
 * `src/components/connectors/agents.md` and the moved cards' own agents.md
 * entry): SELECT only `id, connected_at`, never `account_label` /
 * `encrypted_tokens` / `token_kms_key_id` / `token_secret_name`.
 */
function useIsConnectorConnected(orgId: string | null, provider: 'google_drive' | 'docusign') {
  const [connected, setConnected] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    if (!orgId) {
      setConnected(false);
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('org_integrations')
        .select('id, connected_at')
        .eq('org_id', orgId)
        .eq('provider', provider)
        .is('revoked_at', null)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        setConnected(false);
        return;
      }
      setConnected(!!data);
    } catch {
      setConnected(false);
    }
  }, [orgId, provider]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async refresh settles after the effect returns
    void refresh();
  }, [refresh]);

  return { connected, refresh };
}

function extractFolders(triggerConfig: Record<string, unknown> | undefined): SelectedDriveFolder[] {
  const raw = triggerConfig?.drive_folders;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is { type: 'drive_folder'; folder_id: string; folder_name?: string } =>
      !!f && typeof f === 'object' && (f as Record<string, unknown>).folder_id !== undefined,
    )
    .map((f) => ({ type: 'drive_folder', folder_id: f.folder_id, folder_name: f.folder_name ?? f.folder_id }));
}

interface DriveConnectorSectionProps {
  orgId: string;
  /** SCRUM-1146 health surface — see `resolveHealthDisplay` above. */
  health?: ConnectorHealthDisplay;
}

function DriveConnectorSection({ orgId, health }: DriveConnectorSectionProps) {
  const { connected, refresh: refreshConnected } = useIsConnectorConnected(orgId, 'google_drive');
  const { state, saving, saveError, save } = useConnectorRule(orgId, 'google_drive');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftFolders, setDraftFolders] = useState<SelectedDriveFolder[] | null>(null);
  const [draftAction, setDraftAction] = useState<ConnectorActionType | null>(null);

  const persistedFolders = useMemo(
    () => (state.status === 'adoptable' || state.status === 'managed' ? extractFolders(state.rule.trigger_config) : []),
    [state],
  );
  const persistedAction: ConnectorActionType =
    (state.status === 'adoptable' || state.status === 'managed') && state.rule.action_type === 'INSTANT_SECURE'
      ? 'INSTANT_SECURE'
      : 'AUTO_ANCHOR'; // PM-12 default pre-selection for a brand-new connector rule

  const folders = draftFolders ?? persistedFolders;
  const actionValue = draftAction ?? persistedAction;
  const isManaged = state.status === 'managed';
  const needsAdminRepair = state.status === 'adoptable' && state.rule.created_by_user_id === null;
  const needsDisabledRuleRecovery = state.status === 'adoptable' && !state.rule.enabled;
  const dirty =
    (draftFolders !== null && JSON.stringify(draftFolders) !== JSON.stringify(persistedFolders)) ||
    (draftAction !== null && draftAction !== persistedAction) || needsAdminRepair || needsDisabledRuleRecovery;

  async function handleSave() {
    const ok = await save({
      name: 'Google Drive',
      triggerConfig: { vendors: ['google_drive'], drive_folders: folders },
      actionType: actionValue,
    });
    if (ok) {
      toast.success(CONNECTORS_LABELS.CONNECTOR_SAVED_TOAST);
      setDraftFolders(null);
      setDraftAction(null);
    }
  }

  return (
    <div className="space-y-4">
      <DriveConnectorCard orgId={orgId} health={health} />

      {connected && !isManaged && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{CONNECTORS_LABELS.DRIVE_FOLDERS_HEADING}</CardTitle>
            <CardDescription>{CONNECTORS_LABELS.DRIVE_FOLDERS_DIRECT_ONLY}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {folders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{CONNECTORS_LABELS.DRIVE_FOLDERS_NONE}</p>
            ) : (
              <ul className="space-y-1">
                {folders.map((f) => (
                  <li key={f.folder_id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    <span className="truncate" title={f.folder_name}>{f.folder_name}</span>
                    <button
                      type="button"
                      aria-label={CONNECTORS_LABELS.DRIVE_PICKER_REMOVE}
                      onClick={() => setDraftFolders(folders.filter((x) => x.folder_id !== f.folder_id))}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
              {CONNECTORS_LABELS.DRIVE_CHOOSE_FOLDERS}
            </Button>

            <ConnectorActionChoice value={actionValue} onChange={setDraftAction} name="drive-action" />

            {saveError && <p className="text-sm text-destructive">{saveError}</p>}
            {needsAdminRepair && !saveError && (
              <p className="text-sm text-destructive">{CONNECTORS_LABELS.CONNECTOR_ADMIN_REPAIR_REQUIRED}</p>
            )}

            <Button onClick={() => void handleSave()} disabled={!dirty || saving}>
              {saving ? CONNECTORS_LABELS.CONNECTOR_SAVING : CONNECTORS_LABELS.CONNECTOR_SAVE}
            </Button>
          </CardContent>
        </Card>
      )}

      {connected && isManaged && (
        <Card>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{CONNECTORS_LABELS.CONNECTOR_MANAGED_BADGE}</Badge>
              <p className="text-sm text-muted-foreground">{CONNECTORS_LABELS.CONNECTOR_MANAGED_IN_RULES}</p>
            </div>
            <RulesLink />
          </CardContent>
        </Card>
      )}

      <DriveFolderPicker
        orgId={orgId}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialSelected={folders}
        onDone={(selected) => setDraftFolders(selected)}
        onReconnect={() => {
          setPickerOpen(false);
          void refreshConnected();
        }}
      />
    </div>
  );
}

function RulesLink() {
  const navigate = useNavigate();
  return (
    <Button variant="link" size="sm" onClick={() => navigate(ROUTES.RULES)}>
      {CONNECTORS_LABELS.CONNECTOR_MANAGE_IN_RULES_LINK}
    </Button>
  );
}

interface DocusignConnectorSectionProps {
  orgId: string;
}

function DocusignConnectorSection({ orgId }: DocusignConnectorSectionProps) {
  const { connected } = useIsConnectorConnected(orgId, 'docusign');
  const { state, saving, saveError, save } = useConnectorRule(orgId, 'docusign');
  const [draftAction, setDraftAction] = useState<ConnectorActionType | null>(null);

  const persistedAction: ConnectorActionType =
    (state.status === 'adoptable' || state.status === 'managed') && state.rule.action_type === 'INSTANT_SECURE'
      ? 'INSTANT_SECURE'
      : 'AUTO_ANCHOR';
  const actionValue = draftAction ?? persistedAction;
  const isManaged = state.status === 'managed';
  const dirty = draftAction !== null && draftAction !== persistedAction;

  async function handleSave() {
    const ok = await save({
      name: 'DocuSign',
      triggerConfig: { vendors: ['docusign'] },
      actionType: actionValue,
    });
    if (ok) {
      toast.success(CONNECTORS_LABELS.CONNECTOR_SAVED_TOAST);
      setDraftAction(null);
    }
  }

  return (
    <div className="space-y-4">
      <DocusignConnectorCard orgId={orgId} />

      {connected && !isManaged && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{CONNECTORS_LABELS.DOCUSIGN_ENVELOPES_HEADING}</CardTitle>
            <CardDescription>{CONNECTORS_LABELS.DOCUSIGN_ENVELOPES_DESC}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ConnectorActionChoice value={actionValue} onChange={setDraftAction} name="docusign-action" />
            {saveError && <p className="text-sm text-destructive">{saveError}</p>}
            <Button onClick={() => void handleSave()} disabled={!dirty || saving}>
              {saving ? CONNECTORS_LABELS.CONNECTOR_SAVING : CONNECTORS_LABELS.CONNECTOR_SAVE}
            </Button>
          </CardContent>
        </Card>
      )}

      {connected && isManaged && (
        <Card>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{CONNECTORS_LABELS.CONNECTOR_MANAGED_BADGE}</Badge>
              <p className="text-sm text-muted-foreground">{CONNECTORS_LABELS.CONNECTOR_MANAGED_IN_RULES}</p>
            </div>
            <RulesLink />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ConnectorsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const orgId = profile?.org_id ?? null;

  // SCRUM-1146 health surface: ONE fetch for every connector on the page,
  // not one per card — see `resolveHealthDisplay` above and this hook's own
  // doc comment for the fail-closed contract.
  const connectorHealth = useConnectorHealth();
  const driveHealthDisplay = resolveHealthDisplay(
    connectorHealth.loading,
    connectorHealth.getHealth('google_drive'),
  );

  // OAuth return-trip consumption — page-level, StrictMode-safe (see header
  // comment). Mirrors OrgProfilePage's existing effect for drive/docusign;
  // Adobe Sign is not on this page in v1.
  useEffect(() => {
    const driveResult = searchParams.get('drive');
    const driveError = searchParams.get('drive_error');
    const docusignResult = searchParams.get('docusign');
    const docusignError = searchParams.get('docusign_error');

    if (driveResult === 'connected') {
      toast.success(CONNECTORS_LABELS.DRIVE_TOAST_CONNECTED);
    } else if (driveError) {
      toast.error(CONNECTORS_LABELS.DRIVE_TOAST_ERROR);
    }

    if (docusignResult === 'connected') {
      toast.success(CONNECTIONS_LABELS.TOAST_CONNECTED);
    } else if (docusignError) {
      toast.error(`${CONNECTIONS_LABELS.TOAST_ERROR_PREFIX}${docusignError}`);
    }

    if (driveResult || driveError || docusignResult || docusignError) {
      const next = new URLSearchParams(searchParams);
      next.delete('drive');
      next.delete('drive_error');
      next.delete('docusign');
      next.delete('docusign_error');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const navigate = useNavigate();

  return (
    <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{CONNECTORS_LABELS.CONNECTORS_PAGE_TITLE}</h1>
          <p className="text-sm text-muted-foreground">{CONNECTORS_LABELS.CONNECTORS_PAGE_SUBTITLE}</p>
        </header>

        {profileLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !orgId ? (
          <p className="text-sm text-muted-foreground">{CONNECTORS_LABELS.CONNECTORS_EMPTY_ORG}</p>
        ) : (
          <>
            <DriveConnectorSection orgId={orgId} health={driveHealthDisplay} />
            <DocusignConnectorSection orgId={orgId} />
          </>
        )}

        <div>
          <Button variant="link" className="px-0" onClick={() => navigate(ROUTES.RULES)}>
            {CONNECTORS_LABELS.CONNECTORS_ADVANCED_LINK}
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
