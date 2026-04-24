/**
 * Organization rules list.
 *
 * Admins can review existing smart-queue rules, enable/disable them, delete
 * them, or start a new rule in the builder.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw, ScrollText, Trash2, ToggleLeft, ToggleRight, Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/layout';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { supabase } from '@/lib/supabase';
import { workerFetch } from '@/lib/workerClient';
import { ROUTES } from '@/lib/routes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface OrgRule {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_type: string;
  action_type: string;
  created_at: string;
  updated_at: string | null;
}

interface OrgRuleDetail extends OrgRule {
  trigger_config: Record<string, unknown>;
  action_config: Record<string, unknown>;
  last_executed_at?: string | null;
}

function formatRuleType(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function RulesPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [rules, setRules] = useState<OrgRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orgRole, setOrgRole] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editRule, setEditRule] = useState<OrgRuleDetail | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editTriggerConfig, setEditTriggerConfig] = useState('{}');
  const [editActionConfig, setEditActionConfig] = useState('{}');
  const [editError, setEditError] = useState<string | null>(null);

  const isOrgAdmin = profile?.role === 'ORG_ADMIN' || orgRole === 'owner' || orgRole === 'admin';

  useEffect(() => {
    async function fetchOrgRole() {
      if (!user?.id || !profile?.org_id) {
        setOrgRole(null);
        return;
      }
      const { data } = await supabase
        .from('org_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('org_id', profile.org_id)
        .maybeSingle();
      setOrgRole((data?.role as string | null) ?? null);
    }
    void fetchOrgRole();
  }, [profile?.org_id, user?.id]);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await workerFetch('/api/rules', { method: 'GET' });
      const body = await res.json().catch(() => ({})) as {
        items?: OrgRule[];
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(body.error?.message ?? `Failed to load rules (${res.status})`);
      setRules(Array.isArray(body.items) ? body.items : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRules();
  }, [fetchRules]);

  async function patchRule(ruleId: string, body: Record<string, unknown>): Promise<boolean> {
    setActingId(ruleId);
    try {
      const res = await workerFetch(`/api/rules/${ruleId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const parsed = await res.json().catch(() => ({})) as { error?: { message?: string } };
      if (!res.ok) throw new Error(parsed.error?.message ?? `Rule update failed (${res.status})`);
      await fetchRules();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rule update failed');
      return false;
    } finally {
      setActingId(null);
    }
  }

  async function openEditRule(ruleId: string): Promise<void> {
    setEditOpen(true);
    setEditLoading(true);
    setEditError(null);
    setEditRule(null);
    try {
      const res = await workerFetch(`/api/rules/${ruleId}`, { method: 'GET' });
      const parsed = await res.json().catch(() => ({})) as {
        item?: OrgRuleDetail;
        error?: { message?: string };
      };
      if (!res.ok || !parsed.item) {
        throw new Error(parsed.error?.message ?? `Rule load failed (${res.status})`);
      }
      setEditRule(parsed.item);
      setEditName(parsed.item.name);
      setEditDescription(parsed.item.description ?? '');
      setEditTriggerConfig(JSON.stringify(parsed.item.trigger_config ?? {}, null, 2));
      setEditActionConfig(JSON.stringify(parsed.item.action_config ?? {}, null, 2));
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Rule load failed');
    } finally {
      setEditLoading(false);
    }
  }

  async function saveEditRule(): Promise<void> {
    if (!editRule) return;
    if (!isOrgAdmin) {
      setEditError('Only organization admins can edit rules.');
      return;
    }
    const name = editName.trim();
    if (!name) {
      setEditError('Rule name is required.');
      return;
    }

    let triggerConfig: Record<string, unknown>;
    let actionConfig: Record<string, unknown>;
    try {
      const parsedTrigger = JSON.parse(editTriggerConfig) as unknown;
      const parsedAction = JSON.parse(editActionConfig) as unknown;
      if (!parsedTrigger || typeof parsedTrigger !== 'object' || Array.isArray(parsedTrigger)) {
        throw new Error('Trigger config must be a JSON object.');
      }
      if (!parsedAction || typeof parsedAction !== 'object' || Array.isArray(parsedAction)) {
        throw new Error('Action config must be a JSON object.');
      }
      triggerConfig = parsedTrigger as Record<string, unknown>;
      actionConfig = parsedAction as Record<string, unknown>;
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Configs must be valid JSON objects.');
      return;
    }

    setEditLoading(true);
    setEditError(null);
    try {
      const res = await workerFetch(`/api/rules/${editRule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          description: editDescription.trim(),
          trigger_config: triggerConfig,
          action_config: actionConfig,
        }),
      });
      const parsed = await res.json().catch(() => ({})) as { error?: { message?: string } };
      if (!res.ok) throw new Error(parsed.error?.message ?? `Rule save failed (${res.status})`);
      toast.success('Rule updated.');
      setEditOpen(false);
      await fetchRules();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Rule save failed');
    } finally {
      setEditLoading(false);
    }
  }

  async function deleteRule(ruleId: string): Promise<void> {
    setActingId(ruleId);
    try {
      const res = await workerFetch(`/api/rules/${ruleId}`, { method: 'DELETE' });
      const parsed = await res.json().catch(() => ({})) as { error?: { message?: string } };
      if (!res.ok) throw new Error(parsed.error?.message ?? `Rule delete failed (${res.status})`);
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
      toast.success('Rule deleted.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rule delete failed');
    } finally {
      setActingId(null);
    }
  }

  async function handleSignOut() {
    await signOut();
    navigate(ROUTES.LOGIN);
  }

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      <div className="mx-auto max-w-5xl p-4 md:p-6 space-y-4 md:space-y-6">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <ScrollText className="h-6 w-6" />
              Rules
            </h1>
            <p className="text-sm text-muted-foreground">
              Smart-queue rules for automatically routing documents into review or anchoring.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={fetchRules} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button onClick={() => navigate(ROUTES.RULE_BUILDER)} disabled={!isOrgAdmin}>
              <Plus className="mr-2 h-4 w-4" />
              New Rule
            </Button>
          </div>
        </header>

        {!isOrgAdmin && (
          <Alert>
            <AlertDescription>
              Only organization admins can create, edit, enable, disable, or delete rules.
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading rules...
          </div>
        ) : rules.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center space-y-3">
              <ScrollText className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="font-medium">No rules yet.</p>
              <Button onClick={() => navigate(ROUTES.RULE_BUILDER)} disabled={!isOrgAdmin}>
                <Plus className="mr-2 h-4 w-4" />
                Create the first rule
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => {
              const busy = actingId === rule.id;
              return (
                <Card key={rule.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex flex-wrap items-center gap-2">
                      <span>{rule.name}</span>
                      <Badge variant={rule.enabled ? 'default' : 'secondary'}>
                        {rule.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {rule.description && (
                      <p className="text-sm text-muted-foreground">{rule.description}</p>
                    )}
                    <div className="flex flex-wrap gap-2 text-xs">
                      <Badge variant="outline">When: {formatRuleType(rule.trigger_type)}</Badge>
                      <Badge variant="outline">Then: {formatRuleType(rule.action_type)}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!isOrgAdmin || busy}
                        onClick={() => void patchRule(rule.id, { enabled: !rule.enabled })}
                      >
                        {rule.enabled ? (
                          <ToggleLeft className="mr-2 h-4 w-4" />
                        ) : (
                          <ToggleRight className="mr-2 h-4 w-4" />
                        )}
                        {rule.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void openEditRule(rule.id)}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        {isOrgAdmin ? 'Edit' : 'View'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!isOrgAdmin || busy}
                        onClick={() => void deleteRule(rule.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{isOrgAdmin ? 'Edit Rule' : 'View Rule'}</DialogTitle>
              <DialogDescription>
                {isOrgAdmin
                  ? 'Update the stored rule definition. Changes are validated before they are saved.'
                  : 'Review the stored rule definition for this organization.'}
              </DialogDescription>
            </DialogHeader>

            {editLoading && !editRule ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading rule...
              </div>
            ) : editRule ? (
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label htmlFor="rule-name">Name</Label>
                  <Input
                    id="rule-name"
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    disabled={editLoading || !isOrgAdmin}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rule-description">Description</Label>
                  <Textarea
                    id="rule-description"
                    value={editDescription}
                    onChange={(event) => setEditDescription(event.target.value)}
                    disabled={editLoading || !isOrgAdmin}
                    rows={3}
                  />
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline">When: {formatRuleType(editRule.trigger_type)}</Badge>
                  <Badge variant="outline">Then: {formatRuleType(editRule.action_type)}</Badge>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="trigger-config">Trigger Config</Label>
                  <Textarea
                    id="trigger-config"
                    value={editTriggerConfig}
                    onChange={(event) => setEditTriggerConfig(event.target.value)}
                    disabled={editLoading || !isOrgAdmin}
                    rows={8}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="action-config">Action Config</Label>
                  <Textarea
                    id="action-config"
                    value={editActionConfig}
                    onChange={(event) => setEditActionConfig(event.target.value)}
                    disabled={editLoading || !isOrgAdmin}
                    rows={8}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            ) : null}

            {editError && (
              <Alert variant="destructive">
                <AlertDescription>{editError}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setEditOpen(false)} disabled={editLoading}>
                Cancel
              </Button>
              {isOrgAdmin && (
                <Button onClick={() => void saveEditRule()} disabled={!editRule || editLoading}>
                  {editLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}

export default RulesPage;
