/**
 * Connectors page — load/adopt/create/patch a connector's `organization_rules`
 * row (SPEC-CONNECTORS §1.5, D5).
 *
 * D5 — adopt, don't create: on load this counts the org's ENABLED rules
 * matching the connector's trigger type. 0 -> the next Save creates a new
 * rule (then enables it — two calls, SEC-02's `ORG_RULE_CREATED` +
 * `ORG_RULE_ENABLED` audit pair). 1 -> the next Save PATCHes that rule in
 * place ("adopt"), regardless of whether `docusign-rule-seed.ts` or a human
 * made it. 2+ -> read-only "Managed in Rules" — Save is not offered.
 *
 * Race guard (CTO pre-mortem, 2026-09-13): the count above is read at page
 * load, but `docusign-rule-seed.ts` can seed a rule asynchronously at any
 * time. The worker re-checks server-side, inside the create call itself, and
 * refuses a connector-tagged create with `409 rule_exists` + the winning
 * rule's id when one already exists. This hook treats that 409 as "adopt
 * instead" and PATCHes the returned id — the race resolves to the SAME
 * outcome (one rule) an admin would get by reloading and adopting, instead of
 * a raw error.
 */
import { useCallback, useEffect, useState } from 'react';
import { workerFetch } from '@/lib/workerClient';
import { CONNECTORS_LABELS } from '@/lib/copy';

export type ConnectorProvider = 'google_drive' | 'docusign';

/** D1 — the only two actions this page writes. */
export type ConnectorActionType = 'INSTANT_SECURE' | 'AUTO_ANCHOR';

export const CONNECTOR_TRIGGER_TYPE: Record<ConnectorProvider, string> = {
  google_drive: 'WORKSPACE_FILE_MODIFIED',
  docusign: 'ESIGN_COMPLETED',
};

/** `action_config.tag` marker this page writes and recognises (§1.4). */
export function connectorTag(provider: ConnectorProvider): string {
  return `connector-${provider}`;
}

export interface ConnectorRuleDetail {
  id: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
  enabled: boolean;
  created_by_user_id?: string | null;
}

export type ConnectorRuleState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  /** 0 matching enabled rules — the next Save creates one. */
  | { status: 'none' }
  /** Exactly 1 matching enabled rule — the next Save adopts (PATCHes) it. */
  | { status: 'adoptable'; rule: ConnectorRuleDetail }
  /** 2+ matching enabled rules — read-only, Save not offered. */
  | { status: 'managed'; rule: ConnectorRuleDetail; count: number };

interface RuleListItem {
  id: string;
  trigger_type: string;
  enabled: boolean;
}

interface SaveInput {
  /** Only used on a CREATE (status: 'none') — ignored when adopting. */
  name: string;
  triggerConfig: Record<string, unknown>;
  actionType: ConnectorActionType;
}

interface RuleWriteBody {
  id?: string;
  drive_folder_mirror?: Array<{ outcome?: string }>;
  error?: { code?: string; message?: string; existing_rule_id?: string };
}

function hasFolderMirrorFailure(body: RuleWriteBody): boolean {
  return Array.isArray(body.drive_folder_mirror)
    && body.drive_folder_mirror.some((result) => result.outcome !== 'created' && result.outcome !== 'existing');
}

async function fetchRuleDetail(id: string): Promise<ConnectorRuleDetail | null> {
  const res = await workerFetch(`/api/rules/${id}`, { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Connector rule detail unavailable');
  const body = (await res.json().catch(() => null)) as { item?: ConnectorRuleDetail } | null;
  if (!body?.item) throw new Error('Connector rule detail response malformed');
  return body.item;
}

export function useConnectorRule(orgId: string | null, provider: ConnectorProvider) {
  const [state, setState] = useState<ConnectorRuleState>({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const triggerType = CONNECTOR_TRIGGER_TYPE[provider];

  const load = useCallback(async () => {
    if (!orgId) {
      setState({ status: 'error', message: CONNECTORS_LABELS.CONNECTORS_EMPTY_ORG });
      return;
    }
    setState({ status: 'loading' });
    try {
      const res = await workerFetch('/api/rules', { method: 'GET' });
      if (!res.ok) {
        setState({ status: 'error', message: CONNECTORS_LABELS.CONNECTOR_LOAD_FAILED });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { items?: RuleListItem[] };
      const sameTrigger = (body.items ?? []).filter((r) => r.trigger_type === triggerType);
      const matches = sameTrigger.filter((r) => r.enabled);

      if (matches.length === 0) {
        // A prior connector save may have committed its SEC-02 disabled rule
        // but failed one or more awaited folder mirrors. Recover only this
        // connector's tagged rows; never adopt an unrelated admin-authored
        // disabled rule that happens to share the trigger type.
        for (const candidate of sameTrigger.filter((r) => !r.enabled)) {
          const detail = await fetchRuleDetail(candidate.id);
          if (detail?.action_config?.tag === connectorTag(provider)) {
            setState({ status: 'adoptable', rule: detail });
            return;
          }
        }
        setState({ status: 'none' });
        return;
      }

      const detail = await fetchRuleDetail(matches[0].id);
      if (!detail) {
        setState({ status: 'error', message: CONNECTORS_LABELS.CONNECTOR_LOAD_FAILED });
        return;
      }
      if (matches.length >= 2) {
        setState({ status: 'managed', rule: detail, count: matches.length });
      } else {
        setState({ status: 'adoptable', rule: detail });
      }
    } catch {
      setState({ status: 'error', message: CONNECTORS_LABELS.CONNECTOR_LOAD_FAILED });
    }
  }, [orgId, provider, triggerType]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load settles after the effect returns
    void load();
  }, [load]);

  const save = useCallback(
    async (input: SaveInput): Promise<boolean> => {
      if (!orgId) return false;
      // D4 — action_type is NEVER sent without its paired action_config; both
      // Save paths below construct them together, never separately.
      const actionConfig = { tag: connectorTag(provider) };
      setSaving(true);
      setSaveError(null);
      try {
        if (state.status === 'adoptable' || state.status === 'managed') {
          const targetId = state.status === 'adoptable' ? state.rule.id : null;
          if (!targetId) {
            // 'managed' (2+ rules) never offers Save — defensive only.
            setSaveError(CONNECTORS_LABELS.CONNECTOR_SAVE_FAILED);
            return false;
          }
          const res = await workerFetch(`/api/rules/${targetId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              trigger_config: input.triggerConfig,
              action_type: input.actionType,
              action_config: actionConfig,
            }),
          });
          const body = await res.json().catch(() => ({})) as RuleWriteBody;
          if (!res.ok || hasFolderMirrorFailure(body)) {
            setSaveError(body?.error?.message ?? (hasFolderMirrorFailure(body) ? CONNECTORS_LABELS.CONNECTOR_FOLDER_RECOVERY_REQUIRED : CONNECTORS_LABELS.CONNECTOR_SAVE_FAILED));
            return false;
          }
          if (!state.rule.enabled) {
            const enableRes = await workerFetch(`/api/rules/${targetId}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
            });
            if (!enableRes.ok) {
              setSaveError(CONNECTORS_LABELS.CONNECTOR_SAVE_FAILED);
              return false;
            }
          }
        } else if (state.status === 'none') {
          const createRes = await workerFetch('/api/rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              org_id: orgId,
              name: input.name,
              trigger_type: triggerType,
              trigger_config: input.triggerConfig,
              action_type: input.actionType,
              action_config: actionConfig,
              enabled: false, // SEC-02 — worker forces this anyway; explicit here for clarity
            }),
          });
          const createBody = await createRes.json().catch(() => ({})) as RuleWriteBody;

          if (createRes.status === 409 && createBody?.error?.code === 'rule_exists' && createBody.error.existing_rule_id) {
            // Adopt-vs-create race: the seeder (or a parallel admin) won.
            // Adopt the rule that landed instead of surfacing a raw error.
            const patchRes = await workerFetch(`/api/rules/${createBody.error.existing_rule_id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                trigger_config: input.triggerConfig,
                action_type: input.actionType,
                action_config: actionConfig,
              }),
            });
            const patchBody = await patchRes.json().catch(() => ({})) as RuleWriteBody;
            if (!patchRes.ok || hasFolderMirrorFailure(patchBody)) {
              setSaveError(hasFolderMirrorFailure(patchBody) ? CONNECTORS_LABELS.CONNECTOR_FOLDER_RECOVERY_REQUIRED : CONNECTORS_LABELS.CONNECTOR_SAVE_FAILED);
              return false;
            }
          } else if (!createRes.ok || !createBody.id) {
            setSaveError(createBody?.error?.message ?? CONNECTORS_LABELS.CONNECTOR_SAVE_FAILED);
            return false;
          } else if (hasFolderMirrorFailure(createBody)) {
            setState({
              status: 'adoptable',
              rule: { id: createBody.id, trigger_type: triggerType, trigger_config: input.triggerConfig, action_type: input.actionType, action_config: actionConfig, enabled: false },
            });
            setSaveError(CONNECTORS_LABELS.CONNECTOR_FOLDER_RECOVERY_REQUIRED);
            return false;
          } else {
            const enableRes = await workerFetch(`/api/rules/${createBody.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: true }),
            });
            if (!enableRes.ok) {
              const enableBody = await enableRes.json().catch(() => ({})) as {
                error?: { code?: string; existing_rule_id?: string };
              };
              // Race guard, second half: the seeder (or a parallel admin) won
              // in the gap between this create and this enable call, not the
              // earlier create-vs-create gap. Same "adopt the winner" recovery
              // as the create-time 409 above — the just-created rule this
              // hook made is left behind disabled (harmless; RulesPage still
              // shows it) rather than left half-enabled with a duplicate.
              if (
                enableRes.status === 409 &&
                enableBody?.error?.code === 'rule_exists' &&
                enableBody.error.existing_rule_id
              ) {
                const patchRes = await workerFetch(`/api/rules/${enableBody.error.existing_rule_id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    trigger_config: input.triggerConfig,
                    action_type: input.actionType,
                    action_config: actionConfig,
                  }),
                });
                const patchBody = await patchRes.json().catch(() => ({})) as RuleWriteBody;
                if (!patchRes.ok || hasFolderMirrorFailure(patchBody)) {
                  setSaveError(hasFolderMirrorFailure(patchBody) ? CONNECTORS_LABELS.CONNECTOR_FOLDER_RECOVERY_REQUIRED : CONNECTORS_LABELS.CONNECTOR_SAVE_FAILED);
                  return false;
                }
              } else {
                setSaveError(CONNECTORS_LABELS.CONNECTOR_SAVE_FAILED);
                return false;
              }
            }
          }
        } else {
          setSaveError(CONNECTORS_LABELS.CONNECTOR_SAVE_FAILED);
          return false;
        }

        await load();
        return true;
      } catch {
        setSaveError(CONNECTORS_LABELS.CONNECTOR_SAVE_FAILED);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [orgId, provider, state, triggerType, load],
  );

  return { state, saving, saveError, reload: load, save };
}
