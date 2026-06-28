/**
 * Webhook Settings Page
 *
 * Wraps WebhookSettings component in the AppShell layout.
 * Manages webhook endpoint CRUD via Supabase RPCs.
 * Secrets are generated server-side and returned once at creation.
 *
 * @see P7-TS-09
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { WebhookSettings } from '@/components/webhooks';
import { supabase } from '@/lib/supabase';
import { WEBHOOK_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: string;
}

export function WebhookSettingsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const navigate = useNavigate();
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const orgId = profile?.org_id;

  async function fetchEndpoints() {
    if (!orgId) return;
    setLoading(true);
    const { data } = await supabase
      .from('webhook_endpoints')
      .select('id, url, events, is_active, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });
    setEndpoints((data as WebhookEndpoint[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    if (!orgId) return;

    const currentOrgId = orgId;
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('webhook_endpoints')
        .select('id, url, events, is_active, created_at')
        .eq('org_id', currentOrgId)
        .order('created_at', { ascending: false });
      if (!cancelled) {
        setEndpoints((data as WebhookEndpoint[]) ?? []);
        setLoading(false);
      }
    }

    load();

    return () => { cancelled = true; };
  }, [orgId]);

  const handleAdd = async (url: string, events: string[]): Promise<string> => {
    const { data, error } = await supabase.rpc('create_webhook_endpoint', {
      p_url: url,
      p_events: events,
    });

    if (error) {
      throw new Error(error.message);
    }

    await fetchEndpoints();

    // Return the server-generated secret (shown to user once)
    return (data as { id: string; secret: string }).secret;
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.rpc('delete_webhook_endpoint', {
      p_endpoint_id: id,
    });
    if (error) {
      throw new Error(error.message);
    }
    await fetchEndpoints();
  };

  const handleToggle = async (id: string, active: boolean) => {
    // Optimistic update — flip the row immediately so the toggle feels
    // responsive. We reconcile against the server below.
    setEndpoints((prev) =>
      prev.map((ep) => (ep.id === id ? { ...ep, is_active: active } : ep)),
    );

    const { error } = await supabase
      .from('webhook_endpoints')
      .update({ is_active: active })
      .eq('id', id);

    if (error) {
      // RLS / permission denial (or any failure): surface it and visibly
      // revert. Without this the optimistic flip silently snaps back via the
      // refetch and the user wrongly believes the change took.
      toast.error(WEBHOOK_LABELS.TOGGLE_ERROR);
    }

    // Reconcile with the server: on success this confirms the new state; on
    // failure it reverts the optimistic flip to the true (unchanged) value.
    await fetchEndpoints();
  };

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <WebhookSettings
        endpoints={endpoints}
        onAdd={handleAdd}
        onDelete={handleDelete}
        onToggle={handleToggle}
        loading={loading}
      />
    </AppShell>
  );
}
