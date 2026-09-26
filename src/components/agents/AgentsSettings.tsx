/**
 * Agents Settings Component (SPEC-AGENTS-UI)
 *
 * The missing frontend for ComputeID / agent passports: lists an org's
 * registered agents (name, type, status, created date, active API key
 * prefixes on demand) with suspend / resume / revoke actions.
 *
 * PR #3083 fixed a real security defect where suspending an agent did not
 * deactivate its API keys — that fix is only reachable through this UI, so
 * the suspend/revoke copy states the consequence explicitly rather than
 * implying only the agent record itself changes.
 *
 * `status: 'revoked'` is TERMINAL (services/worker/src/api/v1/agents.ts —
 * a PATCH carrying `status` against a revoked agent 409s). A revoked agent
 * therefore offers NO status action buttons here — there is nothing a
 * button could legally do.
 */

import { useState } from 'react';
import { Ban, PauseCircle, PlayCircle, CheckCircle2, Loader2, AlertCircle, Bot, ChevronDown, ChevronUp, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AGENT_LABELS, AGENT_TYPE_LABELS } from '@/lib/copy';
import { AgentActionError, type Agent } from '@/hooks/useAgents';
import { AgentKeysPanel } from './AgentKeysPanel';

interface AgentsSettingsProps {
  agents: Agent[];
  onSuspend: (agentId: string) => Promise<void>;
  onResume: (agentId: string) => Promise<void>;
  onRevoke: (agentId: string) => Promise<void>;
  loading?: boolean;
  fetchError?: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function agentTypeLabel(type: Agent['agent_type']): string {
  return AGENT_TYPE_LABELS[type] ?? type;
}

/** Status is never color-only: every badge carries an icon AND its text label. */
function AgentStatusBadge({ status }: { status: Agent['status'] }) {
  if (status === 'suspended') {
    return (
      <Badge variant="secondary" className="bg-amber-100 text-amber-800 gap-1">
        <PauseCircle className="h-3 w-3" aria-hidden="true" />
        {AGENT_LABELS.STATUS_SUSPENDED}
      </Badge>
    );
  }
  if (status === 'revoked') {
    return (
      <Badge variant="secondary" className="bg-gray-100 text-gray-600 gap-1">
        <Ban className="h-3 w-3" aria-hidden="true" />
        {AGENT_LABELS.STATUS_REVOKED}
      </Badge>
    );
  }
  return (
    <Badge variant="default" className="bg-green-100 text-green-700 gap-1">
      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
      {AGENT_LABELS.STATUS_ACTIVE}
    </Badge>
  );
}

/**
 * Maps an action failure to curated copy — never the raw thrown message
 * (§1.4/§1.5: may carry server internals).
 *
 * Review P2: a lost response can follow a committed mutation, so this no
 * longer assumes the pre-mutation state still holds. `useAgents` always
 * reads the agent back after a failure and attaches the result as
 * `err.observedStatus`:
 *   - `undefined` — no readback available; fall back to the generic string.
 *   - `null` — the readback itself also failed; say so rather than guess.
 *   - a concrete status — report exactly that, including the case where the
 *     mutation actually succeeded despite the reported failure.
 */
function actionFailureMessage(err: unknown, action: 'suspend' | 'resume' | 'revoke', fallback: string): string {
  if (!(err instanceof AgentActionError)) {
    return fallback;
  }
  if (err.status === 409) {
    return AGENT_LABELS.REVOKED_TERMINAL_ERROR;
  }
  if (err.observedStatus === undefined) {
    return fallback;
  }
  if (err.observedStatus === null) {
    if (action === 'suspend') return AGENT_LABELS.SUSPEND_RESULT_UNCONFIRMED;
    if (action === 'resume') return AGENT_LABELS.RESUME_RESULT_UNCONFIRMED;
    return AGENT_LABELS.REVOKE_RESULT_UNCONFIRMED;
  }
  if (action === 'suspend') {
    return err.observedStatus === 'suspended'
      ? AGENT_LABELS.SUSPEND_SUCCEEDED_DESPITE_ERROR
      : AGENT_LABELS.SUSPEND_FAILED_CONFIRMED_ACTIVE;
  }
  if (action === 'resume') {
    return err.observedStatus === 'active'
      ? AGENT_LABELS.RESUME_SUCCEEDED_DESPITE_ERROR
      : AGENT_LABELS.RESUME_FAILED_CONFIRMED_SUSPENDED;
  }
  return fallback;
}

export function AgentsSettings({
  agents,
  onSuspend,
  onResume,
  onRevoke,
  loading = false,
  fetchError = null,
}: Readonly<AgentsSettingsProps>) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const toggleExpanded = (agentId: string) => {
    setExpandedId((current) => (current === agentId ? null : agentId));
  };

  const clearActionError = (agentId: string) => {
    setActionErrors((prev) => {
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  };

  const handleSuspend = async (agent: Agent) => {
    clearActionError(agent.id);
    setActionLoadingId(agent.id);
    try {
      await onSuspend(agent.id);
    } catch (err) {
      setActionErrors((prev) => ({
        ...prev,
        [agent.id]: actionFailureMessage(err, 'suspend', AGENT_LABELS.SUSPEND_FAILED),
      }));
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleResume = async (agent: Agent) => {
    clearActionError(agent.id);
    setActionLoadingId(agent.id);
    try {
      await onResume(agent.id);
    } catch (err) {
      setActionErrors((prev) => ({
        ...prev,
        [agent.id]: actionFailureMessage(err, 'resume', AGENT_LABELS.RESUME_FAILED),
      }));
    } finally {
      setActionLoadingId(null);
    }
  };

  const openRevokeConfirm = (agentId: string) => {
    setRevokeError(null);
    setConfirmRevokeId(agentId);
  };

  const closeRevokeConfirm = () => {
    if (revoking) return;
    setConfirmRevokeId(null);
    setRevokeError(null);
  };

  const handleConfirmRevoke = async () => {
    if (!confirmRevokeId) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await onRevoke(confirmRevokeId);
      setConfirmRevokeId(null);
    } catch (err) {
      // Review P2: a lost response can follow a committed mutation. Before
      // assuming the revoke did NOT happen, trust the hook's post-failure
      // readback (err.observedStatus) — if it confirms the agent IS now
      // revoked, this "failure" is the success it actually was, so close
      // the dialog rather than telling the user something untrue.
      if (err instanceof AgentActionError && err.observedStatus === 'revoked') {
        setConfirmRevokeId(null);
      } else {
        setRevokeError(actionFailureMessage(err, 'revoke', AGENT_LABELS.REVOKE_FAILED));
      }
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="space-y-6 animate-in-view">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{AGENT_LABELS.PAGE_TITLE}</h1>
        <p className="text-muted-foreground mt-1">{AGENT_LABELS.PAGE_DESCRIPTION}</p>
      </div>

      {/* Revoke confirmation — destructive + terminal, so it is confirmed and
          reachable by keyboard (Radix Dialog: focus trap, Escape to cancel). */}
      <Dialog open={!!confirmRevokeId} onOpenChange={(open) => { if (!open) closeRevokeConfirm(); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{AGENT_LABELS.CONFIRM_REVOKE_TITLE}</DialogTitle>
            <DialogDescription>{AGENT_LABELS.CONFIRM_REVOKE_BODY}</DialogDescription>
          </DialogHeader>
          {revokeError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{revokeError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeRevokeConfirm} disabled={revoking}>
              {AGENT_LABELS.CONFIRM_REVOKE_CANCEL}
            </Button>
            <Button variant="destructive" onClick={handleConfirmRevoke} disabled={revoking}>
              {revoking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {AGENT_LABELS.CONFIRM_REVOKE_CONFIRM}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {fetchError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {AGENT_LABELS.FETCH_ERROR}: {fetchError}
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : agents.length === 0 ? (
        !fetchError && (
          <Card className="shadow-card-rest">
            <CardContent className="py-12 text-center">
              <Bot className="mx-auto h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-muted-foreground">{AGENT_LABELS.NO_AGENTS}</p>
            </CardContent>
          </Card>
        )
      ) : (
        <div className="space-y-3">
          {agents.map((agent, index) => {
            const isExpanded = expandedId === agent.id;
            const isActionLoading = actionLoadingId === agent.id;
            const actionError = actionErrors[agent.id];
            const isRevoked = agent.status === 'revoked';

            return (
              <Card
                key={agent.id}
                className={`shadow-card-rest hover:shadow-card-hover transition-all hover:-translate-y-0.5 stagger-${index + 1}`}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-base">{agent.name}</CardTitle>
                      <AgentStatusBadge status={agent.status} />
                    </div>
                    <div className="flex items-center gap-1">
                      {!isRevoked && agent.status === 'active' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Suspend ${agent.name}`}
                          disabled={isActionLoading}
                          onClick={() => void handleSuspend(agent)}
                        >
                          {isActionLoading ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <PauseCircle className="h-4 w-4 mr-1" />
                          )}
                          {AGENT_LABELS.SUSPEND}
                        </Button>
                      )}
                      {!isRevoked && agent.status === 'suspended' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Resume ${agent.name}`}
                          disabled={isActionLoading}
                          onClick={() => void handleResume(agent)}
                        >
                          {isActionLoading ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <PlayCircle className="h-4 w-4 mr-1" />
                          )}
                          {AGENT_LABELS.RESUME}
                        </Button>
                      )}
                      {!isRevoked && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={`Revoke ${agent.name}`}
                          disabled={isActionLoading}
                          onClick={() => openRevokeConfirm(agent.id)}
                        >
                          <Ban className="h-4 w-4 mr-1" />
                          {AGENT_LABELS.REVOKE}
                        </Button>
                      )}
                    </div>
                  </div>
                  <CardDescription className="flex items-center gap-1 flex-wrap">
                    <span>{agentTypeLabel(agent.agent_type)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{AGENT_LABELS.CREATED_LABEL} {formatDate(agent.created_at)}</span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {actionError && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>{actionError}</AlertDescription>
                    </Alert>
                  )}
                  {isRevoked && (
                    <p className="text-xs text-muted-foreground">{AGENT_LABELS.REVOKED_NOTE}</p>
                  )}
                  {!isRevoked && (
                    <p className="text-xs text-muted-foreground">{AGENT_LABELS.SUSPEND_HINT}</p>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground"
                    aria-expanded={isExpanded}
                    onClick={() => toggleExpanded(agent.id)}
                  >
                    <KeyRound className="h-3 w-3 mr-1" />
                    {isExpanded ? AGENT_LABELS.HIDE_KEYS : AGENT_LABELS.VIEW_KEYS}
                    {isExpanded ? (
                      <ChevronUp className="h-3 w-3 ml-1" />
                    ) : (
                      <ChevronDown className="h-3 w-3 ml-1" />
                    )}
                  </Button>
                  {isExpanded && <AgentKeysPanel agentId={agent.id} />}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
