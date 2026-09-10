/** Auth owns recovery-session validation and password writes; the page renders its state. */
import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { ActivateAccountSchema } from '@/lib/validators';
import { SET_PASSWORD_LABELS as L } from '@/lib/copy';

const passwordSchema = ActivateAccountSchema.shape.password.max(128);

export function useSetPassword() {
  const [state, setState] = useState<'checking' | 'ready' | 'missing' | 'saved'>('checking');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // getUser validates the recovery session with Auth. The event may have
    // fired before this lazy route mounted, so an event-only gate loses it.
    void supabase.auth.getUser().then(({ data, error: authError }) => {
      if (active) setState(!authError && data.user ? 'ready' : 'missing');
    }).catch(() => { if (active) setState('missing'); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && active) setState('missing');
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || state !== 'ready') return;
    if (!passwordSchema.safeParse(password).success) { setError(L.INVALID); return; }
    if (password !== confirmation) { setError(L.MISMATCH); return; }
    setSaving(true); setError(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) { setError(L.FAILED); return; }
      setPassword(''); setConfirmation(''); setState('saved');
    } catch {
      setError(L.FAILED);
    } finally {
      setSaving(false);
    }
  }

  return { state, password, setPassword, confirmation, setConfirmation, saving, error, submit };
}
