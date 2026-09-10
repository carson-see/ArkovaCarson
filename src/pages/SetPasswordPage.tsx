/** Recovery links must remain on this route even after Supabase signs in. */
import { Link } from 'react-router-dom';
import { AuthLayout } from '@/components/layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ROUTES } from '@/lib/routes';
import { useSetPassword } from '@/hooks/useSetPassword';
import { SET_PASSWORD_LABELS as L } from '@/lib/copy';

export function SetPasswordPage() {
  const { state, password, setPassword, confirmation, setConfirmation, saving, error, submit } = useSetPassword();

  return <AuthLayout title={L.TITLE} description={L.DESCRIPTION}>
    {state === 'checking' && <p role="status">{L.CHECKING}</p>}
    {state === 'missing' && <Alert><AlertDescription>{L.MISSING}</AlertDescription></Alert>}
    {state === 'saved' && <div className="space-y-4">
      <p role="status">{L.SAVED}</p>
      <Button asChild className="w-full"><Link to={ROUTES.DASHBOARD}>{L.CONTINUE}</Link></Button>
    </div>}
    {state === 'ready' && <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert variant="destructive"><AlertDescription role="alert">{error}</AlertDescription></Alert>}
      <div className="space-y-2">
        <Label htmlFor="new-password">{L.PASSWORD}</Label>
        <Input id="new-password" type="password" autoComplete="new-password" maxLength={128}
          value={password} onChange={(event) => setPassword(event.target.value)} disabled={saving} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">{L.CONFIRMATION}</Label>
        <Input id="confirm-password" type="password" autoComplete="new-password" maxLength={128}
          value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={saving} />
      </div>
      <Button type="submit" className="w-full" disabled={saving}>{saving ? L.SAVING : L.SAVE}</Button>
    </form>}
  </AuthLayout>;
}
